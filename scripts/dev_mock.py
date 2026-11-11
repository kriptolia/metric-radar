#!/usr/bin/env python3
"""Local dev server with a mock Metric API, mock chain RPCs and a mock explorer, for working on the UI offline.

    python3 scripts/dev_mock.py 8080
    open http://localhost:8080/?api=mock   (the page reads ?api=mock and points everything at this server)

Mock endpoints, with the response shapes of the real services:
  /public/v1/chains
  /public/v1/evm/{chain}/metadata                 pool listing; records carry a chain name but no chain id, as in production
  /public/v1/evm/{chain}/{pool}/bid_ask
  /public/v1/evm/{chain}/{pool}/analytics/bins
  /public/v1/evm/{chain}/{pool}/activity          a pool's latest swaps
  /public/v1/evm/{chain}/positions/{wallet}       open LP positions with performance (demo wallet only)
  /rpc/{chain}                                    JSON-RPC: eth_getBlockByNumber, eth_getTransactionReceipt, eth_getLogs
                                                  (logs: rejects more than 4 addresses or 20,000 blocks)
  /explorer/{chain}/api/v2/addresses/{a}/transactions   the transactions an address sent, 50 a page (demo wallet only)
  /explorer/{chain}/api?module=logs&action=getLogs  Etherscan-style logs (swaps whose output went straight to the demo wallet)
  /data/latest.json, /data/history.json           the hourly snapshot, built with scripts/snapshot.py from the mock pools

Query switches for failure drills: ?api=mock&down=rpc | explorer | api | positions (comma-separated), read from the Referer.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import random
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("snapshot", os.path.join(ROOT, "scripts", "snapshot.py"))
snapshot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(snapshot)

random.seed(7)
START = time.time()
NOW = int(START)

TOPIC_SWAP = "0x9734819749a91fc3be03ea83205f924ee08479bd3f0da48efc91d94d050cac1e"
ROUTER = "0x02201E6f13c41506c7Bb635d7543F98826229aB7"
DATA_PROVIDER = "0x9BB15FE2B214E37d19A6c59eE7B132e787FdfB2a"
DEMO_WALLET = "0x1111111111111111111111111111111111111111"
RPC_MAX_ADDRS = 4
RPC_MAX_RANGE = 20_000

# chain id -> (API name, seconds per block, block number when the server started)
# Robinhood's blocks here are slower than the 0.1 s the site assumes, as they are at quiet hours in production.
CHAINS = {1: ("ethereum", 12.0, 26_390_000), 56: ("BSC", 0.45, 132_950_000), 4663: ("Robinhood", 0.13, 111_640_000)}
TOKENS = {
    "WETH": ("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18, 2059.4, "#101010"),
    "USDC": ("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, 0.9998, "#0050b0"),
    "USDT": ("0xdAC17F958D2ee523a2206206994597C13D831ec7", 6, 1.0001, "#26a17b"),
    "WBTC": ("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8, 64120.0, "#f7931a"),
    "BNB": ("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", 18, 612.3, "#f3ba2f"),
    "TSLAb": ("0x7b8f2a0c5c1e4d3f8a9b0c1d2e3f4a5b6c7d8e9f", 18, 241.7, "#cc0000"),
    "AAPLb": ("0x8c9d3b1d6d2f5e4a9b0c1d2e3f4a5b6c7d8e9f01", 18, 229.1, "#555555"),
    "XAUt": ("0x68749665FF8D2d112Fa859AA293F07A622f09eAB", 6, 4120.0, "#d4af37"),
    "GOLD": ("0x9d0e4b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80", 18, 4118.0, "#b8860b"),
}
PAIRS = [("WETH", "USDC"), ("USDC", "USDT"), ("WBTC", "USDC"), ("WETH", "USDT"), ("TSLAb", "USDC"), ("AAPLb", "USDC"), ("XAUt", "USDC"), ("GOLD", "USDT"), ("BNB", "USDT"), ("WBTC", "WETH")]


def addr_from(seed: str) -> str:
    return "0x" + hashlib.sha256(seed.encode()).hexdigest()[:40]


def latest_block(cid: int) -> int:
    _, bt, base = CHAINS[cid]
    return base + int((time.time() - START) / bt)


def block_ts(cid: int, block: int) -> int:
    _, bt, base = CHAINS[cid]
    return int(START + (block - base) * bt)


def make_pools():
    pools = []
    for cid, (cname, bt, latest) in CHAINS.items():
        funded = {1: 14, 56: 11, 4663: 9}[cid]
        for i in range(funded + 12):  # the last 12 of each chain are empty shells, like most pools in production
            a, b = PAIRS[i % len(PAIRS)]
            addr = addr_from(f"pool-{cid}-{i}")
            is_empty = i >= funded
            tvl = 0.0 if is_empty else round(random.choice([1500, 9000, 45_000, 120_000, 380_000, 1_200_000, 3_400_000]) * random.uniform(0.6, 1.4), 2)
            vol24 = round(tvl * random.uniform(0.2, 9.0), 2)
            tier = random.choice(["green", "green", "yellow", "red", "unclassified"])
            reasons = {"green": [], "yellow": ["curator_unverified"], "red": random.choice([["stop_loss_mutable"], ["app_missing", "curator_unverified"], ["remove_liquidity_extension_present"]]), "unclassified": []}[tier]
            status = "unknown" if is_empty else random.choice(["healthy"] * 6 + ["feed_down", "pool_refused", "unknown"])
            private = random.random() < 0.12
            mk = {}
            for w in ["24h", "7d", "30d", "all"]:
                mk[w] = {"fromTimestamp": NOW - 86400, "byHorizon": {}}
                for hz in ["1m", "5m", "30m"]:
                    apr = int(random.uniform(-900, 4800))
                    mk[w]["byHorizon"][hz] = {"markoutFiat": round(tvl * apr / 1e4 / 52, 2), "aprBps": apr, "pricedVolumeShare": round(random.uniform(0.6, 1.0), 3), "unpricedFills": 3, "tradedLiquidityShare": round(random.uniform(0.2, 1.0), 3), "tradedBins": 6, "fundedBins": 12, "throughTimestamp": NOW - 300}
            t0 = TOKENS[a]
            t1 = TOKENS[b]
            pools.append({
                "_chainId": cid,  # internal: production listings have no chain id field, and neither do the mock's responses
                "pair": f"{a}/{b}", "chain": cname, "contractVersion": "v1", "poolAddress": addr,
                "priceProviderAddress": addr_from(f"pp-{cid}-{i}"),
                "priceProviderDetails": {"providerType": "anchored" if tier in ("green", "yellow") else "regular", "oracle": "0x30a88bf894D1b806125a23ebf23D715496fD7102", "feedMode": "single", "marginStep": "0", "minMargin": "5000000000000", "maxRefStaleness": "15", "maxSpreadMult": "1000000000000000000", "mutableParams": False, "source": addr_from(f"src-{cid}-{i}") if tier == "green" else None},
                "token0": t0[0], "token1": t1[0], "token0Symbol": a, "token1Symbol": b, "token0Name": a, "token1Name": b, "token0Decimals": t0[1], "token1Decimals": t1[1],
                "token0LogoUrl": "", "token1LogoUrl": "", "token0BrandColor": t0[3], "token1BrandColor": t1[3], "token0FiatPrice": t0[2], "token1FiatPrice": t1[2],
                "tvlFiat": tvl, "creator": addr_from(f"cur-{i}"), "admin": addr_from(f"cur-{i}"), "adminUsername": random.choice(["Carcosa", None, "Keyrock", "Wintermute", None]), "verifiedAdmin": tier == "green",
                "adminFeeDestination": addr_from("fee"), "spreadProtocolFeeE6": 75000, "spreadAdminFeeE6": random.choice([100000, 200000, 300000]), "protocolNotionalFeeE8": 0, "adminNotionalFeeE8": 0,
                "analytics24h": {"fromTs": NOW - 86400, "toTs": NOW, "generatedAtTs": NOW, "fiatAvailable": True, "fiatCoveragePct": 100, "fiatStatus": "active", "fiatCurrency": "USD", "fromBlock": latest - 7000, "toBlock": latest, "swapTxCount": 0 if is_empty else int(random.uniform(150, 2400)), "liquidityEventCount": 2, "liquidityAddEventCount": 1, "liquidityRemoveEventCount": 1, "transfers": 100,
                                 "token0": {"liquidityFiat": round(tvl * 0.55, 2), "volumeFiat": round(vol24 / 2, 2)}, "token1": {"liquidityFiat": round(tvl * 0.45, 2), "volumeFiat": round(vol24 / 2, 2)}, "pricingMode": "estimated_spot", "usdCoveragePct": 100, "aprBps": int(random.uniform(50, 3000)), "feesFiat": round(vol24 * 0.0002, 2), "tvlFiat": tvl, "volumeFiat": vol24},
                "aprBps7d": int(random.uniform(50, 3500)), "tradingPnlAprBps7d": int(random.uniform(-4000, 3000)),
                "markoutByWindow": mk, "volumeByWindow": {"24h": vol24, "7d": round(vol24 * 6.2, 2), "30d": round(vol24 * 24, 2), "all": round(vol24 * 60, 2)},
                "lockedPricing": tier != "red", "pauseLevel": 0, "priceProviderCooldownSecs": 18446744073709551615 if tier != "red" else 3600, "depositWhitelistingEnabled": private,
                "createdBlockNumber": latest - int(random.uniform(20_000, 600_000)), "createdTimestamp": NOW - int(random.uniform(3, 70) * 86400), "priceProviderSinceBlock": latest - 100000,
                "extensions": ["0xE4038fA09f0bB9963068afaF97BE0c045155090D", "0xEbc53e61078976118E384f110c262A263decB84B"],
                # real pools carry small values here (0.05% drawdown, 0.01% a block): keep the mock in that range
                "extensionDetails": {"stopLoss": {"phases": ["afterSwap"], "drawdownE6": random.choice(["500", "20000", "150000"]), "decayPerSecondE18": random.choice(["5787037037", "1736111111111"]), "timelockSecs": "1099511627775" if tier != "red" else "3600"}, "priceVelocity": {"phases": ["beforeSwap"], "maxChangePerBlockE18": random.choice(["100000000000000", "100000000000000000"])}},
                "classificationSummary": {"tierQualification": tier, "reasonCodes": reasons},
                "poolFactoryAddress": "0x2a53833cc95548cf52c7b159110e22D3a9018f32", "dataProviderAddress": DATA_PROVIDER, "quoterAddress": "0x3B9ea79f482094323d06064E637a7F4528560fcb",
                "priceProviderStatus": status, "curBinIdx": random.randint(-3, 3),
            })
    return pools


POOLS = make_pools()
BY_ADDR = {p["poolAddress"].lower(): p for p in POOLS}
Q64 = 1 << 64


def public(p: dict) -> dict:
    return {k: v for k, v in p.items() if not k.startswith("_")}


def word(v: int) -> str:
    return (v % (1 << 256)).to_bytes(32, "big").hex()


def pack2int128(hi: int, lo: int) -> int:
    return ((hi & ((1 << 128) - 1)) << 128) | (lo & ((1 << 128) - 1))


def topic_addr(a: str) -> str:
    return "0x" + a[2:].lower().rjust(64, "0")


# ---- deterministic swaps: a pool trades on every block where (block - offset) % stride == 0, so overlapping queries agree ----
def stride_of(p: dict) -> int:
    n = int(p["analytics24h"]["swapTxCount"] or 0)
    if n <= 0:
        return 0
    return max(1, int(86400 / CHAINS[p["_chainId"]][1] / n))


def swap_at(p: dict, block: int, recipient: str | None = None) -> dict:
    """The swap of pool p at `block`: amounts derived from the block number, so every caller sees the same trade."""
    rnd = random.Random(f"{p['poolAddress']}:{block}")
    d0, d1 = p["token0Decimals"], p["token1Decimals"]
    usd = rnd.choice([120, 900, 3200, 12000, 48000]) * rnd.uniform(0.5, 1.5)
    if rnd.random() < 0.5:  # the trader sells token0: the pool receives token0 (positive) and pays token1 (negative)
        a0, a1 = int(usd / p["token0FiatPrice"] * 10**d0), -int(usd / p["token1FiatPrice"] * 10**d1 * 0.999)
    else:
        a1, a0 = int(usd / p["token1FiatPrice"] * 10**d1), -int(usd / p["token0FiatPrice"] * 10**d0 * 0.999)
    return {"block": block, "a0": a0, "a1": a1, "usd": usd, "bin": rnd.randint(-2, 2), "idx": rnd.randint(0, 200),
            "recipient": recipient or addr_from(f"trader{rnd.randint(0, 8)}"), "tx": "0x" + hashlib.sha256(f"tx{p['poolAddress']}{block}".encode()).hexdigest()}


def swaps_between(p: dict, frm: int, to: int) -> list[dict]:
    stride = stride_of(p)
    if not stride:
        return []
    offset = int(p["poolAddress"][2:10], 16) % stride
    first = frm + ((offset - frm) % stride)
    return [swap_at(p, b) for b in range(first, to + 1, stride)]


def swap_log(p: dict, s: dict, style: str) -> dict:
    cid = p["_chainId"]
    details = (1 << 120) | ((s["bin"] & 0xFFFF) << 104) | 12345
    log = {"address": p["poolAddress"].lower(), "topics": [TOPIC_SWAP, topic_addr(ROUTER), topic_addr(s["recipient"])],
           "data": "0x" + word(details) + word(pack2int128(s["a0"], s["a1"])) + word(pack2int128(1000, 0)),
           "blockNumber": hex(s["block"]), "transactionHash": s["tx"], "logIndex": hex(s["idx"])}
    if style == "rpc":
        # Robinhood Chain's RPC really does send "0x0" here; the other chains send the block time
        log.update({"blockTimestamp": "0x0" if cid == 4663 else hex(block_ts(cid, s["block"])), "transactionIndex": "0x1", "blockHash": "0x" + "00" * 32, "removed": False})
    else:  # Blockscout's Etherscan-style API: timeStamp, and topics padded to four entries
        log.update({"timeStamp": hex(block_ts(cid, s["block"])), "gasPrice": "0x1", "gasUsed": "0x5208", "transactionIndex": "0x1"})
        log["topics"] = log["topics"] + [None]
    return log


def wallet_swaps(cid: int) -> list[tuple[dict, dict]]:
    """Fourteen swaps the demo wallet made on this chain's first pools, all after those pools were created.

    As in production, the output of every other swap goes to the router first (it unwraps to the native coin), so the
    pool's event does not mention the wallet at all: only the wallet's own transactions reveal those.
    """
    cpools = [p for p in POOLS if p["_chainId"] == cid and stride_of(p)]
    base = CHAINS[cid][2]
    out = []
    for k in range(14):
        p = cpools[k % len(cpools)]
        out.append((p, swap_at(p, base - (k + 1) * 1200, DEMO_WALLET if k % 2 == 0 else ROUTER)))
    return out


def iso(ts: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000000Z", time.gmtime(ts))


def wallet_transactions(cid: int) -> list[dict]:
    """What the explorer lists for the demo wallet, newest first: its swaps, unrelated activity, and older history."""
    base = CHAINS[cid][2]
    txs = []
    for p, s in wallet_swaps(cid):
        txs.append({"hash": s["tx"], "block_number": s["block"], "status": "ok", "result": "success", "method": "0xac9650d8", "transaction_types": ["contract_call", "token_transfer"]})
    for k in range(45):  # approvals, transfers and one failed swap between them: none of these holds a Metric swap
        kind = k % 3
        txs.append({"hash": "0x" + hashlib.sha256(f"misc{cid}{k}".encode()).hexdigest(), "block_number": base - 600 - k * 380,
                    "status": "error" if k == 7 else "ok", "result": "execution reverted" if k == 7 else "success",
                    "method": ["approve", None, "transfer"][kind], "transaction_types": [["contract_call"], ["coin_transfer"], ["contract_call", "token_transfer"]][kind]})
    for k in range(70):  # activity from before Metric existed on the chain
        txs.append({"hash": "0x" + hashlib.sha256(f"old{cid}{k}".encode()).hexdigest(), "block_number": base - int((95 + k) * 86400 / CHAINS[cid][1]),
                    "status": "ok", "result": "success", "method": "swap", "transaction_types": ["contract_call", "token_transfer"]})
    txs.sort(key=lambda x: -x["block_number"])
    for x in txs:
        x.update({"timestamp": iso(block_ts(cid, x["block_number"])), "from": {"hash": DEMO_WALLET, "is_contract": False}, "to": {"hash": ROUTER, "is_contract": True, "name": None}, "token_transfers": None, "token_transfers_overflow": None})
    return txs


def handle_rpc(cid: int, req: dict):
    method = req.get("method")
    params = req.get("params") or []
    latest = latest_block(cid)
    if method == "eth_blockNumber":
        return hex(latest)
    if method == "eth_getBlockByNumber":
        n = latest if params[0] == "latest" else min(latest, int(params[0], 16))
        return {"number": hex(n), "timestamp": hex(block_ts(cid, n)), "hash": "0x" + "00" * 32}
    if method == "eth_getTransactionReceipt":
        for p, sw in wallet_swaps(cid):
            if sw["tx"] == params[0]:
                # a token transfer first, then the pool's event: readers must pick the Swap out of the receipt
                transfer = {"address": p["token0"].lower(), "topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic_addr(DEMO_WALLET), topic_addr(p["poolAddress"])], "data": "0x" + word(1), "blockNumber": hex(sw["block"]), "transactionHash": sw["tx"], "logIndex": "0x0"}
                return {"transactionHash": sw["tx"], "blockNumber": hex(sw["block"]), "status": "0x1", "from": DEMO_WALLET, "to": ROUTER.lower(), "logs": [transfer, swap_log(p, sw, "rpc")]}
        known = {x["hash"] for x in wallet_transactions(cid)}
        return {"transactionHash": params[0], "status": "0x1", "logs": []} if params[0] in known else None
    if method == "eth_getLogs":
        f = params[0]
        frm = int(f.get("fromBlock", "0x0"), 16)
        to = latest if f.get("toBlock", "latest") == "latest" else min(latest, int(f["toBlock"], 16))
        addrs = f.get("address")
        addrs = [a.lower() for a in (addrs if isinstance(addrs, list) else [addrs])] if addrs else []
        # the same kinds of refusals the public endpoints give
        if not addrs:
            return {"__error__": {"code": -32701, "message": "Please specify an address in your request"}}
        if len(addrs) > RPC_MAX_ADDRS:
            return {"__error__": {"code": -32602, "message": f"A maximum of {RPC_MAX_ADDRS} addresses is allowed."}}
        if to - frm + 1 > RPC_MAX_RANGE:
            return {"__error__": {"code": -32602, "message": f"query spans {to - frm + 1} blocks, but only {RPC_MAX_RANGE} are allowed for this request"}}
        topics = f.get("topics") or []
        if not topics or topics[0] != TOPIC_SWAP:
            return []
        logs = []
        for a in addrs:
            p = BY_ADDR.get(a)
            if p and p["_chainId"] == cid:
                logs.extend(swap_log(p, s, "rpc") for s in swaps_between(p, frm, to))
        return sorted(logs, key=lambda l: (int(l["blockNumber"], 16), int(l["logIndex"], 16)))
    return {"__error__": {"code": -32601, "message": "method not found"}}


def position_row(cid: int, p: dict, k: int) -> dict:
    """One row of GET /evm/{chain}/positions/{wallet}?periods=24h,7d,30d,all&fiat=USD, in the production shape."""
    d0, d1 = p["token0Decimals"], p["token1Decimals"]
    cur = p["curBinIdx"]
    bins = [cur - 1, cur, cur + 1] if k == 0 else [cur + 2, cur + 3]  # the second position sits above the active bin
    usd_per_bin = 400.0 * (k + 1)
    rows = []
    tot0 = tot1 = 0
    for b in bins:
        a0 = int(usd_per_bin / p["token0FiatPrice"] * 10**d0) if b >= cur else 0
        a1 = int(usd_per_bin / p["token1FiatPrice"] * 10**d1) if b <= cur else 0
        if b == cur:
            a0 //= 2
            a1 //= 2
        tot0 += a0
        tot1 += a1
        rows.append({"binIdx": str(b), "shares": str(10**20 * (k + 1)), "token0Amount": str(a0), "token1Amount": str(a1)})
    value = tot0 / 10**d0 * p["token0FiatPrice"] + tot1 / 10**d1 * p["token1FiatPrice"]
    opened = NOW - (9 + 5 * k) * 86400

    def horizon(scale):
        return {hz: {"markoutFiat": round(value * 0.002 * scale * m, 2), "apr": round(0.31 * m, 4), "pricedVolumeShare": 0.998, "capitalSecondsFiat": round(value * 86400 * scale, 2), "throughTimestamp": NOW - 600} for hz, m in (("1m", 0.9), ("5m", 1.0), ("30m", 1.2))}

    scales = {"24h": 1, "7d": 7, "30d": 9 + 5 * k, "all": 9 + 5 * k}
    return {
        "id": f"{cid}-{p['poolAddress'].lower()}-{DEMO_WALLET}-{k}", "chainId": str(cid), "poolAddress": p["poolAddress"],
        "token0": p["token0"], "token1": p["token1"], "priceProviderAddress": p["priceProviderAddress"],
        "token0FiatPrice": p["token0FiatPrice"], "token1FiatPrice": p["token1FiatPrice"], "provider": DEMO_WALLET, "salt": str(k),
        "totalAmount0Delta": str(tot0 * 10 ** (18 - d0)), "totalAmount1Delta": str(tot1 * 10 ** (18 - d1)), "token0Amount": str(tot0), "token1Amount": str(tot1),
        "lastModifiedBlock": str(latest_block(cid) - 5000), "lastModifiedTimestamp": str(opened + 3600), "lastDepositTimestamp": opened + 3600,
        "bins": rows, "range": {"lowerOffsetRatio": (bins[0] - cur) * 0.0004, "upperOffsetRatio": (bins[-1] - cur + 1) * 0.0004},
        "classificationSummary": p["classificationSummary"], "lockedPricing": p["lockedPricing"], "verifiedAdmin": p["verifiedAdmin"],
        "performance": {
            "openedAtTimestamp": opened, "fiatCurrency": "USD", "currentValueFiat": round(value, 2), "feesEarnedFiat": round(value * 0.011, 2), "previous24hFeeIncomeFiat": round(value * 0.0009, 2),
            "finiteWindowsStatus": "ready", "valuedThroughTimestamp": NOW - 600, "windowsThroughTimestamp": NOW,
            "aprByPeriod": {w: {"apr": round(0.33 + 0.02 * s / 7, 4), "pnlApr": round(0.06 - 0.03 * k, 4), "feeIncomeFiat": round(value * 0.0009 * s, 2), "timeWeightedCapitalFiat": round(value * 0.9, 2), "capitalSecondsFiat": round(value * 86400 * s, 2)} for w, s in scales.items()},
            "pnlByPeriod": {w: round(value * 0.0005 * s * (1 if k == 0 else -1), 2) for w, s in scales.items()},
            "markoutByPeriod": {w: {"byHorizon": horizon(s)} for w, s in scales.items()},
            "volumeByPeriod": {w: round(value * 4.4 * s, 2) for w, s in scales.items() if w != "all"},
        },
    }


def build_snapshot() -> tuple[dict, dict]:
    """The files the hourly workflow publishes, produced by scripts/snapshot.py's own functions from the mock pools."""
    pools = [snapshot.normalize({**public(p), "chainId": p["_chainId"]}) for p in POOLS]
    meta = snapshot.chain_meta(pools)
    latest = {"v": 2, "generatedAt": NOW - 1500, "chains": list(CHAINS), "chainMeta": meta, "source": "mock",
              "pools": [snapshot.without_shared(p, meta) for p in pools if snapshot.is_active(p)], "index": [snapshot.slim(p, meta) for p in pools if not snapshot.is_active(p)]}
    history: dict = {}
    rnd = random.Random(11)
    drift = {p["address"]: 0.75 for p in pools}
    for hours_ago in range(24 * 12, -1, -1):  # twelve days of hourly points with a gentle upward walk
        scaled = []
        for p in pools:
            drift[p["address"]] = min(1.0, max(0.4, drift[p["address"]] * rnd.uniform(0.985, 1.02)))
            f = drift[p["address"]] if hours_ago else 1.0
            scaled.append({**p, "tvl": round((p["tvl"] or 0) * f, 2), "vol24": round((p["vol24"] or 0) * f * rnd.uniform(0.7, 1.2), 2)})
        history = snapshot.roll_history(history, scaled, NOW - 1500 - hours_ago * 3600)
    return latest, history


SNAPSHOT_LATEST, SNAPSHOT_HISTORY = build_snapshot()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):  # quieter: API-ish requests only
        if any(k in str(args[0]) for k in ("/public/v1", "/rpc/", "/explorer/")):
            sys.stderr.write("%s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always serve the files as they are on disk now
        super().end_headers()

    def down(self) -> set[str]:
        """Failure drills: services named in the page's ?down= are answered with errors."""
        ref = urlparse(self.headers.get("Referer") or "")
        return {x for x in parse_qs(ref.query).get("down", [""])[0].split(",") if x}

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_POST(self):
        u = urlparse(self.path)
        ln = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(ln) or b"{}")
        if u.path.startswith("/rpc/"):
            if "rpc" in self.down():
                return self.send_json({"jsonrpc": "2.0", "id": body.get("id"), "error": {"code": -32603, "message": "service temporarily unavailable"}})
            res = handle_rpc(int(u.path.split("/")[2]), body)
            if isinstance(res, dict) and "__error__" in res:
                return self.send_json({"jsonrpc": "2.0", "id": body.get("id"), "error": res["__error__"]})
            return self.send_json({"jsonrpc": "2.0", "id": body.get("id"), "result": res})
        return self.send_json({"error": "not found"}, 404)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        parts = [x for x in u.path.split("/") if x]
        if parts[:1] == ["data"] and parts[1:] in (["latest.json"], ["history.json"]):
            return self.send_json(SNAPSHOT_LATEST if parts[1] == "latest.json" else SNAPSHOT_HISTORY)
        if len(parts) == 3 and parts[0] == "explorer" and parts[2] == "api":
            return self.explorer(int(parts[1]), q)
        if len(parts) == 7 and parts[0] == "explorer" and parts[2:5] == ["api", "v2", "addresses"] and parts[6] == "transactions":
            return self.explorer_transactions(int(parts[1]), parts[5], q)
        if parts[:2] == ["public", "v1"]:
            if "api" in self.down():
                return self.send_json({"error": "upstream unavailable"}, 503)
            return self.api(parts[2:], q)
        return super().do_GET()

    def explorer(self, cid: int, q: dict):
        if "explorer" in self.down():
            return self.send_json({"message": "Too many requests. Increase limits now at https://dev.blockscout.com", "result": None, "status": "0"}, 429)
        if q.get("module") == ["block"]:
            return self.send_json({"jsonrpc": "2.0", "result": hex(latest_block(cid)), "id": 1})
        frm = int(q.get("fromBlock", ["0"])[0])
        to = int(q.get("toBlock", ["999999999"])[0])
        logs = []
        if q.get("topic0") == [TOPIC_SWAP] and q.get("topic2") == [topic_addr(DEMO_WALLET)]:
            logs = [swap_log(p, s, "explorer") for p, s in wallet_swaps(cid) if frm <= s["block"] <= to and s["recipient"] == DEMO_WALLET]
            logs.sort(key=lambda l: int(l["blockNumber"], 16))
        if not logs:
            return self.send_json({"message": "No logs found", "result": [], "status": "0"})
        return self.send_json({"message": "OK", "result": logs[:1000], "status": "1"})

    def explorer_transactions(self, cid: int, address: str, q: dict):
        """Blockscout's REST listing: 50 a page, newest first, continued with the block number of the last item."""
        if "explorer" in self.down():
            return self.send_json({"message": "Too Many Requests"}, 429)
        txs = wallet_transactions(cid) if address.lower() == DEMO_WALLET else []
        if "block_number" in q:
            txs = [x for x in txs if x["block_number"] < int(q["block_number"][0])]
        page = txs[:50]
        nxt = {"block_number": page[-1]["block_number"], "index": 0, "items_count": 50, "filter": "from"} if len(txs) > 50 else None
        return self.send_json({"items": page, "next_page_params": nxt})

    def api(self, rest: list[str], q: dict):
        if rest == ["chains"]:
            return self.send_json({"chains": [{"type": "evm", "chainId": c, "name": CHAINS[c][0]} for c in CHAINS]})
        if len(rest) == 3 and rest[0] == "evm" and rest[2] == "metadata":
            cid = int(rest[1])
            pools = sorted((p for p in POOLS if p["_chainId"] == cid), key=lambda p: -p["tvlFiat"])
            if "addresses" in q:
                want = {a.lower() for a in q["addresses"][0].split(",")}
                pools = [p for p in pools if p["poolAddress"].lower() in want]
            min_tvl = float(q.get("minTvlFiat", ["0"])[0])
            pools = [p for p in pools if p["tvlFiat"] >= min_tvl]
            offset = int(q.get("offset", ["0"])[0])
            count = min(500, int(q.get("count", ["50"])[0]))
            nxt = offset + count if offset + count < len(pools) else None
            return self.send_json({"data": [public(p) for p in pools[offset:offset + count]], "total": len(pools), "nextOffset": nxt})
        if len(rest) == 4 and rest[0] == "evm" and rest[2] == "positions":
            cid = int(rest[1])
            if "positions" in self.down():
                return self.send_json({"error": "upstream unavailable"}, 503)
            if len(rest[3]) != 42 or not rest[3].startswith("0x"):
                return self.send_json({"error": f"Invalid address '{rest[3]}'. Expected a 0x-prefixed 20-byte hex address."}, 400)
            if rest[3].lower() != DEMO_WALLET:
                return self.send_json([])
            funded = [p for p in POOLS if p["_chainId"] == cid and p["tvlFiat"] > 0]
            return self.send_json([position_row(cid, p, k) for k, p in enumerate(funded[:2])])
        p = BY_ADDR.get(rest[2].lower()) if len(rest) >= 4 and rest[0] == "evm" else None
        if len(rest) == 4 and rest[3] == "activity":
            if not p:
                return self.send_json({"error": "not found"}, 404)
            cid = p["_chainId"]
            limit = int(q.get("limit", ["100"])[0])
            if not 1 <= limit <= 300:
                return self.send_json({"error": f"Invalid limit '{limit}'. Allowed range: 1..=300"}, 400)
            latest = latest_block(cid)
            swaps = swaps_between(p, latest - int(86400 / CHAINS[cid][1]), latest)[-limit:][::-1]
            items = [{"id": f"{cid}-{p['poolAddress'].lower()}-{s['block']}-{s['idx']}", "kind": "swap", "type": "sell" if s["a0"] > 0 else "buy", "blockNumber": s["block"], "logIndex": s["idx"], "timestamp": block_ts(cid, s["block"]), "txHash": s["tx"],
                      "amount0Raw": str(s["a0"]), "amount1Raw": str(s["a1"]), "amount0Fiat": round(s["a0"] / 10 ** p["token0Decimals"] * p["token0FiatPrice"], 6), "amount1Fiat": round(s["a1"] / 10 ** p["token1Decimals"] * p["token1FiatPrice"], 6), "totalFiat": round(s["usd"], 6)} for s in swaps]
            return self.send_json({"chain": p["chain"], "pair": p["poolAddress"], "period": "24h", "fiatAvailable": True, "fiatCoveragePct": 100, "fiatCurrency": "USD", "fiatStatus": "active", "items": items, "nextCursor": None})
        if len(rest) == 4 and rest[3] == "bid_ask":
            if not p:
                return self.send_json({"error": f"Pair metadata not found for {rest[2]}"}, 404)
            mid = p["token0FiatPrice"] / p["token1FiatPrice"]
            d0, d1 = p["token0Decimals"], p["token1Decimals"]
            if p["priceProviderStatus"] != "healthy":
                return self.send_json({"pair": p["pair"], "poolAddress": p["poolAddress"], "priceProviderStatus": p["priceProviderStatus"], "bidAdj": "0", "askAdj": str((1 << 128) - 1), "totalToken0Available": "0", "totalToken1Available": "0", "serverTs": NOW, "depth": {"bids": [], "asks": []}})
            bids, asks = [], []
            cum_in = cum_out = 0
            for k in range(6):
                cum_in += int(2 * 10**d0)
                cum_out += int(2 * mid * 10**d1 * (1 - 0.001 * k))
                bids.append({"binIdx": -1 - k, "price": str(int(mid * (0.9995 - 0.001 * (k + 1)) * Q64)), "cumulativeVolume": str(cum_out), "cumulativeInputVolume": str(cum_in), "priceImpactE6": str(int(1000 * (k + 1)))})
            cum_in = cum_out = 0
            for k in range(6):
                cum_out += int(2 * 10**d0)
                cum_in += int(2 * mid * 10**d1 * (1 + 0.001 * k))
                asks.append({"binIdx": -1 + k, "price": str(int(mid * (1.0005 + 0.001 * (k + 1)) * Q64)), "cumulativeVolume": str(cum_out), "cumulativeInputVolume": str(cum_in), "priceImpactE6": str(int(1000 * (k + 1)))})
            return self.send_json({"pair": p["pair"], "poolAddress": p["poolAddress"], "priceProviderStatus": "healthy", "bidAdj": str(int(mid * 0.9995 * Q64)), "askAdj": str(int(mid * 1.0005 * Q64)), "totalToken0Available": str(12 * 10**d0), "totalToken1Available": str(int(12 * mid * 10**d1)), "serverTs": NOW, "depth": {"bids": bids, "asks": asks}})
        if len(rest) == 5 and rest[3] == "analytics" and rest[4] == "bins":
            if not p:
                return self.send_json({"error": "not found"}, 404)
            rnd = random.Random(p["poolAddress"])
            bins = []
            for b in range(-8, 9):
                r0 = max(0, 6000 - abs(b) * 600) * rnd.uniform(0.7, 1.3)
                r1 = max(0, 6000 - abs(b) * 600) * rnd.uniform(0.7, 1.3)
                vol = max(0, 40000 - abs(b - p["curBinIdx"]) * 9000) * rnd.uniform(0.5, 1.5)
                bins.append({"bin": str(b), "swapCount": str(int(vol / 1500)), "lengthE6": 10000, "token0": {"reserveFiat": round(r0, 2), "volumeFiat": round(vol / 2, 2), "lpFeesFiat": round(vol * 0.0001, 2), "avgLiquidityFiat": round(r0, 2)}, "token1": {"reserveFiat": round(r1, 2), "volumeFiat": round(vol / 2, 2), "lpFeesFiat": round(vol * 0.0001, 2), "avgLiquidityFiat": round(r1, 2)}, "aprBps": int(vol * 0.0002 / max(1, r0 + r1) * 52 * 1e4), "pnlAprBps": int(rnd.uniform(-3000, 3000))})
            return self.send_json({"pair": p["pair"], "chain": p["chain"], "period": "7d", "fiatAvailable": True, "fiatCurrency": "USD", "window": {"fromTs": NOW - 7 * 86400, "toTs": NOW}, "curBinIdx": p["curBinIdx"], "bins": bins})
        return self.send_json({"error": "not found"}, 404)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"mock server on http://localhost:{port}/?api=mock  (demo wallet {DEMO_WALLET})", file=sys.stderr)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

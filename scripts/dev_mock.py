#!/usr/bin/env python3
"""Local dev server with a mock Metric API + mock JSON-RPC, for working on the UI without network access.

    python3 scripts/dev_mock.py 8080
    open http://localhost:8080/?api=mock   (the page reads ?api=mock and points at this server)

Mock endpoints (same shapes as the real API):
  /public/v1/chains, /public/v1/evm/metadata, /public/v1/evm/{chain}/metadata,
  /public/v1/evm/{chain}/{pool}/bid_ask, /public/v1/evm/{chain}/{pool}/analytics/bins
  /rpc/{chain}  JSON-RPC: eth_blockNumber, eth_getBlockByNumber, eth_getLogs, eth_call (multicall3 aggregate3)
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
random.seed(7)
NOW = int(time.time())

TOPIC_ADD = "0xa55772434bee2a347743b1e8086fa44bac69a060e124ec92ab6b9cc7fc5268af"
TOPIC_REMOVE = "0xf53d04bdbda6d88dd536895ec533833d3e09d0cbe2474fae32a368c5f83fc610"
TOPIC_SWAP = "0x9734819749a91fc3be03ea83205f924ee08479bd3f0da48efc91d94d050cac1e"
SEL = {"positionBinShares": "2875de46", "binTotalShares": "7b06033b", "binState": "5d6dc217", "aggregate3": "82ad56cb"}
DATA_PROVIDER = "0x9BB15FE2B214E37d19A6c59eE7B132e787FdfB2a"
DEMO_WALLET = "0x1111111111111111111111111111111111111111"

CHAINS = {1: ("ethereum", 12.0, 26_500_000), 56: ("BSC", 0.75, 92_000_000), 4663: ("Robinhood", 0.25, 41_000_000)}
TOKENS = {
    "WETH": ("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18, 2709.4, "#101010"),
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


def make_pools():
    pools = []
    for cid, (cname, _, latest) in CHAINS.items():
        n = {1: 14, 56: 11, 4663: 9}[cid]
        for i in range(n):
            a, b = PAIRS[i % len(PAIRS)]
            addr = addr_from(f"pool-{cid}-{i}")
            tvl = round(random.choice([1500, 9000, 45_000, 120_000, 380_000, 1_200_000, 3_400_000]) * random.uniform(0.6, 1.4), 2)
            vol24 = round(tvl * random.uniform(0.2, 9.0), 2)
            tier = random.choice(["green", "green", "yellow", "red", "unclassified"])
            reasons = {"green": [], "yellow": ["curator_unverified"], "red": random.choice([["stop_loss_mutable"], ["app_missing", "curator_unverified"], ["remove_liquidity_extension_present"]]), "unclassified": []}[tier]
            status = random.choice(["healthy"] * 6 + ["feed_down", "pool_refused", "unknown"])
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
                "pair": f"{a}/{b}", "chain": cname, "chainId": cid, "contractVersion": "v1", "poolAddress": addr,
                "priceProviderAddress": addr_from(f"pp-{cid}-{i}"),
                "priceProviderDetails": {"providerType": "anchored" if tier in ("green", "yellow") else "regular", "oracle": "0x30a88bf894D1b806125a23ebf23D715496fD7102", "feedMode": "single", "marginStep": "0", "minMargin": "5000000000000", "maxRefStaleness": "15", "maxSpreadMult": "1000000000000000000", "mutableParams": False, "source": addr_from(f"src-{cid}-{i}") if tier == "green" else None},
                "token0": t0[0], "token1": t1[0], "token0Symbol": a, "token1Symbol": b, "token0Name": a, "token1Name": b, "token0Decimals": t0[1], "token1Decimals": t1[1],
                "token0LogoUrl": "", "token1LogoUrl": "", "token0BrandColor": t0[3], "token1BrandColor": t1[3], "token0FiatPrice": t0[2], "token1FiatPrice": t1[2],
                "tvlFiat": tvl, "creator": addr_from(f"cur-{i}"), "admin": addr_from(f"cur-{i}"), "adminUsername": random.choice(["Carcosa", None, "Keyrock", "Wintermute", None]), "verifiedAdmin": tier == "green",
                "adminFeeDestination": addr_from("fee"), "spreadProtocolFeeE6": 75000, "spreadAdminFeeE6": random.choice([100000, 200000, 300000]), "protocolNotionalFeeE8": 0, "adminNotionalFeeE8": 0,
                "analytics24h": {"fromTs": NOW - 86400, "toTs": NOW, "generatedAtTs": NOW, "fiatAvailable": True, "fiatCoveragePct": 100, "fiatStatus": "active", "fiatCurrency": "USD", "fromBlock": latest - 7000, "toBlock": latest, "swapTxCount": int(vol24 / random.uniform(800, 4000)), "liquidityEventCount": 2, "liquidityAddEventCount": 1, "liquidityRemoveEventCount": 1, "transfers": 100,
                                 "token0": {"liquidityFiat": round(tvl * 0.55, 2), "volumeFiat": round(vol24 / 2, 2)}, "token1": {"liquidityFiat": round(tvl * 0.45, 2), "volumeFiat": round(vol24 / 2, 2)}, "pricingMode": "estimated_spot", "usdCoveragePct": 100, "aprBps": int(random.uniform(50, 3000)), "feesFiat": round(vol24 * 0.0002, 2), "tvlFiat": tvl, "volumeFiat": vol24},
                "aprBps7d": int(random.uniform(50, 3500)), "tradingPnlAprBps7d": int(random.uniform(-4000, 3000)),
                "markoutByWindow": mk, "volumeByWindow": {"24h": vol24, "7d": round(vol24 * 6.2, 2), "30d": round(vol24 * 24, 2), "all": round(vol24 * 60, 2)},
                "lockedPricing": tier != "red", "pauseLevel": 0, "priceProviderCooldownSecs": 18446744073709551615 if tier != "red" else 3600, "depositWhitelistingEnabled": private,
                "createdBlockNumber": latest - int(random.uniform(20_000, 600_000)), "createdTimestamp": NOW - int(random.uniform(3, 70) * 86400), "priceProviderSinceBlock": latest - 100000,
                "extensions": ["0xE4038fA09f0bB9963068afaF97BE0c045155090D", "0xEbc53e61078976118E384f110c262A263decB84B"],
                "extensionDetails": {"stopLoss": {"phases": ["afterSwap"], "drawdownE6": "150000", "decayPerSecondE18": "1736111111111", "timelockSecs": "1099511627775" if tier != "red" else "3600"}, "priceVelocity": {"phases": ["beforeSwap"], "maxChangePerBlockE18": "100000000000000000"}},
                "classificationSummary": {"tierQualification": tier, "reasonCodes": reasons},
                "poolFactoryAddress": "0x2a53833cc95548cf52c7b159110e22D3a9018f32", "dataProviderAddress": DATA_PROVIDER, "quoterAddress": "0x3B9ea79f482094323d06064E637a7F4528560fcb",
                "priceProviderStatus": status, "curBinIdx": random.randint(-3, 3),
            })
    return pools


POOLS = make_pools()
BY_ADDR = {p["poolAddress"].lower(): p for p in POOLS}
Q64 = 1 << 64


def word(v: int) -> str:
    return (v % (1 << 256)).to_bytes(32, "big").hex()


def pack2int128(hi: int, lo: int) -> int:
    return ((hi & ((1 << 128) - 1)) << 128) | (lo & ((1 << 128) - 1))


def swap_log(pool: dict, block: int, idx: int, recipient: str):
    d0 = pool["token0Decimals"]
    d1 = pool["token1Decimals"]
    p0 = pool["token0FiatPrice"]
    p1 = pool["token1FiatPrice"]
    usd = random.choice([120, 900, 3200, 12000, 48000]) * random.uniform(0.5, 1.5)
    zero_for_one = random.random() < 0.5
    if zero_for_one:
        a0 = int(usd / p0 * 10**d0)
        a1 = -int(usd / p1 * 10**d1 * 0.999)
    else:
        a1 = int(usd / p1 * 10**d1)
        a0 = -int(usd / p0 * 10**d0 * 0.999)
    details = (1 << 120) | ((random.randint(-2, 2) & 0xFFFF) << 104) | 12345
    data = "0x" + word(details) + word(pack2int128(a0, a1)) + word(pack2int128(1000, 0))
    return {"address": pool["poolAddress"], "topics": [TOPIC_SWAP, "0x" + "02201E6f13c41506c7Bb635d7543F98826229aB7".lower().rjust(64, "0"), "0x" + recipient[2:].lower().rjust(64, "0")], "data": data, "blockNumber": hex(block), "transactionHash": "0x" + hashlib.sha256(f"tx{block}{idx}".encode()).hexdigest(), "logIndex": hex(idx)}


def liq_log(pool: dict, block: int, salt: int, bins: list[int], shares: list[int], add=True, idx=0):
    def arr_int(xs):
        return word(len(xs)) + "".join(word(x) for x in xs)
    bin_deltas = word(len(bins)) + "".join(word(10**18 * (i + 1)) + word(10**18 * (i + 2)) for i, _ in enumerate(bins))
    a1 = arr_int(bins)
    a3 = arr_int(shares)
    head = word(0x60) + word(0x60 + len(a1) // 2) + word(0x60 + len(a1) // 2 + len(bin_deltas) // 2)
    data = "0x" + head + a1 + bin_deltas + a3
    return {"address": pool["poolAddress"], "topics": [TOPIC_ADD if add else TOPIC_REMOVE, "0x" + DEMO_WALLET[2:].lower().rjust(64, "0"), "0x" + word(salt)], "data": data, "blockNumber": hex(block), "transactionHash": "0x" + hashlib.sha256(f"liq{block}{salt}".encode()).hexdigest(), "logIndex": hex(idx)}


# demo wallet positions: pool index 0 and 1 on each chain, bins -1..1, shares 40% of total
DEMO_SHARES = 4 * 10**20
DEMO_TOTAL = 10 * 10**20


def handle_rpc(cid: int, req: dict):
    method = req.get("method")
    params = req.get("params") or []
    cname, bt, latest = CHAINS[cid]
    if method == "eth_blockNumber":
        return hex(latest)
    if method == "eth_getBlockByNumber":
        n = latest if params[0] == "latest" else int(params[0], 16)
        return {"number": hex(n), "timestamp": hex(NOW - int((latest - n) * bt))}
    if method == "eth_getLogs":
        f = params[0]
        frm = int(f.get("fromBlock", "0x0"), 16)
        to = latest if f.get("toBlock", "latest") == "latest" else int(f["toBlock"], 16)
        if to - frm > 120_000:
            return {"__error__": {"code": -32005, "message": "query returned more than 10000 results / block range too large"}}
        topics = f.get("topics") or []
        t0 = topics[0] if topics else None
        t0s = t0 if isinstance(t0, list) else [t0]
        addrs = f.get("address")
        addrs = [a.lower() for a in (addrs if isinstance(addrs, list) else [addrs])] if addrs else list(BY_ADDR.keys())
        cpools = [p for p in POOLS if p["chainId"] == cid and p["poolAddress"].lower() in addrs]
        logs = []
        wallet_topic = "0x" + DEMO_WALLET[2:].lower().rjust(64, "0")
        if TOPIC_SWAP in t0s:
            recipient_filter = topics[2] if len(topics) > 2 else None
            sender_filter = topics[1] if len(topics) > 1 else None
            if recipient_filter == wallet_topic:
                for k in range(14):
                    p = cpools[k % max(1, len(cpools))]
                    logs.append(swap_log(p, latest - int((k + 1) * 86400 * 0.6 / bt), k, DEMO_WALLET))
            elif recipient_filter is None and sender_filter is None:
                span = to - frm
                n = min(400, max(5, int(span * bt / 90)))
                for k in range(n):
                    p = random.choice(cpools) if cpools else POOLS[0]
                    b = frm + random.randint(0, max(0, span))
                    logs.append(swap_log(p, b, k, addr_from(f"trader{k % 9}")))
        if (TOPIC_ADD in t0s or TOPIC_REMOVE in t0s) and len(topics) > 1 and topics[1] == wallet_topic:
            for k, p in enumerate(cpools[:2]):
                logs.append(liq_log(p, latest - 50_000 - k * 1000, salt=777 + k, bins=[-1, 0, 1], shares=[DEMO_SHARES] * 3, add=True, idx=k))
            if len(cpools) > 2:
                logs.append(liq_log(cpools[2], latest - 60_000, salt=999, bins=[0], shares=[DEMO_SHARES], add=True, idx=5))
                logs.append(liq_log(cpools[2], latest - 30_000, salt=999, bins=[0], shares=[DEMO_SHARES], add=False, idx=6))
        logs = [l for l in logs if frm <= int(l["blockNumber"], 16) <= to]
        return logs
    if method == "eth_call":
        data = params[0]["data"][2:]
        sel = data[:8]
        if sel == SEL["aggregate3"]:
            # decode (address,bool,bytes)[]
            body = data[8:]
            w = lambda i: int(body[i * 64:(i + 1) * 64], 16)
            arr = w(0) // 32
            n = w(arr)
            results = []
            for k in range(n):
                off = w(arr + 1 + k) // 32
                base = arr + 1 + off
                target = w(base)
                doff = w(base + 2) // 32
                dbase = base + doff
                ln = w(dbase)
                cd = body[(dbase + 1) * 64:(dbase + 1) * 64 + ln * 2]
                results.append(single_call(cd))
            # encode (bool,bytes)[]
            enc_tuples = []
            for ok, ret in results:
                r = ret[2:]
                enc_tuples.append(word(1 if ok else 0) + word(0x40) + word(len(r) // 2) + r.ljust(((len(r) + 63) // 64) * 64, "0"))
            offs = ""
            acc = n * 32
            for tpl in enc_tuples:
                offs += word(acc)
                acc += len(tpl) // 2
            return "0x" + word(0x20) + word(n) + offs + "".join(enc_tuples)
        ok, ret = single_call(data)
        return ret
    return {"__error__": {"code": -32601, "message": "method not found"}}


def single_call(cd: str):
    sel = cd[:8]
    args = cd[8:]
    w = lambda i: int(args[i * 64:(i + 1) * 64], 16)
    if sel == SEL["positionBinShares"]:
        pool = "0x" + args[24:64]
        owner = "0x" + args[64 + 24:128]
        salt = w(2)
        b = w(3)
        b = b - (1 << 256) if b >= (1 << 255) else b
        p = BY_ADDR.get(pool.lower())
        if not p or owner.lower() != DEMO_WALLET.lower():
            return True, "0x" + word(0)
        idx = [q for q in POOLS if q["chainId"] == p["chainId"]].index(p)
        if (idx in (0, 1) and salt == 777 + idx and b in (-1, 0, 1)) or (idx == 2 and salt == 999 and b == 0 and False):
            return True, "0x" + word(DEMO_SHARES)
        return True, "0x" + word(0)
    if sel == SEL["binTotalShares"]:
        return True, "0x" + word(DEMO_TOTAL)
    if sel == SEL["binState"]:
        pool = "0x" + args[24:64]
        p = BY_ADDR.get(pool.lower())
        d0, d1 = p["token0Decimals"], p["token1Decimals"]
        mx = max(18, d0, d1)
        # each bin holds $5,000 of token0 and $5,000 of token1 (scaled units)
        bal0 = int(5000 / p["token0FiatPrice"] * 10**mx)
        bal1 = int(5000 / p["token1FiatPrice"] * 10**mx)
        return True, "0x" + word(bal0) + word(bal1) + word(100) + word(0) + word(0)
    return False, "0x"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):  # quieter
        if "/public/v1" in str(args[0]) or "/rpc/" in str(args[0]):
            sys.stderr.write("%s\n" % (fmt % args))

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
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_POST(self):
        u = urlparse(self.path)
        ln = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(ln) or b"{}")
        if u.path.startswith("/rpc/"):
            cid = int(u.path.split("/")[2])
            if isinstance(body, list):
                out = []
                for r in body:
                    res = handle_rpc(cid, r)
                    out.append({"jsonrpc": "2.0", "id": r.get("id"), **({"error": res["__error__"]} if isinstance(res, dict) and "__error__" in res else {"result": res})})
                return self.send_json(out)
            res = handle_rpc(cid, body)
            if isinstance(res, dict) and "__error__" in res:
                return self.send_json({"jsonrpc": "2.0", "id": body.get("id"), "error": res["__error__"]})
            return self.send_json({"jsonrpc": "2.0", "id": body.get("id"), "result": res})
        return self.send_json({"error": "not found"}, 404)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        parts = [x for x in u.path.split("/") if x]
        if parts[:2] == ["public", "v1"]:
            rest = parts[2:]
            if rest == ["chains"]:
                return self.send_json([{"chainId": c, "name": CHAINS[c][0]} for c in CHAINS])
            if rest[:2] == ["evm", "metadata"] or (len(rest) == 3 and rest[0] == "evm" and rest[2] == "metadata"):
                chain_ids = [int(x) for x in q.get("chainIds", [""])[0].split(",") if x] if rest[1] == "metadata" else [int(rest[1])]
                pools = [p for p in POOLS if not chain_ids or p["chainId"] in chain_ids]
                if "addresses" in q:
                    want = {a.lower() for a in q["addresses"][0].split(",")}
                    pools = [p for p in pools if p["poolAddress"].lower() in want]
                offset = int(q.get("offset", ["0"])[0])
                count = min(500, int(q.get("count", ["50"])[0]))
                page = pools[offset:offset + count]
                nxt = offset + count if offset + count < len(pools) else None
                return self.send_json({"data": page, "total": len(pools), "nextOffset": nxt})
            if len(rest) == 4 and rest[0] == "evm" and rest[3] == "bid_ask":
                p = BY_ADDR.get(rest[2].lower())
                if not p:
                    return self.send_json({"error": f"Pair metadata not found for {rest[2]}"}, 404)
                mid = p["token0FiatPrice"] / p["token1FiatPrice"]
                bid = int(mid * 0.9995 * Q64)
                ask = int(mid * 1.0005 * Q64)
                d0, d1 = p["token0Decimals"], p["token1Decimals"]
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
                if p["priceProviderStatus"] != "healthy":
                    return self.send_json({"pair": p["pair"], "poolAddress": p["poolAddress"], "priceProviderStatus": p["priceProviderStatus"], "bidAdj": "0", "askAdj": str((1 << 128) - 1), "totalToken0Available": "0", "totalToken1Available": "0", "serverTs": NOW, "depth": {"bids": [], "asks": []}})
                return self.send_json({"pair": p["pair"], "poolAddress": p["poolAddress"], "priceProviderStatus": "healthy", "bidAdj": str(bid), "askAdj": str(ask), "totalToken0Available": str(12 * 10**d0), "totalToken1Available": str(int(12 * mid * 10**d1)), "serverTs": NOW, "depth": {"bids": bids, "asks": asks}})
            if len(rest) == 5 and rest[0] == "evm" and rest[3] == "analytics" and rest[4] == "bins":
                p = BY_ADDR.get(rest[2].lower())
                if not p:
                    return self.send_json({"error": "not found"}, 404)
                bins = []
                for b in range(-8, 9):
                    r0 = max(0, 6000 - abs(b) * 600) * random.uniform(0.7, 1.3)
                    r1 = max(0, 6000 - abs(b) * 600) * random.uniform(0.7, 1.3)
                    vol = max(0, 40000 - abs(b - p["curBinIdx"]) * 9000) * random.uniform(0.5, 1.5)
                    bins.append({"bin": str(b), "swapCount": str(int(vol / 1500)), "lengthE6": 10000, "token0": {"reserveFiat": round(r0, 2), "volumeFiat": round(vol / 2, 2), "lpFeesFiat": round(vol * 0.0001, 2), "avgLiquidityFiat": round(r0, 2)}, "token1": {"reserveFiat": round(r1, 2), "volumeFiat": round(vol / 2, 2), "lpFeesFiat": round(vol * 0.0001, 2), "avgLiquidityFiat": round(r1, 2)}, "aprBps": int(vol * 0.0002 / max(1, r0 + r1) * 52 * 1e4), "pnlAprBps": int(random.uniform(-3000, 3000))})
                return self.send_json({"pair": p["pair"], "chain": p["chain"], "period": "7d", "fiatAvailable": True, "fiatCurrency": "USD", "window": {"fromTs": NOW - 7 * 86400, "toTs": NOW}, "curBinIdx": p["curBinIdx"], "bins": bins})
            return self.send_json({"error": "not found"}, 404)
        return super().do_GET()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"mock server on http://localhost:{port}/?api=mock  (demo wallet {DEMO_WALLET})", file=sys.stderr)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

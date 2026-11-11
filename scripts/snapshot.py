#!/usr/bin/env python3
"""Metric Radar snapshot.

Fetches every pool on Metric's public chains from the keyless public API, writes:
  data/latest.json   - what the site renders first: full records of the active pools ("pools"), slim records of
                       the empty ones ("index", needed to attribute wallet activity), shared addresses ("chainMeta")
  data/history.json  - rolling time series: hourly + daily per chain, daily per pool

Run hourly by GitHub Actions (.github/workflows/snapshot.yml), which publishes both files to the `data` branch.
Standard library only. Field shapes mirror normalizePool() in assets/data.js: keep the two in sync.
"""
from __future__ import annotations

import collections
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get("METRIC_API_BASE", "https://api.metric.xyz/public/v1").rstrip("/")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
PUBLIC_CHAINS = [1, 56, 4663]

HOURLY_KEEP = 24 * 60  # 60 days of hourly points per chain
DAILY_KEEP = 400
POOL_DAILY_KEEP = 120
ACTIVE_MIN_TVL = 1.0  # below this a pool counts as empty
POOL_HISTORY_MIN_TVL = 1000.0  # per-pool series are kept for pools at or above this
SHARED_FIELDS = ("dataProvider", "quoter", "factory")  # identical for (nearly) every pool of a chain


def get(path: str, retries: int = 3) -> dict:
    url = API + path
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "metric-radar-snapshot/1.0 (+https://github.com/kriptolia/metric-radar)"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as e:  # noqa: PERF203
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v else None


def r2(v):
    return None if v is None else round(v, 2)


def normalize(raw: dict) -> dict:
    a = raw.get("analytics24h") or {}
    vw = raw.get("volumeByWindow") or {}
    cs = raw.get("classificationSummary") or {}
    mk = {}
    for w, wv in (raw.get("markoutByWindow") or {}).items():
        mk[w] = {}
        for hz, x in ((wv or {}).get("byHorizon") or {}).items():
            x = x or {}
            mk[w][hz] = {
                "usd": r2(num(x.get("markoutFiat"))),
                "aprBps": num(x.get("aprBps")),
                "priced": None if num(x.get("pricedVolumeShare")) is None else round(x["pricedVolumeShare"], 3),
                "tradedBins": num(x.get("tradedBins")),
                "fundedBins": num(x.get("fundedBins")),
                "tradedShare": None if num(x.get("tradedLiquidityShare")) is None else round(x["tradedLiquidityShare"], 3),
            }
    t0 = {"addr": raw.get("token0"), "sym": raw.get("token0Symbol") or "?", "name": raw.get("token0Name") or "", "dec": raw.get("token0Decimals", 18), "logo": raw.get("token0LogoUrl") or "", "color": raw.get("token0BrandColor") or "", "price": num(raw.get("token0FiatPrice"))}
    t1 = {"addr": raw.get("token1"), "sym": raw.get("token1Symbol") or "?", "name": raw.get("token1Name") or "", "dec": raw.get("token1Decimals", 18), "logo": raw.get("token1LogoUrl") or "", "color": raw.get("token1BrandColor") or "", "price": num(raw.get("token1FiatPrice"))}
    swaps = a.get("swapTxCount")
    try:
        swaps = int(swaps) if swaps is not None else None
    except (TypeError, ValueError):
        swaps = None
    return {
        "chainId": int(raw.get("chainId") or chain_id_from_name(raw.get("chain"))),
        "chain": raw.get("chain"),
        "address": raw.get("poolAddress"),
        "pair": raw.get("pair") or f"{t0['sym']}/{t1['sym']}",
        "t0": t0,
        "t1": t1,
        "tvl": r2(num(raw.get("tvlFiat", a.get("tvlFiat")))),
        "liq0": r2(num((a.get("token0") or {}).get("liquidityFiat"))),
        "liq1": r2(num((a.get("token1") or {}).get("liquidityFiat"))),
        "vol24": r2(num(a.get("volumeFiat", vw.get("24h")))),
        "vol7": r2(num(vw.get("7d"))),
        "vol30": r2(num(vw.get("30d"))),
        "volAll": r2(num(vw.get("all"))),
        "fees24": r2(num(a.get("feesFiat"))),
        "swaps24": swaps,
        "apr24Bps": num(a.get("aprBps")),
        "apr7Bps": num(raw.get("aprBps7d")),
        "pnlApr7Bps": num(raw.get("tradingPnlAprBps7d")),
        "markout": mk,
        "tier": cs.get("tierQualification") or "unclassified",
        "reasons": cs.get("reasonCodes") or [],
        "private": bool(raw.get("depositWhitelistingEnabled")),
        "verifiedAdmin": bool(raw.get("verifiedAdmin")),
        "admin": raw.get("admin"),
        "adminName": raw.get("adminUsername"),
        "creator": raw.get("creator"),
        "protocolFeeE6": num(raw.get("spreadProtocolFeeE6")),
        "adminFeeE6": num(raw.get("spreadAdminFeeE6")),
        "protocolNotionalE8": num(raw.get("protocolNotionalFeeE8")),
        "adminNotionalE8": num(raw.get("adminNotionalFeeE8")),
        "ppStatus": raw.get("priceProviderStatus") or "unknown",
        "ppAddress": raw.get("priceProviderAddress"),
        "ppDetails": raw.get("priceProviderDetails"),
        "locked": bool(raw.get("lockedPricing")),
        "cooldown": None if raw.get("priceProviderCooldownSecs") is None else str(raw.get("priceProviderCooldownSecs")),
        "pauseLevel": raw.get("pauseLevel", 0),
        "curBinIdx": raw.get("curBinIdx"),
        "created": num(raw.get("createdTimestamp")),
        "createdBlock": num(raw.get("createdBlockNumber")),
        "extensions": raw.get("extensions") or [],
        "extDetails": raw.get("extensionDetails"),
        "dataProvider": raw.get("dataProviderAddress"),
        "quoter": raw.get("quoterAddress"),
        "factory": raw.get("poolFactoryAddress"),
    }


CHAIN_NAMES = {"ethereum": 1, "bsc": 56, "bnb": 56, "robinhood": 4663}


def chain_id_from_name(name):
    return CHAIN_NAMES.get((name or "").lower(), 0)


def fetch_chains() -> list[int]:
    try:
        r = get("/chains")
        items = r if isinstance(r, list) else r.get("data") or r.get("chains") or []
        ids = []
        for it in items:
            cid = it.get("chainId") if isinstance(it, dict) else it
            try:
                ids.append(int(cid))
            except (TypeError, ValueError):
                pass
        ids = [i for i in ids if i in PUBLIC_CHAINS] or PUBLIC_CHAINS
        return ids
    except Exception as e:  # noqa: BLE001
        print(f"warn: /chains failed ({e}); using defaults", file=sys.stderr)
        return PUBLIC_CHAINS


def fetch_pools(chain_ids: list[int]) -> list[dict]:
    out = []
    for cid in chain_ids:
        offset = 0
        pages = 0
        while offset is not None and pages < 20:
            r = get(f"/evm/{cid}/metadata?include24h=true&count=500&sortBy=tvl&minTvlFiat=0&offset={offset}")
            for raw in r.get("data") or []:
                raw.setdefault("chainId", cid)
                out.append(normalize(raw))
            offset = r.get("nextOffset")
            pages += 1
        count = sum(1 for p in out if p["chainId"] == cid)
        print(f"chain {cid}: {count} pools", file=sys.stderr)
        if not count:
            # an outage that answers with an empty list must not be recorded as "this chain has no pools"
            raise RuntimeError(f"chain {cid} returned no pools; keeping the previous snapshot")
    return out


def is_active(p: dict) -> bool:
    """Funded, or traded recently: these get a full record. Most pools ever created are empty shells."""
    return (p.get("tvl") or 0) >= ACTIVE_MIN_TVL or (p.get("vol7") or 0) > 0 or (p.get("swaps24") or 0) > 0


def chain_meta(pools: list[dict]) -> dict:
    """Most common helper-contract addresses per chain, so pool records only carry the exceptions."""
    meta = {}
    for cid in sorted({p["chainId"] for p in pools}):
        entry = {}
        for field in SHARED_FIELDS:
            counts = collections.Counter(p[field] for p in pools if p["chainId"] == cid and p.get(field))
            entry[field] = counts.most_common(1)[0][0] if counts else None
        meta[str(cid)] = entry
    return meta


def without_shared(p: dict, meta: dict) -> dict:
    shared = meta.get(str(p["chainId"])) or {}
    return {k: v for k, v in p.items() if not (k in SHARED_FIELDS and v == shared.get(k))}


def slim(p: dict, meta: dict) -> dict:
    """What the site needs from an empty pool: identity, decimals/prices to value a wallet's activity, and totals."""

    def tok(t):
        return {"addr": t["addr"], "sym": t["sym"], "dec": t["dec"], "price": t["price"]}

    out = {
        "chainId": p["chainId"],
        "address": p["address"],
        "pair": p["pair"],
        "t0": tok(p["t0"]),
        "t1": tok(p["t1"]),
        "tvl": p["tvl"],
        "tier": p["tier"],
        "private": p["private"],
        "verifiedAdmin": p["verifiedAdmin"],
        "ppStatus": p["ppStatus"],
        "curBinIdx": p["curBinIdx"],
        "created": p["created"],
        "createdBlock": p["createdBlock"],
        "vol30": p["vol30"],
        "volAll": p["volAll"],
    }
    shared = meta.get(str(p["chainId"])) or {}
    for field in SHARED_FIELDS:
        if p.get(field) and p[field] != shared.get(field):
            out[field] = p[field]
    return out


def load_history(path) -> dict:
    """A missing file starts a new history; an unreadable one aborts the run instead of silently replacing months of data."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        history = json.load(f)
    if not isinstance(history, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return history


def dump_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
    os.replace(tmp, path)


def day_key(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d")


def roll_history(history: dict, pools: list[dict], now: int) -> dict:
    hourly = history.setdefault("hourly", {})
    daily = history.setdefault("daily", {})
    per_pool = history.setdefault("pools", {})
    live = [p for p in pools if p.get("tier") != "black"]
    for cid in sorted({p["chainId"] for p in live}):
        cp = [p for p in live if p["chainId"] == cid]
        funded = sum(1 for p in cp if (p["tvl"] or 0) >= ACTIVE_MIN_TVL)
        point = [now, r2(sum(p["tvl"] or 0 for p in cp)), r2(sum(p["vol24"] or 0 for p in cp)), funded, sum(p["swaps24"] or 0 for p in cp)]
        key = str(cid)
        series = hourly.setdefault(key, [])
        series.append(point)
        del series[:-HOURLY_KEEP]
        d = daily.setdefault(key, [])
        if d and day_key(d[-1][0]) == day_key(now):
            d[-1] = point  # last snapshot of the day wins
        else:
            d.append(point)
        del d[:-DAILY_KEEP]
    for p in live:
        if (p["tvl"] or 0) < POOL_HISTORY_MIN_TVL:
            continue
        key = f"{p['chainId']}:{p['address'].lower()}"
        mk = ((p.get("markout") or {}).get("7d") or {}).get("5m") or {}
        point = [now, p["tvl"], p["vol24"], p["apr7Bps"], mk.get("aprBps"), p["swaps24"]]
        s = per_pool.setdefault(key, [])
        if s and day_key(s[-1][0]) == day_key(now):
            s[-1] = point
        else:
            s.append(point)
        del s[:-POOL_DAILY_KEEP]
    # drop pools that vanished from the API more than 60 days ago
    cutoff = now - 60 * 86400
    for key in list(per_pool.keys()):
        if per_pool[key] and per_pool[key][-1][0] < cutoff:
            del per_pool[key]
    history["updatedAt"] = now
    return history


def main() -> int:
    now = int(time.time())
    chain_ids = fetch_chains()
    pools = fetch_pools(chain_ids)
    if not pools:
        print("no pools fetched; keeping previous files", file=sys.stderr)
        return 1
    os.makedirs(DATA, exist_ok=True)
    history = roll_history(load_history(os.path.join(DATA, "history.json")), pools, now)
    meta = chain_meta(pools)
    active = [without_shared(p, meta) for p in pools if is_active(p)]
    index = [slim(p, meta) for p in pools if not is_active(p)]
    latest = {"v": 2, "generatedAt": now, "chains": chain_ids, "chainMeta": meta, "pools": active, "index": index, "source": API}
    dump_json(os.path.join(DATA, "latest.json"), latest)
    dump_json(os.path.join(DATA, "history.json"), history)
    print(f"ok: {len(active)} active + {len(index)} empty pools, generatedAt={now}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

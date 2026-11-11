/* Metric Radar — data layer: hourly snapshot (data branch) + Metric public API, plus chain logs for the trade feed. */
(function () {
  "use strict";
  const MR = (window.MR = window.MR || {});

  // ---------- configuration ----------
  // Endpoint limits below were measured from a browser on 2026-11-11. Public endpoints change their rules without
  // notice; when one stops working the trade feed falls back to the next entry, then to Metric's own activity API.
  const DEFAULTS = {
    apiBase: "https://api.metric.xyz/public/v1",
    // latest.json + history.json are published hourly to this repo's `data` branch by .github/workflows/snapshot.yml
    dataBase: "https://raw.githubusercontent.com/kriptolia/metric-radar/data",
    referralCode: "", // set your Metric referral code (app.metric.xyz/referrals) to link pools through it
    chains: {
      // logRpc: JSON-RPC endpoints that allow browser calls and serve eth_getLogs, with the largest address list and
      //         block span each accepts per request.
      // explorerApi: REST API of an indexed explorer (Blockscout v2). Lists the transactions an address sent; allows
      //         about 150 requests a minute per visitor. Used for a wallet's swap history.
      // logsApi: the same explorer's Etherscan-compatible log API. Topic-only queries, but about 10 requests per hour
      //         per visitor, and on Robinhood Chain it only reaches back about a week: a supplement, never the source.
      1: {
        name: "Ethereum", short: "ETH", blockTime: 12, explorer: "https://etherscan.io",
        explorerApi: "https://eth.blockscout.com/api/v2",
        logsApi: "https://eth.blockscout.com/api",
        logRpc: [
          { url: "https://rpc.mevblocker.io", maxAddrs: 40, maxRange: 5000 },
          { url: "https://ethereum-rpc.publicnode.com", maxAddrs: 10, maxRange: 5000 },
        ],
      },
      56: {
        name: "BNB Chain", short: "BNB", blockTime: 0.45, explorer: "https://bscscan.com",
        explorerApi: null, // no keyless indexed explorer for BNB Chain
        logsApi: null,
        logRpc: [{ url: "https://bsc-rpc.publicnode.com", maxAddrs: 10, maxRange: 5000 }],
      },
      4663: {
        name: "Robinhood Chain", short: "Robinhood", blockTime: 0.1, explorer: "https://robin.etherscan.io",
        explorerApi: "https://robinhoodchain.blockscout.com/api/v2",
        logsApi: "https://robinhoodchain.blockscout.com/api",
        logRpc: [{ url: "https://rpc.mainnet.chain.robinhood.com", maxAddrs: 100, maxRange: 100000 }],
      },
    },
    swapTopic: "0x9734819749a91fc3be03ea83205f924ee08479bd3f0da48efc91d94d050cac1e",
  };
  const CUSTOM_RPC_LIMITS = { maxAddrs: 10, maxRange: 2000 }; // conservative: fits every public endpoint tested

  function loadSettings() {
    try {
      const raw = localStorage.getItem("mr.settings");
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function saveSettings(s) {
    try {
      localStorage.setItem("mr.settings", JSON.stringify(s));
    } catch (e) {
      /* storage unavailable: settings live for this page only */
    }
  }
  const settings = loadSettings();
  // ?api=mock points everything at scripts/dev_mock.py on the same origin; ?api=<url> overrides the API base;
  // ?data=local reads data/latest.json next to the page, ?data=<url> reads another snapshot location.
  const query = new URLSearchParams(location.search);
  const apiParam = query.get("api");
  const dataParam = query.get("data");
  const mock = apiParam === "mock";
  function defaultDataBase() {
    // on GitHub Pages, follow the repo the page is served from, so forks read their own data branch
    const m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
    const repo = location.pathname.split("/").filter(Boolean)[0];
    return m && repo ? `https://raw.githubusercontent.com/${m[1]}/${repo}/data` : DEFAULTS.dataBase;
  }
  const chains = {};
  for (const id of Object.keys(DEFAULTS.chains)) {
    const c = { ...DEFAULTS.chains[id] };
    if (mock) {
      c.logRpc = [{ url: location.origin + "/rpc/" + id, maxAddrs: 4, maxRange: 20000 }];
      c.logsApi = c.logsApi ? location.origin + "/explorer/" + id + "/api" : null;
      c.explorerApi = c.explorerApi ? location.origin + "/explorer/" + id + "/api/v2" : null;
    } else {
      // v1 saved its whole default list here; those entries either refuse browsers or do not serve logs
      const dead = /rpc\.metric\.xyz|llamarpc\.com|bsc-dataseed/;
      const custom = ((settings.rpc && settings.rpc[id]) || []).filter((u) => /^https?:\/\//.test(u) && !dead.test(u) && !c.logRpc.some((e) => e.url === u));
      c.logRpc = custom.map((url) => ({ url, ...CUSTOM_RPC_LIMITS })).concat(c.logRpc);
    }
    chains[id] = c;
  }
  const CONFIG = {
    ...DEFAULTS,
    chains,
    apiBase: (mock ? location.origin + "/public/v1" : apiParam || settings.apiBase || DEFAULTS.apiBase).replace(/\/+$/, ""),
    dataBase: (mock || dataParam === "local" ? "data" : dataParam || defaultDataBase()).replace(/\/+$/, ""),
    mock,
  };
  MR.config = CONFIG;
  MR.settings = { get: () => loadSettings(), set: (s) => saveSettings(s) };
  MR.logEndpoints = (chainId) => CONFIG.chains[chainId].logRpc.slice();
  const CHAIN_IDS = Object.keys(CONFIG.chains).map(Number);

  // ---------- small utils ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function fetchJson(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || 25000);
    try {
      const res = await fetch(url, { ...(opts || {}), signal: ctrl.signal });
      if (!res.ok) {
        let msg = res.status + " " + res.statusText;
        try {
          const t = await res.text();
          msg += ": " + t.slice(0, 200);
        } catch (e) {
          /* ignore */
        }
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
  /** Runs fn over items with at most `limit` in flight; results keep the input order. Rejects on the first failure. */
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }
  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
  MR.util = { sleep, fetchJson, mapLimit };
  const poolKey = (p) => p.chainId + ":" + String(p.address).toLowerCase();
  MR.poolKey = poolKey;

  // ---------- normalization (shared with scripts/snapshot.py: keep shapes in sync) ----------
  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }
  function normalizePool(raw, chainId) {
    const a = raw.analytics24h || {};
    const vw = raw.volumeByWindow || {};
    const cs = raw.classificationSummary || {};
    const mk = {};
    if (raw.markoutByWindow) {
      for (const w of Object.keys(raw.markoutByWindow)) {
        const bh = (raw.markoutByWindow[w] && raw.markoutByWindow[w].byHorizon) || {};
        mk[w] = {};
        for (const h of Object.keys(bh)) {
          const x = bh[h] || {};
          mk[w][h] = { usd: num(x.markoutFiat), aprBps: num(x.aprBps), priced: num(x.pricedVolumeShare), tradedBins: num(x.tradedBins), fundedBins: num(x.fundedBins), tradedShare: num(x.tradedLiquidityShare) };
        }
      }
    }
    return {
      // the multi-chain listing carries a chain name but no chain id: callers pass the id of the endpoint they asked
      chainId: Number(chainId != null ? chainId : raw.chainId),
      chain: raw.chain,
      address: raw.poolAddress,
      pair: raw.pair || ((raw.token0Symbol || "?") + "/" + (raw.token1Symbol || "?")),
      t0: { addr: raw.token0, sym: raw.token0Symbol || "?", name: raw.token0Name || "", dec: raw.token0Decimals != null ? raw.token0Decimals : 18, logo: raw.token0LogoUrl || "", color: raw.token0BrandColor || "", price: num(raw.token0FiatPrice) },
      t1: { addr: raw.token1, sym: raw.token1Symbol || "?", name: raw.token1Name || "", dec: raw.token1Decimals != null ? raw.token1Decimals : 18, logo: raw.token1LogoUrl || "", color: raw.token1BrandColor || "", price: num(raw.token1FiatPrice) },
      tvl: num(raw.tvlFiat != null ? raw.tvlFiat : a.tvlFiat),
      liq0: num(a.token0 && a.token0.liquidityFiat),
      liq1: num(a.token1 && a.token1.liquidityFiat),
      vol24: num(a.volumeFiat != null ? a.volumeFiat : vw["24h"]),
      vol7: num(vw["7d"]),
      vol30: num(vw["30d"]),
      volAll: num(vw.all),
      fees24: num(a.feesFiat),
      swaps24: num(Number(a.swapTxCount)),
      apr24Bps: num(a.aprBps),
      apr7Bps: num(raw.aprBps7d),
      pnlApr7Bps: num(raw.tradingPnlAprBps7d),
      markout: mk,
      tier: cs.tierQualification || "unclassified",
      reasons: cs.reasonCodes || [],
      private: !!raw.depositWhitelistingEnabled,
      verifiedAdmin: !!raw.verifiedAdmin,
      admin: raw.admin || null,
      adminName: raw.adminUsername || null,
      creator: raw.creator || null,
      protocolFeeE6: num(raw.spreadProtocolFeeE6),
      adminFeeE6: num(raw.spreadAdminFeeE6),
      protocolNotionalE8: num(raw.protocolNotionalFeeE8),
      adminNotionalE8: num(raw.adminNotionalFeeE8),
      ppStatus: raw.priceProviderStatus || "unknown",
      ppAddress: raw.priceProviderAddress || null,
      ppDetails: raw.priceProviderDetails || null,
      locked: !!raw.lockedPricing,
      cooldown: raw.priceProviderCooldownSecs != null ? String(raw.priceProviderCooldownSecs) : null,
      pauseLevel: raw.pauseLevel != null ? raw.pauseLevel : 0,
      curBinIdx: raw.curBinIdx != null ? raw.curBinIdx : null,
      created: num(raw.createdTimestamp),
      createdBlock: num(raw.createdBlockNumber),
      extensions: raw.extensions || [],
      extDetails: raw.extensionDetails || null,
      dataProvider: raw.dataProviderAddress || null,
      quoter: raw.quoterAddress || null,
      factory: raw.poolFactoryAddress || null,
    };
  }
  MR.normalizePool = normalizePool;
  /** Snapshot records (especially the slim index entries) omit fields the views iterate over. */
  function hydrate(p, chainMeta, slim) {
    if (!p.reasons) p.reasons = [];
    if (!p.extensions) p.extensions = [];
    if (!p.markout) p.markout = {};
    if (!p.t0) p.t0 = { sym: "?", dec: 18 };
    if (!p.t1) p.t1 = { sym: "?", dec: 18 };
    if (slim) p.slim = true;
    const meta = chainMeta && chainMeta[p.chainId];
    if (meta) {
      if (!p.dataProvider) p.dataProvider = meta.dataProvider || null;
      if (!p.quoter) p.quoter = meta.quoter || null;
      if (!p.factory) p.factory = meta.factory || null;
    }
    return p;
  }

  // ---------- Metric API ----------
  const api = {
    base: () => CONFIG.apiBase,
    async get(path, ms) {
      return fetchJson(CONFIG.apiBase + path, { headers: { Accept: "application/json" } }, ms || 25000);
    },
    /** One chain's pools at or above minTvl USD, largest first. */
    async chainPools(chainId, minTvl) {
      const out = [];
      let offset = 0;
      for (let page = 0; page < 10 && offset !== null; page++) {
        const r = await this.get(`/evm/${chainId}/metadata?include24h=true&count=500&sortBy=tvl&minTvlFiat=${minTvl}&offset=${offset}`);
        for (const raw of r.data || []) out.push(normalizePool(raw, chainId));
        offset = r.nextOffset == null ? null : r.nextOffset;
      }
      return out;
    },
    /** Funded pools (TVL >= $1) on every chain. Empty pools come from the hourly snapshot instead: there are ~4x as many. */
    async fundedPools() {
      const lists = await Promise.all(CHAIN_IDS.map((id) => this.chainPools(id, 1)));
      return lists.flat();
    },
    async poolMeta(chainId, address) {
      const r = await this.get(`/evm/${chainId}/metadata?include24h=true&addresses=${address}&minTvlFiat=0`);
      return r.data && r.data[0] ? normalizePool(r.data[0], chainId) : null;
    },
    async bidAsk(chainId, address) {
      return this.get(`/evm/${chainId}/${address}/bid_ask`);
    },
    // The three calls below are what app.metric.xyz itself uses; they are not in the published API reference.
    async bins(chainId, address, period) {
      return this.get(`/evm/${chainId}/${address}/analytics/bins?contract_version=v1&period=${period || "7d"}`);
    },
    /** Open LP positions of a wallet, with performance per period. */
    async positions(chainId, wallet) {
      return this.get(`/evm/${chainId}/positions/${wallet}?periods=24h,7d,30d,all&fiat=USD`, 30000);
    },
    /** A pool's latest swaps and liquidity events, newest first (limit 1..300). */
    async activity(chainId, address, limit) {
      return this.get(`/evm/${chainId}/${address}/activity?period=24h&limit=${limit || 100}`);
    },
  };
  MR.api = api;

  // ---------- dataset: snapshot first (fast, always there), then a live refresh of the funded pools ----------
  /** Returns { pools (full records), index (slim records of empty pools), history, generatedAt, chainMeta, error }. */
  MR.loadSnapshot = async function loadSnapshot() {
    const bucket = Math.floor(Date.now() / 300000);
    const urls = [CONFIG.dataBase + "/latest.json?t=" + bucket];
    if (CONFIG.dataBase !== "data") urls.push("data/latest.json?t=" + bucket); // optional copy next to the page
    const historyP = fetchJson(CONFIG.dataBase + "/history.json?t=" + bucket, {}, 20000).catch(() => null);
    let snap = null;
    let err = null;
    for (const u of urls) {
      try {
        snap = await fetchJson(u, {}, 25000);
        break;
      } catch (e) {
        err = e;
      }
    }
    const history = await historyP;
    if (!snap || !Array.isArray(snap.pools)) return { pools: [], index: [], history, generatedAt: null, chainMeta: {}, error: String(err && err.message ? err.message : err || "empty snapshot") };
    const meta = snap.chainMeta || {};
    return {
      pools: snap.pools.map((p) => hydrate(p, meta, false)),
      index: (snap.index || []).map((p) => hydrate(p, meta, true)),
      history,
      generatedAt: snap.generatedAt || null,
      chainMeta: meta,
      error: null,
    };
  };
  /** Replaces/extends the snapshot's pools with current API values. Throws if the API is unreachable. */
  MR.refreshLive = async function refreshLive(data) {
    const live = await api.fundedPools();
    if (!live.length) throw new Error("empty live response");
    const byKey = new Map(data.pools.map((p) => [poolKey(p), p]));
    const fresh = new Set();
    for (const p of live) {
      hydrate(p, data.chainMeta, false);
      byKey.set(poolKey(p), p);
      fresh.add(poolKey(p));
    }
    return { ...data, pools: [...byKey.values()], index: data.index.filter((p) => !fresh.has(poolKey(p))), liveAt: Date.now() / 1000 };
  };

  // ---------- hex / ABI helpers (BigInt) ----------
  const MASK128 = (1n << 128n) - 1n;
  function hexToBig(h) {
    return h ? BigInt(h) : 0n;
  }
  function word(hexData, i) {
    // i-th 32-byte word of 0x-prefixed data
    return BigInt("0x" + hexData.slice(2 + i * 64, 2 + (i + 1) * 64));
  }
  function toSigned(v, bits) {
    const b = BigInt(bits);
    const lim = 1n << (b - 1n);
    const mask = (1n << b) - 1n;
    v = v & mask;
    return v >= lim ? v - (1n << b) : v;
  }
  function padAddress(addr) {
    return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  }
  function fmtUnits(big, dec) {
    // BigInt raw -> Number in whole units (adequate for display)
    const neg = big < 0n;
    const v = neg ? -big : big;
    const s = v.toString().padStart(dec + 1, "0");
    const int = s.slice(0, s.length - dec) || "0";
    const frac = s.slice(s.length - dec);
    const n = Number(int + "." + frac);
    return neg ? -n : n;
  }
  function toBig(v) {
    try {
      return BigInt(v);
    } catch (e) {
      return null;
    }
  }
  const hexBlock = (n) => "0x" + n.toString(16);
  MR.abi = { hexToBig, word, toSigned, padAddress, fmtUnits };

  // ---------- swap decoding ----------
  function logTs(log) {
    const v = log.timeStamp || log.blockTimestamp; // explorers send timeStamp, most RPC nodes blockTimestamp
    const n = v ? Number(hexToBig(v)) : 0;
    return n > 0 ? n : null; // Robinhood Chain's RPC fills the field with "0x0": that is a missing value
  }
  /**
   * Pool event Swap(sender, recipient, details, deltas, fees).
   * details: bit 120 exact-input flag, bits 104..119 the bin index (int16), low 104 bits the position inside the bin.
   * deltas: two int128 in token units, token0 then token1; positive = the pool received it.
   */
  function decodeSwapLog(log) {
    const topics = log.topics || [];
    if ((topics[0] || "").toLowerCase() !== CONFIG.swapTopic || !topics[1] || !topics[2] || !log.data || log.data.length < 2 + 3 * 64) return null;
    try {
      const details = word(log.data, 0);
      const deltas = word(log.data, 1);
      return {
        pool: String(log.address).toLowerCase(),
        sender: "0x" + topics[1].slice(-40),
        recipient: "0x" + topics[2].slice(-40),
        exactInput: ((details >> 120n) & 1n) === 1n,
        binIdx: Number(toSigned(details >> 104n, 16)),
        delta0: toSigned(deltas >> 128n, 128),
        delta1: toSigned(deltas & MASK128, 128),
        block: Number(hexToBig(log.blockNumber)),
        ts: logTs(log),
        tx: log.transactionHash,
        logIndex: Number(hexToBig(log.logIndex || "0x0")),
      };
    } catch (e) {
      return null;
    }
  }
  /** Adds amounts, direction and USD to a decoded swap, using the pool's tokens. */
  function describeSwap(s, pool) {
    const zeroForOne = s.delta0 > 0n; // the pool received token0 → the trader sold token0
    const tokIn = zeroForOne ? pool.t0 : pool.t1;
    const tokOut = zeroForOne ? pool.t1 : pool.t0;
    const amountIn = fmtUnits(zeroForOne ? s.delta0 : s.delta1, tokIn.dec);
    const amountOut = fmtUnits(zeroForOne ? -s.delta1 : -s.delta0, tokOut.dec);
    let usd = null;
    if (tokIn.price != null) usd = amountIn * tokIn.price;
    else if (tokOut.price != null) usd = amountOut * tokOut.price;
    return { ...s, side: zeroForOne ? "sell" : "buy", tokIn, tokOut, amountIn, amountOut, usd, pair: pool.pair, chainId: pool.chainId };
  }
  /** Same record from an item of the activity API (which has fiat amounts but no trader addresses). */
  function describeActivity(item, pool) {
    const d0 = toBig(item.amount0Raw);
    const d1 = toBig(item.amount1Raw);
    if (d0 === null || d1 === null) return null;
    const s = describeSwap({ pool: pool.address.toLowerCase(), sender: null, recipient: null, delta0: d0, delta1: d1, block: Number(item.blockNumber), ts: Number(item.timestamp), tx: item.txHash, logIndex: Number(item.logIndex) }, pool);
    if (num(item.totalFiat) != null) s.usd = item.totalFiat;
    return s;
  }
  MR.decode = { swap: decodeSwapLog };
  MR.describeSwap = describeSwap;
  MR.describeActivity = describeActivity;
  const bySwapOrder = (a, b) => b.block - a.block || b.logIndex - a.logIndex;

  // ---------- trade feed ----------
  async function rpcCall(url, method, params, ms) {
    const res = await fetchJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, ms || 20000);
    if (res.error) {
      const err = new Error(res.error.message || "rpc error");
      err.rpcError = res.error;
      throw err;
    }
    return res.result;
  }
  MR.rpcCall = rpcCall;
  /** Swap logs of `addresses` in [fromBlock, toBlock] from one endpoint, newest range first, within its limits. */
  async function swapLogs(ep, addresses, fromBlock, toBlock, opts) {
    const groups = chunk(addresses, ep.maxAddrs);
    const maxLogs = opts.maxLogs || 15000;
    const logs = [];
    let hi = toBlock;
    let calls = 0;
    while (hi >= fromBlock) {
      const lo = Math.max(fromBlock, hi - ep.maxRange + 1);
      const parts = await mapLimit(groups, 4, async (group) => {
        const filter = { address: group, topics: [CONFIG.swapTopic], fromBlock: hexBlock(lo), toBlock: hexBlock(hi) };
        try {
          return await rpcCall(ep.url, "eth_getLogs", [filter], 30000);
        } catch (e) {
          await sleep(700); // public endpoints shed load now and then: one retry before giving up on this endpoint
          return rpcCall(ep.url, "eth_getLogs", [filter], 30000);
        }
      });
      calls += groups.length;
      for (const part of parts) for (const l of part) logs.push(l);
      hi = lo - 1;
      opts.onProgress && opts.onProgress({ logs: logs.length, calls });
      if (logs.length >= maxLogs && hi >= fromBlock) return { logs, complete: false, coveredFrom: hi + 1, calls };
    }
    return { logs, complete: true, coveredFrom: fromBlock, calls };
  }

  const feedCache = {}; // chainId -> { key, endpoint, from, to, swaps, complete }
  const feedInflight = {}; // "chainId:seconds" -> promise, so the overview strip and the trade tab never fetch the same window twice
  const FEED_KEEP_SECONDS = 3 * 3600;
  /**
   * Swaps on one chain during the last `seconds` (at most 3 hours).
   * pools: the chain's pool records; only those with trades in the last 24h are queried.
   * Returns { swaps (newest first), source: "rpc" | "api", complete, from, to, poolsCovered, poolsTotal }.
   * A repeated call fetches only the blocks added since the previous one.
   */
  MR.recentSwaps = function recentSwaps(chainId, pools, seconds, opts) {
    const k = chainId + ":" + seconds;
    if (!feedInflight[k]) {
      feedInflight[k] = loadSwaps(chainId, pools, seconds, opts).finally(() => {
        delete feedInflight[k];
      });
    }
    return feedInflight[k];
  };
  async function blockTimestamp(url, block) {
    try {
      const b = await rpcCall(url, "eth_getBlockByNumber", [typeof block === "number" ? hexBlock(block) : block, false], 12000);
      const ts = b ? Number(hexToBig(b.timestamp)) : 0;
      return ts > 0 ? { number: Number(hexToBig(b.number)), ts } : null;
    } catch (e) {
      return null;
    }
  }
  /** Gives swaps without a timestamp one, by interpolating between two blocks whose timestamps are known. */
  function stampSwaps(swaps, b0, t0, b1, t1, blockTime) {
    for (const s of swaps) {
      if (s.ts != null) continue;
      s.ts = t0 != null && b1 > b0 ? t0 + ((s.block - b0) * (t1 - t0)) / (b1 - b0) : t1 - (b1 - s.block) * blockTime;
    }
    return swaps;
  }
  async function loadSwaps(chainId, pools, seconds, opts) {
    const o = opts || {};
    const cfg = CONFIG.chains[chainId];
    const targets = pools.filter((p) => (p.swaps24 || 0) > 0 || (p.vol24 || 0) > 0).sort((a, b) => (b.swaps24 || 0) - (a.swaps24 || 0));
    if (!targets.length) return { swaps: [], source: "rpc", complete: true, from: null, to: null, poolsCovered: 0, poolsTotal: 0 };
    const byAddr = new Map(targets.map((p) => [p.address.toLowerCase(), p]));
    const addresses = [...byAddr.keys()];
    const key = targets.length + ":" + targets[0].address.toLowerCase();
    const decodeAll = (logs) => {
      const out = [];
      for (const l of logs) {
        const pool = byAddr.get(String(l.address).toLowerCase());
        const s = pool && decodeSwapLog(l);
        if (s) out.push(describeSwap(s, pool));
      }
      return out;
    };

    let lastErr = null;
    for (const ep of cfg.logRpc) {
      try {
        const head = await blockTimestamp(ep.url, "latest");
        if (!head || !(head.number > 0)) throw new Error("no head block from " + ep.url);
        const tip = head.number;
        const since = head.ts - seconds; // measured on the chain's clock, not the visitor's
        let wantFrom = Math.max(0, tip - Math.ceil((seconds / cfg.blockTime) * 1.1) - 5);
        const cached = feedCache[chainId];
        const reuse = !!cached && cached.key === key && cached.endpoint === ep.url && cached.complete && cached.from <= wantFrom && cached.to <= tip && cached.to >= wantFrom;
        let entry;
        if (reuse) {
          const r = cached.to < tip ? await swapLogs(ep, addresses, cached.to + 1, tip, o) : { logs: [], complete: true };
          const seen = new Set(cached.swaps.map((s) => s.tx + ":" + s.logIndex));
          const added = stampSwaps(decodeAll(r.logs), cached.to, cached.toTs, tip, head.ts, cfg.blockTime).filter((s) => !seen.has(s.tx + ":" + s.logIndex));
          const keepFrom = head.ts - FEED_KEEP_SECONDS;
          entry = { key, endpoint: ep.url, from: cached.from, to: tip, toTs: head.ts, complete: r.complete, swaps: added.concat(cached.swaps).filter((s) => s.ts >= keepFrom).sort(bySwapOrder) };
        } else {
          // Block times drift (Robinhood Chain makes blocks on demand): if the first block of the estimated range is
          // younger than the window, size the range again from the pace actually observed.
          let first = await blockTimestamp(ep.url, wantFrom);
          if (first && first.ts > since && tip > wantFrom) {
            const perBlock = (head.ts - first.ts) / (tip - wantFrom);
            wantFrom = Math.max(0, tip - Math.ceil((seconds / perBlock) * 1.1) - 5);
            first = await blockTimestamp(ep.url, wantFrom);
          }
          const r = await swapLogs(ep, addresses, wantFrom, tip, o);
          entry = { key, endpoint: ep.url, from: r.coveredFrom, to: tip, toTs: head.ts, complete: r.complete, swaps: stampSwaps(decodeAll(r.logs), wantFrom, first ? first.ts : null, tip, head.ts, cfg.blockTime).sort(bySwapOrder) };
        }
        feedCache[chainId] = entry;
        return { swaps: entry.swaps.filter((s) => s.ts >= since), source: "rpc", complete: entry.complete, from: Math.max(entry.from, wantFrom), to: tip, asOf: head.ts, poolsCovered: targets.length, poolsTotal: targets.length };
      } catch (e) {
        lastErr = e;
      }
    }

    // No chain endpoint answered: read the busiest pools' activity from Metric's API instead (trader addresses are not in it).
    const since = Date.now() / 1000 - seconds;
    const top = targets.slice(0, o.apiPools || 8);
    const limit = seconds <= 900 ? 60 : seconds <= 3600 ? 150 : 300;
    const lists = await mapLimit(top, 4, (p) => api.activity(chainId, p.address, limit).then((r) => ({ p, r }), () => null));
    const ok = lists.filter(Boolean);
    if (!ok.length) throw lastErr || new Error("trade feed unavailable");
    const swaps = [];
    for (const { p, r } of ok) {
      for (const it of r.items || []) {
        if (it.kind !== "swap" || !(Number(it.timestamp) >= since)) continue;
        const s = describeActivity(it, p);
        if (s) swaps.push(s);
      }
    }
    return { swaps: swaps.sort(bySwapOrder), source: "api", complete: false, from: null, to: null, poolsCovered: ok.length, poolsTotal: targets.length };
  }

  // ---------- explorer logs (wallet swap history) ----------
  /**
   * Etherscan-compatible getLogs on the chain's explorer. q: { fromBlock, toBlock?, address?, topic0, topic1?, topic2? }.
   * The API returns at most 1,000 logs, oldest first; this pages forward by block. Returns { logs, complete }.
   * Errors carry .rateLimited when the explorer's hourly allowance is used up.
   */
  async function explorerLogs(chainId, q, opts) {
    const base = CONFIG.chains[chainId].logsApi;
    if (!base) throw new Error("no explorer log API for chain " + chainId);
    const maxPages = (opts && opts.maxPages) || 2;
    const out = [];
    const seen = new Set();
    let from = Math.max(0, q.fromBlock || 0);
    let complete = true;
    for (let page = 0; page < maxPages; page++) {
      const p = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: String(from), toBlock: String(q.toBlock != null ? q.toBlock : 999999999), topic0: q.topic0 });
      if (q.address) p.set("address", q.address);
      if (q.topic1) {
        p.set("topic1", q.topic1);
        p.set("topic0_1_opr", "and");
      }
      if (q.topic2) {
        p.set("topic2", q.topic2);
        p.set("topic0_2_opr", "and");
      }
      if (q.topic1 && q.topic2) p.set("topic1_2_opr", "and");
      let r;
      try {
        r = await fetchJson(base + "?" + p.toString(), {}, 40000);
      } catch (e) {
        if (e.status === 429 || /too many requests/i.test(e.message || "")) e.rateLimited = true;
        throw e;
      }
      if (!Array.isArray(r.result)) {
        const err = new Error("explorer: " + String(r.message || r.result || "unexpected response").slice(0, 160));
        if (/too many requests/i.test(String(r.message || ""))) err.rateLimited = true;
        throw err;
      }
      // { status: "0", message: "No logs found", result: [] } is the normal empty answer
      let added = 0;
      for (const l of r.result) {
        const k = l.transactionHash + ":" + l.logIndex;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(l);
        added++;
      }
      if (r.result.length < 1000) break;
      if (!added || page === maxPages - 1) {
        complete = false; // page budget used up, or one block holds more than a full page
        break;
      }
      from = Number(hexToBig(r.result[r.result.length - 1].blockNumber)); // the boundary block is re-read; duplicates are dropped above
    }
    return { logs: out, complete };
  }
  MR.explorerLogs = explorerLogs;

  // ---------- wallet ----------
  function positionStatus(heldBins, cur, range) {
    if (cur != null && heldBins.length) {
      const lo = Math.min(...heldBins);
      const hi = Math.max(...heldBins);
      if (cur < lo || cur > hi) return "out";
      return lo !== hi && (cur === lo || cur === hi) ? "edge" : "in";
    }
    // no active-bin reading: the API states the range as offsets from the reference price
    if (range && num(range.lowerOffsetRatio) != null && num(range.upperOffsetRatio) != null) return range.lowerOffsetRatio <= 0 && range.upperOffsetRatio >= 0 ? "in" : "out";
    return "unknown";
  }
  /** One row of GET /evm/{chain}/positions/{wallet} → the record the wallet view draws. */
  function mapPosition(chainId, r, pool) {
    const perf = r.performance || {};
    const binRows = (r.bins || [])
      .map((b) => ({ bin: Number(b.binIdx), shares: toBig(b.shares) || 0n, raw0: toBig(b.token0Amount) || 0n, raw1: toBig(b.token1Amount) || 0n }))
      .filter((b) => isFinite(b.bin) && b.shares > 0n)
      .sort((a, b) => a.bin - b.bin);
    const raw0 = toBig(r.token0Amount);
    const raw1 = toBig(r.token1Amount);
    const amt0 = pool && raw0 !== null ? fmtUnits(raw0, pool.t0.dec) : null; // amounts are in token units
    const amt1 = pool && raw1 !== null ? fmtUnits(raw1, pool.t1.dec) : null;
    const price0 = num(r.token0FiatPrice) != null ? r.token0FiatPrice : pool ? pool.t0.price : null;
    const price1 = num(r.token1FiatPrice) != null ? r.token1FiatPrice : pool ? pool.t1.price : null;
    let value = num(perf.currentValueFiat);
    if (value == null && amt0 != null && amt1 != null && price0 != null && price1 != null) value = amt0 * price0 + amt1 * price1;
    const periods = {};
    for (const w of ["24h", "7d", "30d", "all"]) {
      const a = (perf.aprByPeriod && perf.aprByPeriod[w]) || {};
      const mw = perf.markoutByPeriod && perf.markoutByPeriod[w];
      const m = (mw && mw.byHorizon && mw.byHorizon["5m"]) || {};
      periods[w] = {
        feeApr: num(a.apr), // fractions: 0.34 = 34% a year
        pnlApr: num(a.pnlApr),
        feeIncome: num(a.feeIncomeFiat),
        capital: num(a.timeWeightedCapitalFiat),
        pnl: num(perf.pnlByPeriod && perf.pnlByPeriod[w]),
        volume: num(perf.volumeByPeriod && perf.volumeByPeriod[w]),
        markout: num(m.markoutFiat),
        markoutApr: num(m.apr),
      };
    }
    const cs = r.classificationSummary || {};
    const lastDeposit = Number(r.lastDepositTimestamp);
    return {
      chainId,
      pool: pool || null,
      poolAddress: r.poolAddress,
      salt: String(r.salt != null ? r.salt : ""),
      bins: binRows.map((b) => b.bin),
      binRows: binRows.map((b) => ({ bin: b.bin, amt0: pool ? fmtUnits(b.raw0, pool.t0.dec) : null, amt1: pool ? fmtUnits(b.raw1, pool.t1.dec) : null })),
      amt0,
      amt1,
      value,
      status: positionStatus(binRows.map((b) => b.bin), pool ? pool.curBinIdx : null, r.range),
      range: r.range || null,
      tier: cs.tierQualification || (pool && pool.tier) || "unclassified",
      openedAt: num(perf.openedAtTimestamp),
      lastDeposit: lastDeposit > 0 ? lastDeposit : null,
      feesEarned: num(perf.feesEarnedFiat),
      fees24: num(perf.previous24hFeeIncomeFiat),
      periods,
    };
  }
  MR.mapPosition = mapPosition;
  /**
   * Open LP positions of a wallet on one chain, from Metric's API (the data behind app.metric.xyz/portfolio).
   * findPool(chainId, address) looks a pool record up in the loaded dataset.
   */
  MR.walletPositions = async function walletPositions(chainId, wallet, findPool) {
    let rows;
    try {
      rows = await api.positions(chainId, wallet);
    } catch (e) {
      if (e.status === 404) rows = []; // an address the API has never seen
      else throw e;
    }
    if (!Array.isArray(rows)) throw new Error("unexpected positions response");
    const out = [];
    for (const r of rows) {
      if (!r || !r.poolAddress) continue;
      let pool = findPool(chainId, r.poolAddress);
      if (!pool) pool = await api.poolMeta(chainId, r.poolAddress).catch(() => null);
      const pos = mapPosition(chainId, r, pool);
      if (pos.bins.length) out.push(pos);
    }
    return out.sort((a, b) => (b.value || 0) - (a.value || 0));
  };
  /**
   * Transactions an address sent, newest first, from the explorer's REST API (50 a page), back to `sinceTs`.
   * Returns { txs, complete }; complete is false when the page budget ran out first.
   */
  async function walletTransactions(chainId, wallet, sinceTs, maxPages) {
    const base = CONFIG.chains[chainId].explorerApi;
    const txs = [];
    let params = { filter: "from" };
    for (let page = 0; page < maxPages; page++) {
      let r;
      for (let attempt = 0; ; attempt++) {
        try {
          r = await fetchJson(base + "/addresses/" + wallet + "/transactions?" + new URLSearchParams(params).toString(), {}, 30000);
          break;
        } catch (e) {
          if (e.status === 404) return { txs, complete: true }; // an address the explorer has never seen
          if (e.status === 429) e.rateLimited = true;
          if (e.rateLimited || attempt >= 1) throw e;
          await sleep(900); // the explorer answers 500 now and then; the same request succeeds a moment later
        }
      }
      for (const x of r.items || []) {
        const ts = Date.parse(x.timestamp) / 1000;
        if (isFinite(ts) && ts < sinceTs) return { txs, complete: true }; // older than Metric on this chain
        txs.push(x);
      }
      if (!r.next_page_params) return { txs, complete: true };
      params = { filter: "from" };
      for (const k of Object.keys(r.next_page_params)) if (r.next_page_params[k] != null) params[k] = String(r.next_page_params[k]);
    }
    return { txs, complete: false };
  }
  async function receipt(chainId, hash) {
    let lastErr = null;
    for (const ep of CONFIG.chains[chainId].logRpc) {
      try {
        const rc = await rpcCall(ep.url, "eth_getTransactionReceipt", [hash], 20000);
        if (rc) return rc;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }
  const WALLET_TX_PAGES = 8; // 400 transactions since Metric's launch on the chain
  /**
   * Metric swaps made by a wallet on one chain.
   * since: { ts, block } of the chain's first Metric pool; nothing older can be a Metric swap.
   *
   * The pool's Swap event names the contract that called it and the address the output went to. Wallets trade through
   * routers, so the output often goes to the router first (always when it is unwrapped to the native coin) and the
   * event never mentions the wallet. So the source of truth is the wallet's own transactions: every Swap event of a
   * known pool inside a transaction the wallet sent is that wallet's swap.
   *
   * Returns { chainId, supported, swaps (newest first), complete, scanned }.
   */
  MR.walletSwaps = async function walletSwaps(chainId, wallet, findPool, since) {
    const cfg = CONFIG.chains[chainId];
    if (!cfg.explorerApi) return { chainId, supported: false, swaps: [], complete: true, scanned: 0 };
    const from = since || { ts: 0, block: 0 };
    const list = await walletTransactions(chainId, wallet, from.ts || 0, WALLET_TX_PAGES);
    // A swap always moves tokens, a failed transaction emits no events, and a plain token send cannot contain a swap:
    // only the remaining receipts are worth reading.
    const candidates = list.txs.filter((x) => x.status === "ok" && x.method !== "transfer" && (x.transaction_types || x.tx_types || []).includes("token_transfer"));
    const found = new Map();
    const add = (log, pool, ts) => {
      const s = decodeSwapLog(log);
      if (!s) return;
      if (ts != null && isFinite(ts)) s.ts = ts;
      const k = s.tx + ":" + s.logIndex;
      if (!found.has(k)) found.set(k, describeSwap(s, pool));
    };
    let unread = 0;
    await mapLimit(candidates, 10, async (x) => {
      let rc;
      try {
        rc = await receipt(chainId, x.hash);
      } catch (e) {
        unread++;
        return;
      }
      for (const l of (rc && rc.logs) || []) {
        const pool = findPool(chainId, l.address);
        if (pool) add(l, pool, Date.parse(x.timestamp) / 1000);
      }
    });
    // Supplement: swaps delivered to the address by somebody else's transaction (smart accounts, relayers).
    // The log API is tightly rationed, so a refusal here is not an error.
    if (cfg.logsApi) {
      try {
        const r = await explorerLogs(chainId, { fromBlock: from.block || 0, topic0: CONFIG.swapTopic, topic2: padAddress(wallet) }, { maxPages: 1 });
        for (const l of r.logs) {
          const pool = findPool(chainId, l.address);
          if (pool) add(l, pool, null);
        }
      } catch (e) {
        /* supplement only */
      }
    }
    return { chainId, supported: true, swaps: [...found.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0) || bySwapOrder(a, b)), complete: list.complete && !unread, scanned: list.txs.length };
  };
})();

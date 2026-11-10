/* Metric Radar — data layer: Metric public API (live → snapshot fallback), chain RPC (logs, multicall), ABI helpers. */
(function () {
  "use strict";
  const MR = (window.MR = window.MR || {});

  // ---------- configuration ----------
  const DEFAULTS = {
    apiBase: "https://api.metric.xyz/public/v1",
    snapshotUrl: "data/latest.json",
    historyUrl: "data/history.json",
    referralCode: "", // set your Metric referral code (app.metric.xyz/referrals) to link pools through it
    chains: {
      1: { name: "Ethereum", short: "ETH", explorer: "https://etherscan.io", rpc: ["https://rpc.metric.xyz/1", "https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"] },
      56: { name: "BNB Chain", short: "BNB", explorer: "https://bscscan.com", rpc: ["https://rpc.metric.xyz/56", "https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"] },
      4663: { name: "Robinhood Chain", short: "Robinhood", explorer: "https://robinhoodchain.blockscout.com", rpc: ["https://rpc.metric.xyz/4663", "https://rpc.mainnet.chain.robinhood.com"] },
    },
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
    topics: {
      liquidityAdded: "0xa55772434bee2a347743b1e8086fa44bac69a060e124ec92ab6b9cc7fc5268af",
      liquidityRemoved: "0xf53d04bdbda6d88dd536895ec533833d3e09d0cbe2474fae32a368c5f83fc610",
      swap: "0x9734819749a91fc3be03ea83205f924ee08479bd3f0da48efc91d94d050cac1e",
    },
    selectors: {
      positionBinShares: "0x2875de46", // positionBinShares(address,address,uint80,int16)
      binTotalShares: "0x7b06033b", // binTotalShares(address,int16)
      binState: "0x5d6dc217", // binState(address,int16)
      aggregate3: "0x82ad56cb", // aggregate3((address,bool,bytes)[])
    },
  };

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
  // ?api=mock points at scripts/dev_mock.py on the same origin; ?api=<url> overrides the API base for this page load.
  const apiParam = new URLSearchParams(location.search).get("api");
  const mock = apiParam === "mock";
  const CONFIG = {
    ...DEFAULTS,
    apiBase: (mock ? location.origin + "/public/v1" : apiParam || settings.apiBase || DEFAULTS.apiBase).replace(/\/+$/, ""),
    rpcOverrides: mock ? Object.fromEntries(Object.keys(DEFAULTS.chains).map((id) => [id, [location.origin + "/rpc/" + id]])) : settings.rpc || {},
    mock,
  };
  MR.config = CONFIG;
  MR.settings = { get: () => loadSettings(), set: (s) => saveSettings(s) };

  function rpcList(chainId) {
    const o = CONFIG.rpcOverrides[chainId];
    if (o && o.length) return o.concat(DEFAULTS.chains[chainId].rpc.filter((u) => !o.includes(u)));
    return DEFAULTS.chains[chainId].rpc.slice();
  }

  // ---------- small utils ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, rej) => (t = setTimeout(() => rej(new Error((label || "request") + " timed out")), ms)));
    return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
  }
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
  MR.util = { sleep, fetchJson };

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
    const cid = Number(chainId != null ? chainId : raw.chainId);
    return {
      chainId: cid,
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

  // ---------- Metric API ----------
  const api = {
    base: () => CONFIG.apiBase,
    async get(path, ms) {
      return fetchJson(CONFIG.apiBase + path, { headers: { Accept: "application/json" } }, ms || 25000);
    },
    async chains() {
      return this.get("/chains");
    },
    /** All pools on the public chains, paginated through the cross-chain endpoint. */
    async allPools(chainIds) {
      const ids = (chainIds || Object.keys(CONFIG.chains).map(Number)).join(",");
      const out = [];
      let offset = 0;
      for (let page = 0; page < 20 && offset !== null; page++) {
        const r = await this.get(`/evm/metadata?include24h=true&count=500&sortBy=tvl&minTvlFiat=0&chainIds=${ids}&offset=${offset}`);
        for (const raw of r.data || []) out.push(normalizePool(raw));
        offset = r.nextOffset == null ? null : r.nextOffset;
      }
      return out;
    },
    async poolMeta(chainId, address) {
      const r = await this.get(`/evm/${chainId}/metadata?include24h=true&addresses=${address}&minTvlFiat=0`);
      return r.data && r.data[0] ? normalizePool(r.data[0], chainId) : null;
    },
    async bidAsk(chainId, address) {
      return this.get(`/evm/${chainId}/${address}/bid_ask`);
    },
    /** Undocumented, used by app.metric.xyz: per-bin analytics. */
    async bins(chainId, address, period) {
      return this.get(`/evm/${chainId}/${address}/analytics/bins?contract_version=v1&period=${period || "7d"}`);
    },
  };
  MR.api = api;

  // ---------- dataset: live first, snapshot fallback ----------
  MR.loadDataset = async function loadDataset(onStatus) {
    const status = { source: "loading", generatedAt: null, error: null };
    onStatus && onStatus(status);
    const historyP = fetchJson(CONFIG.historyUrl + "?t=" + Math.floor(Date.now() / 300000), {}, 20000).catch(() => null);
    let pools = null;
    try {
      pools = await api.allPools();
      status.source = "live";
      status.generatedAt = Date.now() / 1000;
    } catch (e) {
      status.error = String(e && e.message ? e.message : e);
    }
    if (!pools) {
      try {
        const snap = await fetchJson(CONFIG.snapshotUrl + "?t=" + Math.floor(Date.now() / 300000), {}, 20000);
        pools = snap.pools || [];
        status.source = "snapshot";
        status.generatedAt = snap.generatedAt || null;
      } catch (e2) {
        status.source = "error";
        status.error = (status.error || "") + " | snapshot: " + String(e2 && e2.message ? e2.message : e2);
        pools = [];
      }
    }
    const history = await historyP;
    onStatus && onStatus(status);
    return { pools, history, status };
  };

  // ---------- hex / ABI helpers (BigInt) ----------
  const MASK128 = (1n << 128n) - 1n;
  const TWO255 = 1n << 255n;
  const TWO256 = 1n << 256n;
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
  function padWord(v) {
    let x = BigInt(v);
    if (x < 0n) x += TWO256;
    return x.toString(16).padStart(64, "0");
  }
  function padAddress(addr) {
    return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  }
  function encodeBytes(hex) {
    const h = hex.replace(/^0x/, "");
    const len = h.length / 2;
    const padded = h.padEnd(Math.ceil(h.length / 64) * 64, "0");
    return padWord(len) + padded;
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
  MR.abi = { hexToBig, word, toSigned, padWord, padAddress, fmtUnits };

  // ---------- JSON-RPC ----------
  const rpcState = {}; // chainId -> index of working endpoint
  async function rpcOnce(url, body, ms) {
    return fetchJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, ms || 30000);
  }
  async function rpc(chainId, method, params, opts) {
    const urls = rpcList(chainId);
    const start = rpcState[chainId] || 0;
    let lastErr = null;
    for (let k = 0; k < urls.length; k++) {
      const i = (start + k) % urls.length;
      const url = urls[i];
      try {
        const res = await rpcOnce(url, { jsonrpc: "2.0", id: 1, method, params }, opts && opts.timeout);
        if (res.error) {
          const err = new Error(res.error.message || "rpc error");
          err.rpcError = res.error;
          err.url = url;
          // a method-level error (e.g. range too large) is not an endpoint failure: surface it
          if (opts && opts.surfaceRpcError) throw err;
          lastErr = err;
          continue;
        }
        rpcState[chainId] = i;
        return res.result;
      } catch (e) {
        if (e.rpcError && opts && opts.surfaceRpcError) throw e;
        lastErr = e;
      }
    }
    throw lastErr || new Error("no rpc endpoint");
  }
  async function rpcBatch(chainId, calls) {
    // calls: [{method, params}] -> results in order (null on per-call error)
    const urls = rpcList(chainId);
    const start = rpcState[chainId] || 0;
    let lastErr = null;
    for (let k = 0; k < urls.length; k++) {
      const i = (start + k) % urls.length;
      try {
        const body = calls.map((c, j) => ({ jsonrpc: "2.0", id: j + 1, method: c.method, params: c.params }));
        const res = await rpcOnce(urls[i], body, 40000);
        if (!Array.isArray(res)) throw new Error("batch not supported");
        const byId = new Map(res.map((r) => [r.id, r]));
        rpcState[chainId] = i;
        return calls.map((_, j) => {
          const r = byId.get(j + 1);
          return r && !r.error ? r.result : null;
        });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("no rpc endpoint");
  }
  async function blockNumber(chainId) {
    return Number(hexToBig(await rpc(chainId, "eth_blockNumber", [])));
  }
  async function getBlock(chainId, n) {
    const b = await rpc(chainId, "eth_getBlockByNumber", [typeof n === "number" ? "0x" + n.toString(16) : n, false]);
    return b ? { number: Number(hexToBig(b.number)), timestamp: Number(hexToBig(b.timestamp)) } : null;
  }

  /**
   * eth_getLogs with adaptive splitting. Returns { logs, scannedFrom, scannedTo, complete }.
   * Stops after maxCalls to keep public RPCs happy; "complete" says whether the whole range was covered.
   */
  async function getLogs(chainId, filter, fromBlock, toBlock, opts) {
    const maxCalls = (opts && opts.maxCalls) || 24;
    const minChunk = (opts && opts.minChunk) || 500;
    let calls = 0;
    const out = [];
    // newest range is popped first, so a partial result covers the most recent blocks
    const stack = [[fromBlock, toBlock]];
    let complete = true;
    while (stack.length) {
      const [a, b] = stack.pop();
      if (calls >= maxCalls) {
        complete = false;
        break;
      }
      calls++;
      try {
        const logs = await rpc(chainId, "eth_getLogs", [{ ...filter, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) }], { surfaceRpcError: true, timeout: 45000 });
        for (const l of logs) out.push(l);
      } catch (e) {
        if (b - a + 1 > minChunk) {
          // range too wide for this endpoint (or a transient failure): split and retry both halves
          const mid = Math.floor((a + b) / 2);
          stack.push([a, mid]);
          stack.push([mid + 1, b]);
        } else {
          complete = false;
          opts && opts.onError && opts.onError(e);
        }
      }
      opts && opts.onProgress && opts.onProgress({ calls, logs: out.length });
    }
    return { logs: out, complete, calls };
  }

  // ---------- multicall3 ----------
  function encodeAggregate3(calls) {
    // calls: [{target, data}] ; allowFailure = true
    const n = calls.length;
    const encodedTuples = calls.map((c) => {
      const data = encodeBytes(c.data);
      return padWord(hexToBig(c.target)) + padWord(1n) + padWord(0x60n) + data;
    });
    let offsets = "";
    let acc = n * 32;
    for (const t of encodedTuples) {
      offsets += padWord(BigInt(acc));
      acc += t.length / 2;
    }
    const arr = padWord(BigInt(n)) + offsets + encodedTuples.join("");
    return CONFIG.selectors.aggregate3 + padWord(0x20n) + arr;
  }
  function decodeAggregate3(hex) {
    // returns [{ok, data}] ; data as 0x-hex
    const h = hex.replace(/^0x/, "");
    const w = (i) => BigInt("0x" + h.slice(i * 64, i * 64 + 64));
    const arrStart = Number(w(0)) / 32; // word index
    const n = Number(w(arrStart));
    const res = [];
    for (let k = 0; k < n; k++) {
      const off = Number(w(arrStart + 1 + k)) / 32;
      const base = arrStart + 1 + off;
      const ok = w(base) === 1n;
      const dOff = Number(w(base + 1)) / 32;
      const dBase = base + dOff;
      const len = Number(w(dBase));
      const data = "0x" + h.slice((dBase + 1) * 64, (dBase + 1) * 64 + len * 2);
      res.push({ ok, data });
    }
    return res;
  }
  /** Executes many eth_calls: multicall3 when available, JSON-RPC batch otherwise. Returns hex results (null on failure). */
  async function multicall(chainId, calls) {
    if (!calls.length) return [];
    const CHUNK = 150;
    const results = new Array(calls.length).fill(null);
    let useMc = true;
    for (let i = 0; i < calls.length; i += CHUNK) {
      const slice = calls.slice(i, i + CHUNK);
      let done = false;
      if (useMc) {
        try {
          const data = encodeAggregate3(slice);
          const ret = await rpc(chainId, "eth_call", [{ to: CONFIG.multicall3, data }, "latest"], { surfaceRpcError: true });
          const dec = decodeAggregate3(ret);
          dec.forEach((d, j) => (results[i + j] = d.ok && d.data !== "0x" ? d.data : null));
          done = true;
        } catch (e) {
          useMc = false; // multicall3 missing on this chain → batch
        }
      }
      if (!done) {
        const batch = await rpcBatch(chainId, slice.map((c) => ({ method: "eth_call", params: [{ to: c.target, data: c.data }, "latest"] })));
        batch.forEach((r, j) => (results[i + j] = r && r !== "0x" ? r : null));
      }
    }
    return results;
  }
  MR.rpc = { call: rpc, batch: rpcBatch, blockNumber, getBlock, getLogs, multicall, list: rpcList, state: rpcState };

  // ---------- event decoders ----------
  function decodeLiquidityLog(log) {
    const t0 = (log.topics[0] || "").toLowerCase();
    const kind = t0 === CONFIG.topics.liquidityAdded ? "add" : t0 === CONFIG.topics.liquidityRemoved ? "remove" : null;
    if (!kind || log.topics.length < 3) return null;
    try {
      const d = log.data;
      const o1 = Number(word(d, 0)) / 32,
        o2 = Number(word(d, 1)) / 32,
        o3 = Number(word(d, 2)) / 32;
      const n1 = Number(word(d, o1));
      const bins = [];
      for (let i = 0; i < n1; i++) bins.push(Number(toSigned(word(d, o1 + 1 + i), 256)));
      const n2 = Number(word(d, o2));
      const delta0 = [],
        delta1 = [];
      for (let i = 0; i < n2; i++) {
        delta0.push(toSigned(word(d, o2 + 1 + i * 2), 256));
        delta1.push(toSigned(word(d, o2 + 2 + i * 2), 256));
      }
      const n3 = Number(word(d, o3));
      const shares = [];
      for (let i = 0; i < n3; i++) shares.push(word(d, o3 + 1 + i));
      return {
        kind,
        pool: log.address.toLowerCase(),
        provider: "0x" + log.topics[1].slice(-40),
        salt: hexToBig(log.topics[2]),
        bins,
        delta0,
        delta1,
        shares,
        block: Number(hexToBig(log.blockNumber)),
        tx: log.transactionHash,
        logIndex: Number(hexToBig(log.logIndex || "0x0")),
      };
    } catch (e) {
      return null;
    }
  }
  function decodeSwapLog(log) {
    if ((log.topics[0] || "").toLowerCase() !== CONFIG.topics.swap || log.topics.length < 3) return null;
    try {
      const details = word(log.data, 0);
      const deltas = word(log.data, 1);
      const fees = word(log.data, 2);
      return {
        pool: log.address.toLowerCase(),
        sender: "0x" + log.topics[1].slice(-40),
        recipient: "0x" + log.topics[2].slice(-40),
        exactInput: ((details >> 120n) & 1n) === 1n,
        binIdx: Number(toSigned(details >> 104n, 16)),
        posInBin: details & ((1n << 104n) - 1n),
        delta0: toSigned(deltas >> 128n, 128),
        delta1: toSigned(deltas & MASK128, 128),
        feeSpread: fees >> 128n,
        feeNotional: fees & MASK128,
        block: Number(hexToBig(log.blockNumber)),
        tx: log.transactionHash,
        logIndex: Number(hexToBig(log.logIndex || "0x0")),
      };
    } catch (e) {
      return null;
    }
  }
  MR.decode = { liquidity: decodeLiquidityLog, swap: decodeSwapLog };

  /** Enrich a decoded swap with amounts/USD using pool metadata. */
  function describeSwap(s, pool) {
    if (!pool) return { ...s, side: "?", amountIn: null, amountOut: null, usd: null };
    const zeroForOne = s.delta0 > 0n; // pool received token0 → trader sold token0
    const tokIn = zeroForOne ? pool.t0 : pool.t1;
    const tokOut = zeroForOne ? pool.t1 : pool.t0;
    const rawIn = zeroForOne ? s.delta0 : s.delta1;
    const rawOut = zeroForOne ? -s.delta1 : -s.delta0;
    const amountIn = fmtUnits(rawIn, tokIn.dec);
    const amountOut = fmtUnits(rawOut, tokOut.dec);
    let usd = null;
    if (tokIn.price != null) usd = amountIn * tokIn.price;
    else if (tokOut.price != null) usd = amountOut * tokOut.price;
    return { ...s, side: zeroForOne ? "sell" : "buy", tokIn, tokOut, amountIn, amountOut, usd, pair: pool.pair, chainId: pool.chainId };
  }
  MR.describeSwap = describeSwap;

  // ---------- block time estimation ----------
  const chainClock = {};
  async function chainTime(chainId) {
    const c = chainClock[chainId];
    if (c && Date.now() - c.at < 60000) return c;
    const latest = await getBlock(chainId, "latest");
    const back = Math.max(1, latest.number - 2000);
    const old = await getBlock(chainId, back);
    const blockTime = old && latest.number > old.number ? (latest.timestamp - old.timestamp) / (latest.number - old.number) : 12;
    const out = { latest, blockTime: Math.max(0.05, blockTime), at: Date.now() };
    chainClock[chainId] = out;
    return out;
  }
  MR.chainTime = chainTime;

  /** Recent swaps across the given pools on one chain within `seconds`. */
  MR.recentSwaps = async function recentSwaps(chainId, pools, seconds, opts) {
    const clock = await chainTime(chainId);
    const span = Math.ceil(seconds / clock.blockTime);
    const to = clock.latest.number;
    const from = Math.max(1, to - span);
    const addresses = pools.map((p) => p.address);
    const r = await getLogs(chainId, { address: addresses, topics: [CONFIG.topics.swap] }, from, to, { maxCalls: (opts && opts.maxCalls) || 16, minChunk: 400, onProgress: opts && opts.onProgress });
    const byAddr = new Map(pools.map((p) => [p.address.toLowerCase(), p]));
    const swaps = r.logs.map(decodeSwapLog).filter(Boolean).map((s) => describeSwap(s, byAddr.get(s.pool)));
    // timestamps: exact for the newest and oldest block, interpolated between
    if (swaps.length) {
      const blocks = swaps.map((s) => s.block);
      const minB = Math.min(...blocks),
        maxB = Math.max(...blocks);
      let tsMin = null,
        tsMax = null;
      try {
        const [b1, b2] = await rpcBatch(chainId, [
          { method: "eth_getBlockByNumber", params: ["0x" + minB.toString(16), false] },
          { method: "eth_getBlockByNumber", params: ["0x" + maxB.toString(16), false] },
        ]);
        tsMin = b1 ? Number(hexToBig(b1.timestamp)) : null;
        tsMax = b2 ? Number(hexToBig(b2.timestamp)) : null;
      } catch (e) {
        /* fall through to estimation */
      }
      for (const s of swaps) {
        if (tsMin != null && tsMax != null && maxB > minB) s.ts = tsMin + ((s.block - minB) * (tsMax - tsMin)) / (maxB - minB);
        else if (tsMax != null) s.ts = tsMax - (maxB - s.block) * clock.blockTime;
        else s.ts = clock.latest.timestamp - (to - s.block) * clock.blockTime;
      }
    }
    swaps.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
    return { swaps, from, to, complete: r.complete, calls: r.calls, blockTime: clock.blockTime };
  };

  // ---------- wallet scan ----------
  function scaleMult(dec0, dec1, dec) {
    return 10n ** BigInt(Math.max(18, dec0, dec1) - dec);
  }
  MR.scanWallet = async function scanWallet(chainId, wallet, pools, opts) {
    const onProgress = (opts && opts.onProgress) || (() => {});
    const w = wallet.toLowerCase();
    const topicW = padAddress(w);
    const addresses = pools.map((p) => p.address);
    const byAddr = new Map(pools.map((p) => [p.address.toLowerCase(), p]));
    const fromBlock = Math.max(1, Math.min(...pools.map((p) => p.createdBlock || 1)) - 1);
    const to = await blockNumber(chainId);
    onProgress({ stage: "logs" });
    const [liq, swapsAsRecipient, swapsAsSender] = await Promise.all([
      getLogs(chainId, { address: addresses, topics: [[CONFIG.topics.liquidityAdded, CONFIG.topics.liquidityRemoved], topicW] }, fromBlock, to, { maxCalls: 40, minChunk: 2000 }),
      getLogs(chainId, { address: addresses, topics: [CONFIG.topics.swap, null, topicW] }, fromBlock, to, { maxCalls: 40, minChunk: 2000 }),
      getLogs(chainId, { address: addresses, topics: [CONFIG.topics.swap, topicW] }, fromBlock, to, { maxCalls: 20, minChunk: 2000 }),
    ]);
    const events = liq.logs.map(decodeLiquidityLog).filter(Boolean);
    const swapMap = new Map();
    for (const l of swapsAsRecipient.logs.concat(swapsAsSender.logs)) {
      const s = decodeSwapLog(l);
      if (s) swapMap.set(s.tx + ":" + s.logIndex, describeSwap(s, byAddr.get(s.pool)));
    }
    const swaps = [...swapMap.values()].sort((a, b) => b.block - a.block);

    // group liquidity events into positions (pool, salt)
    const posMap = new Map();
    for (const e of events) {
      const key = e.pool + ":" + e.salt.toString();
      let p = posMap.get(key);
      if (!p) {
        p = { pool: e.pool, salt: e.salt, bins: new Set(), firstBlock: e.block, lastBlock: e.block, adds: 0, removes: 0, events: [] };
        posMap.set(key, p);
      }
      e.bins.forEach((b) => p.bins.add(b));
      p.firstBlock = Math.min(p.firstBlock, e.block);
      p.lastBlock = Math.max(p.lastBlock, e.block);
      if (e.kind === "add") p.adds++;
      else p.removes++;
      p.events.push(e);
    }
    const keys = [...posMap.values()].map((p) => ({ ...p, bins: [...p.bins].sort((a, b) => a - b) }));

    // onchain reads
    onProgress({ stage: "reads", positions: keys.length });
    const calls = [];
    const shareIdx = [];
    const binIdx = new Map();
    for (const k of keys) {
      const pool = byAddr.get(k.pool);
      const dp = (pool && pool.dataProvider) || null;
      if (!dp) continue;
      for (const b of k.bins) {
        shareIdx.push({ key: k.pool + ":" + k.salt + ":" + b, i: calls.length });
        calls.push({ target: dp, data: CONFIG.selectors.positionBinShares + padWord(hexToBig(k.pool)) + padWord(hexToBig(w)) + padWord(k.salt) + padWord(BigInt(b)) });
        const bk = k.pool + ":" + b;
        if (!binIdx.has(bk)) {
          binIdx.set(bk, { total: calls.length, state: calls.length + 1 });
          calls.push({ target: dp, data: CONFIG.selectors.binTotalShares + padWord(hexToBig(k.pool)) + padWord(BigInt(b)) });
          calls.push({ target: dp, data: CONFIG.selectors.binState + padWord(hexToBig(k.pool)) + padWord(BigInt(b)) });
        }
      }
    }
    const res = calls.length ? await multicall(chainId, calls) : [];
    const shares = new Map(shareIdx.map((s) => [s.key, res[s.i] ? word(res[s.i], 0) : 0n]));

    // block timestamps: exact for first deposits and up to ~80 swap blocks, interpolated for the rest
    const wanted = [...new Set(keys.map((k) => k.firstBlock).concat(swaps.map((s) => s.block)))].sort((a, b) => a - b);
    const sample = wanted.length <= 90 ? wanted : [...new Set([wanted[0], wanted[wanted.length - 1], ...keys.map((k) => k.firstBlock), ...wanted.filter((_, i) => i % Math.ceil(wanted.length / 80) === 0)])].sort((a, b) => a - b);
    const tsMap = new Map();
    if (sample.length) {
      try {
        const bs = await rpcBatch(chainId, sample.map((n) => ({ method: "eth_getBlockByNumber", params: ["0x" + n.toString(16), false] })));
        bs.forEach((b, i) => b && tsMap.set(sample[i], Number(hexToBig(b.timestamp))));
      } catch (e) {
        /* timestamps optional */
      }
    }
    const known = [...tsMap.entries()].sort((a, b) => a[0] - b[0]);
    const tsOf = (n) => {
      if (tsMap.has(n)) return tsMap.get(n);
      if (known.length < 2) return null;
      let lo = known[0], hi = known[known.length - 1];
      for (const k of known) {
        if (k[0] <= n) lo = k;
        if (k[0] >= n) { hi = k; break; }
      }
      if (hi[0] === lo[0]) return lo[1];
      return lo[1] + ((n - lo[0]) * (hi[1] - lo[1])) / (hi[0] - lo[0]);
    };
    for (const s of swaps) s.ts = tsOf(s.block);

    // value positions
    const positions = [];
    let closed = 0;
    for (const k of keys) {
      const pool = byAddr.get(k.pool);
      if (!pool) continue;
      const m0 = scaleMult(pool.t0.dec, pool.t1.dec, pool.t0.dec);
      const m1 = scaleMult(pool.t0.dec, pool.t1.dec, pool.t1.dec);
      let amt0 = 0,
        amt1 = 0;
      const heldBins = [];
      const binRows = [];
      for (const b of k.bins) {
        const user = shares.get(k.pool + ":" + k.salt + ":" + b) || 0n;
        const bi = binIdx.get(k.pool + ":" + b);
        const total = bi && res[bi.total] ? word(res[bi.total], 0) : 0n;
        const st = bi && res[bi.state] ? res[bi.state] : null;
        const bal0 = st ? word(st, 0) : 0n;
        const bal1 = st ? word(st, 1) : 0n;
        const lengthE6 = st ? Number(word(st, 2)) : null;
        let a0 = 0,
          a1 = 0;
        if (user > 0n && total > 0n) {
          a0 = fmtUnits((bal0 * user) / total / m0, pool.t0.dec);
          a1 = fmtUnits((bal1 * user) / total / m1, pool.t1.dec);
          heldBins.push(b);
        }
        amt0 += a0;
        amt1 += a1;
        binRows.push({ bin: b, share: user > 0n && total > 0n ? Number((user * 1000000n) / total) / 1e6 : 0, amt0: a0, amt1: a1, lengthE6 });
      }
      const value = (pool.t0.price != null ? amt0 * pool.t0.price : 0) + (pool.t1.price != null ? amt1 * pool.t1.price : 0);
      if (!heldBins.length) {
        closed++;
        continue;
      }
      const cur = pool.curBinIdx;
      let status = "in";
      if (cur == null) status = "unknown";
      else {
        const lo = Math.min(...heldBins),
          hi = Math.max(...heldBins);
        if (cur < lo || cur > hi) status = "out";
        else if (lo !== hi && (cur === lo || cur === hi)) status = "edge";
      }
      positions.push({ chainId, pool, salt: k.salt.toString(), bins: heldBins, binRows, amt0, amt1, value, status, firstBlock: k.firstBlock, firstTs: tsOf(k.firstBlock) || null, adds: k.adds, removes: k.removes, events: k.events });
    }
    positions.sort((a, b) => b.value - a.value);
    return { chainId, positions, closed, swaps, complete: liq.complete && swapsAsRecipient.complete, events };
  };
})();

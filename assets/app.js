/* Metric Radar — app shell, router and views. */
(function () {
  "use strict";
  const MR = (window.MR = window.MR || {});
  const I18N = window.MR_I18N;
  const CONFIG = MR.config;
  const CHAIN_IDS = Object.keys(CONFIG.chains).map(Number);
  const SERIES = { 1: "var(--series-1)", 56: "var(--series-2)", 4663: "var(--series-3)" };
  const FUNDED_MIN_TVL = 1; // below this a pool counts as empty (same threshold as scripts/snapshot.py)
  const PULSE_SECONDS = 900;
  const TRADE_WINDOWS = { "15m": 900, "1h": 3600, "3h": 10800 };
  const PERIODS = ["24h", "7d", "30d", "all"];

  // ---------- state ----------
  const S = {
    lang: null,
    theme: null,
    data: null, // { pools, index, history, generatedAt, chainMeta, liveAt }
    status: { source: "loading" }, // source: loading | snapshot | live | error; api: pending | ok | down
    route: null,
    pulse: null, // { at, promise } shared by re-renders of the overview
    poolMap: null, // { data, map } lookup of every known pool by chain:address
    poolFetch: {}, // chain:address -> "loading" | "failed", for pool pages whose full record is fetched on demand
    trades: { window: "1h", auto: false, timer: null },
    wallet: { addr: "", results: null, pending: null }, // pending: { addr, promise } of a lookup in flight
    poolsView: { chain: "all", tier: new Set(["green", "yellow", "red", "unclassified"]), minTvl: 1000, healthy: false, verified: false, hidePrivate: false, showEmpty: false, q: "", sort: "tvl" },
  };

  // ---------- i18n ----------
  function detectLang() {
    try {
      const u = new URLSearchParams(location.search).get("lang");
      if (u === "tr" || u === "en") return u;
      const s = localStorage.getItem("mr.lang");
      if (s === "tr" || s === "en") return s;
    } catch (e) {
      /* ignore */
    }
    return (navigator.language || "").toLowerCase().startsWith("tr") ? "tr" : "en";
  }
  function t(path, vars) {
    const parts = path.split(".");
    let cur = I18N[S.lang];
    for (const p of parts) {
      if (cur == null) break;
      cur = cur[p];
    }
    if (cur == null) {
      let fb = I18N.en;
      for (const p of parts) {
        if (fb == null) break;
        fb = fb[p];
      }
      cur = fb;
    }
    if (typeof cur !== "string") return cur == null ? path : cur;
    return vars ? cur.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)) : cur;
  }
  MR.t = t;

  // ---------- formatting ----------
  const locale = () => (S.lang === "tr" ? "tr-TR" : "en-US");
  function fmtUsd(v, digits) {
    if (v == null || !isFinite(v)) return t("common.na");
    const a = Math.abs(v);
    const sign = v < 0 ? "−" : "";
    if (a >= 1e9) return sign + "$" + (a / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(2) + "M";
    if (a >= 1e4) return sign + "$" + (a / 1e3).toFixed(1) + "K";
    if (a >= 100) return sign + "$" + new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(a);
    if (a >= 0.01) return sign + "$" + a.toFixed(digits != null ? digits : 2);
    if (a === 0) return "$0";
    return sign + "$" + a.toFixed(digits != null ? digits : 4);
  }
  function fmtUsdFull(v) {
    if (v == null || !isFinite(v)) return t("common.na");
    return new Intl.NumberFormat(locale(), { style: "currency", currency: "USD", maximumFractionDigits: v < 1 ? 4 : 2 }).format(v);
  }
  function fmtNum(v, d) {
    if (v == null || !isFinite(v)) return t("common.na");
    const a = Math.abs(v);
    const digits = d != null ? d : a >= 1000 ? 0 : a >= 1 ? 4 : 6;
    return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(v);
  }
  function fmtBps(bps, signed) {
    if (bps == null || !isFinite(bps)) return t("common.na");
    const p = bps / 100;
    return (signed && p > 0 ? "+" : "") + (Math.abs(p) >= 1000 ? p.toFixed(0) : Math.abs(p) >= 100 ? p.toFixed(1) : p.toFixed(2)) + "%";
  }
  function fmtPct(frac, d) {
    if (frac == null || !isFinite(frac)) return t("common.na");
    return (frac * 100).toFixed(d != null ? d : 1) + "%";
  }
  /** Percent with as many decimals as the size needs: 15%, 2.5%, 0.05%, 0.0012%. */
  function fmtPctSmart(frac) {
    if (frac == null || !isFinite(frac)) return t("common.na");
    const p = frac * 100;
    const a = Math.abs(p);
    const d = a >= 10 ? 1 : a >= 0.1 ? 2 : a >= 0.01 ? 3 : 4;
    return String(Number(p.toFixed(d))) + "%";
  }
  function fmtInt(v) {
    if (v == null || !isFinite(v)) return t("common.na");
    return new Intl.NumberFormat(locale()).format(Math.round(v));
  }
  function fmtAgo(ts) {
    if (!ts) return t("common.na");
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return t("time.justNow");
    const txt = s < 3600 ? t("time.min", { n: Math.floor(s / 60) }) : s < 86400 ? t("time.hour", { n: Math.floor(s / 3600) }) : t("time.day", { n: Math.floor(s / 86400) });
    return t("time.ago", { t: txt });
  }
  function fmtDur(s) {
    if (s == null) return t("common.na");
    if (s < 60) return s + "s";
    if (s < 3600) return Math.round(s / 60) + " min";
    if (s < 86400) return (s / 3600).toFixed(1) + " h";
    return (s / 86400).toFixed(1) + " d";
  }
  function fmtDate(ts, withTime) {
    if (!ts) return t("common.na");
    const d = new Date(ts * 1000);
    return new Intl.DateTimeFormat(locale(), withTime ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" }).format(d);
  }
  function fmtTime(ts) {
    if (!ts) return t("common.na");
    return new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ts * 1000));
  }
  function short(addr, n) {
    if (!addr) return t("common.na");
    const k = n || 4;
    return addr.slice(0, 2 + k) + "…" + addr.slice(-k);
  }
  function chainName(id) {
    return t("chains." + id) !== "chains." + id ? t("chains." + id) : CONFIG.chains[id] ? CONFIG.chains[id].name : String(id);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function poolUrl(p) {
    const base = `https://app.metric.xyz/pool/${p.chainId}/${p.address}`;
    return CONFIG.referralCode ? base + "?ref=" + encodeURIComponent(CONFIG.referralCode) : base;
  }
  function explorerAddr(chainId, addr) {
    return CONFIG.chains[chainId].explorer + "/address/" + addr;
  }
  function explorerTx(chainId, tx) {
    return CONFIG.chains[chainId].explorer + "/tx/" + tx;
  }
  function xShare(text, url) {
    return "https://x.com/intent/post?text=" + encodeURIComponent(text) + "&url=" + encodeURIComponent(url || location.href);
  }
  function markout(p, w, h) {
    const m = p.markout && p.markout[w] && p.markout[w][h];
    return m || null;
  }
  function tierOf(p) {
    return p.private ? "private" : p.tier || "unclassified";
  }
  function ageText(p) {
    if (!p.created) return t("common.na");
    const d = (Date.now() / 1000 - p.created) / 86400;
    return d < 1 ? t("time.hour", { n: Math.max(1, Math.round(d * 24)) }) : t("time.day", { n: Math.round(d) });
  }
  function signCls(v) {
    return v == null ? "" : v < 0 ? "neg" : v > 0 ? "pos" : "";
  }

  // ---------- DOM helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs)
      for (const k in attrs) {
        if (k === "class") e.className = attrs[k];
        else if (k === "html") e.innerHTML = attrs[k];
        else if (k.startsWith("on")) e.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
      }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return e;
  }
  function tokenLogo(tok, size) {
    const s = size || 18;
    if (tok.logo) {
      const img = h("img", { class: "tok", src: tok.logo, alt: "", width: s, height: s, loading: "lazy" });
      img.addEventListener("error", () => img.replaceWith(tokenDot(tok, s)));
      return img;
    }
    return tokenDot(tok, s);
  }
  function tokenDot(tok, s) {
    const d = h("span", { class: "tok tok-dot", title: tok.sym });
    d.style.width = d.style.height = s + "px";
    d.style.background = tok.color || "var(--surface-3)";
    d.textContent = (tok.sym || "?").slice(0, 1);
    return d;
  }
  function pairCell(p) {
    return h("span", { class: "pair" }, h("span", { class: "tok-pair" }, tokenLogo(p.t0), tokenLogo(p.t1)), h("span", { class: "pair-name" }, p.pair));
  }
  function chainChip(id, full) {
    return h("span", { class: "chip chain-chip", title: chainName(id) }, h("i", { class: "sw", style: "background:" + SERIES[id] }), full ? chainName(id) : CONFIG.chains[id] ? CONFIG.chains[id].short : chainName(id));
  }
  function tierChip(p, withText) {
    const tier = tierOf(p);
    return h("span", { class: "chip tier tier-" + tier, title: t("tiers.desc." + tier) }, h("i", { class: "sw" }), withText === false ? "" : t("tiers." + tier));
  }
  function statusChip(p) {
    const st = p.pauseLevel && p.pauseLevel > 0 ? "pool_paused" : p.ppStatus || "unknown";
    return h("span", { class: "chip st st-" + st, title: t("ppStatus.desc." + st) }, h("i", { class: "sw" }), t("ppStatus." + st));
  }
  function statTile(label, value, sub, cls) {
    return h("div", { class: "tile " + (cls || "") }, h("div", { class: "tile-v" }, value), h("div", { class: "tile-l" }, label), sub ? h("div", { class: "tile-s" }, sub) : null);
  }
  function section(title, hint, ...body) {
    return h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, title), hint ? h("p", { class: "hint" }, hint) : null), ...body);
  }
  function table(cols, rows, opts) {
    const tbl = h("table", { class: "mr-table " + ((opts && opts.cls) || "") });
    const thead = h("thead", null, h("tr", null, ...cols.map((c) => h("th", { class: c.num ? "num" : "", scope: "col" }, c.label))));
    const tbody = h("tbody");
    rows.forEach((r) => tbody.appendChild(r));
    tbl.appendChild(thead);
    tbl.appendChild(tbody);
    return h("div", { class: "table-wrap" }, tbl);
  }
  function td(content, cls) {
    return h("td", { class: cls || "" }, content);
  }
  function linkBtn(label, href, cls) {
    return h("a", { class: "btn " + (cls || ""), href, target: href.startsWith("#") ? null : "_blank", rel: "noopener" }, label);
  }
  function empty(text) {
    return h("p", { class: "mr-empty" }, text);
  }
  function note(text) {
    return h("p", { class: "note" }, text);
  }
  function kv(rows) {
    return h("dl", { class: "kv" }, ...rows.map(([k, v]) => h("div", { class: "kv-row" }, h("dt", null, k), h("dd", null, v))));
  }

  // ---------- router ----------
  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, "");
    const [pathPart, qs] = hash.split("?");
    const parts = pathPart.split("/").filter(Boolean);
    const q = new URLSearchParams(qs || "");
    return { name: parts[0] || "overview", parts, q };
  }
  function go(path) {
    location.hash = "#/" + path;
  }
  window.addEventListener("hashchange", () => render());

  // ---------- shell ----------
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", S.theme);
  }
  function renderShell() {
    const nav = $("#nav");
    nav.innerHTML = "";
    const r = S.route || parseRoute();
    ["overview", "pools", "trades", "wallet", "guide"].forEach((n) => {
      const a = h("a", { href: "#/" + n, class: "tab" + (r.name === n || (n === "pools" && r.name === "pool") ? " active" : ""), "aria-current": r.name === n ? "page" : null }, t("nav." + n));
      nav.appendChild(a);
    });
    $("#byline").textContent = t("byline");
    $("#langBtn").textContent = S.lang === "tr" ? "EN" : "TR";
    $("#langBtn").setAttribute("aria-label", S.lang === "tr" ? t("lang.en") : t("lang.tr"));
    $("#themeBtn").setAttribute("aria-label", S.theme === "dark" ? t("theme.light") : t("theme.dark"));
    $("#settingsBtn").setAttribute("aria-label", t("common.settings"));
    $("#footNote").textContent = t("guide.disclaimer");
    $("#footData").textContent = t("common.poweredBy");
    renderSource();
  }
  function renderSource() {
    const b = $("#sourceBadge");
    const st = S.status;
    b.className = "source " + st.source;
    if (st.source === "live") b.textContent = t("source.live");
    else if (st.source === "snapshot") b.textContent = t("source.snapshot") + (st.generatedAt ? " · " + t("source.snapshotAge", { age: fmtAgo(st.generatedAt).replace(/ (önce|ago)$/, "") }) : "");
    else if (st.source === "error") b.textContent = t("source.error");
    else b.textContent = t("source.loading");
    b.title = st.error ? t("source.liveFailed") + " " + st.error : "";
  }

  // ---------- data helpers ----------
  function pools() {
    return (S.data && S.data.pools) || [];
  }
  function emptyPools() {
    return (S.data && S.data.index) || [];
  }
  /** Any known pool (funded or empty) by chain and address. */
  function findPool(chainId, addr) {
    if (!S.data || !addr) return null;
    if (!S.poolMap || S.poolMap.data !== S.data) {
      const map = new Map();
      for (const p of emptyPools()) map.set(MR.poolKey(p), p);
      for (const p of pools()) map.set(MR.poolKey(p), p);
      S.poolMap = { data: S.data, map };
    }
    return S.poolMap.map.get(Number(chainId) + ":" + String(addr).toLowerCase()) || null;
  }
  function sum(arr, f) {
    return arr.reduce((s, x) => s + (f(x) || 0), 0);
  }
  const isFunded = (p) => (p.tvl || 0) >= FUNDED_MIN_TVL;

  // history series: [[ts, value]]
  const HIST_IDX = { ts: 0, tvl: 1, vol24: 2, pools: 3, swaps24: 4 };
  function seriesFor(chainId, field, maxPoints) {
    const hst = S.data && S.data.history;
    if (!hst || !hst.hourly || !hst.hourly[chainId]) return [];
    return hst.hourly[chainId].slice(-(maxPoints || 1000)).map((r) => [r[0], r[HIST_IDX[field]]]);
  }
  function dailySeriesFor(chainId, field) {
    const hst = S.data && S.data.history;
    if (!hst || !hst.daily || !hst.daily[chainId]) return [];
    return hst.daily[chainId].map((r) => [r[0], r[HIST_IDX[field]]]);
  }
  function poolHistory(p) {
    const hst = S.data && S.data.history;
    if (!hst || !hst.pools) return [];
    return hst.pools[MR.poolKey(p)] || [];
  }

  // ---------- swap helpers shared by the overview pulse, the trade feed and the wallet ----------
  function swapTip(s) {
    return `<div class="mr-tip-head">${esc(s.pair)} · ${fmtTime(s.ts)}</div><div>${s.side === "sell" ? t("trades.sell") : t("trades.buy")} ${esc(fmtNum(s.amountIn))} ${esc(s.tokIn.sym)} → ${esc(fmtNum(s.amountOut))} ${esc(s.tokOut.sym)}</div><b>${fmtUsd(s.usd)}</b>`;
  }
  /** Dots for the pulse strip; a busy window keeps its largest swaps so the strip stays readable and light. */
  function swapDots(swaps, cap) {
    const list = swaps.length > cap ? [...swaps].sort((a, b) => (b.usd || 0) - (a.usd || 0)).slice(0, cap) : swaps;
    return list.map((s) => ({ t: s.ts, usd: s.usd || 0, href: explorerTx(s.chainId, s.tx), title: swapTip(s) }));
  }
  function sideCell(s) {
    return h("span", { class: "side " + s.side }, s.side === "sell" ? t("trades.sell") + " " + s.tokIn.sym : t("trades.buy") + " " + s.tokOut.sym);
  }
  function pulseData() {
    if (S.pulse && Date.now() - S.pulse.at < 30000) return S.pulse.promise;
    const ps = pools().filter((p) => p.tier !== "black");
    const promise = Promise.all(
      CHAIN_IDS.map(async (id) => {
        try {
          return { id, r: await MR.recentSwaps(id, ps.filter((p) => p.chainId === id), PULSE_SECONDS) };
        } catch (e) {
          return { id, r: null };
        }
      })
    );
    S.pulse = { at: Date.now(), promise };
    return promise;
  }

  // ---------- views ----------
  function viewOverview(main) {
    const live = pools().filter((p) => p.tier !== "black");
    const funded = live.filter(isFunded);
    const everyPool = live.concat(emptyPools());
    const tvl = sum(live, (p) => p.tvl);
    const healthy = funded.filter((p) => p.ppStatus === "healthy" && !(p.pauseLevel > 0)).length;

    main.appendChild(
      h("section", { class: "hero" },
        h("div", { class: "hero-text" }, h("h1", null, t("overview.title")), h("p", { class: "lead" }, t("tagline"))),
        h("div", { class: "tiles" },
          statTile(t("overview.tvl"), fmtUsd(tvl)),
          statTile(t("overview.vol24"), fmtUsd(sum(live, (p) => p.vol24))),
          statTile(t("overview.vol7"), fmtUsd(sum(live, (p) => p.vol7))),
          statTile(t("overview.volAll"), fmtUsd(sum(everyPool, (p) => p.volAll)), t("overview.volAllSub")),
          statTile(t("overview.pools"), fmtInt(funded.length), t("overview.poolsSub", { total: fmtInt(everyPool.length), healthy: fmtInt(healthy) })),
          statTile(t("overview.swaps24"), fmtInt(sum(live, (p) => p.swaps24))),
          statTile(t("overview.fees24"), fmtUsd(sum(live, (p) => p.fees24)))
        )
      )
    );

    // pulse strip
    const pulseBody = h("div", { class: "pulse-body" }, empty(t("common.loading") + "…"));
    main.appendChild(section(t("overview.pulse"), t("overview.pulseHint"), pulseBody, h("div", { class: "card-foot" }, linkBtn(t("overview.seeTrades"), "#/trades", "ghost"))));
    loadPulse(pulseBody);

    // by chain
    const grid = h("div", { class: "grid-2" });
    const chainTbl = table(
      [{ label: t("pools.cols.chain") }, { label: t("detail.tvl"), num: true }, { label: t("pools.cols.vol24"), num: true }, { label: t("overview.poolsShort"), num: true }, { label: t("pools.cols.swaps24"), num: true }, { label: t("overview.tvl7d"), num: true }],
      CHAIN_IDS.map((id) => {
        const cp = live.filter((p) => p.chainId === id);
        const hist = seriesFor(id, "tvl", 7 * 24);
        return h("tr", null,
          td(h("a", { href: "#/pools?chain=" + id }, chainChip(id, true))),
          td(fmtUsd(sum(cp, (p) => p.tvl)), "num"), td(fmtUsd(sum(cp, (p) => p.vol24)), "num"), td(fmtInt(cp.filter(isFunded).length), "num"), td(fmtInt(sum(cp, (p) => p.swaps24)), "num"),
          td(hist.length > 1 ? MR.sparkline(hist, SERIES[id], 90, 28) : t("common.na"), "num spark")
        );
      }),
      { cls: "compact" }
    );
    grid.appendChild(section(t("overview.byChain"), null, chainTbl));

    // tier mix
    const tierCounts = {};
    funded.forEach((p) => {
      const k = tierOf(p);
      tierCounts[k] = tierCounts[k] || { n: 0, tvl: 0 };
      tierCounts[k].n++;
      tierCounts[k].tvl += p.tvl || 0;
    });
    const seg = h("div", { class: "segbar", role: "img", "aria-label": t("overview.tierMix") });
    const legend = h("div", { class: "seg-legend" });
    ["green", "yellow", "red", "private", "unclassified"].forEach((k) => {
      const c = tierCounts[k];
      if (!c || !c.tvl) return;
      const w = (c.tvl / Math.max(1, tvl)) * 100;
      seg.appendChild(h("div", { class: "seg tier-" + k, style: "width:" + w + "%", title: t("tiers." + k) + " " + fmtUsd(c.tvl) }));
      legend.appendChild(h("div", { class: "seg-item" }, h("span", { class: "chip tier tier-" + k }, h("i", { class: "sw" }), t("tiers." + k)), h("span", { class: "num" }, fmtInt(c.n) + " · " + fmtUsd(c.tvl) + " · " + w.toFixed(0) + "%")));
    });
    grid.appendChild(section(t("overview.tierMix"), null, seg, legend));
    main.appendChild(grid);

    // top pools
    const grid2 = h("div", { class: "grid-2" });
    const topVol = live.filter((p) => p.vol24).sort((a, b) => b.vol24 - a.vol24).slice(0, 8);
    grid2.appendChild(section(t("overview.topPools"), null, miniPoolTable(topVol, "vol24")));
    // outsiders cannot deposit into private pools, so they do not belong in a list people read for yield
    const topApr = live
      .filter((p) => !p.private && (p.tvl || 0) >= 10000 && markout(p, "7d", "5m") && markout(p, "7d", "5m").aprBps != null && (markout(p, "7d", "5m").priced || 0) >= 0.7)
      .sort((a, b) => markout(b, "7d", "5m").aprBps - markout(a, "7d", "5m").aprBps)
      .slice(0, 8);
    grid2.appendChild(section(t("overview.topApr"), null, miniPoolTable(topApr, "markout")));
    main.appendChild(grid2);

    // history
    const histWrap = h("div", { class: "grid-2" });
    const tvlChart = h("div", { class: "chart" });
    const volChart = h("div", { class: "chart" });
    histWrap.appendChild(section(t("overview.historyTvl"), null, tvlChart));
    histWrap.appendChild(section(t("overview.historyVol"), null, volChart));
    main.appendChild(histWrap);
    requestAnimationFrame(() => {
      const hs = CHAIN_IDS.map((id) => ({ name: chainName(id), color: SERIES[id], points: seriesFor(id, "tvl", 24 * 90) }));
      MR.lineChart(tvlChart, { series: hs, yFmt: fmtUsd, xFmt: (x, full) => fmtDate(x, !!full), emptyText: t("overview.historyEmpty"), tableLabel: t("common.tableView"), xLabel: t("trades.cols.time") });
      const vs = CHAIN_IDS.map((id) => ({ name: chainName(id), color: SERIES[id], points: dailySeriesFor(id, "vol24") }));
      MR.lineChart(volChart, { series: vs, yFmt: fmtUsd, xFmt: (x) => fmtDate(x, false), emptyText: t("overview.historyEmpty"), tableLabel: t("common.tableView"), xLabel: t("trades.cols.time") });
    });
    main.appendChild(h("div", { class: "card-foot center" }, linkBtn(t("overview.seeAllPools"), "#/pools", "primary")));
  }

  function miniPoolTable(list, metric) {
    if (!list.length) return empty(t("pools.empty"));
    return table(
      [{ label: t("pools.cols.pair") }, { label: t("pools.cols.chain") }, { label: t("pools.cols.tier") }, { label: t("pools.cols.tvl"), num: true }, { label: metric === "vol24" ? t("pools.cols.vol24") : t("pools.cols.markoutShort"), num: true }],
      list.map((p) => {
        const mk = markout(p, "7d", "5m");
        return h("tr", { class: "row-link", onclick: () => go("pool/" + p.chainId + "/" + p.address) },
          td(h("a", { href: "#/pool/" + p.chainId + "/" + p.address }, pairCell(p))),
          td(chainChip(p.chainId)),
          td(tierChip(p)),
          td(fmtUsd(p.tvl), "num"),
          td(metric === "vol24" ? fmtUsd(p.vol24) : fmtBps(mk && mk.aprBps, true), "num " + (metric !== "vol24" ? signCls(mk && mk.aprBps) : ""))
        );
      }),
      { cls: "compact" }
    );
  }

  async function loadPulse(container) {
    const results = await pulseData();
    if (!container.isConnected) return;
    container.innerHTML = "";
    if (!results.some((x) => x.r)) {
      container.appendChild(empty(t("overview.pulseUnavailable")));
      return;
    }
    const to = Math.floor(Date.now() / 1000);
    const rows = results.map((x) => ({ label: CONFIG.chains[x.id].short + " · " + (x.r ? fmtInt(x.r.swaps.length) : t("common.na")), color: SERIES[x.id], dots: x.r ? swapDots(x.r.swaps, 300) : [] }));
    MR.pulseStrip(container, rows, to - PULSE_SECONDS, to, { xFmt: (x) => fmtTime(x).slice(0, 5) });
  }

  // ----- pools -----
  function viewPools(main) {
    const V = S.poolsView;
    const q = S.route.q;
    if (q.get("chain")) V.chain = q.get("chain");
    if (q.get("tier")) V.tier = new Set(q.get("tier").split(","));
    const head = h("div", { class: "page-head" }, h("h1", null, t("pools.title")), h("div", { class: "page-actions" }));
    main.appendChild(head);

    const filters = h("div", { class: "filters" });
    const sel = (label, value, options, onchange) => {
      const s = h("select", { "aria-label": label, onchange: (e) => onchange(e.target.value) }, ...options.map((o) => h("option", { value: o[0], selected: String(o[0]) === String(value) ? "selected" : null }, o[1])));
      return h("label", { class: "f" }, h("span", null, label), s);
    };
    filters.appendChild(sel(t("pools.cols.chain"), V.chain, [["all", t("chains.all")], ...CHAIN_IDS.map((id) => [id, chainName(id)])], (v) => { V.chain = v; drawRows(); }));
    const tierBox = h("div", { class: "f" }, h("span", null, t("pools.tier")), h("div", { class: "chips" }, ...["green", "yellow", "red", "unclassified"].map((k) =>
      h("button", { type: "button", class: "chip tier tier-" + k + (V.tier.has(k) ? " on" : ""), "aria-pressed": String(V.tier.has(k)), onclick: (e) => { if (V.tier.has(k)) V.tier.delete(k); else V.tier.add(k); e.currentTarget.classList.toggle("on"); e.currentTarget.setAttribute("aria-pressed", String(V.tier.has(k))); drawRows(); } }, h("i", { class: "sw" }), t("tiers." + k))
    )));
    filters.appendChild(tierBox);
    const tvlSel = sel(t("pools.minTvl"), V.minTvl, [[0, t("common.all")], [1000, "$1K"], [10000, "$10K"], [100000, "$100K"], [1000000, "$1M"]], (v) => { V.minTvl = Number(v); drawRows(); });
    filters.appendChild(tvlSel);
    filters.appendChild(sel(t("pools.sort"), V.sort, Object.keys(I18N.en.pools.sorts).map((k) => [k, t("pools.sorts." + k)]), (v) => { V.sort = v; drawRows(); }));
    const check = (key, label, after) => h("label", null, h("input", { type: "checkbox", checked: V[key] ? "checked" : null, onchange: (e) => { V[key] = e.target.checked; if (after) after(); drawRows(); } }), label);
    filters.appendChild(h("div", { class: "f toggles" },
      check("healthy", t("pools.onlyHealthy")),
      check("verified", t("pools.onlyVerified")),
      check("hidePrivate", t("pools.hidePrivate")),
      // empty pools sit below every TVL floor: showing them only makes sense with the floor removed
      check("showEmpty", t("pools.showEmpty"), () => { if (V.showEmpty) { V.minTvl = 0; $("select", tvlSel).value = "0"; } })
    ));
    const search = h("input", { type: "search", class: "search", placeholder: t("pools.search"), value: V.q, "aria-label": t("pools.search"), oninput: (e) => { V.q = e.target.value.trim().toLowerCase(); drawRows(); } });
    filters.appendChild(h("div", { class: "f grow" }, search));
    main.appendChild(filters);

    const count = h("p", { class: "count" });
    const wrap = h("div");
    main.appendChild(count);
    main.appendChild(wrap);
    $(".page-actions", head).appendChild(h("button", { type: "button", class: "btn ghost", onclick: () => exportCsv(filtered()) }, t("pools.export")));

    function filtered() {
      let list = pools().filter((p) => p.tier !== "black");
      list = V.showEmpty ? list.concat(emptyPools()) : list.filter(isFunded);
      if (V.chain !== "all") list = list.filter((p) => String(p.chainId) === String(V.chain));
      list = list.filter((p) => V.tier.has(p.tier || "unclassified") || (p.private && V.tier.size));
      if (V.hidePrivate) list = list.filter((p) => !p.private);
      if (V.minTvl) list = list.filter((p) => (p.tvl || 0) >= V.minTvl);
      if (V.healthy) list = list.filter((p) => p.ppStatus === "healthy" && !(p.pauseLevel > 0));
      if (V.verified) list = list.filter((p) => p.verifiedAdmin);
      if (V.q) list = list.filter((p) => (p.pair + " " + p.address + " " + (p.t0.name || "") + " " + (p.t1.name || "") + " " + (p.adminName || "")).toLowerCase().includes(V.q));
      const key = {
        tvl: (p) => p.tvl, vol24: (p) => p.vol24, vol7: (p) => p.vol7, apr7: (p) => p.apr7Bps, pnl: (p) => p.pnlApr7Bps, created: (p) => p.created, fees24: (p) => p.fees24, swaps24: (p) => p.swaps24,
        markout: (p) => (markout(p, "7d", "5m") ? markout(p, "7d", "5m").aprBps : null),
      }[V.sort];
      list.sort((a, b) => {
        const av = key(a), bv = key(b);
        if (av == null && bv == null) return (b.tvl || 0) - (a.tvl || 0);
        if (av == null) return 1;
        if (bv == null) return -1;
        return bv - av || (b.tvl || 0) - (a.tvl || 0);
      });
      return list;
    }
    function drawRows() {
      const list = filtered();
      const hidden = V.showEmpty ? 0 : pools().filter((p) => p.tier !== "black" && !isFunded(p)).length + emptyPools().length;
      count.textContent = t("pools.count", { n: fmtInt(list.length) }) + (hidden ? " · " + t("pools.emptyHidden", { n: fmtInt(hidden) }) : "");
      wrap.innerHTML = "";
      if (!list.length) {
        wrap.appendChild(empty(t("pools.empty")));
        return;
      }
      const cols = [
        { label: t("pools.cols.pair") }, { label: t("pools.cols.chain") }, { label: t("pools.cols.tier") }, { label: t("pools.cols.status") },
        { label: t("pools.cols.tvl"), num: true }, { label: t("pools.cols.vol24"), num: true }, { label: t("pools.cols.vol7"), num: true },
        { label: t("pools.cols.apr7"), num: true }, { label: t("pools.cols.markout"), num: true }, { label: t("pools.cols.pnl"), num: true },
        { label: t("pools.cols.fees24"), num: true }, { label: t("pools.cols.swaps24"), num: true }, { label: t("pools.cols.curator") }, { label: t("pools.cols.age"), num: true },
      ];
      // a very long table makes the page sluggish: draw the first 400 rows and say so
      const rows = list.slice(0, 400).map((p) => {
        const mk = markout(p, "7d", "5m");
        return h("tr", { class: "row-link", onclick: (e) => { if (e.target.closest("a")) return; go("pool/" + p.chainId + "/" + p.address); } },
          td(h("a", { href: "#/pool/" + p.chainId + "/" + p.address }, pairCell(p))),
          td(chainChip(p.chainId)),
          td(tierChip(p)),
          td(statusChip(p)),
          td(fmtUsd(p.tvl), "num"),
          td(fmtUsd(p.vol24), "num"),
          td(fmtUsd(p.vol7), "num"),
          td(fmtBps(p.apr7Bps), "num"),
          td(h("span", { title: mk && mk.priced != null ? t("detail.priced") + " " + fmtPct(mk.priced, 0) : "" }, fmtBps(mk && mk.aprBps, true)), "num " + signCls(mk && mk.aprBps)),
          td(fmtBps(p.pnlApr7Bps, true), "num " + signCls(p.pnlApr7Bps)),
          td(fmtUsd(p.fees24), "num"),
          td(fmtInt(p.swaps24), "num"),
          td(curatorCell(p)),
          td(ageText(p), "num")
        );
      });
      wrap.appendChild(table(cols, rows, { cls: "pools" }));
      if (list.length > rows.length) wrap.appendChild(note(t("pools.truncated", { shown: fmtInt(rows.length), n: fmtInt(list.length) })));
    }
    drawRows();
  }
  function curatorCell(p) {
    const name = p.adminName || short(p.admin || p.creator);
    return h("span", { class: "curator" + (p.verifiedAdmin ? " verified" : ""), title: p.verifiedAdmin ? t("detail.verified") : t("detail.unverified") }, p.verifiedAdmin ? h("i", { class: "check" }) : null, name);
  }
  function exportCsv(list) {
    const cols = ["chainId", "pair", "address", "tier", "private", "ppStatus", "tvl", "vol24", "vol7", "vol30", "volAll", "fees24", "swaps24", "apr7Bps", "pnlApr7Bps", "markout7d5mAprBps", "protocolFeeE6", "adminFeeE6", "verifiedAdmin", "adminName", "created"];
    const lines = [cols.join(",")];
    list.forEach((p) => {
      const mk = markout(p, "7d", "5m");
      const row = { ...p, markout7d5mAprBps: mk ? mk.aprBps : "" };
      lines.push(cols.map((c) => { const v = row[c]; return v == null ? "" : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v); }).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "metric-radar-pools.csv" });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ----- pool detail -----
  /** The snapshot keeps only a slim record for empty pools, and knows nothing of pools created after it: fetch those. */
  function ensureFullPool(chainId, addr, p) {
    const key = chainId + ":" + addr.toLowerCase();
    if ((p && !p.slim) || S.poolFetch[key] || !CHAIN_IDS.includes(Number(chainId)) || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return S.poolFetch[key] || null;
    S.poolFetch[key] = "loading";
    MR.api.poolMeta(Number(chainId), addr).then(
      (full) => {
        if (!full || !S.data) {
          S.poolFetch[key] = "failed";
          return;
        }
        delete S.poolFetch[key];
        S.data = { ...S.data, pools: pools().filter((x) => MR.poolKey(x) !== key).concat([full]), index: emptyPools().filter((x) => MR.poolKey(x) !== key) };
      },
      () => {
        S.poolFetch[key] = "failed";
      }
    ).then(() => {
      const r = parseRoute();
      if (r.name === "pool" && String(r.parts[1]) === String(chainId) && (r.parts[2] || "").toLowerCase() === addr.toLowerCase()) render({ keepScroll: true });
    });
    return "loading";
  }
  function viewPool(main) {
    const [, chainId, addr] = S.route.parts;
    let p = findPool(chainId, addr || "");
    const fetching = ensureFullPool(chainId, addr || "", p);
    if (fetching === "loading") {
      main.appendChild(h("div", { class: "loading" }, h("div", { class: "spinner" }), h("p", null, t("common.loading") + "…")));
      return;
    }
    if (!p) {
      main.appendChild(empty(t("detail.notFound")));
      main.appendChild(linkBtn(t("detail.back"), "#/pools", "ghost"));
      return;
    }
    const mk75 = markout(p, "7d", "5m");
    const shareTxt = t("detail.shareText", { pair: p.pair, tvl: fmtUsd(p.tvl), vol: fmtUsd(p.vol24), apr: fmtBps(mk75 && mk75.aprBps, true) });
    main.appendChild(h("div", { class: "page-head" },
      h("div", null, h("a", { class: "back", href: "#/pools" }, "← " + t("detail.back")),
        h("h1", { class: "pool-title" }, h("span", { class: "tok-pair big" }, tokenLogo(p.t0, 28), tokenLogo(p.t1, 28)), p.pair),
        h("div", { class: "chips-row" }, chainChip(p.chainId), tierChip(p), statusChip(p), p.slim ? null : p.locked ? h("span", { class: "chip" }, t("detail.locked")) : h("span", { class: "chip warn" }, t("detail.changeable")))),
      h("div", { class: "page-actions" },
        linkBtn(t("detail.openOnMetric"), poolUrl(p), "primary"),
        linkBtn(t("detail.explorer"), explorerAddr(p.chainId, p.address), "ghost"),
        linkBtn(t("detail.share"), xShare(shareTxt, location.href), "ghost"),
        h("button", { type: "button", class: "btn ghost", onclick: (e) => { navigator.clipboard && navigator.clipboard.writeText(p.address); e.currentTarget.textContent = t("detail.copied"); } }, t("detail.copyAddr")))
    ));
    main.appendChild(h("p", { class: "addr num" }, p.address));
    if (p.slim) main.appendChild(note(t("detail.slimNote")));

    // summary tiles
    main.appendChild(h("div", { class: "tiles four" },
      statTile(t("detail.tvl"), fmtUsd(p.tvl), p.liq0 != null ? fmtUsd(p.liq0) + " " + p.t0.sym + " · " + fmtUsd(p.liq1) + " " + p.t1.sym : null),
      statTile(t("detail.vol24"), fmtUsd(p.vol24), p.swaps24 != null ? fmtInt(p.swaps24) + " " + t("detail.swaps24").toLowerCase() : null),
      statTile(t("detail.vol7"), fmtUsd(p.vol7)),
      statTile(t("detail.vol30"), fmtUsd(p.vol30), t("detail.volAll") + " " + fmtUsd(p.volAll)),
      statTile(t("detail.fees24"), fmtUsd(p.fees24), t("detail.apr24") + " " + fmtBps(p.apr24Bps)),
      statTile(t("detail.apr7"), fmtBps(p.apr7Bps)),
      statTile(t("detail.pnlApr7"), fmtBps(p.pnlApr7Bps, true), null, signCls(p.pnlApr7Bps)),
      statTile(t("detail.markout") + " 7d/5m", fmtBps(mk75 && mk75.aprBps, true), mk75 && mk75.priced != null ? t("detail.priced") + " " + fmtPct(mk75.priced, 0) : null, signCls(mk75 && mk75.aprBps))
    ));

    const grid = h("div", { class: "grid-2" });
    // tier reasons
    const tier = tierOf(p);
    const reasons = h("div", null,
      h("p", null, h("span", { class: "chip tier tier-" + tier }, h("i", { class: "sw" }), t("tiers." + tier)), " ", t("tiers.desc." + tier)),
      p.reasons.length ? h("ul", { class: "reasons" }, ...p.reasons.map((r) => h("li", null, h("code", null, r), " — ", t("reasons." + r) === "reasons." + r ? r : t("reasons." + r)))) : p.slim ? null : h("p", { class: "ok" }, t("detail.noReasons")),
      h("p", { class: "risk" }, t("detail.riskNote"))
    );
    grid.appendChild(section(t("detail.reasonsTitle"), null, reasons));

    // curator & fees
    const lpShare = p.protocolFeeE6 != null && p.adminFeeE6 != null ? 1 - (p.protocolFeeE6 + p.adminFeeE6) / 1e6 : null;
    const notional = (p.protocolNotionalE8 || 0) + (p.adminNotionalE8 || 0);
    const feeRows = [
      [p.verifiedAdmin ? t("detail.curator") : t("detail.operator"), h("span", { class: "curator-cell" }, curatorCell(p), p.admin && p.adminName ? h("a", { class: "sub", href: explorerAddr(p.chainId, p.admin), target: "_blank", rel: "noopener" }, short(p.admin)) : null, " ", h("small", null, p.verifiedAdmin ? t("detail.verified") : t("detail.unverified")))],
      [t("detail.creator"), p.creator ? h("a", { href: explorerAddr(p.chainId, p.creator), target: "_blank", rel: "noopener" }, short(p.creator)) : t("common.na")],
      [t("detail.created"), fmtDate(p.created, true) + " · " + ageText(p)],
      [t("detail.protocolShare"), p.protocolFeeE6 != null ? fmtPctSmart(p.protocolFeeE6 / 1e6) : t("common.na")],
      [t("detail.adminShare"), p.adminFeeE6 != null ? fmtPctSmart(p.adminFeeE6 / 1e6) : t("common.na")],
      [t("detail.lpShare"), lpShare != null ? fmtPctSmart(lpShare) : t("common.na")],
      [t("detail.notional"), p.protocolNotionalE8 == null && p.adminNotionalE8 == null ? t("common.na") : notional > 0 ? fmtPctSmart(notional / 1e8) : "0%"],
    ];
    grid.appendChild(section(t("detail.fees"), t("detail.feesHint"), kv(feeRows)));
    main.appendChild(grid);

    // markout table
    const horizons = ["1m", "5m", "30m"];
    const mkRows = PERIODS.map((w) => h("tr", null, td(w), ...horizons.map((hz) => {
      const m = markout(p, w, hz);
      if (!m) return td(t("common.na"), "num");
      return td(h("span", { title: (m.priced != null ? t("detail.priced") + " " + fmtPct(m.priced, 0) : "") + (m.tradedBins != null ? " · " + t("detail.tradedBins") + " " + m.tradedBins + "/" + (m.fundedBins != null ? m.fundedBins : "?") : "") },
        h("b", { class: signCls(m.aprBps) }, fmtBps(m.aprBps, true)), h("small", null, " " + fmtUsd(m.usd))), "num");
    })));
    main.appendChild(section(t("detail.markout"), t("detail.markoutHint"), table([{ label: t("detail.window") }, ...horizons.map((hz) => ({ label: t("detail.horizon") + " " + hz, num: true }))], mkRows, { cls: "compact" })));

    // pricing & guards
    const grid3 = h("div", { class: "grid-2" });
    const d = p.ppDetails || {};
    const addrLink = (a) => (a ? h("a", { href: explorerAddr(p.chainId, a), target: "_blank", rel: "noopener" }, short(a)) : t("common.na"));
    const prRows = [
      [t("detail.providerType"), d.providerType === "anchored" ? t("detail.anchored") : d.providerType === "regular" ? t("detail.regular") : p.slim ? t("common.na") : t("detail.customProvider")],
      [t("detail.pricing"), addrLink(p.ppAddress)],
      [t("detail.locked"), p.slim ? t("common.na") : p.locked ? t("common.yes") : t("common.no")],
      [t("detail.cooldown"), p.cooldown && BigInt(p.cooldown) >= 2n ** 53n ? "∞" : p.cooldown ? fmtDur(Number(p.cooldown)) : t("common.na")],
      [t("detail.staleness"), d.maxRefStaleness != null ? d.maxRefStaleness + " s" : d.maxTimeDelta != null ? d.maxTimeDelta + " s" : t("common.na")],
      [t("detail.oracle"), addrLink(d.oracle)],
      [t("detail.feedMode"), d.feedMode || t("common.na")],
      [t("detail.source"), addrLink(d.source)],
    ];
    grid3.appendChild(section(t("detail.pricing"), null, kv(prRows)));
    const ext = p.extDetails || {};
    const sl = ext.stopLoss;
    const pv = ext.priceVelocity;
    const part = (label, value) => label + " " + (value != null ? value : "?");
    const gRows = [
      [t("detail.stopLoss"), sl ? [
        part(t("detail.drawdown"), sl.drawdownE6 != null ? fmtPctSmart(Number(sl.drawdownE6) / 1e6) : null),
        part(t("detail.decay"), sl.decayPerSecondE18 != null ? fmtPctSmart((Number(sl.decayPerSecondE18) / 1e18) * 86400) : null),
        part(t("detail.timelock"), sl.timelockSecs != null ? (Number(sl.timelockSecs) >= 1099511627775 ? t("detail.locked40") : fmtDur(Number(sl.timelockSecs))) : null),
      ].join(" · ") : p.slim ? t("common.na") : t("detail.none")],
      [t("detail.velocity"), pv ? part(t("detail.maxChange"), pv.maxChangePerBlockE18 != null ? fmtPctSmart(Number(pv.maxChangePerBlockE18) / 1e18) : null) : p.slim ? t("common.na") : t("detail.none")],
      [t("detail.extensions"), p.extensions.length ? h("span", { class: "addr-list" }, ...p.extensions.map((a) => h("a", { href: explorerAddr(p.chainId, a), target: "_blank", rel: "noopener" }, short(a)))) : p.slim ? t("common.na") : t("detail.none")],
      [t("detail.activeBin"), p.curBinIdx != null ? "#" + p.curBinIdx : t("common.na")],
    ];
    grid3.appendChild(section(t("detail.guards"), null, kv(gRows)));
    main.appendChild(grid3);

    // tokens
    const tokRows = [p.t0, p.t1].map((tk, i) => h("tr", null, td(h("span", { class: "pair" }, tokenLogo(tk, 20), " ", tk.sym, h("small", { class: "sub" }, tk.name))), td(addrLink(tk.addr)), td(tk.dec, "num"), td(fmtUsdFull(tk.price), "num"), td(fmtUsd(i === 0 ? p.liq0 : p.liq1), "num")));
    main.appendChild(section(t("detail.tokens"), null, table([{ label: t("detail.tokens") }, { label: t("detail.address") }, { label: t("detail.decimals"), num: true }, { label: t("detail.price"), num: true }, { label: t("detail.liquidity"), num: true }], tokRows, { cls: "compact" })));

    // depth ladder (live)
    const depthBody = h("div");
    const depthBtn = h("button", { type: "button", class: "btn", onclick: () => loadDepth(p, depthBody, depthBtn) }, t("detail.depthLoad"));
    main.appendChild(section(t("detail.depth"), t("detail.depthHint"), h("div", { class: "card-foot" }, depthBtn), depthBody));
    // bins analytics
    const binsBody = h("div");
    const binsBtn = h("button", { type: "button", class: "btn", onclick: () => loadBins(p, binsBody, binsBtn) }, t("detail.binsLoad"));
    main.appendChild(section(t("detail.bins"), t("detail.binsHint"), h("div", { class: "card-foot" }, binsBtn), binsBody));
    if (S.status.api !== "down") {
      loadDepth(p, depthBody, depthBtn);
      loadBins(p, binsBody, binsBtn);
    }

    // history: TVL and volume differ by orders of magnitude, so each gets its own axis
    const hist = poolHistory(p);
    const tvlChart = h("div", { class: "chart" });
    const volChart = h("div", { class: "chart" });
    main.appendChild(h("div", { class: "grid-2" }, section(t("detail.history") + " · " + t("detail.tvl"), null, tvlChart), section(t("detail.history") + " · " + t("detail.vol24"), null, volChart)));
    requestAnimationFrame(() => {
      const common = { yFmt: fmtUsd, xFmt: (x, full) => fmtDate(x, !!full), emptyText: t("detail.historyEmpty"), tableLabel: t("common.tableView"), xLabel: t("trades.cols.time") };
      MR.lineChart(tvlChart, { ...common, area: true, series: [{ name: t("detail.tvl"), color: SERIES[p.chainId], points: hist.map((r) => [r[0], r[1]]) }] });
      MR.lineChart(volChart, { ...common, series: [{ name: t("detail.vol24"), color: "var(--series-4)", points: hist.map((r) => [r[0], r[2]]) }] });
    });
  }
  async function loadDepth(p, body, btn) {
    btn.disabled = true;
    btn.textContent = t("detail.depthLoading") + "…";
    try {
      const r = await MR.api.bidAsk(p.chainId, p.address);
      body.innerHTML = "";
      const Q = 2 ** 64;
      const bid = Number(BigInt(r.bidAdj)) / Q;
      const askRaw = BigInt(r.askAdj);
      const askUnavailable = askRaw === (1n << 128n) - 1n;
      const ask = askUnavailable ? null : Number(askRaw) / Q;
      const bidUnavailable = BigInt(r.bidAdj) === 0n;
      const mid = !bidUnavailable && !askUnavailable ? Math.sqrt(bid * ask) : null;
      const spreadBps = mid ? ((ask - bid) / mid) * 1e4 : null;
      body.appendChild(h("div", { class: "tiles small" },
        statTile(t("detail.mid"), mid ? fmtNum(mid) + " " + p.t1.sym : t("common.na")),
        statTile(t("detail.bidSide"), bidUnavailable ? t("detail.unavailableSide") : fmtNum(bid) + " " + p.t1.sym),
        statTile(t("detail.askSide"), askUnavailable ? t("detail.unavailableSide") : fmtNum(ask) + " " + p.t1.sym),
        statTile(t("detail.spreadBps"), spreadBps != null ? spreadBps.toFixed(1) + " bp" : t("common.na")),
        statTile(t("pools.cols.status"), statusChip({ ppStatus: r.priceProviderStatus, pauseLevel: 0 }))
      ));
      const depth = r.depth || { bids: [], asks: [] };
      const mkSide = (levels, isBid) => {
        const rows = levels.filter((l, i, arr) => i === 0 || l.cumulativeVolume !== arr[i - 1].cumulativeVolume).slice(0, 12).map((l) => {
          const price = Number(BigInt(l.price)) / Q;
          const out = MR.abi.fmtUnits(BigInt(l.cumulativeVolume), isBid ? p.t1.dec : p.t0.dec);
          const inp = MR.abi.fmtUnits(BigInt(l.cumulativeInputVolume), isBid ? p.t0.dec : p.t1.dec);
          return h("tr", null, td("#" + l.binIdx, "num"), td(fmtNum(price), "num"), td(fmtNum(inp) + " " + (isBid ? p.t0.sym : p.t1.sym), "num"), td(fmtNum(out) + " " + (isBid ? p.t1.sym : p.t0.sym), "num"), td((Number(l.priceImpactE6) / 1e4).toFixed(3) + "%", "num"));
        });
        return table([{ label: t("detail.level"), num: true }, { label: t("detail.price"), num: true }, { label: t("detail.cumIn"), num: true }, { label: t("detail.cumOut"), num: true }, { label: t("detail.impact"), num: true }], rows, { cls: "compact depth" });
      };
      body.appendChild(h("div", { class: "grid-2" }, h("div", null, h("h3", null, t("detail.bidSide")), (depth.bids || []).length ? mkSide(depth.bids, true) : empty(t("detail.unavailableSide"))), h("div", null, h("h3", null, t("detail.askSide")), (depth.asks || []).length ? mkSide(depth.asks, false) : empty(t("detail.unavailableSide")))));
      btn.textContent = t("trades.refresh");
    } catch (e) {
      body.innerHTML = "";
      body.appendChild(empty(t("detail.depthFail") + " (" + (e.message || e) + ")"));
      btn.textContent = t("common.retry");
    } finally {
      btn.disabled = false;
    }
  }
  async function loadBins(p, body, btn) {
    btn.disabled = true;
    btn.textContent = t("common.loading") + "…";
    try {
      const r = await MR.api.bins(p.chainId, p.address, "7d");
      body.innerHTML = "";
      const bins = (r.bins || []).map((b) => {
        const res0 = (b.token0 && b.token0.reserveFiat) || 0, res1 = (b.token1 && b.token1.reserveFiat) || 0;
        const fees = ((b.token0 && b.token0.lpFeesFiat) || 0) + ((b.token1 && b.token1.lpFeesFiat) || 0);
        const vol = ((b.token0 && b.token0.volumeFiat) || 0) + ((b.token1 && b.token1.volumeFiat) || 0);
        return { bin: Number(b.bin), value: res0 + res1, fees, vol, aprBps: b.aprBps, pnlAprBps: b.pnlAprBps, active: Number(b.bin) === r.curBinIdx, swaps: Number(b.swapCount || 0) };
      }).filter((b) => b.value > 0 || b.vol > 0 || b.active);
      const chart = h("div", { class: "chart" });
      body.appendChild(chart);
      requestAnimationFrame(() => MR.binsChart(chart, bins, { yFmt: fmtUsd, tipHtml: (b) => `<div class="mr-tip-head">Bin #${b.bin}${b.active ? " · " + t("detail.activeBin") : ""}</div><div>${t("detail.liquidity")}: <b>${fmtUsd(b.value)}</b></div><div>${t("detail.vol7")}: ${fmtUsd(b.vol)}</div><div>${t("detail.binFees")}: ${fmtUsd(b.fees)} · APR ${fmtBps(b.aprBps)}</div><div>Trading PnL APR: ${fmtBps(b.pnlAprBps, true)}</div><div>${t("detail.binSwaps")}: ${fmtInt(b.swaps)}</div>`, emptyText: t("detail.binsFail") }));
      const rows = bins.map((b) => h("tr", { class: b.active ? "active" : "" }, td("#" + b.bin, "num"), td(fmtUsd(b.value), "num"), td(fmtUsd(b.vol), "num"), td(fmtUsd(b.fees), "num"), td(fmtBps(b.aprBps), "num"), td(fmtBps(b.pnlAprBps, true), "num " + signCls(b.pnlAprBps)), td(fmtInt(b.swaps), "num")));
      const tb = table([{ label: t("detail.level"), num: true }, { label: t("detail.liquidity"), num: true }, { label: t("detail.vol7"), num: true }, { label: t("detail.binFees"), num: true }, { label: "APR", num: true }, { label: "PnL APR", num: true }, { label: t("detail.binSwaps"), num: true }], rows, { cls: "compact" });
      const twin = h("div", { class: "mr-table-twin" }, tb);
      twin.hidden = true;
      body.appendChild(h("button", { type: "button", class: "mr-linkbtn", onclick: () => (twin.hidden = !twin.hidden) }, t("common.tableView")));
      body.appendChild(twin);
      btn.textContent = t("trades.refresh");
    } catch (e) {
      body.innerHTML = "";
      body.appendChild(empty(t("detail.binsFail") + " (" + (e.message || e) + ")"));
      btn.textContent = t("common.retry");
    } finally {
      btn.disabled = false;
    }
  }

  // ----- trades -----
  function viewTrades(main) {
    const T = S.trades;
    if (!TRADE_WINDOWS[T.window]) T.window = "1h";
    main.appendChild(h("div", { class: "page-head" }, h("div", null, h("h1", null, t("trades.title")), h("p", { class: "hint" }, t("trades.hint"))),
      h("div", { class: "page-actions" },
        h("label", { class: "f inline" }, h("span", null, t("trades.window")), h("select", { onchange: (e) => { T.window = e.target.value; runTrades(); } }, ...Object.keys(TRADE_WINDOWS).map((k) => h("option", { value: k, selected: T.window === k ? "selected" : null }, t("trades.windows." + k))))),
        h("label", { class: "f inline" }, h("input", { type: "checkbox", checked: T.auto ? "checked" : null, onchange: (e) => { T.auto = e.target.checked; scheduleAuto(); } }), t("trades.auto")),
        h("button", { type: "button", class: "btn primary", onclick: () => runTrades() }, t("trades.refresh")))));
    const status = h("p", { class: "count", "aria-live": "polite" });
    const strip = h("div", { class: "pulse-body" });
    const statsEl = h("div", { class: "tiles small" });
    const perPool = h("div", { class: "bars-2col" });
    const tbl = h("div");
    main.appendChild(status);
    main.appendChild(section(t("overview.pulse"), null, strip));
    main.appendChild(statsEl);
    main.appendChild(section(t("trades.stats.perPool"), null, perPool));
    main.appendChild(section(t("trades.title"), t("trades.tableHint"), tbl));

    let busy = false;
    async function runTrades() {
      if (busy) return;
      const windowKey = T.window;
      const sec = TRADE_WINDOWS[windowKey];
      busy = true;
      status.textContent = t("trades.loading") + "…";
      const ps = pools().filter((p) => p.tier !== "black");
      const results = [];
      const failed = [];
      const pending = new Set(CHAIN_IDS);
      const progress = {};
      const live = () => status.isConnected && windowKey === T.window;
      await Promise.all(CHAIN_IDS.map(async (id) => {
        try {
          const r = await MR.recentSwaps(id, ps.filter((p) => p.chainId === id), sec, { onProgress: (pr) => { progress[id] = pr.logs; if (live()) drawStatus(); } });
          results.push({ id, r });
        } catch (e) {
          failed.push(id);
        }
        pending.delete(id);
        if (live()) draw(); // a fast chain is on screen while a slower one is still being read
      }));
      busy = false;
      if (status.isConnected && windowKey !== T.window) runTrades(); // the window changed while this request was running

      function drawStatus() {
        const notes = [];
        if (pending.size) notes.push(t("trades.loading") + "… " + [...pending].map((id) => chainName(id) + (progress[id] ? " " + fmtInt(progress[id]) : "")).join(", "));
        else if (results.length) notes.push(t("trades.updated", { time: fmtTime(Date.now() / 1000) }));
        else notes.push(t("trades.fail"));
        results.forEach((x) => {
          if (x.r.source === "api") notes.push(t("trades.apiFallback", { chain: chainName(x.id), n: x.r.poolsCovered }));
          else if (!x.r.complete) notes.push(t("trades.truncated", { chain: chainName(x.id) }));
        });
        if (results.length || pending.size) failed.forEach((id) => notes.push(t("trades.chainFail", { chain: chainName(id) })));
        status.textContent = notes.join(" · ");
      }
      function draw() {
        drawStatus();
        results.sort((a, b) => CHAIN_IDS.indexOf(a.id) - CHAIN_IDS.indexOf(b.id));
        const all = results.flatMap((x) => x.r.swaps).sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const known = results.length > 0;
        const to = Math.floor(Date.now() / 1000);
        strip.innerHTML = "";
        if (known) MR.pulseStrip(strip, results.map((x) => ({ label: CONFIG.chains[x.id].short + " · " + fmtInt(x.r.swaps.length), color: SERIES[x.id], dots: swapDots(x.r.swaps, 300) })), to - sec, to, { xFmt: (x) => fmtTime(x).slice(0, 5) });
        else strip.appendChild(empty(pending.size ? t("common.loading") + "…" : t("trades.fail")));

        const biggest = all.reduce((m, s) => ((s.usd || 0) > (m ? m.usd || 0 : 0) ? s : m), null);
        const recipients = new Set(all.filter((s) => s.recipient).map((s) => s.recipient));
        statsEl.innerHTML = "";
        statsEl.appendChild(statTile(t("trades.stats.count"), known ? fmtInt(all.length) : t("common.na")));
        statsEl.appendChild(statTile(t("trades.stats.volume"), known ? fmtUsd(sum(all, (s) => s.usd)) : t("common.na")));
        statsEl.appendChild(statTile(t("trades.stats.biggest"), biggest ? fmtUsd(biggest.usd) : t("common.na"), biggest ? biggest.pair : null));
        statsEl.appendChild(statTile(t("trades.stats.uniq"), recipients.size ? fmtInt(recipients.size) : t("common.na")));

        const agg = new Map();
        all.forEach((s) => { const k = s.chainId + ":" + s.pool; const a = agg.get(k) || { label: s.pair, chainId: s.chainId, pool: s.pool, usd: 0, n: 0 }; a.usd += s.usd || 0; a.n++; agg.set(k, a); });
        const top = [...agg.values()].sort((a, b) => b.usd - a.usd).slice(0, 12);
        if (top.length) MR.barRows(perPool, top.map((a) => ({ label: a.label, sub: chainName(a.chainId) + " · " + fmtInt(a.n), value: a.usd, color: SERIES[a.chainId], href: "#/pool/" + a.chainId + "/" + a.pool })), fmtUsd);
        else { perPool.innerHTML = ""; perPool.appendChild(empty(pending.size ? t("common.loading") + "…" : t("trades.empty"))); }

        tbl.innerHTML = "";
        if (!all.length) tbl.appendChild(empty(pending.size ? t("common.loading") + "…" : known ? t("trades.empty") : t("trades.fail")));
        else tbl.appendChild(table([{ label: t("trades.cols.time") }, { label: t("trades.cols.chain") }, { label: t("trades.cols.pool") }, { label: t("trades.cols.side") }, { label: t("trades.cols.amountIn"), num: true }, { label: t("trades.cols.amountOut"), num: true }, { label: t("trades.cols.usd"), num: true }, { label: t("trades.cols.trader") }, { label: t("trades.cols.tx") }],
          all.slice(0, 150).map((s) => h("tr", null, td(fmtTime(s.ts), "num"), td(chainChip(s.chainId)), td(h("a", { href: "#/pool/" + s.chainId + "/" + s.pool }, s.pair)), td(sideCell(s)), td(fmtNum(s.amountIn) + " " + s.tokIn.sym, "num"), td(fmtNum(s.amountOut) + " " + s.tokOut.sym, "num"), td(fmtUsd(s.usd), "num"), td(s.recipient ? h("a", { href: "#/wallet/" + s.recipient }, short(s.recipient)) : t("common.na")), td(h("a", { href: explorerTx(s.chainId, s.tx), target: "_blank", rel: "noopener" }, short(s.tx, 3))))),
          { cls: "compact trades" }));
      }
    }
    function scheduleAuto() {
      if (T.timer) clearInterval(T.timer);
      T.timer = null;
      if (!T.auto) return;
      const timer = setInterval(() => {
        if (status.isConnected) runTrades();
        else {
          clearInterval(timer); // this view is gone; a newer one schedules its own refresh
          if (T.timer === timer) T.timer = null;
        }
      }, 60000);
      T.timer = timer;
    }
    runTrades();
    scheduleAuto();
  }

  // ----- wallet -----
  function viewWallet(main) {
    const W = S.wallet;
    const fromRoute = S.route.parts[1];
    if (fromRoute && /^0x[0-9a-fA-F]{40}$/.test(fromRoute) && fromRoute.toLowerCase() !== (W.addr || "").toLowerCase()) { W.addr = fromRoute; W.results = null; }
    const input = h("input", { type: "text", class: "search mono", placeholder: t("wallet.placeholder"), value: W.addr, "aria-label": t("wallet.placeholder"), spellcheck: "false", autocomplete: "off" });
    const btn = h("button", { type: "button", class: "btn primary", onclick: () => submit() }, t("wallet.lookup"));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    main.appendChild(h("div", { class: "page-head" }, h("div", null, h("h1", null, t("wallet.title")), h("p", { class: "hint" }, t("wallet.hint")))));
    main.appendChild(h("div", { class: "lookup" }, input, btn));
    const status = h("p", { class: "count", "aria-live": "polite" });
    const out = h("div");
    main.appendChild(status);
    main.appendChild(out);

    function submit() {
      const v = input.value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) { status.textContent = t("wallet.invalid"); return; }
      if (location.hash !== "#/wallet/" + v) { location.hash = "#/wallet/" + v; return; } // the route change runs the lookup
      W.results = null;
      run();
    }
    /** When and at which block the chain's first Metric pool was created: no swap can be older. */
    function firstPool(chainId) {
      let ts = Infinity;
      let block = Infinity;
      for (const p of pools().concat(emptyPools())) {
        if (p.chainId !== chainId) continue;
        if (p.created > 0 && p.created < ts) ts = p.created;
        if (p.createdBlock > 0 && p.createdBlock < block) block = p.createdBlock;
      }
      return { ts: isFinite(ts) ? ts - 3600 : 0, block: isFinite(block) ? block : 0 };
    }
    /** Positions (Metric API) and swap history (explorer + chain) of one address. Never rejects: failures are listed in the result. */
    function lookup(addr) {
      if (W.pending && W.pending.addr === addr) return W.pending.promise; // a redraw joins the lookup already in flight
      const promise = (async () => {
        const res = { addr, positions: [], posFailed: [], swaps: [], swapNotes: [] };
        await Promise.all(CHAIN_IDS.map(async (id) => {
          try {
            res.positions.push(...(await MR.walletPositions(id, addr, findPool)));
          } catch (e) {
            res.posFailed.push(id);
          }
        }).concat(CHAIN_IDS.map(async (id) => {
          try {
            const r = await MR.walletSwaps(id, addr, findPool, firstPool(id));
            if (!r.supported) res.swapNotes.push({ id, kind: "unsupported" });
            else {
              res.swaps.push(...r.swaps);
              if (!r.complete) res.swapNotes.push({ id, kind: "partial" });
            }
          } catch (e) {
            res.swapNotes.push({ id, kind: e.rateLimited ? "limited" : "failed" });
          }
        })));
        res.positions.sort((a, b) => (b.value || 0) - (a.value || 0));
        if (W.pending && W.pending.promise === promise) W.pending = null;
        return res;
      })();
      W.pending = { addr, promise };
      return promise;
    }
    async function run() {
      const addr = W.addr;
      btn.disabled = true;
      status.textContent = t("wallet.scanning") + "…";
      out.innerHTML = "";
      const res = await lookup(addr);
      if (!out.isConnected) return; // this view was replaced; its successor awaits the same lookup
      btn.disabled = false;
      W.results = res;
      drawWallet();
    }
    function drawWallet() {
      const { positions, posFailed, swaps: rawSwaps, swapNotes } = W.results;
      const swaps = [...rawSwaps].sort((a, b) => (b.ts || 0) - (a.ts || 0));
      out.innerHTML = "";
      status.textContent = posFailed.map((id) => t("wallet.posFail", { chain: chainName(id) })).join(" ");
      const known = posFailed.length < CHAIN_IDS.length; // at least one chain answered
      const totalValue = sum(positions, (p) => p.value);
      const fees = sum(positions, (p) => p.feesEarned);
      const weighted = positions.filter((p) => p.value > 0 && p.periods["7d"].feeApr != null);
      const apr7 = weighted.length ? sum(weighted, (p) => p.value * p.periods["7d"].feeApr) / sum(weighted, (p) => p.value) : null;
      const swapVol = sum(swaps, (s) => s.usd);
      const swapChains = CHAIN_IDS.filter((id) => !swapNotes.some((n) => n.id === id && n.kind !== "partial")).map((id) => CONFIG.chains[id].short).join(" + ");
      out.appendChild(h("div", { class: "tiles" },
        statTile(t("wallet.summary.value"), known ? fmtUsd(totalValue) : t("common.na")),
        statTile(t("wallet.summary.positions"), known ? fmtInt(positions.length) : t("common.na"), positions.length ? t("wallet.summary.chains", { n: new Set(positions.map((p) => p.chainId)).size }) : null),
        statTile(t("wallet.summary.fees"), known ? fmtUsd(fees) : t("common.na")),
        statTile(t("wallet.summary.apr7"), apr7 != null ? fmtPct(apr7, 1) : t("common.na")),
        statTile(t("wallet.summary.swapVol"), swapChains ? fmtUsd(swapVol) : t("common.na"), swapChains || null),
        statTile(t("wallet.summary.swapCount"), swapChains ? fmtInt(swaps.length) : t("common.na"), swaps.length ? t("wallet.summary.lastSwap") + " " + fmtDate(swaps[0].ts, true) : null)
      ));
      const shareTxt = t("wallet.shareText", { swaps: fmtInt(swaps.length), vol: fmtUsd(swapVol), positions: fmtInt(positions.length), value: fmtUsd(totalValue) });
      out.appendChild(h("div", { class: "card-foot" }, linkBtn(t("wallet.share"), xShare(shareTxt, location.href), "ghost"), linkBtn(t("wallet.openPortfolio"), "https://app.metric.xyz/portfolio", "ghost")));

      // positions
      const posEl = h("div", { class: "positions" });
      if (!positions.length) posEl.appendChild(empty(posFailed.length === CHAIN_IDS.length ? t("wallet.posUnavailable") : t("wallet.noPositions")));
      positions.forEach((pos) => posEl.appendChild(positionCard(pos)));
      out.appendChild(section(t("wallet.positions"), t("wallet.positionsHint"), posEl));
      out.appendChild(section(t("wallet.points"), null, h("p", { class: "hint" }, t("wallet.pointsNote"))));

      // swaps
      const swapSection = section(t("wallet.swaps"), t("wallet.swapScope"));
      swapNotes.filter((n) => n.kind !== "unsupported").forEach((n) => swapSection.appendChild(note(t("wallet.swapNote." + n.kind, { chain: chainName(n.id) }))));
      if (swaps.length) {
        const byChain = CHAIN_IDS.map((id) => { const cs = swaps.filter((s) => s.chainId === id); return { label: chainName(id), value: sum(cs, (s) => s.usd), color: SERIES[id], sub: fmtInt(cs.length) + " swap" }; }).filter((r) => r.value > 0);
        const agg = new Map();
        swaps.forEach((s) => { const k = s.chainId + ":" + s.pool; const a = agg.get(k) || { label: s.pair, chainId: s.chainId, pool: s.pool, usd: 0, n: 0 }; a.usd += s.usd || 0; a.n++; agg.set(k, a); });
        const bc = h("div");
        const bp = h("div");
        MR.barRows(bc, byChain, fmtUsd);
        MR.barRows(bp, [...agg.values()].sort((a, b) => b.usd - a.usd).slice(0, 10).map((a) => ({ label: a.label, sub: chainName(a.chainId) + " · " + fmtInt(a.n), value: a.usd, color: SERIES[a.chainId], href: "#/pool/" + a.chainId + "/" + a.pool })), fmtUsd);
        swapSection.appendChild(h("div", { class: "grid-2 plain" }, h("div", null, h("h3", null, t("wallet.byChain")), bc), h("div", null, h("h3", null, t("wallet.byPool")), bp)));
        swapSection.appendChild(table([{ label: t("wallet.swapCols.time") }, { label: t("wallet.swapCols.chain") }, { label: t("wallet.swapCols.pool") }, { label: t("wallet.swapCols.side") }, { label: t("wallet.swapCols.in"), num: true }, { label: t("wallet.swapCols.out"), num: true }, { label: t("wallet.swapCols.usd"), num: true }, { label: t("wallet.swapCols.tx") }],
          swaps.slice(0, 200).map((s) => h("tr", null, td(s.ts ? fmtDate(s.ts, true) : "#" + fmtInt(s.block), "num"), td(chainChip(s.chainId)), td(h("a", { href: "#/pool/" + s.chainId + "/" + s.pool }, s.pair)), td(sideCell(s)), td(fmtNum(s.amountIn) + " " + s.tokIn.sym, "num"), td(fmtNum(s.amountOut) + " " + s.tokOut.sym, "num"), td(fmtUsd(s.usd), "num"), td(h("a", { href: explorerTx(s.chainId, s.tx), target: "_blank", rel: "noopener" }, short(s.tx, 3))))),
          { cls: "compact" }));
      } else if (swapChains) swapSection.appendChild(empty(t("wallet.noSwaps")));
      out.appendChild(swapSection);
    }
    function positionCard(pos) {
      const p = pos.pool;
      const st = pos.status;
      const stTxt = st === "in" ? t("wallet.pos.inRange") : st === "edge" ? t("wallet.pos.edge") : st === "out" ? t("wallet.pos.outRange") : t("common.na");
      const stNote = st === "out" ? t("wallet.pos.outNote") : st === "edge" ? t("wallet.pos.edgeNote") : null;
      const lo = Math.min(...pos.bins), hi = Math.max(...pos.bins);
      const w7 = pos.periods["7d"];
      const all = pos.periods.all;
      const amount = (v, tok) => (v != null && tok ? fmtNum(v) + " " + tok.sym : t("common.na"));
      const perfRows = PERIODS.map((w) => {
        const x = pos.periods[w];
        return h("tr", null, td(t("wallet.period." + w)), td(x.feeApr != null ? fmtPct(x.feeApr, 1) : t("common.na"), "num"), td(fmtUsd(x.feeIncome), "num"), td(fmtUsd(x.pnl), "num " + signCls(x.pnl)), td(fmtUsd(x.markout), "num " + signCls(x.markout)), td(fmtUsd(x.volume), "num"));
      });
      return h("div", { class: "pos-card" },
        h("div", { class: "pos-head" }, p ? h("a", { href: "#/pool/" + p.chainId + "/" + p.address }, pairCell(p)) : h("span", { class: "mono" }, short(pos.poolAddress)), chainChip(pos.chainId), tierChip({ private: !!(p && p.private), tier: pos.tier })),
        h("div", { class: "pos-grid" },
          h("div", null, h("small", null, t("wallet.pos.value")), h("b", { class: "big" }, fmtUsd(pos.value))),
          h("div", null, h("small", null, t("wallet.pos.amounts")), h("span", null, amount(pos.amt0, p && p.t0)), h("br"), h("span", null, amount(pos.amt1, p && p.t1))),
          h("div", null, h("small", null, t("wallet.pos.bins")), h("span", { class: "num" }, "#" + lo + (lo !== hi ? " … #" + hi : "") + " (" + pos.bins.length + ")"), h("small", { class: "under" }, t("detail.activeBin") + " #" + (p && p.curBinIdx != null ? p.curBinIdx : "?"))),
          h("div", null, h("small", null, t("wallet.pos.status")), h("span", { class: "chip st st-" + (st === "in" ? "healthy" : st === "out" ? "feed_down" : st === "edge" ? "pool_paused" : "unknown") }, h("i", { class: "sw" }), stTxt), stNote ? h("small", { class: "under" }, stNote) : null),
          h("div", null, h("small", null, t("wallet.pos.feeApr")), h("span", null, w7.feeApr != null ? fmtPct(w7.feeApr, 1) : t("common.na"))),
          h("div", null, h("small", null, t("wallet.pos.fees")), h("span", null, fmtUsd(pos.feesEarned)), pos.fees24 != null ? h("small", { class: "under" }, t("wallet.pos.fees24") + " " + fmtUsd(pos.fees24)) : null),
          h("div", null, h("small", null, t("wallet.pos.pnl")), h("span", { class: signCls(all.pnl) }, fmtUsd(all.pnl))),
          h("div", null, h("small", null, t("wallet.pos.opened")), h("span", null, fmtDate(pos.openedAt || pos.lastDeposit, true)))
        ),
        h("details", { class: "pos-more" }, h("summary", null, t("wallet.pos.performance")),
          table([{ label: t("detail.window") }, { label: t("wallet.pos.feeAprCol"), num: true }, { label: t("wallet.pos.feeIncome"), num: true }, { label: t("wallet.pos.pnl"), num: true }, { label: t("wallet.pos.markout"), num: true }, { label: t("wallet.pos.volume"), num: true }], perfRows, { cls: "compact" })),
        h("p", { class: "sub mono" }, t("wallet.pos.salt") + " " + pos.salt)
      );
    }
    if (W.addr && /^0x[0-9a-fA-F]{40}$/.test(W.addr)) {
      if (W.results && W.results.addr === W.addr) drawWallet();
      else run();
    }
  }

  // ----- guide -----
  function viewGuide(main) {
    const G = I18N[S.lang].guide;
    main.appendChild(h("div", { class: "page-head" }, h("div", null, h("h1", null, G.title), h("p", { class: "hint" }, G.intro))));
    const art = h("article", { class: "guide" });
    [G.s1, G.s2].forEach((s) => art.appendChild(h("section", null, h("h2", null, s.h), h("p", null, s.p))));
    art.appendChild(h("section", null, h("h2", null, G.s3.h), h("p", null, G.s3.p), h("div", { class: "ways" }, ...G.s3.items.map((it) => h("div", { class: "way" }, h("h3", null, it.t), h("p", null, it.d))))));
    art.appendChild(h("section", null, h("h2", null, G.s4.h), h("p", null, G.s4.p), h("div", { class: "chips-row" }, ...["green", "yellow", "red"].map((k) => h("span", { class: "chip tier tier-" + k }, h("i", { class: "sw" }), t("tiers." + k))))));
    art.appendChild(h("section", null, h("h2", null, G.s5.h), h("ol", { class: "checklist" }, ...G.s5.items.map((it) => h("li", null, it)))));
    art.appendChild(h("section", null, h("h2", null, G.s6.h), h("p", null, G.s6.p)));
    const links = [["https://app.metric.xyz", G.links.app], ["https://docs.metric.xyz", G.links.docs], ["https://app.metric.xyz/referrals/", G.links.referrals], ["https://discord.gg/metricxyz", G.links.discord], ["https://x.com/KriptoliaTR", G.links.kriptolia], ["https://github.com/kriptolia/metric-radar", G.links.repo]];
    art.appendChild(h("section", null, h("h2", null, G.links.h), h("div", { class: "chips-row" }, ...links.map(([u, l]) => linkBtn(l, u, "ghost")))));
    art.appendChild(h("p", { class: "risk" }, G.disclaimer));
    main.appendChild(art);
  }

  // ---------- settings dialog ----------
  function openSettings() {
    const dlg = $("#settingsDialog");
    const cur = MR.settings.get();
    dlg.innerHTML = "";
    const api = h("input", { type: "url", value: cur.apiBase || CONFIG.apiBase, class: "search mono" });
    const rpcs = CHAIN_IDS.map((id) => ({ id, el: h("input", { type: "text", class: "search mono", value: ((cur.rpc && cur.rpc[id]) || []).join(", "), placeholder: MR.logEndpoints(id).map((e) => e.url).join(", ") }) }));
    const form = h("form", { method: "dialog", class: "settings" },
      h("h2", null, t("common.settings")),
      h("label", null, h("span", null, t("common.settingsApi")), api, h("small", null, t("common.settingsApiHint"))),
      h("p", { class: "sub" }, t("common.settingsRpcHint")),
      ...rpcs.map((r) => h("label", null, h("span", null, t("common.settingsRpc") + " · " + chainName(r.id)), r.el)),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn ghost", onclick: () => { MR.settings.set({}); location.reload(); } }, t("common.reset")),
        h("button", { type: "button", class: "btn ghost", onclick: () => dlg.close() }, t("common.close")),
        h("button", { type: "submit", class: "btn primary", onclick: (e) => {
          e.preventDefault();
          const s = { rpc: {} };
          const base = api.value.trim().replace(/\/+$/, "");
          if (base && base !== MR.config.apiBase) s.apiBase = base; // keep following the default unless it was changed
          else if (cur.apiBase) s.apiBase = cur.apiBase;
          rpcs.forEach((r) => { const list = r.el.value.split(",").map((x) => x.trim()).filter(Boolean); if (list.length) s.rpc[r.id] = list; });
          MR.settings.set(s);
          location.reload();
        } }, t("common.save")))
    );
    dlg.appendChild(form);
    dlg.showModal();
  }

  // ---------- render ----------
  function render(opts) {
    S.route = parseRoute();
    renderShell();
    const main = $("#main");
    const y = window.scrollY;
    main.innerHTML = "";
    if (!S.data) {
      main.appendChild(h("div", { class: "loading" }, h("div", { class: "spinner" }), h("p", null, t("common.loading") + "…")));
      return;
    }
    if (S.status.source === "error" && !pools().length && S.route.name !== "guide") {
      main.appendChild(h("div", { class: "loading" }, h("p", null, t("source.error")), h("p", { class: "hint" }, S.status.error || ""), h("button", { type: "button", class: "btn primary", onclick: () => location.reload() }, t("common.retry"))));
      return;
    }
    const v = { overview: viewOverview, pools: viewPools, pool: viewPool, trades: viewTrades, wallet: viewWallet, guide: viewGuide }[S.route.name] || viewOverview;
    v(main);
    window.scrollTo(0, opts && opts.keepScroll ? y : 0);
    const titled = S.route.name === "pool" ? findPool(S.route.parts[1], S.route.parts[2] || "") : null;
    document.title = (titled ? titled.pair + " · " : S.route.name !== "overview" && S.route.name !== "pool" ? t("nav." + S.route.name) + " · " : "") + t("appName");
  }

  // ---------- boot ----------
  async function boot() {
    S.lang = detectLang();
    try { S.theme = localStorage.getItem("mr.theme") || (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"); } catch (e) { S.theme = "dark"; }
    applyTheme();
    document.documentElement.lang = S.lang;
    $("#langBtn").addEventListener("click", () => { S.lang = S.lang === "tr" ? "en" : "tr"; try { localStorage.setItem("mr.lang", S.lang); } catch (e) { /* ignore */ } document.documentElement.lang = S.lang; render({ keepScroll: true }); });
    $("#themeBtn").addEventListener("click", () => { S.theme = S.theme === "dark" ? "light" : "dark"; try { localStorage.setItem("mr.theme", S.theme); } catch (e) { /* ignore */ } applyTheme(); render({ keepScroll: true }); });
    $("#settingsBtn").addEventListener("click", openSettings);
    render();

    // 1) the hourly snapshot paints the page at once; 2) the API then brings the funded pools up to the minute
    const snap = await MR.loadSnapshot();
    const hadSnapshot = snap.pools.length > 0;
    if (hadSnapshot) {
      S.data = snap;
      S.status = { source: "snapshot", generatedAt: snap.generatedAt, api: "pending" };
      render();
    }
    try {
      S.data = await MR.refreshLive(S.data || snap);
      S.status = { source: "live", generatedAt: snap.generatedAt, api: "ok" };
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.warn("Metric Radar: live API failed" + (hadSnapshot ? ", showing the snapshot" : "") + ":", msg);
      if (!S.data) S.data = snap;
      S.status = hadSnapshot ? { source: "snapshot", generatedAt: snap.generatedAt, api: "down", error: msg } : { source: "error", api: "down", error: msg + (snap.error ? " · snapshot: " + snap.error : "") };
    }
    // Fresh numbers matter on the overview and the pool list. Elsewhere a re-render would only interrupt
    // (a lookup in progress, a form being typed in), so those views pick the new data up on the next navigation.
    const focused = document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (!hadSnapshot || ((S.route.name === "overview" || S.route.name === "pools") && !focused)) render({ keepScroll: true });
    else renderSource();
  }
  document.addEventListener("DOMContentLoaded", boot);
})();

/* Metric Radar — app shell, router and views. */
(function () {
  "use strict";
  const MR = (window.MR = window.MR || {});
  const I18N = window.MR_I18N;
  const CONFIG = MR.config;
  const CHAIN_IDS = Object.keys(CONFIG.chains).map(Number);
  const SERIES = { 1: "var(--series-1)", 56: "var(--series-2)", 4663: "var(--series-3)" };
  const TIER_ORDER = ["green", "yellow", "red", "unclassified", "black"];

  // ---------- state ----------
  const S = {
    lang: null,
    theme: null,
    data: null, // { pools, history, status }
    status: { source: "loading" },
    route: null,
    pulse: null,
    trades: { window: "1h", results: {}, loading: false, auto: false, timer: null },
    wallet: { addr: "", results: null, loading: false, errors: [] },
    poolsView: { chain: "all", tier: new Set(["green", "yellow", "red", "unclassified"]), status: "any", minTvl: 1000, healthy: false, verified: false, hidePrivate: false, q: "", sort: "tvl", dir: "desc" },
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
    if (a >= 100) return sign + "$" + a.toFixed(0);
    if (a >= 1) return sign + "$" + a.toFixed(digits != null ? digits : 2);
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
    const s = (signed && p > 0 ? "+" : "") + (Math.abs(p) >= 1000 ? p.toFixed(0) : Math.abs(p) >= 100 ? p.toFixed(1) : p.toFixed(2)) + "%";
    return s;
  }
  function fmtPct(frac, d) {
    if (frac == null || !isFinite(frac)) return t("common.na");
    return (frac * 100).toFixed(d != null ? d : 1) + "%";
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
    const c = h("span", { class: "chip tier tier-" + tier, title: t("tiers.desc." + tier) }, h("i", { class: "sw" }), withText === false ? "" : t("tiers." + tier));
    return c;
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
      const a = h("a", { href: "#/" + n, class: "tab" + ((r.name === n || (n === "pools" && r.name === "pool")) ? " active" : ""), "aria-current": r.name === n ? "page" : null }, t("nav." + n));
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
    b.title = st.error ? st.error : "";
  }

  // ---------- data helpers ----------
  function pools() {
    return (S.data && S.data.pools) || [];
  }
  function poolByKey(chainId, addr) {
    const a = addr.toLowerCase();
    return pools().find((p) => p.chainId === Number(chainId) && p.address.toLowerCase() === a);
  }
  function histKey(p) {
    return p.chainId + ":" + p.address.toLowerCase();
  }
  function sum(arr, f) {
    return arr.reduce((s, x) => s + (f(x) || 0), 0);
  }

  // ---------- views ----------
  function viewOverview(main) {
    const ps = pools();
    const live = ps.filter((p) => p.tier !== "black");
    const tvl = sum(live, (p) => p.tvl);
    const vol24 = sum(live, (p) => p.vol24);
    const vol7 = sum(live, (p) => p.vol7);
    const volAll = sum(live, (p) => p.volAll);
    const swaps24 = sum(live, (p) => p.swaps24);
    const fees24 = sum(live, (p) => p.fees24);
    const healthy = live.filter((p) => p.ppStatus === "healthy" && !(p.pauseLevel > 0)).length;

    const hero = h("section", { class: "hero" },
      h("div", { class: "hero-text" }, h("h1", null, t("overview.title")), h("p", { class: "lead" }, t("tagline"))),
      h("div", { class: "tiles" },
        statTile(t("overview.tvl"), fmtUsd(tvl)),
        statTile(t("overview.vol24"), fmtUsd(vol24)),
        statTile(t("overview.vol7"), fmtUsd(vol7)),
        statTile(t("overview.volAll"), fmtUsd(volAll)),
        statTile(t("overview.pools"), fmtInt(live.length), healthy + " " + t("ppStatus.healthy").toLowerCase()),
        statTile(t("overview.swaps24"), fmtInt(swaps24)),
        statTile(t("overview.fees24"), fmtUsd(fees24))
      )
    );
    main.appendChild(hero);

    // pulse strip
    const pulseBody = h("div", { class: "pulse-body" }, h("p", { class: "mr-empty" }, t("common.loading") + "…"));
    main.appendChild(section(t("overview.pulse"), t("overview.pulseHint"), pulseBody, h("div", { class: "card-foot" }, linkBtn(t("overview.seeTrades"), "#/trades", "ghost"))));
    loadPulse(pulseBody);

    // by chain
    const grid = h("div", { class: "grid-2" });
    const byChain = CHAIN_IDS.map((id) => {
      const cp = live.filter((p) => p.chainId === id);
      return { id, tvl: sum(cp, (p) => p.tvl), vol24: sum(cp, (p) => p.vol24), vol7: sum(cp, (p) => p.vol7), n: cp.length, swaps: sum(cp, (p) => p.swaps24) };
    });
    const chainTbl = table(
      [{ label: t("pools.cols.chain") }, { label: t("detail.tvl"), num: true }, { label: t("pools.cols.vol24"), num: true }, { label: t("overview.poolsShort"), num: true }, { label: t("pools.cols.swaps24"), num: true }, { label: "TVL 7d", num: true }],
      byChain.map((c) => {
        const hist = seriesFor(c.id, "tvl", 7 * 24);
        return h("tr", null,
          td(h("a", { href: "#/pools?chain=" + c.id }, chainChip(c.id, true))),
          td(fmtUsd(c.tvl), "num"), td(fmtUsd(c.vol24), "num"), td(fmtInt(c.n), "num"), td(fmtInt(c.swaps), "num"),
          td(hist.length > 1 ? MR.sparkline(hist, SERIES[c.id], 90, 28) : "—", "num spark")
        );
      }),
      { cls: "compact" }
    );
    grid.appendChild(section(t("overview.byChain"), null, chainTbl));

    // tier mix
    const tierCounts = {};
    live.forEach((p) => {
      const k = tierOf(p);
      tierCounts[k] = tierCounts[k] || { n: 0, tvl: 0 };
      tierCounts[k].n++;
      tierCounts[k].tvl += p.tvl || 0;
    });
    const order = ["green", "yellow", "red", "private", "unclassified"];
    const seg = h("div", { class: "segbar", role: "img", "aria-label": t("overview.tierMix") });
    const legend = h("div", { class: "seg-legend" });
    order.forEach((k) => {
      const c = tierCounts[k];
      if (!c || !c.tvl) return;
      const w = (c.tvl / Math.max(1, tvl)) * 100;
      seg.appendChild(h("div", { class: "seg tier-" + k, style: "width:" + w + "%", title: t("tiers." + k) + " " + fmtUsd(c.tvl) }));
      legend.appendChild(h("div", { class: "seg-item" }, h("span", { class: "chip tier tier-" + k }, h("i", { class: "sw" }), t("tiers." + k)), h("span", { class: "num" }, fmtInt(c.n) + " · " + fmtUsd(c.tvl) + " · " + (w).toFixed(0) + "%")));
    });
    grid.appendChild(section(t("overview.tierMix"), null, seg, legend));
    main.appendChild(grid);

    // top pools
    const grid2 = h("div", { class: "grid-2" });
    const topVol = live.filter((p) => p.vol24).sort((a, b) => b.vol24 - a.vol24).slice(0, 8);
    grid2.appendChild(section(t("overview.topPools"), null, miniPoolTable(topVol, "vol24")));
    const topApr = live
      .filter((p) => (p.tvl || 0) >= 10000 && markout(p, "7d", "5m") && markout(p, "7d", "5m").aprBps != null && (markout(p, "7d", "5m").priced || 0) >= 0.7)
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
      MR.lineChart(tvlChart, { series: hs, yFmt: fmtUsd, xFmt: (x, full) => fmtDate(x, !!full), area: true, emptyText: t("overview.historyEmpty"), tableLabel: t("common.tableView"), xLabel: t("trades.cols.time") });
      const vs = CHAIN_IDS.map((id) => ({ name: chainName(id), color: SERIES[id], points: dailySeriesFor(id, "vol24") }));
      MR.lineChart(volChart, { series: vs, yFmt: fmtUsd, xFmt: (x, full) => fmtDate(x, false), emptyText: t("overview.historyEmpty"), tableLabel: t("common.tableView"), xLabel: t("trades.cols.time") });
    });
    main.appendChild(h("div", { class: "card-foot center" }, linkBtn(t("overview.seeAllPools"), "#/pools", "primary")));
  }

  function miniPoolTable(list, metric) {
    if (!list.length) return empty(t("pools.empty"));
    return table(
      [{ label: t("pools.cols.pair") }, { label: t("pools.cols.chain") }, { label: t("pools.cols.tier") }, { label: t("pools.cols.tvl"), num: true }, { label: metric === "vol24" ? t("pools.cols.vol24") : t("pools.cols.markoutShort"), num: true }],
      list.map((p) =>
        h("tr", { class: "row-link", onclick: () => go("pool/" + p.chainId + "/" + p.address) },
          td(h("a", { href: "#/pool/" + p.chainId + "/" + p.address }, pairCell(p))),
          td(chainChip(p.chainId)),
          td(tierChip(p)),
          td(fmtUsd(p.tvl), "num"),
          td(metric === "vol24" ? fmtUsd(p.vol24) : fmtBps(markout(p, "7d", "5m") && markout(p, "7d", "5m").aprBps, true), "num " + (metric !== "vol24" ? signCls(markout(p, "7d", "5m") && markout(p, "7d", "5m").aprBps) : ""))
        )
      ),
      { cls: "compact" }
    );
  }
  function signCls(v) {
    return v == null ? "" : v < 0 ? "neg" : v > 0 ? "pos" : "";
  }

  // history series: [[ts, value]]
  function seriesFor(chainId, field, maxPoints) {
    const hst = S.data && S.data.history;
    if (!hst || !hst.hourly || !hst.hourly[chainId]) return [];
    const idx = { ts: 0, tvl: 1, vol24: 2, pools: 3, swaps24: 4 };
    return hst.hourly[chainId].slice(-(maxPoints || 1000)).map((r) => [r[0], r[idx[field]]]);
  }
  function dailySeriesFor(chainId, field) {
    const hst = S.data && S.data.history;
    if (!hst || !hst.daily || !hst.daily[chainId]) return [];
    const idx = { ts: 0, tvl: 1, vol24: 2, pools: 3, swaps24: 4 };
    return hst.daily[chainId].map((r) => [r[0], r[idx[field]]]);
  }
  function poolHistory(p) {
    const hst = S.data && S.data.history;
    if (!hst || !hst.pools) return [];
    return hst.pools[histKey(p)] || [];
  }

  async function loadPulse(container) {
    const ps = pools().filter((p) => p.tier !== "black");
    if (!ps.length) return;
    const windowSec = 3600;
    const rows = [];
    let okAny = false;
    const to = Math.floor(Date.now() / 1000);
    await Promise.all(
      CHAIN_IDS.map(async (id) => {
        const cp = ps.filter((p) => p.chainId === id);
        if (!cp.length) return;
        try {
          const r = await MR.recentSwaps(id, cp, windowSec, { maxCalls: 8 });
          okAny = true;
          S.trades.results[id + ":1h"] = r;
          rows.push({ id, label: CONFIG.chains[id].short + " · " + r.swaps.length, color: SERIES[id], dots: r.swaps.map((s) => ({ t: s.ts, usd: s.usd || 0, href: explorerTx(id, s.tx), title: `<div class="mr-tip-head">${esc(s.pair)} · ${fmtTime(s.ts)}</div><div>${s.side === "sell" ? t("trades.sell") : t("trades.buy")} ${esc(fmtNum(s.amountIn))} ${esc(s.tokIn.sym)} → ${esc(fmtNum(s.amountOut))} ${esc(s.tokOut.sym)}</div><b>${fmtUsd(s.usd)}</b>` })) });
        } catch (e) {
          rows.push({ id, label: CONFIG.chains[id].short + " · —", color: SERIES[id], dots: [] });
        }
      })
    );
    if (!container.isConnected) return;
    if (!okAny) {
      container.innerHTML = "";
      container.appendChild(empty(t("overview.pulseUnavailable")));
      return;
    }
    rows.sort((a, b) => CHAIN_IDS.indexOf(a.id) - CHAIN_IDS.indexOf(b.id));
    MR.pulseStrip(container, rows, to - windowSec, to, { xFmt: (x) => fmtTime(x).slice(0, 5) });
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
    const tierBox = h("div", { class: "f" }, h("span", null, t("pools.tier")), h("div", { class: "chips" }, ...["green", "yellow", "red", "unclassified"].map((k) => {
      const b = h("button", { type: "button", class: "chip tier tier-" + k + (V.tier.has(k) ? " on" : ""), "aria-pressed": String(V.tier.has(k)), onclick: (e) => { if (V.tier.has(k)) V.tier.delete(k); else V.tier.add(k); e.currentTarget.classList.toggle("on"); e.currentTarget.setAttribute("aria-pressed", String(V.tier.has(k))); drawRows(); } }, h("i", { class: "sw" }), t("tiers." + k));
      return b;
    })));
    filters.appendChild(tierBox);
    filters.appendChild(sel(t("pools.minTvl"), V.minTvl, [[0, t("common.all")], [1000, "$1K"], [10000, "$10K"], [100000, "$100K"], [1000000, "$1M"]], (v) => { V.minTvl = Number(v); drawRows(); }));
    filters.appendChild(sel(t("pools.sort"), V.sort, Object.keys(I18N.en.pools.sorts).map((k) => [k, t("pools.sorts." + k)]), (v) => { V.sort = v; drawRows(); }));
    const toggles = h("div", { class: "f toggles" },
      h("label", null, h("input", { type: "checkbox", checked: V.healthy ? "checked" : null, onchange: (e) => { V.healthy = e.target.checked; drawRows(); } }), t("pools.onlyHealthy")),
      h("label", null, h("input", { type: "checkbox", checked: V.verified ? "checked" : null, onchange: (e) => { V.verified = e.target.checked; drawRows(); } }), t("pools.onlyVerified")),
      h("label", null, h("input", { type: "checkbox", checked: V.hidePrivate ? "checked" : null, onchange: (e) => { V.hidePrivate = e.target.checked; drawRows(); } }), t("pools.hidePrivate"))
    );
    filters.appendChild(toggles);
    const search = h("input", { type: "search", class: "search", placeholder: t("pools.search"), value: V.q, "aria-label": t("pools.search"), oninput: (e) => { V.q = e.target.value.trim().toLowerCase(); drawRows(); } });
    filters.appendChild(h("div", { class: "f grow" }, search));
    main.appendChild(filters);

    const count = h("p", { class: "count" });
    const wrap = h("div");
    main.appendChild(count);
    main.appendChild(wrap);
    const actions = $(".page-actions", head);
    const csvBtn = h("button", { type: "button", class: "btn ghost", onclick: () => exportCsv(filtered()) }, t("pools.export"));
    actions.appendChild(csvBtn);

    function filtered() {
      let list = pools().filter((p) => p.tier !== "black");
      if (V.chain !== "all") list = list.filter((p) => String(p.chainId) === String(V.chain));
      list = list.filter((p) => V.tier.has(p.tier || "unclassified") || (p.private && V.tier.size));
      if (V.hidePrivate) list = list.filter((p) => !p.private);
      if (V.minTvl) list = list.filter((p) => (p.tvl || 0) >= V.minTvl);
      if (V.healthy) list = list.filter((p) => p.ppStatus === "healthy" && !(p.pauseLevel > 0));
      if (V.verified) list = list.filter((p) => p.verifiedAdmin);
      if (V.q) list = list.filter((p) => (p.pair + " " + p.address + " " + p.t0.name + " " + p.t1.name + " " + (p.adminName || "")).toLowerCase().includes(V.q));
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
      count.textContent = t("pools.count", { n: list.length });
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
      const rows = list.map((p) => {
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
    }
    drawRows();
  }
  function curatorCell(p) {
    const name = p.adminName || short(p.admin || p.creator);
    return h("span", { class: "curator" + (p.verifiedAdmin ? " verified" : "") , title: p.verifiedAdmin ? t("detail.verified") : t("detail.unverified") }, p.verifiedAdmin ? h("i", { class: "check" }) : null, name);
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
  function viewPool(main) {
    const [, chainId, addr] = S.route.parts;
    const p = poolByKey(chainId, addr || "");
    if (!p) {
      main.appendChild(h("p", { class: "mr-empty" }, t("pools.empty")));
      main.appendChild(linkBtn(t("detail.back"), "#/pools", "ghost"));
      return;
    }
    const mk75 = markout(p, "7d", "5m");
    const shareTxt = t("detail.shareText", { pair: p.pair, tvl: fmtUsd(p.tvl), vol: fmtUsd(p.vol24), apr: fmtBps(mk75 && mk75.aprBps, true) });
    main.appendChild(h("div", { class: "page-head" },
      h("div", null, h("a", { class: "back", href: "#/pools" }, "← " + t("detail.back")),
        h("h1", { class: "pool-title" }, h("span", { class: "tok-pair big" }, tokenLogo(p.t0, 28), tokenLogo(p.t1, 28)), p.pair),
        h("div", { class: "chips-row" }, chainChip(p.chainId), tierChip(p), statusChip(p), p.locked ? h("span", { class: "chip" }, t("detail.locked")) : h("span", { class: "chip warn" }, t("detail.changeable")))),
      h("div", { class: "page-actions" },
        linkBtn(t("detail.openOnMetric"), poolUrl(p), "primary"),
        linkBtn(t("detail.explorer"), explorerAddr(p.chainId, p.address), "ghost"),
        linkBtn(t("detail.share"), xShare(shareTxt, location.href), "ghost"),
        h("button", { type: "button", class: "btn ghost", onclick: (e) => { navigator.clipboard && navigator.clipboard.writeText(p.address); e.currentTarget.textContent = t("detail.copied"); } }, t("detail.copyAddr")))
    ));
    main.appendChild(h("p", { class: "addr num" }, p.address));

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
      p.reasons.length ? h("ul", { class: "reasons" }, ...p.reasons.map((r) => h("li", null, h("code", null, r), " — ", t("reasons." + r) === "reasons." + r ? r : t("reasons." + r)))) : h("p", { class: "ok" }, t("detail.noReasons")),
      h("p", { class: "risk" }, t("detail.riskNote"))
    );
    grid.appendChild(section(t("detail.reasonsTitle"), null, reasons));

    // curator & fees
    const lpShare = p.protocolFeeE6 != null && p.adminFeeE6 != null ? 1 - (p.protocolFeeE6 + p.adminFeeE6) / 1e6 : null;
    const feeRows = [
      [p.verifiedAdmin ? t("detail.curator") : t("detail.operator"), h("span", { class: "curator-cell" }, curatorCell(p), p.admin && p.adminName ? h("a", { class: "sub", href: explorerAddr(p.chainId, p.admin), target: "_blank", rel: "noopener" }, short(p.admin)) : null, " ", h("small", null, p.verifiedAdmin ? t("detail.verified") : t("detail.unverified")))],
      [t("detail.creator"), h("a", { href: explorerAddr(p.chainId, p.creator || ""), target: "_blank", rel: "noopener" }, short(p.creator))],
      [t("detail.created"), fmtDate(p.created, true) + " · " + ageText(p)],
      [t("detail.protocolShare"), p.protocolFeeE6 != null ? fmtPct(p.protocolFeeE6 / 1e6) : t("common.na")],
      [t("detail.adminShare"), p.adminFeeE6 != null ? fmtPct(p.adminFeeE6 / 1e6) : t("common.na")],
      [t("detail.lpShare"), lpShare != null ? fmtPct(lpShare) : t("common.na")],
      [t("detail.notional"), (p.protocolNotionalE8 || 0) + (p.adminNotionalE8 || 0) > 0 ? fmtPct(((p.protocolNotionalE8 || 0) + (p.adminNotionalE8 || 0)) / 1e8, 3) : "0%"],
    ];
    grid.appendChild(section(t("detail.fees"), t("detail.feesHint"), kv(feeRows)));
    main.appendChild(grid);

    // markout table
    const windows = ["24h", "7d", "30d", "all"], horizons = ["1m", "5m", "30m"];
    const mkRows = windows.map((w) => h("tr", null, td(w), ...horizons.map((hz) => {
      const m = markout(p, w, hz);
      if (!m) return td(t("common.na"), "num");
      return td(h("span", { title: (m.priced != null ? t("detail.priced") + " " + fmtPct(m.priced, 0) : "") + (m.tradedBins != null ? " · " + t("detail.tradedBins") + " " + m.tradedBins + "/" + (m.fundedBins != null ? m.fundedBins : "?") : "") },
        h("b", { class: signCls(m.aprBps) }, fmtBps(m.aprBps, true)), h("small", null, " " + fmtUsd(m.usd))), "num");
    })));
    main.appendChild(section(t("detail.markout"), t("detail.markoutHint"), table([{ label: t("detail.window") }, ...horizons.map((hz) => ({ label: t("detail.horizon") + " " + hz, num: true }))], mkRows, { cls: "compact" })));

    // pricing & guards
    const grid3 = h("div", { class: "grid-2" });
    const d = p.ppDetails || {};
    const prRows = [
      [t("detail.providerType"), d.providerType === "anchored" ? t("detail.anchored") : d.providerType === "regular" ? t("detail.regular") : t("detail.customProvider")],
      [t("detail.pricing"), h("a", { href: explorerAddr(p.chainId, p.ppAddress || ""), target: "_blank", rel: "noopener" }, short(p.ppAddress))],
      [t("detail.locked"), p.locked ? t("common.yes") : t("common.no")],
      [t("detail.cooldown"), p.cooldown && BigInt(p.cooldown) >= 2n ** 53n ? "∞" : p.cooldown ? fmtDur(Number(p.cooldown)) : t("common.na")],
      [t("detail.staleness"), d.maxRefStaleness != null ? d.maxRefStaleness + " s" : d.maxTimeDelta != null ? d.maxTimeDelta + " s" : t("common.na")],
      [t("detail.oracle"), d.oracle ? h("a", { href: explorerAddr(p.chainId, d.oracle), target: "_blank", rel: "noopener" }, short(d.oracle)) : t("common.na")],
      [t("detail.feedMode"), d.feedMode || t("common.na")],
      [t("detail.source"), d.source ? h("a", { href: explorerAddr(p.chainId, d.source), target: "_blank", rel: "noopener" }, short(d.source)) : t("common.na")],
    ];
    grid3.appendChild(section(t("detail.pricing"), null, kv(prRows)));
    const ext = p.extDetails || {};
    const sl = ext.stopLoss;
    const pv = ext.priceVelocity;
    const gRows = [
      [t("detail.stopLoss"), sl ? h("span", null, t("detail.drawdown") + " " + (sl.drawdownE6 != null ? fmtPct(Number(sl.drawdownE6) / 1e6, 0) : "?") + " · " + t("detail.decay") + " " + (sl.decayPerSecondE18 != null ? fmtPct((Number(sl.decayPerSecondE18) / 1e18) * 86400, 1) : "?") + " · " + t("detail.timelock") + " " + (sl.timelockSecs != null ? (Number(sl.timelockSecs) >= 1099511627775 ? t("detail.locked40") : fmtDur(Number(sl.timelockSecs))) : "?")) : t("detail.none")],
      [t("detail.velocity"), pv ? t("detail.maxChange") + " " + (pv.maxChangePerBlockE18 != null ? fmtPct(Number(pv.maxChangePerBlockE18) / 1e18, 2) : "?") : t("detail.none")],
      [t("detail.extensions"), p.extensions.length ? h("span", { class: "addr-list" }, ...p.extensions.map((a) => h("a", { href: explorerAddr(p.chainId, a), target: "_blank", rel: "noopener" }, short(a)))) : t("detail.none")],
      [t("detail.activeBin"), p.curBinIdx != null ? "#" + p.curBinIdx : t("common.na")],
    ];
    grid3.appendChild(section(t("detail.guards"), null, kv(gRows)));
    main.appendChild(grid3);

    // tokens
    const tokRows = [p.t0, p.t1].map((tk, i) => h("tr", null, td(h("span", { class: "pair" }, tokenLogo(tk, 20), " ", tk.sym, h("small", { class: "sub" }, tk.name))), td(h("a", { href: explorerAddr(p.chainId, tk.addr), target: "_blank", rel: "noopener" }, short(tk.addr))), td(tk.dec, "num"), td(fmtUsdFull(tk.price), "num"), td(fmtUsd(i === 0 ? p.liq0 : p.liq1), "num")));
    main.appendChild(section(t("detail.tokens"), null, table([{ label: t("detail.tokens") }, { label: "Address" }, { label: "Decimals", num: true }, { label: t("detail.price"), num: true }, { label: t("detail.liquidity"), num: true }], tokRows, { cls: "compact" })));

    // depth ladder (live)
    const depthBody = h("div");
    const depthBtn = h("button", { type: "button", class: "btn", onclick: () => loadDepth(p, depthBody, depthBtn) }, t("detail.depthLoad"));
    main.appendChild(section(t("detail.depth"), t("detail.depthHint"), h("div", { class: "card-foot" }, depthBtn), depthBody));
    // bins analytics
    const binsBody = h("div");
    const binsBtn = h("button", { type: "button", class: "btn", onclick: () => loadBins(p, binsBody, binsBtn) }, t("detail.binsLoad"));
    main.appendChild(section(t("detail.bins"), t("detail.binsHint"), h("div", { class: "card-foot" }, binsBtn), binsBody));
    if (S.status.source === "live") {
      loadDepth(p, depthBody, depthBtn);
      loadBins(p, binsBody, binsBtn);
    }

    // history
    const hist = poolHistory(p);
    const hc = h("div", { class: "chart" });
    main.appendChild(section(t("detail.history"), null, hc));
    requestAnimationFrame(() => {
      MR.lineChart(hc, { series: [{ name: t("detail.tvl"), color: SERIES[p.chainId], points: hist.map((r) => [r[0], r[1]]) }, { name: t("detail.vol24"), color: "var(--series-4)", points: hist.map((r) => [r[0], r[2]]) }], yFmt: fmtUsd, xFmt: (x, full) => fmtDate(x, !!full), emptyText: t("detail.historyEmpty"), tableLabel: t("common.tableView") });
    });
  }
  function kv(rows) {
    return h("dl", { class: "kv" }, ...rows.map(([k, v]) => h("div", { class: "kv-row" }, h("dt", null, k), h("dd", null, v))));
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
      body.appendChild(h("div", { class: "grid-2" }, h("div", null, h("h3", null, t("detail.bidSide")), depth.bids.length ? mkSide(depth.bids, true) : empty(t("detail.unavailableSide"))), h("div", null, h("h3", null, t("detail.askSide")), depth.asks.length ? mkSide(depth.asks, false) : empty(t("detail.unavailableSide")))));
      btn.textContent = t("trades.refresh");
    } catch (e) {
      body.innerHTML = "";
      body.appendChild(empty(t("detail.depthFail") + " (" + esc(e.message || e) + ")"));
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
      requestAnimationFrame(() => MR.binsChart(chart, bins, { yFmt: fmtUsd, tipHtml: (b) => `<div class="mr-tip-head">Bin #${b.bin}${b.active ? " · " + t("detail.activeBin") : ""}</div><div>${t("detail.liquidity")}: <b>${fmtUsd(b.value)}</b></div><div>7d ${t("detail.vol7").toLowerCase()}: ${fmtUsd(b.vol)}</div><div>7d LP: ${fmtUsd(b.fees)} · APR ${fmtBps(b.aprBps)}</div><div>Trading PnL APR: ${fmtBps(b.pnlAprBps, true)}</div><div>${t("detail.swaps24").replace(/24.*/, "")} ${b.swaps}</div>`, emptyText: t("detail.binsFail") }));
      const rows = bins.map((b) => h("tr", { class: b.active ? "active" : "" }, td("#" + b.bin, "num"), td(fmtUsd(b.value), "num"), td(fmtUsd(b.vol), "num"), td(fmtUsd(b.fees), "num"), td(fmtBps(b.aprBps), "num"), td(fmtBps(b.pnlAprBps, true), "num " + signCls(b.pnlAprBps)), td(fmtInt(b.swaps), "num")));
      const tb = table([{ label: t("detail.level"), num: true }, { label: t("detail.liquidity"), num: true }, { label: t("detail.vol7"), num: true }, { label: "7d LP", num: true }, { label: "APR", num: true }, { label: "PnL APR", num: true }, { label: "Swaps", num: true }], rows, { cls: "compact" });
      const twin = h("div", { class: "mr-table-twin" }, tb);
      twin.hidden = true;
      body.appendChild(h("button", { type: "button", class: "mr-linkbtn", onclick: () => (twin.hidden = !twin.hidden) }, t("common.tableView")));
      body.appendChild(twin);
      btn.textContent = t("trades.refresh");
    } catch (e) {
      body.innerHTML = "";
      body.appendChild(empty(t("detail.binsFail") + " (" + esc(e.message || e) + ")"));
      btn.textContent = t("common.retry");
    } finally {
      btn.disabled = false;
    }
  }

  // ----- trades -----
  function viewTrades(main) {
    const T = S.trades;
    main.appendChild(h("div", { class: "page-head" }, h("div", null, h("h1", null, t("trades.title")), h("p", { class: "hint" }, t("trades.hint"))),
      h("div", { class: "page-actions" },
        h("label", { class: "f inline" }, h("span", null, t("trades.window")), h("select", { onchange: (e) => { T.window = e.target.value; runTrades(); } }, ...Object.keys(I18N.en.trades.windows).map((k) => h("option", { value: k, selected: T.window === k ? "selected" : null }, t("trades.windows." + k))))),
        h("label", { class: "f inline" }, h("input", { type: "checkbox", checked: T.auto ? "checked" : null, onchange: (e) => { T.auto = e.target.checked; scheduleAuto(); } }), t("trades.auto")),
        h("button", { type: "button", class: "btn primary", onclick: () => runTrades(true) }, t("trades.refresh")))));
    const status = h("p", { class: "count" });
    const strip = h("div", { class: "pulse-body" });
    const statsEl = h("div", { class: "tiles small" });
    const perPool = h("div");
    const tbl = h("div");
    main.appendChild(status);
    main.appendChild(section(t("overview.pulse"), null, strip));
    main.appendChild(statsEl);
    main.appendChild(section(t("trades.stats.perPool"), null, perPool));
    main.appendChild(section(t("trades.title"), null, tbl));
    perPool.className = "bars-2col";

    async function runTrades(force) {
      if (T.loading) return;
      const sec = { "1h": 3600, "3h": 10800, "12h": 43200, "24h": 86400 }[T.window];
      const cacheKey = (id) => id + ":" + T.window;
      T.loading = true;
      status.textContent = t("trades.loading") + "…";
      const ps = pools().filter((p) => p.tier !== "black");
      const results = [];
      const errs = [];
      await Promise.all(CHAIN_IDS.map(async (id) => {
        const cp = ps.filter((p) => p.chainId === id);
        if (!cp.length) return;
        const cached = T.results[cacheKey(id)];
        if (!force && cached && Date.now() - (cached.at || 0) < 60000) { results.push({ id, r: cached }); return; }
        try {
          const r = await MR.recentSwaps(id, cp, sec, { maxCalls: T.window === "24h" ? 30 : 16, onProgress: () => { status.textContent = t("trades.loading") + "… " + chainName(id); } });
          r.at = Date.now();
          T.results[cacheKey(id)] = r;
          results.push({ id, r });
        } catch (e) {
          errs.push(id);
        }
      }));
      T.loading = false;
      if (!main.isConnected) return;
      const all = results.flatMap((x) => x.r.swaps.map((s) => ({ ...s, chainId: x.id }))).sort((a, b) => (b.ts || 0) - (a.ts || 0));
      const scanned = results.reduce((s, x) => s + (x.r.to - x.r.from + 1), 0);
      status.textContent = (errs.length ? errs.map((id) => t("wallet.rpcFail", { chain: chainName(id) })).join(" ") + " " : "") + t("trades.scanned", { blocks: fmtInt(scanned) }) + (results.some((x) => !x.r.complete) ? " (partial)" : "");
      const to = Math.floor(Date.now() / 1000);
      const rows = results.sort((a, b) => CHAIN_IDS.indexOf(a.id) - CHAIN_IDS.indexOf(b.id)).map((x) => ({ label: CONFIG.chains[x.id].short + " · " + x.r.swaps.length, color: SERIES[x.id], dots: x.r.swaps.map((s) => ({ t: s.ts, usd: s.usd || 0, href: explorerTx(x.id, s.tx), title: `<div class="mr-tip-head">${esc(s.pair)} · ${fmtTime(s.ts)}</div><div>${s.side === "sell" ? t("trades.sell") : t("trades.buy")} ${esc(fmtNum(s.amountIn))} ${esc(s.tokIn.sym)} → ${esc(fmtNum(s.amountOut))} ${esc(s.tokOut.sym)}</div><b>${fmtUsd(s.usd)}</b>` })) }));
      if (rows.length) MR.pulseStrip(strip, rows, to - sec, to, { xFmt: (x) => fmtTime(x).slice(0, 5) });
      else { strip.innerHTML = ""; strip.appendChild(empty(t("trades.fail"))); }
      const vol = sum(all, (s) => s.usd);
      const biggest = all.reduce((m, s) => (s.usd || 0) > (m ? m.usd : 0) ? s : m, null);
      statsEl.innerHTML = "";
      statsEl.appendChild(statTile(t("trades.stats.count"), fmtInt(all.length)));
      statsEl.appendChild(statTile(t("trades.stats.volume"), fmtUsd(vol)));
      statsEl.appendChild(statTile(t("trades.stats.biggest"), biggest ? fmtUsd(biggest.usd) : t("common.na"), biggest ? biggest.pair : null));
      statsEl.appendChild(statTile(t("trades.stats.uniq"), fmtInt(new Set(all.map((s) => s.recipient)).size)));
      // per pool
      const agg = new Map();
      all.forEach((s) => { const k = s.chainId + ":" + s.pool; const a = agg.get(k) || { label: s.pair, chainId: s.chainId, pool: s.pool, usd: 0, n: 0 }; a.usd += s.usd || 0; a.n++; agg.set(k, a); });
      const top = [...agg.values()].sort((a, b) => b.usd - a.usd).slice(0, 12);
      MR.barRows(perPool, top.map((a) => ({ label: a.label, sub: chainName(a.chainId) + " · " + a.n, value: a.usd, color: SERIES[a.chainId], href: "#/pool/" + a.chainId + "/" + a.pool })), fmtUsd);
      // table
      tbl.innerHTML = "";
      if (!all.length) tbl.appendChild(empty(t("trades.empty")));
      else tbl.appendChild(table([{ label: t("trades.cols.time") }, { label: t("trades.cols.chain") }, { label: t("trades.cols.pool") }, { label: t("trades.cols.side") }, { label: t("trades.cols.amountIn"), num: true }, { label: t("trades.cols.amountOut"), num: true }, { label: t("trades.cols.usd"), num: true }, { label: t("trades.cols.trader") }, { label: t("trades.cols.tx") }],
        all.slice(0, 150).map((s) => h("tr", null, td(fmtTime(s.ts), "num"), td(chainChip(s.chainId)), td(h("a", { href: "#/pool/" + s.chainId + "/" + s.pool }, s.pair || short(s.pool))), td(h("span", { class: "side " + s.side }, s.side === "sell" ? t("trades.sell") + " " + (s.tokIn ? s.tokIn.sym : "") : t("trades.buy") + " " + (s.tokOut ? s.tokOut.sym : ""))), td(s.tokIn ? fmtNum(s.amountIn) + " " + s.tokIn.sym : t("common.na"), "num"), td(s.tokOut ? fmtNum(s.amountOut) + " " + s.tokOut.sym : t("common.na"), "num"), td(fmtUsd(s.usd), "num"), td(h("a", { href: "#/wallet/" + s.recipient }, short(s.recipient))), td(h("a", { href: explorerTx(s.chainId, s.tx), target: "_blank", rel: "noopener" }, short(s.tx, 3))))),
        { cls: "compact trades" }));
    }
    function scheduleAuto() {
      if (T.timer) clearInterval(T.timer);
      T.timer = null;
      if (T.auto) T.timer = setInterval(() => { if (main.isConnected) runTrades(true); else clearInterval(T.timer); }, 60000);
    }
    runTrades();
    scheduleAuto();
  }

  // ----- wallet -----
  function viewWallet(main) {
    const W = S.wallet;
    const fromRoute = S.route.parts[1];
    if (fromRoute && /^0x[0-9a-fA-F]{40}$/.test(fromRoute) && fromRoute.toLowerCase() !== (W.addr || "").toLowerCase()) { W.addr = fromRoute; W.results = null; }
    const input = h("input", { type: "text", class: "search mono", placeholder: t("wallet.placeholder"), value: W.addr, "aria-label": t("wallet.placeholder"), spellcheck: "false" });
    const btn = h("button", { type: "button", class: "btn primary", onclick: () => submit() }, t("wallet.lookup"));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    main.appendChild(h("div", { class: "page-head" }, h("div", null, h("h1", null, t("wallet.title")), h("p", { class: "hint" }, t("wallet.hint")))));
    main.appendChild(h("div", { class: "lookup" }, input, btn));
    const status = h("p", { class: "count" });
    const out = h("div");
    main.appendChild(status);
    main.appendChild(out);
    function submit() {
      const v = input.value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) { status.textContent = t("wallet.invalid"); return; }
      W.addr = v;
      W.results = null;
      if (location.hash !== "#/wallet/" + v) { location.hash = "#/wallet/" + v; return; }
      run();
    }
    async function run() {
      if (W.loading) return;
      W.loading = true;
      btn.disabled = true;
      status.textContent = t("wallet.scanning") + "…";
      out.innerHTML = "";
      const ps = pools();
      const res = [];
      const errs = [];
      await Promise.all(CHAIN_IDS.map(async (id) => {
        const cp = ps.filter((p) => p.chainId === id);
        if (!cp.length) return;
        try {
          const r = await MR.scanWallet(id, W.addr, cp, { onProgress: (pr) => { status.textContent = t("wallet.scanning") + "… " + chainName(id) + (pr.stage === "reads" ? " (" + pr.positions + ")" : ""); } });
          res.push(r);
        } catch (e) {
          errs.push({ id, e });
        }
      }));
      W.loading = false;
      btn.disabled = false;
      W.results = { res, errs, at: Date.now() };
      if (!main.isConnected) return;
      drawWallet();
    }
    function drawWallet() {
      const { res, errs } = W.results;
      out.innerHTML = "";
      status.textContent = errs.length ? errs.map((x) => t("wallet.rpcFail", { chain: chainName(x.id) })).join(" ") + " " + t("wallet.partial") : "";
      const positions = res.flatMap((r) => r.positions);
      const swaps = res.flatMap((r) => r.swaps.map((s) => ({ ...s, chainId: r.chainId }))).sort((a, b) => b.block - a.block);
      const closed = sum(res, (r) => r.closed);
      const totalValue = sum(positions, (p) => p.value);
      const swapVol = sum(swaps, (s) => s.usd);
      const chainsActive = new Set([...positions.map((p) => p.chainId), ...swaps.map((s) => s.chainId)]);
      const firstTs = positions.map((p) => p.firstTs).concat(swaps.map((s) => s.ts)).filter(Boolean).sort((a, b) => a - b)[0] || null;
      const lastTs = swaps.map((s) => s.ts).concat(positions.map((p) => p.firstTs)).filter(Boolean).sort((a, b) => b - a)[0] || null;
      const shareTxt = t("wallet.shareText", { swaps: fmtInt(swaps.length), vol: fmtUsd(swapVol), positions: fmtInt(positions.length), value: fmtUsd(totalValue) });
      out.appendChild(h("div", { class: "tiles" },
        statTile(t("wallet.summary.value"), fmtUsd(totalValue)),
        statTile(t("wallet.summary.positions"), fmtInt(positions.length), closed ? t("wallet.closed", { n: closed }) : null),
        statTile(t("wallet.summary.swapVol"), fmtUsd(swapVol)),
        statTile(t("wallet.summary.swapCount"), fmtInt(swaps.length)),
        statTile(t("wallet.summary.chains"), fmtInt(chainsActive.size)),
        statTile(t("wallet.summary.firstSeen"), firstTs ? fmtDate(firstTs) : t("common.na"), lastTs ? t("wallet.summary.lastSeen") + " " + fmtDate(lastTs, true) : null)
      ));
      out.appendChild(h("div", { class: "card-foot" }, linkBtn(t("wallet.share"), xShare(shareTxt, location.href), "ghost")));
      // positions
      const posEl = h("div", { class: "positions" });
      if (!positions.length) posEl.appendChild(empty(t("wallet.noPositions")));
      positions.forEach((pos) => posEl.appendChild(positionCard(pos)));
      out.appendChild(section(t("wallet.positions"), null, posEl));
      // points placeholder
      out.appendChild(section(t("wallet.points"), null, h("p", { class: "hint" }, t("wallet.pointsNote"))));
      // swaps
      const g = h("div", { class: "grid-2" });
      const byChain = CHAIN_IDS.map((id) => ({ label: chainName(id), value: sum(swaps.filter((s) => s.chainId === id), (s) => s.usd), color: SERIES[id], sub: swaps.filter((s) => s.chainId === id).length + " swap" })).filter((r) => r.value > 0);
      const bc = h("div");
      MR.barRows(bc, byChain, fmtUsd);
      const agg = new Map();
      swaps.forEach((s) => { const k = s.chainId + ":" + s.pool; const a = agg.get(k) || { label: s.pair || short(s.pool), chainId: s.chainId, pool: s.pool, usd: 0, n: 0 }; a.usd += s.usd || 0; a.n++; agg.set(k, a); });
      const bp = h("div");
      MR.barRows(bp, [...agg.values()].sort((a, b) => b.usd - a.usd).slice(0, 10).map((a) => ({ label: a.label, sub: chainName(a.chainId) + " · " + a.n, value: a.usd, color: SERIES[a.chainId], href: "#/pool/" + a.chainId + "/" + a.pool })), fmtUsd);
      g.appendChild(section(t("wallet.byChain"), null, byChain.length ? bc : empty(t("wallet.noSwaps"))));
      g.appendChild(section(t("wallet.byPool"), null, agg.size ? bp : empty(t("wallet.noSwaps"))));
      out.appendChild(g);
      const swapTbl = swaps.length ? table([{ label: t("wallet.swapCols.time") }, { label: t("wallet.swapCols.chain") }, { label: t("wallet.swapCols.pool") }, { label: t("wallet.swapCols.side") }, { label: t("wallet.swapCols.in"), num: true }, { label: t("wallet.swapCols.out"), num: true }, { label: t("wallet.swapCols.usd"), num: true }, { label: t("wallet.swapCols.tx") }],
        swaps.slice(0, 200).map((s) => h("tr", null, td(s.ts ? fmtDate(s.ts, true) : "#" + fmtInt(s.block), "num"), td(chainChip(s.chainId)), td(h("a", { href: "#/pool/" + s.chainId + "/" + s.pool }, s.pair || short(s.pool))), td(h("span", { class: "side " + s.side }, s.side === "sell" ? t("trades.sell") : t("trades.buy"))), td(s.tokIn ? fmtNum(s.amountIn) + " " + s.tokIn.sym : t("common.na"), "num"), td(s.tokOut ? fmtNum(s.amountOut) + " " + s.tokOut.sym : t("common.na"), "num"), td(fmtUsd(s.usd), "num"), td(h("a", { href: explorerTx(s.chainId, s.tx), target: "_blank", rel: "noopener" }, short(s.tx, 3))))),
        { cls: "compact" }) : empty(t("wallet.noSwaps"));
      out.appendChild(section(t("wallet.swaps"), null, swapTbl));
    }
    function positionCard(pos) {
      const p = pos.pool;
      const st = pos.status;
      const stTxt = st === "in" ? t("wallet.pos.inRange") : st === "edge" ? t("wallet.pos.edge") : st === "out" ? t("wallet.pos.outRange") : t("common.na");
      const lo = Math.min(...pos.bins), hi = Math.max(...pos.bins);
      const card = h("div", { class: "pos-card" },
        h("div", { class: "pos-head" }, h("a", { href: "#/pool/" + p.chainId + "/" + p.address }, pairCell(p)), chainChip(p.chainId), tierChip(p)),
        h("div", { class: "pos-grid" },
          h("div", null, h("small", null, t("wallet.pos.value")), h("b", { class: "big" }, fmtUsd(pos.value))),
          h("div", null, h("small", null, t("wallet.pos.amounts")), h("span", null, fmtNum(pos.amt0) + " " + p.t0.sym), h("br"), h("span", null, fmtNum(pos.amt1) + " " + p.t1.sym)),
          h("div", null, h("small", null, t("wallet.pos.bins")), h("span", { class: "num" }, "#" + lo + (lo !== hi ? " … #" + hi : "") + " (" + pos.bins.length + ")"), h("br"), h("small", null, t("detail.activeBin") + " #" + (p.curBinIdx != null ? p.curBinIdx : "?"))),
          h("div", null, h("small", null, t("wallet.pos.status")), h("span", { class: "chip st st-" + (st === "in" ? "healthy" : st === "edge" ? "unknown" : "feed_down") }, h("i", { class: "sw" }), stTxt)),
          h("div", null, h("small", null, t("wallet.pos.feeApr")), h("span", null, fmtBps(p.apr7Bps))),
          h("div", null, h("small", null, t("wallet.pos.deposited")), h("span", null, pos.firstTs ? fmtDate(pos.firstTs, true) : "#" + fmtInt(pos.firstBlock)))
        ),
        h("p", { class: "sub mono" }, t("wallet.pos.salt") + " " + pos.salt + " · " + t("wallet.add") + " " + pos.adds + " · " + t("wallet.remove") + " " + pos.removes)
      );
      return card;
    }
    if (W.addr && /^0x[0-9a-fA-F]{40}$/.test(W.addr)) {
      if (W.results) drawWallet();
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
    const rpcs = CHAIN_IDS.map((id) => ({ id, el: h("input", { type: "text", class: "search mono", value: (cur.rpc && cur.rpc[id] ? cur.rpc[id] : MR.rpc.list(id)).join(", ") }) }));
    const form = h("form", { method: "dialog", class: "settings" },
      h("h2", null, t("common.settings")),
      h("label", null, h("span", null, t("common.settingsApi")), api, h("small", null, t("common.settingsApiHint"))),
      ...rpcs.map((r) => h("label", null, h("span", null, t("common.settingsRpc") + " · " + chainName(r.id)), r.el)),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn ghost", onclick: () => { MR.settings.set({}); location.reload(); } }, t("common.reset")),
        h("button", { type: "button", class: "btn ghost", onclick: () => dlg.close() }, t("common.close")),
        h("button", { type: "submit", class: "btn primary", onclick: (e) => { e.preventDefault(); const s = { apiBase: api.value.trim(), rpc: {} }; rpcs.forEach((r) => { s.rpc[r.id] = r.el.value.split(",").map((x) => x.trim()).filter(Boolean); }); MR.settings.set(s); location.reload(); } }, t("common.save")))
    );
    dlg.appendChild(form);
    dlg.showModal();
  }

  // ---------- render ----------
  function render() {
    S.route = parseRoute();
    renderShell();
    const main = $("#main");
    main.innerHTML = "";
    window.scrollTo(0, 0);
    if (!S.data) {
      main.appendChild(h("div", { class: "loading" }, h("div", { class: "spinner" }), h("p", null, t("common.loading") + "…")));
      return;
    }
    if (S.status.source === "error" && !pools().length) {
      main.appendChild(h("div", { class: "loading" }, h("p", null, t("source.error")), h("p", { class: "hint" }, S.status.error || ""), h("button", { type: "button", class: "btn primary", onclick: () => location.reload() }, t("common.retry"))));
      if (S.route.name !== "guide") return;
    }
    const v = { overview: viewOverview, pools: viewPools, pool: viewPool, trades: viewTrades, wallet: viewWallet, guide: viewGuide }[S.route.name] || viewOverview;
    v(main);
    document.title = (S.route.name === "pool" ? (poolByKey(S.route.parts[1], S.route.parts[2] || "") || { pair: "" }).pair + " · " : S.route.name !== "overview" ? t("nav." + S.route.name) + " · " : "") + t("appName");
  }

  // ---------- boot ----------
  async function boot() {
    S.lang = detectLang();
    try { S.theme = localStorage.getItem("mr.theme") || (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"); } catch (e) { S.theme = "dark"; }
    applyTheme();
    document.documentElement.lang = S.lang;
    $("#langBtn").addEventListener("click", () => { S.lang = S.lang === "tr" ? "en" : "tr"; try { localStorage.setItem("mr.lang", S.lang); } catch (e) { /* ignore */ } document.documentElement.lang = S.lang; render(); });
    $("#themeBtn").addEventListener("click", () => { S.theme = S.theme === "dark" ? "light" : "dark"; try { localStorage.setItem("mr.theme", S.theme); } catch (e) { /* ignore */ } applyTheme(); render(); });
    $("#settingsBtn").addEventListener("click", openSettings);
    render();
    const data = await MR.loadDataset((st) => { S.status = st; renderSource(); });
    S.data = data;
    S.status = data.status;
    if (data.status.source === "snapshot" && data.status.error) console.warn("Metric Radar: live API failed, using snapshot:", data.status.error);
    render();
  }
  document.addEventListener("DOMContentLoaded", boot);
})();

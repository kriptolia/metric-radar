/* Metric Radar — small SVG chart helpers (no dependencies). Thin marks, hairline grid, hover tooltips, table twins. */
(function () {
  "use strict";
  const MR = (window.MR = window.MR || {});
  const NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, children) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    (children || []).forEach((c) => e.appendChild(c));
    return e;
  }
  function html(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- tooltip (one for the page) ----
  let tip = null;
  function showTip(x, y, content) {
    if (!tip) {
      tip = html("div", "mr-tip");
      tip.setAttribute("role", "status");
      document.body.appendChild(tip);
    }
    tip.innerHTML = content;
    tip.style.display = "block";
    const r = tip.getBoundingClientRect();
    const vw = window.innerWidth,
      vh = window.innerHeight;
    let left = x + 14,
      top = y + 14;
    if (left + r.width > vw - 8) left = x - r.width - 14;
    if (top + r.height > vh - 8) top = y - r.height - 14;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }
  function hideTip() {
    if (tip) tip.style.display = "none";
  }
  MR.tip = { show: showTip, hide: hideTip };

  function niceTicks(min, max, n) {
    if (!(max > min)) return [min];
    const span = max - min;
    const step0 = span / Math.max(1, n);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
    return out;
  }

  /**
   * Line chart. opts: { series:[{name,color,points:[[t,v]]}], yFmt, xFmt, height, area:boolean, tableLabel }
   * Renders an SVG plus a hidden table twin toggled by a button.
   */
  MR.lineChart = function lineChart(container, opts) {
    container.innerHTML = "";
    // a line needs two points: a series with fewer is left out, and with none left the chart says why it is empty
    const series = (opts.series || [])
      .map((s) => ({ ...s, points: (s.points || []).filter((p) => p[1] != null && isFinite(p[1])) }))
      .filter((s) => s.points.length >= 2);
    if (!series.length) {
      container.appendChild(html("p", "mr-empty", opts.emptyText || "—"));
      return;
    }
    const W = Math.max(320, container.clientWidth || 640);
    const H = opts.height || 220;
    const pad = { l: 56, r: 16, t: 14, b: 28 };
    const allX = series.flatMap((s) => s.points.map((p) => p[0]));
    const allY = series.flatMap((s) => s.points.map((p) => p[1])).filter((v) => v != null && isFinite(v));
    const xMin = Math.min(...allX),
      xMax = Math.max(...allX);
    let yMin = Math.min(0, ...allY),
      yMax = Math.max(...allY);
    if (yMax === yMin) yMax = yMin + 1;
    const ticks = niceTicks(yMin, yMax, 4);
    yMin = Math.min(yMin, ticks[0]);
    yMax = Math.max(yMax, ticks[ticks.length - 1]);
    const sx = (x) => pad.l + ((x - xMin) / Math.max(1, xMax - xMin)) * (W - pad.l - pad.r);
    const sy = (y) => pad.t + (1 - (y - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, class: "mr-chart", role: "img", "aria-label": opts.ariaLabel || "" });
    // grid
    for (const t of ticks) {
      svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: sy(t), y2: sy(t), class: "mr-grid" }));
      const lbl = el("text", { x: pad.l - 8, y: sy(t) + 4, class: "mr-axis", "text-anchor": "end" });
      lbl.textContent = opts.yFmt ? opts.yFmt(t) : String(t);
      svg.appendChild(lbl);
    }
    // x labels (first, middle, last)
    const xs = [xMin, (xMin + xMax) / 2, xMax];
    xs.forEach((x, i) => {
      const lbl = el("text", { x: sx(x), y: H - 8, class: "mr-axis", "text-anchor": i === 0 ? "start" : i === 2 ? "end" : "middle" });
      lbl.textContent = opts.xFmt ? opts.xFmt(x) : String(x);
      svg.appendChild(lbl);
    });
    svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: sy(yMin), y2: sy(yMin), class: "mr-baseline" }));
    // series
    series.forEach((s) => {
      const pts = s.points;
      const d = pts.map((p, i) => (i ? "L" : "M") + sx(p[0]).toFixed(1) + " " + sy(p[1]).toFixed(1)).join(" ");
      if (opts.area && series.length === 1) {
        const dA = d + ` L${sx(pts[pts.length - 1][0]).toFixed(1)} ${sy(yMin)} L${sx(pts[0][0]).toFixed(1)} ${sy(yMin)} Z`;
        svg.appendChild(el("path", { d: dA, fill: s.color, "fill-opacity": "0.10", stroke: "none" }));
      }
      svg.appendChild(el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      const last = pts[pts.length - 1];
      svg.appendChild(el("circle", { cx: sx(last[0]), cy: sy(last[1]), r: 3.5, fill: s.color, stroke: "var(--surface-2)", "stroke-width": 2 }));
    });
    // hover layer
    const cross = el("line", { x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, class: "mr-cross", style: "display:none" });
    svg.appendChild(cross);
    const dots = series.map((s) => {
      const c = el("circle", { r: 4, fill: s.color, stroke: "var(--surface-2)", "stroke-width": 2, style: "display:none" });
      svg.appendChild(c);
      return c;
    });
    const hit = el("rect", { x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b, fill: "transparent" });
    svg.appendChild(hit);
    const onMove = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const x = xMin + ((px - pad.l) / (W - pad.l - pad.r)) * (xMax - xMin);
      let rows = "";
      let cx = null;
      series.forEach((s, i) => {
        let best = null;
        for (const p of s.points) if (p[1] != null && (best === null || Math.abs(p[0] - x) < Math.abs(best[0] - x))) best = p;
        if (!best) return;
        if (cx === null) cx = sx(best[0]);
        dots[i].setAttribute("cx", sx(best[0]));
        dots[i].setAttribute("cy", sy(best[1]));
        dots[i].style.display = "";
        rows += `<div class="mr-tip-row"><i style="background:${s.color}"></i><span>${s.name}</span><b>${opts.yFmt ? opts.yFmt(best[1]) : best[1]}</b></div>`;
        if (i === 0) rows = `<div class="mr-tip-head">${opts.xFmt ? opts.xFmt(best[0], true) : best[0]}</div>` + rows;
      });
      if (cx !== null) {
        cross.setAttribute("x1", cx);
        cross.setAttribute("x2", cx);
        cross.style.display = "";
      }
      showTip(ev.clientX, ev.clientY, rows);
    };
    hit.addEventListener("mousemove", onMove);
    hit.addEventListener("mouseleave", () => {
      cross.style.display = "none";
      dots.forEach((d) => (d.style.display = "none"));
      hideTip();
    });
    container.appendChild(svg);
    // legend for >= 2 series
    if (series.length > 1) {
      const lg = html("div", "mr-legend");
      series.forEach((s) => {
        const it = html("span", "mr-legend-item");
        const sw = html("i");
        sw.style.background = s.color;
        it.appendChild(sw);
        it.appendChild(document.createTextNode(s.name));
        lg.appendChild(it);
      });
      container.appendChild(lg);
    }
    // table twin
    const tbtn = html("button", "mr-linkbtn", opts.tableLabel || "Table");
    tbtn.type = "button";
    const tbl = html("div", "mr-table-twin");
    tbl.hidden = true;
    const t = document.createElement("table");
    t.className = "mr-table compact";
    const thead = t.createTHead();
    const hr = thead.insertRow();
    hr.appendChild(html("th", "", opts.xLabel || "t"));
    series.forEach((s) => hr.appendChild(html("th", "", s.name)));
    const tb = t.createTBody();
    const xsAll = [...new Set(allX)].sort((a, b) => a - b).slice(-60);
    xsAll.forEach((x) => {
      const r = tb.insertRow();
      r.appendChild(html("td", "", opts.xFmt ? opts.xFmt(x, true) : String(x)));
      series.forEach((s) => {
        const p = s.points.find((q) => q[0] === x);
        r.appendChild(html("td", "num", p && p[1] != null ? (opts.yFmt ? opts.yFmt(p[1]) : p[1]) : "—"));
      });
    });
    tbl.appendChild(t);
    tbtn.addEventListener("click", () => {
      tbl.hidden = !tbl.hidden;
      tbtn.setAttribute("aria-expanded", String(!tbl.hidden));
    });
    container.appendChild(tbtn);
    container.appendChild(tbl);
  };

  /** Horizontal bars: rows [{label, value, color, sub}] */
  MR.barRows = function barRows(container, rows, fmt, opts) {
    container.innerHTML = "";
    const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.value || 0)));
    const list = html("div", "mr-bars");
    rows.forEach((r) => {
      const row = html("div", "mr-bar-row");
      const lab = html("div", "mr-bar-label");
      if (r.href) {
        const a = html("a", "", r.label);
        a.href = r.href;
        lab.appendChild(a);
      } else lab.textContent = r.label;
      if (r.sub) lab.appendChild(html("small", "", r.sub));
      const track = html("div", "mr-bar-track");
      const fill = html("div", "mr-bar-fill");
      fill.style.width = Math.max(1, (Math.abs(r.value || 0) / max) * 100) + "%";
      fill.style.background = r.color || "var(--series-1)";
      track.appendChild(fill);
      const val = html("div", "mr-bar-val num", fmt ? fmt(r.value) : String(r.value));
      row.appendChild(lab);
      row.appendChild(track);
      row.appendChild(val);
      list.appendChild(row);
    });
    container.appendChild(list);
  };

  /** Bins histogram: bins [{bin, value, fees, aprBps, active, vol}] */
  MR.binsChart = function binsChart(container, bins, opts) {
    container.innerHTML = "";
    if (!bins.length) {
      container.appendChild(html("p", "mr-empty", opts.emptyText || "—"));
      return;
    }
    const W = Math.max(320, container.clientWidth || 640);
    const H = opts.height || 180;
    const pad = { l: 48, r: 12, t: 12, b: 26 };
    const max = Math.max(1e-9, ...bins.map((b) => b.value || 0));
    const n = bins.length;
    const bw = (W - pad.l - pad.r) / n;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, class: "mr-chart" });
    const ticks = niceTicks(0, max, 3);
    const sy = (v) => pad.t + (1 - v / Math.max(max, ticks[ticks.length - 1] || max)) * (H - pad.t - pad.b);
    for (const t of ticks) {
      svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: sy(t), y2: sy(t), class: "mr-grid" }));
      const lbl = el("text", { x: pad.l - 6, y: sy(t) + 4, class: "mr-axis", "text-anchor": "end" });
      lbl.textContent = opts.yFmt ? opts.yFmt(t) : t;
      svg.appendChild(lbl);
    }
    bins.forEach((b, i) => {
      const x = pad.l + i * bw;
      const h = Math.max(0, sy(0) - sy(b.value || 0));
      const rect = el("rect", { x: x + 1, y: sy(b.value || 0), width: Math.max(1, bw - 2), height: h, rx: Math.min(3, bw / 3), fill: b.active ? "var(--accent)" : "var(--series-1)", "fill-opacity": b.active ? 1 : 0.85 });
      const g = el("g", {}, [rect]);
      const hit = el("rect", { x, y: pad.t, width: bw, height: H - pad.t - pad.b, fill: "transparent" });
      hit.addEventListener("mousemove", (ev) => showTip(ev.clientX, ev.clientY, opts.tipHtml ? opts.tipHtml(b) : String(b.value)));
      hit.addEventListener("mouseleave", hideTip);
      g.appendChild(hit);
      svg.appendChild(g);
      if (b.active) {
        const lbl = el("text", { x: x + bw / 2, y: H - 8, class: "mr-axis", "text-anchor": "middle", "font-weight": "600" });
        lbl.textContent = "#" + b.bin;
        svg.appendChild(lbl);
      } else if (i === 0 || i === n - 1) {
        const lbl = el("text", { x: x + bw / 2, y: H - 8, class: "mr-axis", "text-anchor": "middle" });
        lbl.textContent = "#" + b.bin;
        svg.appendChild(lbl);
      }
    });
    svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: sy(0), y2: sy(0), class: "mr-baseline" }));
    container.appendChild(svg);
  };

  /** Pulse strip: rows [{label, color, dots:[{t, usd, title}]}], from/to seconds. */
  MR.pulseStrip = function pulseStrip(container, rows, from, to, opts) {
    container.innerHTML = "";
    const W = Math.max(320, container.clientWidth || 640);
    const rowH = 34;
    const narrow = W < 480;
    const pad = { l: narrow ? 110 : 118, r: 14, t: 6, b: 22 };
    // a crowded strip turns into a solid band: shrink and lighten the dots as their density per pixel grows
    const density = Math.max(0, ...rows.map((r) => r.dots.length)) / Math.max(1, W - pad.l - pad.r);
    const shrink = density > 0.6 ? 0.42 : density > 0.3 ? 0.58 : density > 0.15 ? 0.78 : 1;
    const H = pad.t + rows.length * rowH + pad.b;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, class: "mr-chart mr-pulse" });
    const clipId = "pulse-clip-" + Math.random().toString(36).slice(2, 8);
    svg.appendChild(el("defs", {}, [el("clipPath", { id: clipId }, [el("rect", { x: pad.l - 2, y: 0, width: W - pad.l - pad.r + 4, height: H })])]));
    const plot = el("g", { "clip-path": `url(#${clipId})` });
    const sx = (t) => pad.l + ((t - from) / Math.max(1, to - from)) * (W - pad.l - pad.r);
    const maxUsd = Math.max(1, ...rows.flatMap((r) => r.dots.map((d) => d.usd || 0)));
    rows.forEach((r, i) => {
      const y = pad.t + i * rowH + rowH / 2;
      svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: "mr-grid" }));
      const lbl = el("text", { x: pad.l - 10, y: y + 4, class: "mr-axis mr-pulse-label", "text-anchor": "end" });
      lbl.textContent = r.label;
      svg.appendChild(lbl);
      r.dots.forEach((d) => {
        const rad = Math.max(1.3, (2.5 + 9 * Math.sqrt((d.usd || 0) / maxUsd)) * shrink);
        const c = el("circle", { cx: sx(d.t), cy: y, r: rad.toFixed(1), fill: r.color, "fill-opacity": shrink < 1 ? 0.4 : 0.55, stroke: r.color, "stroke-width": shrink < 1 ? 0.6 : 1 });
        c.addEventListener("mousemove", (ev) => showTip(ev.clientX, ev.clientY, d.title || ""));
        c.addEventListener("mouseleave", hideTip);
        if (d.href) {
          c.style.cursor = "pointer";
          c.addEventListener("click", () => window.open(d.href, "_blank", "noopener"));
        }
        plot.appendChild(c);
      });
    });
    svg.appendChild(plot);
    // time axis: five ticks, three where there is no room for more
    const steps = narrow ? 2 : 4;
    for (let k = 0; k <= steps; k++) {
      const t = from + ((to - from) * k) / steps;
      const lbl = el("text", { x: sx(t), y: H - 6, class: "mr-axis", "text-anchor": k === 0 ? "start" : k === steps ? "end" : "middle" });
      lbl.textContent = opts && opts.xFmt ? opts.xFmt(t) : "";
      svg.appendChild(lbl);
    }
    container.appendChild(svg);
  };

  /** Tiny sparkline for cards. */
  MR.sparkline = function sparkline(points, color, w, h) {
    const W = w || 120,
      H = h || 32;
    const pts = points.filter((p) => p[1] != null);
    if (pts.length < 2) return el("svg", { width: W, height: H });
    const xs = pts.map((p) => p[0]),
      ys = pts.map((p) => p[1]);
    const xMin = Math.min(...xs),
      xMax = Math.max(...xs),
      yMin = Math.min(...ys),
      yMax = Math.max(...ys);
    const sx = (x) => ((x - xMin) / Math.max(1, xMax - xMin)) * (W - 4) + 2;
    const sy = (y) => (yMax === yMin ? H / 2 : (1 - (y - yMin) / (yMax - yMin)) * (H - 6) + 3);
    const d = pts.map((p, i) => (i ? "L" : "M") + sx(p[0]).toFixed(1) + " " + sy(p[1]).toFixed(1)).join(" ");
    return el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "mr-spark" }, [el("path", { d, fill: "none", stroke: color || "var(--series-1)", "stroke-width": 1.5 })]);
  };
})();

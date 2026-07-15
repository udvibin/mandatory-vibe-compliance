// dither-polar.js — pie + radar renderers for the dither chart engine. Zero dependencies.
//
// The cartesian engine (dither-chart.js) paints value columns; these paint a disc and
// polygons. Same paint rules — every pixel is its series' one fill colour and only the
// alpha varies, the Bayer 4×4 decides which cells light — driven by the polar half of
// dither-geom.js. Upstream's radial rule: density is distance-driven, dense at the edge
// and thinning toward the centre (their distToPolygonEdge comment).
//
//   ditherPie(el,   { data, dataKey: "value", nameKey: "name", colors: [...] })
//   ditherRadar(el, { data, nameKey: "axis", series: [{ key, color }] })

import {
  BAYER, BORDER_ALPHA, OFF_TIER, PALETTE, backingSize, bloomStyle, clamp01,
  easeInOutCubic, prefersReducedMotion, rgb, seedOf,
} from "./dither.js";
import {
  axisAtAngle, distToPolygonEdge, pieSlices, pointInPolygon, polarX, polarY, radarAxes,
  sliceAtAngle,
} from "./dither-geom.js";

const TOP = -Math.PI / 2;
const TAU = Math.PI * 2;
const LEGEND_H = 18;

/* ------------------------------------------------------------- scaffolding */

function mkLayer(host, pixelated) {
  const c = document.createElement("canvas");
  c.setAttribute("aria-hidden", "true");
  c.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;" +
    (pixelated ? "image-rendering:pixelated;" : "");
  host.append(c);
  return c;
}

/** Layers + tooltip + legend strip, shared by pie and radar. */
function scaffold(host, o, withChrome) {
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const chrome = withChrome ? mkLayer(host, false) : null; // crisp text, device res
  const surface = mkLayer(host, true);                     // the dither, backing res
  const glow = mkLayer(host, false);                       // bloom

  const tip = document.createElement("div");
  tip.style.cssText =
    "position:absolute;pointer-events:none;display:none;z-index:3;padding:.4em .6em;" +
    "border-radius:5px;font-size:12px;line-height:1.45;white-space:nowrap;" +
    "background:rgba(6,12,16,.92);border:1px solid rgba(157,180,189,.2)";
  host.append(tip);

  const legend = document.createElement("div");
  legend.style.cssText =
    "position:absolute;left:0;bottom:-2px;display:flex;gap:.8em;flex-wrap:wrap;z-index:3;" +
    "font-size:11px;line-height:1";
  if (o.legend) host.append(legend);

  const syncBloom = () => {
    const bl = bloomStyle(o.bloom);
    glow.style.display = bl ? "" : "none";
    if (bl) Object.assign(glow.style, bl);
  };
  syncBloom();

  return { chrome, surface, glow, tip, legend, syncBloom };
}

/**
 * Legend with the engine's spotlight semantics: hover focuses, click locks.
 * Returns a getter for the current emphasis (or null).
 */
function buildLegend(el, items, onChange) {
  el.innerHTML = "";
  let focus = null, selected = null;
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.style.cssText =
      "display:flex;align-items:center;gap:.4em;background:none;border:0;cursor:pointer;" +
      "padding:0;color:inherit;font:inherit;opacity:.75";
    const dot = document.createElement("i");
    dot.style.cssText = `width:8px;height:8px;border-radius:2px;background:${rgb(it.fill)}`;
    b.append(dot, document.createTextNode(it.label));
    b.addEventListener("pointerenter", () => { focus = it.id; onChange(); });
    b.addEventListener("pointerleave", () => { focus = null; onChange(); });
    b.addEventListener("click", () => {
      selected = selected === it.id ? null : it.id;
      onChange();
    });
    el.append(b);
  }
  return () => selected ?? focus;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/* --------------------------------------------------------------------- pie */

const SLICE_COLORS = Object.keys(PALETTE);

export function ditherPie(host, opts = {}) {
  const o = {
    data: [], dataKey: "value", nameKey: "name", colors: [],
    variant: "gradient", donut: 0, bloom: "off",
    animate: true, animationDuration: 900, legend: true, tooltip: true,
    formatValue: (v) => String(v),
    ...opts,
  };
  const reduce = prefersReducedMotion();
  const { surface, glow, tip, legend, syncBloom } = scaffold(host, o, false);
  const sctx = surface.getContext("2d");
  const bctx = glow.getContext("2d");

  let cols = 0, rows = 0, cx = 0, cy = 0, R = 0, w = 0, h = 0;
  let slices = [], seeds = [];
  let hoverSlice = -1, tipXY = null;
  let intensity = 0, hovered = false, revealNow = 1, animStart = 0, raf = 0;
  let emphOf = () => null;

  function measure() {
    const box = host.getBoundingClientRect();
    w = box.width;
    h = Math.max(10, box.height - (o.legend ? LEGEND_H : 0));
    ({ cols, rows } = backingSize(w, h));
    surface.width = glow.width = cols;
    surface.height = glow.height = rows;
    for (const c of [surface, glow]) {
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    cx = cols / 2;
    cy = rows / 2;
    R = Math.min(cols, rows) / 2 - 2;
  }

  function build() {
    slices = pieSlices(o.data, o.dataKey, o.nameKey);
    seeds = slices.map((s, i) =>
      seedOf(o.colors[i] ?? SLICE_COLORS[i % SLICE_COLORS.length]));
    emphOf = o.legend
      ? buildLegend(legend,
          slices.map((s, i) => ({ id: i, label: s.name, fill: seeds[i].fill })), kick)
      : () => null;
  }

  function paint() {
    sctx.clearRect(0, 0, cols, rows);
    const sweep = TOP + revealNow * TAU;   // entrance: the disc sweeps in clockwise
    const inner = R * clamp01(o.donut);
    const span = R - inner || 1;
    const emph = emphOf() ?? (hoverSlice >= 0 ? hoverSlice : null);
    const bias = o.variant === "dotted" ? 0.12 : 0;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const r = Math.hypot(dx, dy);
        if (r > R || r < inner) continue;
        let a = Math.atan2(dy, dx);
        if (a < TOP) a += TAU;
        if (a > sweep) continue;
        const si = sliceAtAngle(slices, a);
        if (si < 0) continue;
        if (o.variant === "hatched" && ((x + y) & 3) >= 2) continue;

        const dim = emph != null && emph !== si ? 0.3 : 1;
        const hot = intensity * (hoverSlice === si ? 1 : 0.35);
        const density = (r - inner) / span; // dense at the rim, thinning to the centre
        const lit = o.variant === "solid" ||
          density > BAYER[y & 3][x & 3] - 0.1 * hot - bias;
        if (o.variant === "dotted" && !lit) continue;

        let alpha;
        if (R - r < 1.5 || (inner && r - inner < 1.5)) {
          alpha = BORDER_ALPHA; // rim outline — the disc's edge, like a column's top border
        } else {
          const k = (0.3 + density * 0.7) * (1 + 0.22 * hot);
          alpha = lit ? k : k * OFF_TIER;
        }
        sctx.fillStyle = rgb(seeds[si].fill, 1, clamp01(alpha * dim));
        sctx.fillRect(x, y, 1, 1);
      }
    }
    if (o.bloom !== "off") {
      bctx.clearRect(0, 0, cols, rows);
      bctx.drawImage(surface, 0, 0);
    }
  }

  function paintTip() {
    if (!o.tooltip || hoverSlice < 0 || !tipXY) { tip.style.display = "none"; return; }
    const s = slices[hoverSlice];
    const total = slices.reduce((t, x) => t + x.value, 0) || 1;
    tip.innerHTML =
      `<div style="opacity:.65">${s.name}</div>` +
      `<b>${o.formatValue(s.value)}</b> · ${Math.round((s.value / total) * 100)}%`;
    tip.style.display = "block";
    tip.style.left = `${Math.max(0, Math.min(tipXY[0] + 12, w - tip.offsetWidth))}px`;
    tip.style.top = `${Math.max(0, tipXY[1] - 34)}px`;
  }

  const loop = () => {
    const want = hovered ? 1 : 0;
    let settling = false;
    if (Math.abs(intensity - want) > 0.001) {
      intensity += (want - intensity) * 0.16;
      settling = true;
    } else intensity = want;
    const prog = o.animate && !reduce
      ? clamp01((performance.now() - animStart) / o.animationDuration)
      : 1;
    const next = easeInOutCubic(prog);
    const entrancing = next !== revealNow;
    revealNow = next;
    paint();
    paintTip();
    raf = settling || entrancing ? requestAnimationFrame(loop) : 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

  const move = (e) => {
    const box = host.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    const r = Math.hypot((px / w) * cols - cx, (py / h) * rows - cy);
    const inside = py <= h && r <= R && r >= R * clamp01(o.donut);
    hovered = inside;
    hoverSlice = inside
      ? sliceAtAngle(slices, Math.atan2((py / h) * rows - cy, (px / w) * cols - cx))
      : -1;
    tipXY = [px, py];
    kick();
  };
  const leave = () => { hovered = false; hoverSlice = -1; kick(); };
  host.addEventListener("pointermove", move, { passive: true });
  host.addEventListener("pointerleave", leave);
  const ro = new ResizeObserver(() => { measure(); kick(); });
  ro.observe(host);

  measure();
  build();
  animStart = performance.now();
  kick();

  return {
    update(next = {}) {
      Object.assign(o, next);
      measure();
      build();
      syncBloom();
      if (next.animate !== false) animStart = performance.now();
      kick();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      surface.remove();
      glow.remove();
      tip.remove();
      legend.remove();
    },
  };
}

/* ------------------------------------------------------------------- radar */

export function ditherRadar(host, opts = {}) {
  const o = {
    data: [], nameKey: "axis", series: [],
    variant: "gradient", rings: 4, bloom: "off",
    animate: true, animationDuration: 1100, legend: true, tooltip: true,
    formatValue: (v) => String(v),
    ink: "#9db4bd", gridLine: "rgba(157,180,189,.16)",
    ...opts,
  };
  const reduce = prefersReducedMotion();
  const { chrome, surface, glow, tip, legend, syncBloom } = scaffold(host, o, true);
  const gctx = chrome.getContext("2d");
  const sctx = surface.getContext("2d");
  const bctx = glow.getContext("2d");
  const labelFont = `11px ${getComputedStyle(host).fontFamily || "sans-serif"}`;

  let cols = 0, rows = 0, w = 0, h = 0;
  let cx = 0, cy = 0, R = 0;          // backing coords
  let cssCx = 0, cssCy = 0, cssR = 0; // device coords (chrome)
  let axes = [], seeds = [], axisMax = [];
  let hoverAxis = -1, tipXY = null;
  let intensity = 0, hovered = false, revealNow = 1, animStart = 0, raf = 0;
  let emphOf = () => null;

  function measure() {
    const box = host.getBoundingClientRect();
    w = box.width;
    h = Math.max(10, box.height - (o.legend ? LEGEND_H : 0));
    ({ cols, rows } = backingSize(w, h));
    surface.width = glow.width = cols;
    surface.height = glow.height = rows;
    for (const c of [surface, glow]) {
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    chrome.width = Math.round(w * dpr);
    chrome.height = Math.round(h * dpr);
    chrome.style.width = `${w}px`;
    chrome.style.height = `${h}px`;
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cssCx = w / 2;
    cssCy = h / 2;
    cssR = Math.min(w, h) / 2 - 24; // room for the spoke labels
    cx = cols / 2;
    cy = rows / 2;
    R = cssR * (cols / w);
  }

  function build() {
    axes = radarAxes(o.data, o.nameKey);
    seeds = o.series.map((s) => seedOf(s.color));
    // Axes are different metrics (shares vs messages…), so each spoke normalises to its
    // own max across the series — a radar with mixed units is meaningless otherwise.
    axisMax = o.data.map((row) =>
      Math.max(...o.series.map((s) => num(row[s.key])), 1));
    emphOf = o.legend
      ? buildLegend(legend,
          o.series.map((s, i) => ({ id: s.key, label: s.label || s.key, fill: seeds[i].fill })),
          kick)
      : () => null;
  }

  const polyOf = (key, reveal, radius, px, py) =>
    axes.map((ax, i) => {
      const rr = (num(o.data[i][key]) / axisMax[i]) * radius * reveal;
      return [polarX(px, rr, ax.angle), polarY(py, rr, ax.angle)];
    }).flat();

  function paintChrome() {
    gctx.clearRect(0, 0, w, h);
    if (!axes.length) return;
    gctx.strokeStyle = o.gridLine;
    gctx.lineWidth = 1;
    // rings — concentric polygons through each spoke, not circles: the grid should
    // share the data's geometry
    for (let q = 1; q <= o.rings; q++) {
      const rr = (cssR * q) / o.rings;
      gctx.beginPath();
      axes.forEach((ax, i) => {
        const px = polarX(cssCx, rr, ax.angle);
        const py = polarY(cssCy, rr, ax.angle);
        i ? gctx.lineTo(px, py) : gctx.moveTo(px, py);
      });
      gctx.closePath();
      gctx.stroke();
    }
    gctx.beginPath();
    for (const ax of axes) {
      gctx.moveTo(cssCx, cssCy);
      gctx.lineTo(polarX(cssCx, cssR, ax.angle), polarY(cssCy, cssR, ax.angle));
    }
    gctx.stroke();

    gctx.font = labelFont;
    gctx.fillStyle = o.ink;
    gctx.textBaseline = "middle";
    for (const ax of axes) {
      const c = Math.cos(ax.angle);
      gctx.textAlign = Math.abs(c) < 0.3 ? "center" : c > 0 ? "left" : "right";
      gctx.fillText(ax.label,
        polarX(cssCx, cssR + 8, ax.angle), polarY(cssCy, cssR + 8, ax.angle));
    }
  }

  function paint() {
    sctx.clearRect(0, 0, cols, rows);
    const emph = emphOf();
    const falloff = Math.max(R * 0.45, 4);
    const bias = o.variant === "dotted" ? 0.12 : 0;

    o.series.forEach((s, si) => {
      const poly = polyOf(s.key, revealNow, R, cx, cy);
      const dim = emph && emph !== s.key ? 0.3 : 1;
      // same front-to-back thinning as overlapping cartesian layers
      const sparse = si * 0.14;
      // scan only the polygon's bounding box
      let x0 = cols, x1 = 0, y0 = rows, y1 = 0;
      for (let i = 0; i < poly.length; i += 2) {
        x0 = Math.min(x0, poly[i]); x1 = Math.max(x1, poly[i]);
        y0 = Math.min(y0, poly[i + 1]); y1 = Math.max(y1, poly[i + 1]);
      }
      x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(cols - 1, Math.ceil(x1));
      y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(rows - 1, Math.ceil(y1));

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          if (!pointInPolygon(px, py, poly)) continue;
          const d = distToPolygonEdge(px, py, poly);
          if (d < 1.3) { // the polygon's outline, same weight as a column's top border
            sctx.fillStyle = rgb(seeds[si].fill, 1, BORDER_ALPHA * dim);
            sctx.fillRect(x, y, 1, 1);
            continue;
          }
          if (o.variant === "hatched" && ((x + y) & 3) >= 2) continue;
          const density = 1 - clamp01(d / falloff); // dense at the edge → thin centre
          const lit = o.variant === "solid" ||
            density > BAYER[y & 3][x & 3] - 0.1 * intensity - bias + sparse;
          if (o.variant === "dotted" && !lit) continue;
          const k = (0.3 + density * 0.7) * (1 + 0.22 * intensity);
          sctx.fillStyle = rgb(seeds[si].fill, 1, clamp01((lit ? k : k * OFF_TIER) * dim));
          sctx.fillRect(x, y, 1, 1);
        }
      }
    });

    // chunky vertex markers where the hovered spoke meets each series
    if (hoverAxis >= 0) {
      o.series.forEach((s, si) => {
        const rr = (num(o.data[hoverAxis][s.key]) / axisMax[hoverAxis]) * R * revealNow;
        const vx = Math.round(polarX(cx, rr, axes[hoverAxis].angle));
        const vy = Math.round(polarY(cy, rr, axes[hoverAxis].angle));
        sctx.fillStyle = rgb(seeds[si].fill);
        sctx.fillRect(vx - 1, vy - 1, 3, 3);
      });
    }

    if (o.bloom !== "off") {
      bctx.clearRect(0, 0, cols, rows);
      bctx.drawImage(surface, 0, 0);
    }
  }

  function paintTip() {
    if (!o.tooltip || hoverAxis < 0 || !tipXY) { tip.style.display = "none"; return; }
    const row = o.data[hoverAxis];
    const lines = o.series.map((s, i) =>
      `<div style="display:flex;gap:.6em;justify-content:space-between">
         <span style="color:${rgb(seeds[i].fill)}">${s.label || s.key}</span>
         <b>${o.formatValue(row[s.key] ?? 0)}</b>
       </div>`).join("");
    tip.innerHTML =
      `<div style="opacity:.65;margin-bottom:.2em">${axes[hoverAxis].label}</div>${lines}`;
    tip.style.display = "block";
    tip.style.left = `${Math.max(0, Math.min(tipXY[0] + 12, w - tip.offsetWidth))}px`;
    tip.style.top = `${Math.max(0, tipXY[1] - 34)}px`;
  }

  const loop = () => {
    const want = hovered ? 1 : 0;
    let settling = false;
    if (Math.abs(intensity - want) > 0.001) {
      intensity += (want - intensity) * 0.16;
      settling = true;
    } else intensity = want;
    const prog = o.animate && !reduce
      ? clamp01((performance.now() - animStart) / o.animationDuration)
      : 1;
    const next = easeInOutCubic(prog);
    const entrancing = next !== revealNow;
    revealNow = next;
    paint();
    paintTip();
    raf = settling || entrancing ? requestAnimationFrame(loop) : 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

  const move = (e) => {
    const box = host.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    const bx = (px / w) * cols - cx;
    const by = (py / h) * rows - cy;
    const inside = py <= h && Math.hypot(bx, by) <= R * 1.15;
    hovered = inside;
    hoverAxis = inside && axes.length ? axisAtAngle(axes, Math.atan2(by, bx)) : -1;
    tipXY = [px, py];
    kick();
  };
  const leave = () => { hovered = false; hoverAxis = -1; kick(); };
  host.addEventListener("pointermove", move, { passive: true });
  host.addEventListener("pointerleave", leave);
  const ro = new ResizeObserver(() => { measure(); paintChrome(); kick(); });
  ro.observe(host);

  measure();
  build();
  paintChrome();
  animStart = performance.now();
  kick();

  return {
    update(next = {}) {
      Object.assign(o, next);
      measure();
      build();
      paintChrome();
      syncBloom();
      if (next.animate !== false) animStart = performance.now();
      kick();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      chrome.remove();
      surface.remove();
      glow.remove();
      tip.remove();
      legend.remove();
    },
  };
}

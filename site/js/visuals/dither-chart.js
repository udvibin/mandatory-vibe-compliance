// dither-chart.js — the standalone cartesian chart engine. Zero dependencies.
//
// This is the piece that makes dither.js a charting library rather than a texture: it owns
// the whole render path — scales, grid, axes, the dither surface, the scrub crosshair,
// tooltip and legend — so the fill and the line can never disagree (the bug the Chart.js
// adapter had to work around: Chart.js drew a bezier while we straight-lined the fill).
//
// Ported in spirit from dither-kit's cartesian engine, which is React contexts + a canvas.
// The paint rules are upstream's; the plumbing is ours.
//
//   ditherChart(el, { type: "area", data, xKey: "month", series: [{ key, color }] })

import {
  backingSize, bloomStyle, clamp01, easeInOutCubic, onWink, paintColumn,
  paintStars, prefersReducedMotion, resample, rgb, seedOf, starField,
} from "./dither.js";
import {
  buildBandScale, buildXScale, buildYScale, computeBands, indexAtBand, nearestIndex,
} from "./dither-geom.js";

const DEFAULT_MARGINS = { top: 14, right: 14, bottom: 26, left: 40 };

/**
 * @param host      positioned element to fill
 * @param type      "area" | "line" | "bar"
 * @param data      array of rows
 * @param xKey      row key holding the category label
 * @param series    [{ key, color, variant, kind }] — kind overrides type per series
 * @param stackType "default" | "stacked" | "percent"
 */
export function ditherChart(host, opts = {}) {
  const o = {
    type: "area", data: [], xKey: "x", series: [],
    stackType: "default",
    bloom: "off", sparkles: true, animate: true, animationDuration: 1100,
    grid: true, legend: true, tooltip: true, yTicks: 5,
    margins: DEFAULT_MARGINS,
    formatX: (v) => String(v),
    formatY: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
    formatValue: (v) => String(v),
    ink: "#9db4bd", gridLine: "rgba(157,180,189,.10)",
    ...opts,
  };
  const margins = { ...DEFAULT_MARGINS, ...(opts.margins || {}) };
  const reduce = prefersReducedMotion();

  /* ---------------------------------------------------------------- layers */
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const chrome = layer(host, false);   // grid + axes, device res, crisp text
  const surface = layer(host, true);   // the dither, backing res, scaled up pixelated
  const glow = layer(host, false);     // bloom
  const gctx = chrome.getContext("2d");
  const bctx = glow.getContext("2d");

  const off = document.createElement("canvas"); // fill cache
  const octx = off.getContext("2d");
  const crisp = document.createElement("canvas"); // fill + stars + crosshair
  const cctx = crisp.getContext("2d");

  const tip = document.createElement("div");
  tip.style.cssText =
    "position:absolute;pointer-events:none;display:none;z-index:3;padding:.4em .6em;" +
    "border-radius:5px;font:12px/1.45 inherit;white-space:nowrap;" +
    "background:rgba(6,12,16,.92);border:1px solid rgba(157,180,189,.2)";
  host.append(tip);

  const legend = document.createElement("div");
  legend.style.cssText =
    "position:absolute;left:0;bottom:-2px;display:flex;gap:.8em;flex-wrap:wrap;z-index:3;" +
    "font:11px/1 inherit";
  if (o.legend) host.append(legend);

  /* ----------------------------------------------------------------- state */
  let plot = { x: 0, y: 0, w: 0, h: 0 };
  let cols = 0, rows = 0;
  let tops = {}, floors = {}, starsOf = {};
  let yScale = null, xScale = null, bandScale = null, bands = {}, keys = [];
  let hoverIndex = null, focusKey = null, selectedKey = null;
  let intensity = 0, hovered = false, revealNow = 1, animStart = 0;
  let raf = 0, needsFill = true, unWink = null;

  const isBar = () => o.type === "bar";
  const stacked = () => o.stackType === "stacked" || o.stackType === "percent";
  const seedFor = (s) => seedOf(s.color);
  const dimOf = (key) => {
    const emphasis = selectedKey ?? focusKey;
    return emphasis && emphasis !== key ? 0.3 : 1;
  };

  /* ---------------------------------------------------------------- layout */
  function measure() {
    const box = host.getBoundingClientRect();
    const legendH = o.legend ? 18 : 0;
    plot = {
      x: margins.left,
      y: margins.top,
      w: Math.max(10, box.width - margins.left - margins.right),
      h: Math.max(10, box.height - margins.top - margins.bottom - legendH),
    };
    const size = backingSize(plot.w, plot.h);
    cols = size.cols;
    rows = size.rows;
    off.width = crisp.width = cols;
    off.height = crisp.height = rows;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [chrome, glow]) {
      c.width = Math.round(box.width * dpr);
      c.height = Math.round(box.height * dpr);
    }
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.setTransform(1, 0, 0, 1, 0, 0);

    // the dither canvas covers only the plot rect
    surface.style.left = `${plot.x}px`;
    surface.style.top = `${plot.y}px`;
    surface.style.width = `${plot.w}px`;
    surface.style.height = `${plot.h}px`;

    const bl = bloomStyle(o.bloom);
    glow.style.display = bl ? "" : "none";
    if (bl) Object.assign(glow.style, bl);
  }

  /* ------------------------------------------------------------- the model */
  function build() {
    keys = o.series.map((s) => s.key);
    const res = computeBands(o.data, keys, o.stackType);
    bands = res.bands;
    yScale = buildYScale(res.max, plot.h);
    xScale = buildXScale(o.data.length, plot.w);
    bandScale = buildBandScale(o.data.length, plot.w);

    // per series: a [top, floor] band per backing column. Areas fall to their floor;
    // lines only fill a thin glow band hugging the value line.
    const glowBand = Math.max(6, Math.round(rows * 0.16));
    tops = {};
    floors = {};
    starsOf = {};
    o.series.forEach((s, si) => {
      const band = bands[s.key] || [];
      const kind = s.kind || (o.type === "line" ? "line" : "area");
      const toRow = (v) => (yScale(v) / plot.h) * (rows - 1);
      const t = band.map((b) => toRow(b[1]));
      const f = band.map((b, i) => (kind === "line"
        ? Math.min(rows - 1, t[i] + glowBand)
        : toRow(b[0])));
      tops[s.key] = resample(t, cols);
      floors[s.key] = resample(f, cols);
      starsOf[s.key] = starField(cols, o.data.length, si);
    });
    needsFill = true;
  }

  /* ---------------------------------------------------------------- chrome */
  function paintChrome() {
    const box = host.getBoundingClientRect();
    gctx.clearRect(0, 0, box.width, box.height);
    if (!yScale) return;
    gctx.font = "11px inherit";
    gctx.fillStyle = o.ink;
    gctx.strokeStyle = o.gridLine;
    gctx.lineWidth = 1;

    // y gridlines + labels
    const ticks = yScale.ticks(o.yTicks);
    gctx.textAlign = "right";
    gctx.textBaseline = "middle";
    for (const v of ticks) {
      const py = plot.y + yScale(v);
      if (o.grid) {
        gctx.beginPath();
        gctx.moveTo(plot.x, Math.round(py) + 0.5);
        gctx.lineTo(plot.x + plot.w, Math.round(py) + 0.5);
        gctx.stroke();
      }
      gctx.fillText(o.formatY(v), plot.x - 8, py);
    }

    // x labels — thinned to whatever fits, so they never collide
    gctx.textAlign = "center";
    gctx.textBaseline = "top";
    const every = Math.max(1, Math.ceil(o.data.length / Math.floor(plot.w / 56)));
    o.data.forEach((row, i) => {
      if (i % every) return;
      const px = plot.x + (isBar() ? bandScale(i) + bandScale.bandwidth() / 2 : xScale(i));
      gctx.fillText(o.formatX(row[o.xKey]), px, plot.y + plot.h + 7);
    });
  }

  /* ------------------------------------------------------------------ fill */
  function paintFill(reveal) {
    octx.clearRect(0, 0, cols, rows);
    const revealCols = Math.ceil(reveal * cols);

    if (isBar()) {
      const st = stacked();
      const n = Math.max(o.series.length, 1);
      o.series.forEach((s, si) => {
        const seed = seedFor(s);
        const variant = s.variant || "gradient";
        const dim = dimOf(s.key);
        const band = bands[s.key] || [];
        band.forEach((b, i) => {
          // px → backing columns. Grouped bars split the band; stacked share it.
          const bw = bandScale.bandwidth();
          const sub = st ? bw : bw / n;
          const x0 = bandScale(i) + (st ? 0 : si * sub);
          const c0 = Math.round((x0 / plot.w) * cols);
          const c1 = Math.round(((x0 + sub) / plot.w) * cols);
          const top = (yScale(b[1]) / plot.h) * (rows - 1);
          const floor = (yScale(b[0]) / plot.h) * (rows - 1);
          for (let x = c0; x < c1 && x <= revealCols; x++) {
            if (x < 0 || x >= cols) continue;
            paintColumn(octx, x, top, floor, seed, { variant, intensity, dim, stacked: st });
          }
        });
      });
      return;
    }

    o.series.forEach((s, si) => {
      const seed = seedFor(s);
      const variant = s.variant || "gradient";
      const kind = s.kind || (o.type === "line" ? "line" : "area");
      const dim = dimOf(s.key);
      // Overlapping (non-stacked) layers thin out front-to-back so they read as distinct
      // layers instead of a muddy blend.
      const sparse = stacked() ? 0 : si * 0.14;
      const t = tops[s.key], f = floors[s.key];
      if (!t) return;
      for (let x = 0; x < cols && x <= revealCols; x++) {
        paintColumn(octx, x, t[x], f[x], seed, {
          variant, intensity, dim,
          stacked: stacked() && kind !== "line",
          sparse,
        });
      }
    });
  }

  /* --------------------------------------------------------- crisp + stars */
  function paintSurface(tick) {
    cctx.clearRect(0, 0, cols, rows);
    cctx.drawImage(off, 0, 0);
    const revealCols = revealNow * cols;

    if (o.sparkles && !isBar()) {
      for (const s of o.series) {
        if (!tops[s.key]) continue;
        paintStars(cctx, starsOf[s.key], tops[s.key], floors[s.key], cols, rows,
          o.data.length, seedFor(s), tick, intensity, revealNow, reduce);
      }
    }

    // scrub crosshair: a full-height column at the hovered index plus a chunky marker
    // block where it meets each series' value line
    if (hoverIndex != null && o.data.length > 1 && !isBar()) {
      const mx = Math.round((hoverIndex / (o.data.length - 1)) * (cols - 1));
      if (mx <= revealCols) {
        for (const s of o.series) {
          const t = tops[s.key];
          if (!t) continue;
          const seed = seedFor(s);
          const my = Math.round(t[mx] ?? 0);
          cctx.fillStyle = rgb(seed.fill, 1, 0.55);
          for (let y = my; y < rows; y++) cctx.fillRect(mx, y, 1, 1);
          cctx.fillStyle = rgb(seed.fill);
          cctx.fillRect(mx - 1, my - 1, 3, 3);
        }
      }
    }

    const sctx = surface.getContext("2d");
    surface.width = cols;
    surface.height = rows;
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(crisp, 0, 0);

    if (o.bloom !== "off") {
      const box = host.getBoundingClientRect();
      bctx.clearRect(0, 0, glow.width, glow.height);
      bctx.imageSmoothingEnabled = false;
      const dpr = glow.width / (box.width || 1);
      bctx.drawImage(crisp, plot.x * dpr, plot.y * dpr, plot.w * dpr, plot.h * dpr);
    }
  }

  /* --------------------------------------------------------------- tooltip */
  function paintTip() {
    if (!o.tooltip || hoverIndex == null) { tip.style.display = "none"; return; }
    const row = o.data[hoverIndex];
    if (!row) { tip.style.display = "none"; return; }
    const lines = o.series.map((s) =>
      `<div style="display:flex;gap:.6em;justify-content:space-between">
         <span style="color:${rgb(seedFor(s).fill)}">${s.label || s.key}</span>
         <b>${o.formatValue(row[s.key] ?? 0)}</b>
       </div>`).join("");
    tip.innerHTML = `<div style="opacity:.65;margin-bottom:.2em">${o.formatX(row[o.xKey])}</div>${lines}`;
    tip.style.display = "block";
    const px = plot.x + (isBar()
      ? bandScale(hoverIndex) + bandScale.bandwidth() / 2
      : xScale(hoverIndex));
    const w = tip.offsetWidth;
    const box = host.getBoundingClientRect();
    tip.style.left = `${Math.max(0, Math.min(px - w / 2, box.width - w))}px`;
    tip.style.top = `${plot.y + 4}px`;
  }

  /* ---------------------------------------------------------------- legend */
  function buildLegend() {
    if (!o.legend) return;
    legend.innerHTML = "";
    for (const s of o.series) {
      const item = document.createElement("button");
      item.type = "button";
      item.style.cssText =
        "display:flex;align-items:center;gap:.4em;background:none;border:0;cursor:pointer;" +
        "padding:0;color:inherit;font:inherit;opacity:.75";
      const dot = document.createElement("i");
      dot.style.cssText =
        `width:8px;height:8px;border-radius:2px;background:${rgb(seedFor(s).fill)}`;
      item.append(dot, document.createTextNode(s.label || s.key));
      // hover spotlights this series (the rest dim to 0.3); click locks the spotlight
      item.addEventListener("pointerenter", () => { focusKey = s.key; needsFill = true; kick(); });
      item.addEventListener("pointerleave", () => { focusKey = null; needsFill = true; kick(); });
      item.addEventListener("click", () => {
        selectedKey = selectedKey === s.key ? null : s.key;
        needsFill = true;
        kick();
      });
      legend.append(item);
    }
  }

  /* ------------------------------------------------------------ the tick(s) */
  let tickCount = 0;
  const loop = () => {
    const want = hovered ? 1 : 0;
    let settling = false;
    if (Math.abs(intensity - want) > 0.001) {
      intensity += (want - intensity) * 0.16;
      settling = true;
      needsFill = true;
    } else intensity = want;

    const prog = o.animate && !reduce
      ? clamp01((performance.now() - animStart) / o.animationDuration)
      : 1;
    const next = easeInOutCubic(prog);
    const entrancing = next !== revealNow;
    revealNow = next;
    if (entrancing) needsFill = true;

    if (needsFill) { paintFill(revealNow); needsFill = false; }
    paintSurface(tickCount);
    paintTip();

    raf = settling || entrancing ? requestAnimationFrame(loop) : 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

  /* ----------------------------------------------------------- interaction */
  const move = (e) => {
    const box = host.getBoundingClientRect();
    const px = e.clientX - box.left - plot.x;
    const py = e.clientY - box.top - plot.y;
    const inside = px >= 0 && px <= plot.w && py >= 0 && py <= plot.h;
    hovered = inside;
    hoverIndex = inside
      ? (isBar() ? indexAtBand(px, o.data.length, plot.w) : nearestIndex(px, o.data.length, plot.w))
      : null;
    kick();
  };
  const leave = () => { hovered = false; hoverIndex = null; kick(); };
  host.addEventListener("pointermove", move, { passive: true });
  host.addEventListener("pointerleave", leave);

  const ro = new ResizeObserver(() => {
    measure();
    build();
    paintChrome();
    kick();
  });
  ro.observe(host);

  /* ------------------------------------------------------------------ boot */
  measure();
  build();
  paintChrome();
  buildLegend();
  animStart = performance.now();
  if (o.sparkles && !reduce) {
    unWink = onWink((t) => { tickCount = t; paintSurface(t); });
  }
  kick();

  return {
    /** Change options (variant, stackType, colours, data…) and repaint. */
    update(next = {}) {
      Object.assign(o, next);
      measure();
      build();
      paintChrome();
      buildLegend();
      if (next.animate !== false) animStart = performance.now();
      kick();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      unWink?.();
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

function layer(host, pixelated) {
  const c = document.createElement("canvas");
  c.setAttribute("aria-hidden", "true");
  c.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;" +
    (pixelated ? "image-rendering:pixelated;" : "width:100%;height:100%;");
  host.append(c);
  return c;
}

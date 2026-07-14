// dither-chartjs.js — the Chart.js adapter for dither.js.
//
// This file is the ONLY thing in the kit that knows Chart.js exists. dither.js itself has
// zero dependencies; if a project doesn't use Chart.js, it simply doesn't take this file.
// (Upstream dither-kit has no equivalent — it renders its own charts, so it never needed a
// bridge. This adapter is ours.)

import {
  backingSize, clamp01, easeInOutCubic, paintColumn, paintStars,
  prefersReducedMotion, resample, seedOf, starField,
} from "./dither.js";

/**
 * Chart.js plugin: replace a line dataset's area fill with the full dither surface —
 * the ordered-dither texture, a left-to-right entrance reveal, winking sparkles, and a
 * hover lift that eases the dither *denser* (not just brighter) while the pointer is
 * over the plot. Chart.js keeps doing axes, tooltips, the line and its own animation;
 * set `fill: false` on the dataset so its gradient doesn't paint underneath.
 *
 * Owns a rAF loop that only runs while something is moving: a wink is due, the hover
 * lift is settling, or the entrance is playing. Idle costs nothing.
 *
 * `opts` is held by reference — mutate `opts.variant` / `opts.color` and call
 * `chart.draw()`.
 */
export function ditherFillPlugin(opts) {
  const o = {
    color: "blue", variant: "gradient", dim: 1, datasetIndex: 0,
    bloom: "off", bloomCanvas: null,
    sparkles: true, hoverLift: true, animate: true, animationDuration: 1100,
    ...opts,
  };
  const off = document.createElement("canvas");  // the fill, cached between frames
  const octx = off.getContext("2d");
  const star = document.createElement("canvas"); // the sparkle layer, backing res
  const starCtx = star.getContext("2d");
  const reduce = prefersReducedMotion();

  let cols = 0, rows = 0, tops = [], floors = [], stars = [], dataLength = 0;
  let intensity = 0, hovered = false, tick = 0, lastWink = 0, revealNow = 1;
  let animStart = 0, needsFill = true, sig = "", raf = 0, chartRef = null;
  let lastArea = null, lastDpr = 1;

  const seed = () => seedOf(o.color); // palette name, hue, hex or rgb — all accepted

  const paintFill = (reveal) => {
    octx.clearRect(0, 0, cols, rows);
    const s = seed();
    const revealCols = Math.ceil(reveal * cols);
    for (let x = 0; x < cols && x <= revealCols; x++) {
      paintColumn(octx, x, tops[x], floors[x], s, { variant: o.variant, intensity, dim: o.dim });
    }
  };

  // Sparkles live on their own overlay canvas, NOT in the chart canvas. Winking them
  // through chart.draw() would re-render every axis, tick and label ~10x/sec just to
  // move a handful of 1px stars — enough to peg the compositor. So the loop repaints
  // the cheap overlay on its own, and only asks Chart.js to redraw while the hover
  // lift is easing (a bounded ~20 frames), since the lift changes the fill itself.
  const paintStarLayer = (area, dpr) => {
    const s = o.starCanvas;
    if (!s || !cols) return;
    const sctx = s.getContext("2d");
    if (s.width !== chartRef.canvas.width || s.height !== chartRef.canvas.height) {
      s.width = chartRef.canvas.width;
      s.height = chartRef.canvas.height;
    }
    sctx.clearRect(0, 0, s.width, s.height);
    if (!o.sparkles) return;
    star.width = cols;
    star.height = rows;
    sctx.imageSmoothingEnabled = false;
    starCtx.clearRect(0, 0, cols, rows);
    paintStars(starCtx, stars, tops, floors, cols, rows, dataLength, seed(), tick, intensity, revealNow, reduce);
    sctx.drawImage(star, area.left * dpr, area.top * dpr,
      (area.right - area.left) * dpr, (area.bottom - area.top) * dpr);
  };

  // The wink is a 10Hz effect, so it rides a timer rather than a permanent rAF — a
  // forever-running rAF would keep the page from ever going idle for no visual gain.
  const wink = () => {
    if (!chartRef || !o.sparkles || reduce || !lastArea) return;
    tick += 1;
    paintStarLayer(lastArea, lastDpr);
  };

  // rAF runs ONLY while the hover lift is easing (~20 frames), then stops. The lift
  // changes the dither density itself, so this is the one case Chart.js must redraw.
  const loop = () => {
    const want = o.hoverLift && hovered ? 1 : 0;
    if (!chartRef || Math.abs(intensity - want) <= 0.001) {
      intensity = want;
      raf = 0;
      return;
    }
    intensity += (want - intensity) * 0.16;
    needsFill = true;
    chartRef.draw();
    raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

  // The entrance reveal drives its own frames. It can't ride Chart.js's animation:
  // Chart.js stops calling draw() the moment *its* animation ends, which would strand
  // the reveal partway and leave a hard vertical edge where the fill just stops.
  const entrance = () => {
    if (!chartRef) return;
    needsFill = true;
    chartRef.draw();
    if (revealNow < 1) requestAnimationFrame(entrance);
  };

  return {
    id: "ditherFill",
    opts: o,

    afterInit(chart) {
      chartRef = chart;
      const enter = () => { hovered = true; kick(); };
      const leave = () => { hovered = false; kick(); };
      chart.canvas.addEventListener("pointerenter", enter);
      chart.canvas.addEventListener("pointerleave", leave);
      const timer = setInterval(wink, 100);
      chart._ditherOff = () => {
        clearInterval(timer);
        chart.canvas.removeEventListener("pointerenter", enter);
        chart.canvas.removeEventListener("pointerleave", leave);
      };
      if (o.animate && !reduce) requestAnimationFrame(entrance);
    },

    destroy(chart) {
      if (raf) cancelAnimationFrame(raf);
      chartRef = null;
      chart._ditherOff?.();
    },

    beforeDatasetsDraw(chart) {
      const area = chart.chartArea;
      const pts = chart.getDatasetMeta(o.datasetIndex)?.data;
      if (!area || !pts?.length) return;
      const w = area.right - area.left;
      const h = area.bottom - area.top;
      const size = backingSize(w, h);

      // Canvas + star field only get rebuilt when the geometry or paint opts change.
      const nextSig = `${size.cols}x${size.rows}|${pts.length}|${o.variant}|${o.color}|${o.dim}`;
      if (nextSig !== sig) {
        sig = nextSig;
        cols = size.cols;
        rows = size.rows;
        off.width = cols;
        off.height = rows;
        dataLength = pts.length;
        floors = new Array(cols).fill(rows - 1);
        stars = starField(cols, dataLength);
        needsFill = true;
      }

      // The surface is re-read on EVERY draw, not just when the signature changes:
      // Chart.js animates its points, so a surface captured on the first frame would
      // freeze the fill at whatever height the entrance happened to be at.
      //
      // Ask the LINE ELEMENT for its height at each column, not the data points. Chart.js
      // draws a bezier through the points (`tension`), so straight-lining between them
      // makes the fill cut the corner on sharp peaks — it leaks past the curve or pulls
      // away from it. `interpolate()` returns a point on the curve Chart.js actually
      // draws, so the fill and the line agree by construction. Falls back to resampling
      // the points if the element can't interpolate (e.g. tension 0, or a future API).
      const lineEl = chart.getDatasetMeta(o.datasetIndex)?.dataset;
      const yToRow = (y) => clamp01((y - area.top) / h) * (rows - 1);
      let next;
      if (typeof lineEl?.interpolate === "function") {
        next = new Array(cols);
        const firstY = pts[0].y;
        const lastY = pts[pts.length - 1].y;
        for (let x = 0; x < cols; x++) {
          const px = area.left + ((x + 0.5) / cols) * w;
          // interpolate() returns undefined just outside the point span — clamp to the
          // end points there rather than dropping the column.
          const p = lineEl.interpolate({ x: px }, "x");
          const y = p ? p.y : (px <= pts[0].x ? firstY : lastY);
          next[x] = yToRow(y);
        }
      } else {
        next = resample(pts.map((p) => yToRow(p.y)), cols);
      }
      for (let x = 0; x < cols; x++) {
        if (Math.abs(next[x] - (tops[x] ?? -1)) > 0.01) { needsFill = true; break; }
      }
      tops = next;

      // Chart.js redraws on its own during its entrance and on every tooltip move, so
      // the reveal rides along for free — no rAF of ours needed for it.
      if (!animStart) animStart = performance.now();
      const prog = o.animate && !reduce
        ? clamp01((performance.now() - animStart) / o.animationDuration)
        : 1;
      revealNow = easeInOutCubic(prog);
      if (prog < 1) needsFill = true;

      if (needsFill) { paintFill(revealNow); needsFill = false; }

      const g = chart.ctx;
      g.save();
      g.imageSmoothingEnabled = false;
      g.drawImage(off, area.left, area.top, w, h);
      g.restore();

      const dpr = chart.canvas.width / chart.canvas.clientWidth || 1;
      lastArea = area;
      lastDpr = dpr;
      paintStarLayer(area, dpr);

      if (o.bloomCanvas && o.bloom !== "off") {
        const b = o.bloomCanvas;
        const bctx = b.getContext("2d");
        b.width = chart.canvas.width;
        b.height = chart.canvas.height;
        bctx.clearRect(0, 0, b.width, b.height);
        bctx.imageSmoothingEnabled = false;
        bctx.drawImage(off, area.left * dpr, area.top * dpr, w * dpr, h * dpr);
      }
    },
  };
}

// dither-geom.js — the chart engine's geometry. Zero dependencies.
//
// Port of dither-kit's `scales.ts` + `polar.ts`. Upstream leans on d3-scale and d3-shape
// for four things (scalePoint, scaleBand, scaleLinear().nice(), stack). We reimplement
// those here rather than pull in d3: it's ~60 lines against two packages, and the whole
// point of this library is that it drops into a project with no npm.

/* ------------------------------------------------------------------ scales */

/** x for each row index, evenly spread across the plot (d3 scalePoint). */
export function buildXScale(length, plotWidth) {
  if (length <= 1) return () => plotWidth / 2;
  const step = plotWidth / (length - 1);
  return (i) => i * step;
}

/**
 * Banded x for bar categories — each index owns a slot (d3 scaleBand with
 * paddingInner .28 / paddingOuter .18, upstream's values).
 */
export function buildBandScale(length, plotWidth) {
  const inner = 0.28;
  const outer = 0.18;
  const n = Math.max(length, 1);
  const step = plotWidth / (n - inner + 2 * outer);
  const bandwidth = step * (1 - inner);
  const start = outer * step;
  const scale = (i) => start + i * step;
  scale.bandwidth = () => bandwidth;
  scale.step = () => step;
  return scale;
}

/** Index of the category whose band a horizontal pixel offset falls in. */
export function indexAtBand(px, length, plotWidth) {
  if (length <= 0 || plotWidth <= 0) return 0;
  const t = Math.max(0, Math.min(0.999, px / plotWidth));
  return Math.min(length - 1, Math.floor(t * length));
}

/** Index of the row nearest a horizontal pixel offset within the plot. */
export function nearestIndex(px, length, plotWidth) {
  if (length <= 1 || plotWidth <= 0) return 0;
  const t = Math.max(0, Math.min(1, px / plotWidth));
  return Math.round(t * (length - 1));
}

/**
 * Round a domain max up to a readable value, the way d3's `.nice()` does — so the top
 * gridline lands on 50 rather than 47.3. Steps are 1/2/5/10 × a power of ten.
 */
export function niceMax(max, ticks = 5) {
  if (!(max > 0)) return 1;
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return Math.ceil(max / step) * step;
}

/** value → vertical pixel, floor at the bottom of the plot (d3 scaleLinear + nice). */
export function buildYScale(max, plotHeight) {
  const top = niceMax(max);
  const y = (v) => plotHeight - (v / top) * plotHeight;
  y.max = top;
  y.ticks = (count = 5) =>
    Array.from({ length: count + 1 }, (_, i) => (top / count) * i);
  return y;
}

/**
 * Per-series [y0, y1] bands for every row. "default" sits every series on the floor;
 * "stacked"/"percent" pile them (d3-shape's stack, with the expand offset for percent).
 * `bands[key][i] = [y0, y1]` is what the painter reads.
 */
export function computeBands(data, keys, stackType = "default") {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const bands = {};
  let max = 0;

  if (stackType === "default") {
    for (const key of keys) {
      bands[key] = data.map((row) => {
        const v = num(row[key]);
        if (v > max) max = v;
        return [0, v];
      });
    }
    return { bands, max: max || 1 };
  }

  for (const key of keys) bands[key] = [];
  data.forEach((row, i) => {
    const total = keys.reduce((s, k) => s + num(row[k]), 0);
    // percent: every row fills the full height, so each value is a share of its own total
    const div = stackType === "percent" ? total || 1 : 1;
    let acc = 0;
    for (const key of keys) {
      const v = num(row[key]) / div;
      bands[key][i] = [acc, acc + v];
      acc += v;
    }
    if (acc > max) max = acc;
  });
  return { bands, max: max || 1 };
}

/* ------------------------------------------------------------------- polar */

// Angles start at the top (−90°) and run clockwise, matching how slices read on screen.
const TOP = -Math.PI / 2;
const TAU = Math.PI * 2;

/** Slice angles from each row's value under `dataKey`, named by `nameKey`. */
export function pieSlices(data, dataKey, nameKey) {
  const vals = data.map((r) => Math.max(0, Number(r[dataKey]) || 0));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  let a = TOP;
  return data.map((r, i) => {
    const span = (vals[i] / total) * TAU;
    const slice = { name: String(r[nameKey] ?? i), value: vals[i], start: a, end: a + span, mid: a + span / 2 };
    a += span;
    return slice;
  });
}

/** Which slice a pointer angle falls in (or -1). */
export function sliceAtAngle(slices, angle) {
  let a = angle;
  while (a < TOP) a += TAU;
  while (a >= TOP + TAU) a -= TAU;
  return slices.findIndex((s) => a >= s.start && a < s.end);
}

/** Evenly-spaced spokes, one per row. */
export function radarAxes(data, nameKey) {
  const n = Math.max(data.length, 1);
  return data.map((r, i) => ({ label: String(r[nameKey] ?? i), angle: TOP + (i / n) * TAU }));
}

/** Nearest radar spoke to a pointer angle. */
export function axisAtAngle(axes, angle) {
  let best = 0;
  let bestD = Infinity;
  axes.forEach((ax, i) => {
    const d = Math.abs(((angle - ax.angle + Math.PI * 3) % TAU) - Math.PI);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

export const polarX = (cx, r, angle) => cx + Math.cos(angle) * r;
export const polarY = (cy, r, angle) => cy + Math.sin(angle) * r;

/** Even-odd point-in-polygon test (polygon as flat [x0,y0,x1,y1,…]). */
export function pointInPolygon(px, py, poly) {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1];
    const xj = poly[j * 2], yj = poly[j * 2 + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Distance from a point to the nearest polygon edge — this is what drives the radial
 * dither density (dense near the edge, thinning toward the centre).
 */
export function distToPolygonEdge(px, py, poly) {
  let best = Infinity;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1];
    const xj = poly[j * 2], yj = poly[j * 2 + 1];
    const dx = xj - xi, dy = yj - yi;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - xi) * dx + (py - yi) * dy) / len2));
    const d = Math.hypot(xi + t * dx - px, yi + t * dy - py);
    if (d < best) best = d;
  }
  return best;
}

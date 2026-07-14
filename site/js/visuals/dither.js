// dither.js — vanilla ES-module port of dither-kit (tripwire.sh/dither-kit, by ripgrim).
//
// The upstream kit ships as React/TSX + Tailwind via a shadcn registry. This is a 1:1
// port of the parts that were never really React: the Bayer paint math (dither-paint.ts,
// pixel.ts, palette.ts) plus vanilla mounts standing in for button.tsx / gradient.tsx /
// avatar.tsx. Paint loops, constants and magic numbers are copied verbatim — if a value
// looks arbitrary, it is arbitrary *upstream* and matching it is the point.
//
// No deps, no build step. Works anywhere ES modules do.

/* ------------------------------------------------------------------ palette */

/** Each seed: the area-fill hue, the bright series line, and the star sparkle. */
export const PALETTE = {
  green: { fill: [40, 210, 110], line: [150, 255, 180], star: [200, 255, 220] },
  blue: { fill: [53, 143, 243], line: [150, 200, 255], star: [205, 228, 255] },
  purple: { fill: [150, 110, 255], line: [200, 175, 255], star: [225, 210, 255] },
  pink: { fill: [240, 90, 190], line: [255, 170, 220], star: [255, 205, 235] },
  orange: { fill: [255, 150, 50], line: [255, 195, 130], star: [255, 220, 175] },
  red: { fill: [240, 70, 70], line: [255, 150, 140], star: [255, 195, 185] },
  grey: { fill: [92, 92, 100], line: [140, 140, 150], star: [165, 165, 175] },
};

export const rgb = ([r, g, b], k = 1, a = 1) =>
  `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},${a})`;

/* -------------------------------------------------------- pixel primitives */

// 4x4 ordered (Bayer) matrix, normalized to 0-1 thresholds. Every surface in the
// kit — charts, buttons, gradients, avatars — dithers against this one matrix.
export const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

export const CELL = 2; // css px per dither cell — chunky enough to read pixelated
const MAX_COLS = 520;
const MAX_ROWS = 200;
// Opacity of the top border outline (just under solid, so it reads as a soft edge).
const BORDER_ALPHA = 0.72;
// Opacity of a dither "off" cell relative to an "on" cell. The scatter modulates
// between two tiers of the *same* colour instead of leaving holes, so the background
// never shows through as stark white on a light theme.
const OFF_TIER = 0.4;

export const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
// Gentle start + soft settle, so entrances don't feel linear.
export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** 32-bit FNV-1a hash — turns any string seed into a stable uint32. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Tiny deterministic PRNG (xorshift32) — floats in [0, 1). */
export function xorshift32(seed) {
  let s = seed || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** Hue (0-360) → an rgb fill tuned to sit alongside the palette. */
export function hueFill(hue) {
  const h = ((hue % 360) + 360) % 360;
  const s = 0.85;
  const l = 0.58;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0]
      : h < 120 ? [x, c, 0]
        : h < 180 ? [0, c, x]
          : h < 240 ? [0, x, c]
            : h < 300 ? [x, 0, c]
              : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** "#rgb" / "#rrggbb" → [r, g, b]. */
export function hexRgb(hex) {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Resolve *any* colour spelling to an rgb fill. Upstream only accepts its seven palette
 * names or a bare hue; this takes those plus real hex and raw rgb, so a project can hand
 * over its own brand colours untouched instead of having them flattened to a hue (a hue
 * throws away saturation and lightness — "#9db4bd" would come back a vivid teal).
 *
 *   "blue" | 210 | "#e4593b" | [228, 89, 59]
 */
export function fillOf(color) {
  if (Array.isArray(color)) return color;
  if (typeof color === "number") return hueFill(color);
  if (typeof color === "string" && color[0] === "#") return hexRgb(color);
  return (PALETTE[color] ?? PALETTE.grey).fill;
}

/** Wrap any colour spelling as a paint seed. */
export const seedOf = (color) => ({ fill: fillOf(color) });

/** Hue of a #rrggbb — for the hue-seeded pieces (avatars) that want a hue, not a fill. */
export function hueOfHex(hex) {
  const [r8, g8, b8] = hexRgb(hex);
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

export const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

/* ------------------------------------------------------------------- bloom */

// A real glow that comes from the colours themselves: a blurred copy of the crisp
// canvas, composited additively so each hue blooms in its own colour rather than
// washing toward white. Lives on a second canvas over the sharp one.
const BLOOM_PRESET = {
  low: { blur: 3, brightness: 1.35, opacity: 0.7, saturate: 1.4 },
  high: { blur: 5, brightness: 1.5, opacity: 0.78, saturate: 1.5 },
  aura: { blur: 15, brightness: 2.9, opacity: 0.1, saturate: 3 },
};

/** Style for the bloom *layer* canvas. null when off. */
export function bloomStyle(bloom) {
  if (!bloom || bloom === "off") return null;
  const cfg = typeof bloom === "string" ? BLOOM_PRESET[bloom] : bloom;
  return {
    filter: `blur(${cfg.blur}px) brightness(${cfg.brightness}) saturate(${cfg.saturate ?? 1})`,
    opacity: cfg.opacity,
    mixBlendMode: cfg.blend ?? "plus-lighter",
    imageRendering: "auto",
  };
}

/** Apply (or clear) the bloom style on a canvas; returns whether bloom is on. */
export function applyBloom(canvas, bloom) {
  const s = bloomStyle(bloom);
  canvas.style.cssText = canvas.style.cssText.replace(/filter:[^;]*;?/, "");
  if (!s) { canvas.style.display = "none"; return false; }
  canvas.style.display = "";
  Object.assign(canvas.style, s);
  return true;
}

/* ----------------------------------------------------------- chart painting */

/**
 * Fill one backing-canvas column `x` from row `top` down to `floor` with the
 * ordered-dither scatter — solid at the floor, dissolving upward so it fades out
 * toward the value line — then cap the top with a soft border outline.
 *
 * Colour vs opacity is the guiding rule of the whole engine: every pixel is the
 * series' single `fill` colour and only the alpha varies, so the texture reads
 * correctly on both light and dark backgrounds.
 */
export function paintColumn(octx, x, top, floor, seed, { variant, intensity = 0, dim = 1, stacked = false, sparse = 0 }) {
  const t = Math.round(top);
  const f = Math.round(floor);
  const depth = f - t;
  if (depth <= 0) {
    octx.fillStyle = rgb(seed.fill, 1, BORDER_ALPHA * dim);
    octx.fillRect(x, t, 1, 1);
    return;
  }
  const bias = (variant === "dotted" ? 0.12 : 0) + (stacked ? 0.2 : 0) - sparse;
  for (let y = t; y < f; y++) {
    // Inverted falloff: 0 at the top line, 1 at the floor.
    let density = (y - t) / depth;
    if (stacked) density = 0.5 + 0.5 * density;
    if (variant === "hatched" && ((x + y) & 3) >= 2) continue;
    const lit = variant === "solid" || density > BAYER[y & 3][x & 3] - 0.1 * intensity - bias;
    // "dotted" keeps real gaps for its open look; every other variant covers the
    // cell and lets the dither ride the alpha.
    if (variant === "dotted" && !lit) continue;
    const k = (0.3 + density * 0.7) * (1 + 0.22 * intensity);
    octx.fillStyle = rgb(seed.fill, 1, clamp01((lit ? k : k * OFF_TIER) * dim));
    octx.fillRect(x, y, 1, 1);
  }
  // Top border outline — the shape's edge now that the fill fades out here, with a
  // faint feather row beneath so it reads as a soft edge rather than a hard line.
  octx.fillStyle = rgb(seed.fill, 1, BORDER_ALPHA * dim);
  octx.fillRect(x, t, 1, 1);
  if (depth > 1) {
    octx.fillStyle = rgb(seed.fill, 1, BORDER_ALPHA * 0.5 * dim);
    octx.fillRect(x, t + 1, 1, 1);
  }
}

/** Linear-resample a per-index fraction array to `cols` columns. */
export function resample(src, cols) {
  const out = new Array(cols);
  const last = Math.max(src.length - 1, 1);
  for (let c = 0; c < cols; c++) {
    const t = (c / Math.max(cols - 1, 1)) * last;
    const i = Math.floor(t);
    const f = t - i;
    const a = src[i] ?? 0;
    const b = src[Math.min(i + 1, src.length - 1)] ?? a;
    out[c] = a + (b - a) * f;
  }
  return out;
}

/** Backing-canvas resolution for a plot rect — low-res, scaled up `pixelated`. */
export function backingSize(width, height) {
  return {
    cols: Math.min(MAX_COLS, Math.max(8, Math.round(width / CELL))),
    rows: Math.min(MAX_ROWS, Math.max(8, Math.round(height / CELL))),
  };
}

/**
 * Deterministic star field for a series — same shape, same stars, every time.
 * `xi` is a data index, `depth` how far down the band the star sits, `phase` its
 * offset in the wink cycle.
 */
export function starField(cols, dataLength, seriesIndex = 0) {
  const out = [];
  const per = Math.max(4, Math.round(cols / 14));
  for (let i = 0; i < per; i++) {
    const s = i * 67 + 13 + seriesIndex * 131;
    out.push({
      xi: s % Math.max(dataLength, 1),
      depth: ((s * 53 + 7) % 100) / 100,
      phase: (s * 41) % 360,
    });
  }
  return out;
}

/**
 * Paint the winking sparkles over a backing canvas. Stars glint in the *series
 * colour* via opacity rather than a lighter shade, so they never read as stray
 * white pixels on a light background. At the peak of a wink a star flares into a
 * 4-point glint. `tick` advances ~10x/sec; `intensity` lets hover brighten them.
 */
export function paintStars(c, stars, tops, floors, cols, rows, dataLength, seed, tick, intensity, reveal = 1, reduce = false) {
  const revealCols = reveal * cols;
  for (const star of stars) {
    const sx = Math.round((star.xi / Math.max(dataLength - 1, 1)) * (cols - 1));
    if (sx > revealCols) continue; // behind the reveal front
    const top = tops[sx] ?? 0;
    const floor = floors[sx] ?? rows - 1;
    const sy = Math.round(top + star.depth * (floor - top));
    const tw = reduce ? 0.85 : (Math.sin((tick + star.phase) * 0.35) + 1) / 2;
    const lift = tw * (0.7 + 0.3 * intensity);
    if (lift < 0.55 || sy < 0 || sy >= rows) continue;
    c.fillStyle = rgb(seed.fill, 1, lift);
    c.fillRect(sx, sy, 1, 1);
    if (tw > 0.9) {
      c.fillStyle = rgb(seed.fill, 1, lift * 0.6 * (tw - 0.9) * 10);
      c.fillRect(sx - 1, sy, 1, 1);
      c.fillRect(sx + 1, sy, 1, 1);
      c.fillRect(sx, sy - 1, 1, 1);
      c.fillRect(sx, sy + 1, 1, 1);
    }
  }
}

/* --------------------------------------------------------- the wink ticker */

// The wink is a 10Hz effect, so it rides one shared timer for the whole page rather
// than a rAF (or a timer *each*). Twelve sparkling bars cost one interval between them,
// and the timer only exists while something is actually subscribed.
let winkTick = 0;
let winkTimer = 0;
const winkSubs = new Set();

export function onWink(fn) {
  winkSubs.add(fn);
  if (!winkTimer) {
    winkTimer = setInterval(() => {
      winkTick += 1;
      for (const f of winkSubs) f(winkTick);
    }, 100);
  }
  return () => {
    winkSubs.delete(fn);
    if (!winkSubs.size) { clearInterval(winkTimer); winkTimer = 0; }
  };
}

/**
 * Bolt sparkles onto any mounted surface (button, gradient, avatar). `read()` hands back
 * the surface's current geometry, colour and hover intensity each wink; stars scatter
 * across the whole rect. Returns a cleanup fn.
 *
 * Upstream only sparkles its charts — this generalises it to everything, which is why the
 * band is the full box rather than a value line and its floor.
 */
export function attachSparkles(host, read) {
  const layer = mountLayer(host, true);
  const lctx = layer.getContext("2d");
  const reduce = prefersReducedMotion();
  let stars = [], sig = "";

  const paint = (tick) => {
    const { cols, rows, color, intensity = 0 } = read();
    if (!cols || !rows) return;
    const next = `${cols}x${rows}`;
    if (next !== sig) {
      sig = next;
      layer.width = cols;
      layer.height = rows;
      stars = starField(cols, cols);
    }
    lctx.clearRect(0, 0, cols, rows);
    paintStars(lctx, stars, new Array(cols).fill(0), new Array(cols).fill(rows - 1),
      cols, rows, cols, seedOf(color), tick, intensity, 1, reduce);
  };

  paint(winkTick);
  const off = onWink(paint);
  return () => { off(); layer.remove(); };
}


/* ----------------------------------------------------------------- button */

const BTN_CELL = 2;

function paintButton(ctx, bloomCtx, cols, rows, { fill, variant }, intensity) {
  ctx.clearRect(0, 0, cols, rows);
  const bias = variant === "dotted" ? 0.12 : 0;
  for (let y = 0; y < rows; y++) {
    const density =
      variant === "gradient" ? 0.25 + 0.75 * ((y + 0.5) / rows)
        : variant === "dotted" ? 0.5
          : 0.75;
    for (let x = 0; x < cols; x++) {
      if (variant === "hatched" && ((x + y) & 3) >= 2) continue;
      const lit = variant === "solid" || density > BAYER[y & 3][x & 3] - 0.1 * intensity - bias;
      if (variant === "dotted" && !lit) continue;
      const k = (0.3 + density * 0.7) * (1 + 0.22 * intensity);
      ctx.fillStyle = rgb(fill, 1, clamp01(lit ? k : k * 0.4));
      ctx.fillRect(x, y, 1, 1);
    }
  }
  // Soft outline in the fill colour, brightening a touch on hover.
  ctx.fillStyle = rgb(fill, 1, clamp01(0.5 + 0.25 * intensity));
  ctx.fillRect(0, 0, cols, 1);
  ctx.fillRect(0, rows - 1, cols, 1);
  ctx.fillRect(0, 0, 1, rows);
  ctx.fillRect(cols - 1, 0, 1, rows);
  if (bloomCtx) {
    bloomCtx.clearRect(0, 0, cols, rows);
    bloomCtx.drawImage(ctx.canvas, 0, 0);
  }
}

/**
 * Turn a real `<button>` (or any element) into a dithered one: canvases are appended
 * behind its existing content, hover eases the dither denser and brighter, pressing
 * lifts it further. Returns a cleanup fn.
 */
export function ditherButton(host, { color = "blue", variant = "gradient", bloom = "off", sparkles = false, opacity = 1 } = {}) {
  const canvas = mountLayer(host, true);
  const bloomCanvas = mountLayer(host, false);
  // the fill is a backdrop for real text — let a caller pull it back so the label keeps
  // its contrast
  if (opacity !== 1) canvas.style.opacity = opacity;
  const ctx = canvas.getContext("2d");
  const hasBloom = applyBloom(bloomCanvas, bloom);
  const bctx = hasBloom ? bloomCanvas.getContext("2d") : null;

  const state = { fill: fillOf(color), variant };
  const reduce = prefersReducedMotion();
  let cols = 0, rows = 0, intensity = 0, target = 0, hovered = false, raf = 0;

  const paint = () => paintButton(ctx, bctx, cols, rows, state, intensity);

  const tick = () => {
    const d = target - intensity;
    if (Math.abs(d) < 0.01) { intensity = target; paint(); raf = 0; return; }
    intensity += d * 0.16;
    paint();
    raf = requestAnimationFrame(tick);
  };
  const setTarget = (t) => {
    target = t;
    if (reduce) { intensity = t; paint(); }
    else if (!raf) raf = requestAnimationFrame(tick);
  };

  const resize = () => {
    const box = host.getBoundingClientRect();
    cols = Math.max(4, Math.round(box.width / BTN_CELL));
    rows = Math.max(4, Math.round(box.height / BTN_CELL));
    canvas.width = bloomCanvas.width = cols;
    canvas.height = bloomCanvas.height = rows;
    paint();
  };
  resize();

  // after resize(): attachSparkles paints immediately and reads cols/rows
  const unSparkle = sparkles
    ? attachSparkles(host, () => ({ cols, rows, color, intensity }))
    : null;

  const enter = () => { hovered = true; setTarget(1); };
  const leave = () => { hovered = false; setTarget(0); };
  const down = () => setTarget(1.5);
  const up = () => setTarget(hovered ? 1 : 0);
  host.addEventListener("pointerenter", enter);
  host.addEventListener("pointerleave", leave);
  host.addEventListener("pointerdown", down);
  host.addEventListener("pointerup", up);
  host.addEventListener("pointercancel", up);
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    host.removeEventListener("pointerenter", enter);
    host.removeEventListener("pointerleave", leave);
    host.removeEventListener("pointerdown", down);
    host.removeEventListener("pointerup", up);
    host.removeEventListener("pointercancel", up);
    ro.disconnect();
    unSparkle?.();
    canvas.remove();
    bloomCanvas.remove();
  };
}

/* --------------------------------------------------------------- gradient */

const G_MAX_COLS = 960;
const G_MAX_ROWS = 600;

function paintGradient(canvas, bloomCanvas, width, height, spec) {
  const ctx = canvas.getContext("2d");
  if (!ctx || width <= 0 || height <= 0) return;
  const cols = Math.min(G_MAX_COLS, Math.max(4, Math.round(width / spec.cell)));
  const rows = Math.min(G_MAX_ROWS, Math.max(4, Math.round(height / spec.cell)));
  canvas.width = cols;
  canvas.height = rows;

  const fromFill = fillOf(spec.from);
  const toFill = spec.to === "transparent" ? null : fillOf(spec.to);
  const o = spec.opacity;
  const lift = spec.intensity || 0;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      // t runs 0 at the `from` edge → 1 at the `to` edge.
      const t =
        spec.direction === "up" ? 1 - (y + 0.5) / rows
          : spec.direction === "down" ? (y + 0.5) / rows
            : spec.direction === "left" ? 1 - (x + 0.5) / cols
              : (x + 0.5) / cols;
      const density = 1 - t;
      // Same lift as the charts and buttons: intensity lowers the threshold, so more
      // cells light up (the texture thickens) and every cell brightens a touch.
      const lit = density > BAYER[y & 3][x & 3] - 0.1 * lift;
      const k = 1 + 0.22 * lift;
      if (toFill) {
        // Two-tone: every cell is painted, the dither decides which colour.
        ctx.fillStyle = rgb(lit ? fromFill : toFill, 1, clamp01(o * k));
        ctx.fillRect(x, y, 1, 1);
      } else {
        // Dissolve to transparent: lit cells carry the ramp, off cells keep a faint
        // tint that also fades out, so the falloff reads smooth.
        const alpha = clamp01((lit ? 0.35 + 0.65 * density : 0.12 * density) * o * k);
        if (alpha <= 0.004) continue;
        ctx.fillStyle = rgb(fromFill, 1, alpha);
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  if (bloomCanvas) {
    const bctx = bloomCanvas.getContext("2d");
    bloomCanvas.width = cols;
    bloomCanvas.height = rows;
    bctx.drawImage(canvas, 0, 0);
  }
}

/**
 * Dithered gradient wash — fills `host` (which must be positioned). Static by default:
 * one paint per size/opts change and no animation loop, so it's cheap enough for a page
 * background, a footer glow or a card backdrop.
 *
 * Pass `hover: true` to make it lift like the buttons and the chart do — useful when the
 * wash is a *bar* rather than a backdrop. `hoverTarget` is what gets watched (default the
 * host), so a bar can react to the whole table row it sits in. The rAF only runs while
 * the lift is easing, then stops. Returns a cleanup fn.
 */
export function ditherGradient(host, {
  from = "blue", to = "transparent", direction = "up",
  cell = 3, opacity = 1, bloom = "off",
  hover = false, hoverTarget = null, sparkles = false,
} = {}) {
  const canvas = mountLayer(host, true);
  const bloomCanvas = mountLayer(host, false);
  const hasBloom = applyBloom(bloomCanvas, bloom);
  const reduce = prefersReducedMotion();

  let intensity = 0, hovered = false, raf = 0;

  const paint = () => {
    const box = host.getBoundingClientRect();
    paintGradient(canvas, hasBloom ? bloomCanvas : null, box.width, box.height,
      { from, to, direction, cell, opacity, intensity });
  };
  paint();

  const ro = new ResizeObserver(paint);
  ro.observe(host);

  const unSparkle = sparkles
    ? attachSparkles(host, () => ({ cols: canvas.width, rows: canvas.height, color: from, intensity }))
    : null;

  if (!hover) {
    return () => { ro.disconnect(); unSparkle?.(); canvas.remove(); bloomCanvas.remove(); };
  }

  const target = hoverTarget || host;
  const loop = () => {
    const want = hovered ? 1 : 0;
    if (Math.abs(intensity - want) <= 0.01) { intensity = want; paint(); raf = 0; return; }
    intensity += (want - intensity) * 0.16;
    paint();
    raf = requestAnimationFrame(loop);
  };
  const kick = () => {
    if (reduce) { intensity = hovered ? 1 : 0; paint(); return; }
    if (!raf) raf = requestAnimationFrame(loop);
  };
  const enter = () => { hovered = true; kick(); };
  const leave = () => { hovered = false; kick(); };
  target.addEventListener("pointerenter", enter);
  target.addEventListener("pointerleave", leave);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    target.removeEventListener("pointerenter", enter);
    target.removeEventListener("pointerleave", leave);
    ro.disconnect();
    unSparkle?.();
    canvas.remove();
    bloomCanvas.remove();
  };
}

/* ----------------------------------------------------------------- avatar */

// 8x8 cells, mirrored across one axis → 32 free pattern bits. With the mirror-axis bit
// and 180 hues that's 2^33 x 180 ≈ 1.5 trillion distinct avatars.
const GRID = 8;
const CELL_PX = 4; // backing px per cell → a 32x32 canvas, scaled up pixelated

/**
 * Derive the full 8x8 cell grid from the name: 32 pattern bits + mirror axis + hue +
 * per-cell densities, all from one deterministic PRNG stream. Every value is drawn
 * unconditionally so overriding `hue` or `mirror` never shifts the pattern.
 */
export function avatarModel(name, hueProp, mirrorProp = "auto") {
  const rand = xorshift32(fnv1a(name));
  const bits = Array.from({ length: 32 }, () => rand() < 0.5);
  const drawnVertical = rand() < 0.5;
  const drawnHue = Math.floor(rand() * 180) * 2;
  const halfDensity = Array.from({ length: 32 }, () => 0.55 + rand() * 0.45);

  const vertical = mirrorProp === "auto" ? drawnVertical : mirrorProp === "vertical";
  const hue = hueProp ?? drawnHue;

  const on = new Array(GRID * GRID);
  const density = new Array(GRID * GRID);
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      // Fold across the chosen axis: left/right symmetric, or top/bottom.
      const i = vertical
        ? Math.min(r, GRID - 1 - r) * GRID + c
        : r * (GRID / 2) + Math.min(c, GRID - 1 - c);
      on[r * GRID + c] = bits[i];
      density[r * GRID + c] = halfDensity[i];
    }
  }
  return { on, density, fill: hueFill(hue) };
}

/**
 * Generative dithered avatar — a mirrored 8x8 pixel glyph derived from a name, in the
 * same ordered-dither texture as the charts. Same name, same avatar. Returns a cleanup.
 */
export function ditherAvatar(host, { name, hue, color, mirror = "auto", bloom = "off", animate = true, animationDuration = 600, sparkles = false } = {}) {
  const canvas = mountLayer(host, true);
  const bloomCanvas = mountLayer(host, false);
  const ctx = canvas.getContext("2d");
  const hasBloom = applyBloom(bloomCanvas, bloom);
  const bctx = hasBloom ? bloomCanvas.getContext("2d") : null;

  host.setAttribute("role", "img");
  host.setAttribute("aria-label", `${name} avatar`);

  const model = avatarModel(name, hue, mirror);
  // `color` overrides the fill outright (hex/rgb keep their saturation, where `hue` would
  // throw it away). The pattern still comes from the name, so the glyph is unchanged.
  if (color != null) model.fill = fillOf(color);
  const px = GRID * CELL_PX;
  canvas.width = canvas.height = px;
  if (bloomCanvas) bloomCanvas.width = bloomCanvas.height = px;

  // The glyph's own fill drives its sparkles, so they glint in its colour.
  const unSparkle = sparkles
    ? attachSparkles(host, () => ({ cols: px, rows: px, color: model.fill, intensity: 0 }))
    : null;

  const draw = (progress) => {
    ctx.clearRect(0, 0, px, px);
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        if (!model.on[r * GRID + c]) continue;
        // Cells materialize in Bayer order — the entrance is made of the same matrix
        // as the texture.
        const start = BAYER[r % 4][c % 4] * 0.7;
        const cellAlpha = clamp01((progress - start) / 0.3);
        if (cellAlpha <= 0) continue;
        const density = model.density[r * GRID + c];
        const base = 0.35 + 0.65 * density;
        for (let py = 0; py < CELL_PX; py++) {
          for (let pxi = 0; pxi < CELL_PX; pxi++) {
            const gx = c * CELL_PX + pxi;
            const gy = r * CELL_PX + py;
            const lit = density > BAYER[gy & 3][gx & 3];
            ctx.fillStyle = rgb(model.fill, 1, (lit ? base : base * 0.35) * cellAlpha);
            ctx.fillRect(gx, gy, 1, 1);
          }
        }
      }
    }
    if (bctx) {
      bctx.clearRect(0, 0, px, px);
      bctx.drawImage(canvas, 0, 0);
    }
  };

  if (!animate || prefersReducedMotion()) {
    draw(1);
    return () => { unSparkle?.(); canvas.remove(); bloomCanvas.remove(); };
  }

  let raf = 0;
  const t0 = performance.now();
  const tick = (now) => {
    const t = clamp01((now - t0) / animationDuration);
    draw(easeOutCubic(t));
    if (t < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(raf); unSparkle?.(); canvas.remove(); bloomCanvas.remove(); };
}

/* ------------------------------------------------------------------ shared */

/** The absolutely-positioned canvas layer every mount paints into. */
function mountLayer(host, crisp) {
  const c = document.createElement("canvas");
  c.setAttribute("aria-hidden", "true");
  c.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;" +
    (crisp ? "image-rendering:pixelated;" : "");
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  host.style.isolation = "isolate";
  host.prepend(c);
  return c;
}

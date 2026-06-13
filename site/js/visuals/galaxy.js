// 3D galaxy of album covers. Chronology maps to spiral-arm position.
// Covers are billboarded quads merged into one mesh per 2048px atlas (max 4 draw calls).
import * as THREE from "three";
import { makeRenderer, makeTooltip, makeOrbit, Loop, dpr, esc, mulberry32 } from "./common.js";

const CELL = 128, GRID = 16, PER = GRID * GRID, ATLAS = CELL * GRID;

const VERT = /* glsl */ `
attribute vec2 corner;   // quad offset, pre-scaled by item size
attribute vec2 unit;     // -1..1 quad coords
attribute vec3 tint;
attribute vec4 aState;   // scale, opacity, brightness, texMix
attribute vec2 aFx;      // pop, desat
varying vec2 vUv;
varying vec2 vUnit;
varying vec3 vTint;
varying vec4 vState;
varying float vDesat;
void main() {
  vUv = uv; vUnit = unit; vTint = tint; vState = aState; vDesat = aFx.y;
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec4 wc = modelMatrix * vec4(position, 1.0);
  vec3 wp = wc.xyz + (camRight * corner.x + camUp * corner.y) * aState.x;
  wp += normalize(cameraPosition - wc.xyz) * aFx.x; // hover pop toward camera
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec2 vUnit;
varying vec3 vTint;
varying vec4 vState;
varying float vDesat;
void main() {
  float d = min(length(vUnit), 1.0);
  vec3 quad = vTint * (1.3 - 0.4 * d);            // emissive-feel colored quad
  vec3 col = mix(quad, texture2D(map, vUv).rgb, vState.w);
  float g = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(g), vDesat) * vState.z;
  gl_FragColor = vec4(col, vState.y);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Items may carry a Spotify ref (`uri`/`id`: "spotify:track:<id>", a full open.spotify.com
// URL, or a bare 22-char id). Returns an https URL, or null when absent.
function spotifyUrl(it) {
  const v = (it && (it.uri || it.id)) || "";
  const m = String(v).match(/(?:spotify:track:|open\.spotify\.com\/track\/)?([A-Za-z0-9]{22})/);
  return m ? `https://open.spotify.com/track/${m[1]}` : null;
}

function loadImage(url) {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });
}

export async function initGalaxy(container, items, opts = {}) {
  const renderer = makeRenderer(null, { antialias: !opts.mobile, alpha: true });
  renderer.setPixelRatio(dpr(opts.dprCap));
  renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  container.appendChild(renderer.domElement);
  const dom = renderer.domElement;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 1200);
  const group = new THREE.Group();
  scene.add(group);

  const N = items.length;
  let disposed = false;

  // --- spiral layout (deterministic) ---
  const rng = mulberry32(951);
  const cs = new Float32Array(N * 4); // x,y,z,size per item (for raycast + build)
  const TURNS = 4.2;
  for (let i = 0; i < N; i++) {
    const t = N > 1 ? i / (N - 1) : 0;
    const ang = t * TURNS * Math.PI * 2 + (rng() - 0.5) * 0.2;
    const rad = 7 + Math.pow(t, 0.78) * 105 + (rng() - 0.5) * (4 + t * 8);
    cs[i * 4] = Math.cos(ang) * rad;
    cs[i * 4 + 1] = (rng() + rng() + rng() - 1.5) * (4.5 - t * 2.0); // vertical scatter
    cs[i * 4 + 2] = Math.sin(ang) * rad;
    cs[i * 4 + 3] = 2.6 + rng();
  }

  // --- atlas slots ---
  // Preferred path: sheets pre-baked in CI (dashboard/atlas.py). data.json gives
  // each track a permanent `cell: [sheet, cellInSheet]`, so the client just loads
  // ~4 WebP sheets instead of fetching ~950 covers + compositing them itself.
  // Fallback path (no `atlas` block, or a track without a `cell`): the original
  // client-side per-cover loader below still fills a CanvasTexture atlas.
  const baked = opts.atlas && Array.isArray(opts.atlas.sheets) && opts.atlas.sheets.length
    ? opts.atlas : null;
  const anis = Math.min(4, renderer.capabilities.getMaxAnisotropy());

  const slotted = new Array(N).fill(null);
  let nAtlas;
  if (baked) {
    nAtlas = baked.sheets.length;
    for (let i = 0; i < N; i++) {
      const c = items[i].cell;
      if (c) slotted[i] = { a: c[0], s: c[1] };
    }
  } else {
    let sc = 0;
    for (let i = 0; i < N; i++) {
      if (items[i].art) { slotted[i] = { a: (sc / PER) | 0, s: sc % PER }; sc++; }
    }
    nAtlas = Math.max(1, Math.ceil(sc / PER));
  }

  // crossfade a sheet's covers in once its texture has decoded (avoids a pop)
  function onSheetReady(a) {
    if (disposed) return;
    for (let i = 0; i < N; i++) if (slotted[i] && slotted[i].a === a) st[i].tTex = 1;
    settled = false;
  }

  const atlases = [];
  for (let a = 0; a < nAtlas; a++) {
    if (baked) {
      // same-origin WebP — no crossOrigin / canvas tainting concerns
      const tx = new THREE.TextureLoader().load(
        `atlas/${baked.sheets[a]}`, () => onSheetReady(a), undefined,
        () => console.warn(`[galaxy] atlas sheet ${a} failed to load`));
      tx.colorSpace = THREE.SRGBColorSpace;
      tx.anisotropy = anis;
      atlases.push({ texture: tx });
    } else {
      const cv = document.createElement("canvas");
      cv.width = cv.height = ATLAS;
      const tx = new THREE.CanvasTexture(cv);
      tx.colorSpace = THREE.SRGBColorSpace;
      tx.anisotropy = anis;
      atlases.push({ ctx: cv.getContext("2d"), texture: tx });
    }
  }

  // --- per-item animated state ---
  const st = [];
  for (let i = 0; i < N; i++) {
    st.push({ scale: 1, opacity: 1, bright: 1, tex: 0, pop: 0, desat: 0,
              tScale: 1, tOpacity: 1, tBright: 1, tTex: 0, tPop: 0, tDesat: 0 });
  }
  let settled = true;

  // --- merged geometry, one mesh (chunk) per atlas ---
  const chunkItems = Array.from({ length: nAtlas }, () => []);
  const loc = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = slotted[i] ? slotted[i].a : i % nAtlas;
    loc[i] = { chunk: a, idx: chunkItems[a].length };
    chunkItems[a].push(i);
  }
  const UNITS = [-1, -1, 1, -1, 1, 1, -1, 1];
  const chunks = [];
  const fallback = new THREE.Color("#8a93a6");
  for (let a = 0; a < nAtlas; a++) {
    const list = chunkItems[a], m = list.length;
    const position = new Float32Array(m * 12), tint = new Float32Array(m * 12);
    const corner = new Float32Array(m * 8), unit = new Float32Array(m * 8), uvA = new Float32Array(m * 8);
    const stateA = new Float32Array(m * 16), fxA = new Float32Array(m * 8);
    const index = new Uint32Array(m * 6);
    const col = new THREE.Color();
    for (let k = 0; k < m; k++) {
      const i = list[k], o = i * 4;
      try { col.set(items[i].color || "#8a93a6"); } catch { col.copy(fallback); }
      let u0 = 0, v0 = 0, du = 0, dv = 0;
      if (slotted[i]) {
        const s = slotted[i].s;
        u0 = (s % GRID) / GRID; du = 1 / GRID;
        v0 = 1 - (((s / GRID) | 0) + 1) / GRID; dv = 1 / GRID;
      }
      for (let v = 0; v < 4; v++) {
        const p3 = (k * 4 + v) * 3, p2 = (k * 4 + v) * 2, p4 = (k * 4 + v) * 4;
        position[p3] = cs[o]; position[p3 + 1] = cs[o + 1]; position[p3 + 2] = cs[o + 2];
        const ux = UNITS[v * 2], uy = UNITS[v * 2 + 1];
        corner[p2] = ux * cs[o + 3] * 0.5; corner[p2 + 1] = uy * cs[o + 3] * 0.5;
        unit[p2] = ux; unit[p2 + 1] = uy;
        uvA[p2] = u0 + (ux * 0.5 + 0.5) * du; uvA[p2 + 1] = v0 + (uy * 0.5 + 0.5) * dv;
        tint[p3] = col.r; tint[p3 + 1] = col.g; tint[p3 + 2] = col.b;
        stateA[p4] = 1; stateA[p4 + 1] = 1; stateA[p4 + 2] = 1; stateA[p4 + 3] = 0;
        fxA[p2] = 0; fxA[p2 + 1] = 0;
      }
      index.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvA, 2));
    geo.setAttribute("corner", new THREE.BufferAttribute(corner, 2));
    geo.setAttribute("unit", new THREE.BufferAttribute(unit, 2));
    geo.setAttribute("tint", new THREE.BufferAttribute(tint, 3));
    const stateAttr = new THREE.BufferAttribute(stateA, 4); stateAttr.setUsage(THREE.DynamicDrawUsage);
    const fxAttr = new THREE.BufferAttribute(fxA, 2); fxAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aState", stateAttr);
    geo.setAttribute("aFx", fxAttr);
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: atlases[a].texture } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    group.add(mesh);
    chunks.push({ geo, mat, state: stateAttr, fx: fxAttr });
  }

  // --- starfield dust ---
  const STARS = 800;
  const sPos = new Float32Array(STARS * 3), sCol = new Float32Array(STARS * 3);
  const personCols = Object.values(opts.personColors || {}).map((c) => { const k = new THREE.Color(); try { k.set(c); } catch {} return k; });
  const sColor = new THREE.Color();
  for (let i = 0; i < STARS; i++) {
    const th = rng() * Math.PI * 2, ph = Math.acos(rng() * 2 - 1), r = 60 + rng() * 230;
    sPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    sPos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
    sPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    if (personCols.length && rng() < 0.12) sColor.copy(personCols[(rng() * personCols.length) | 0]).multiplyScalar(0.8);
    else sColor.setRGB(0.45, 0.5, 0.62).multiplyScalar(0.5 + rng() * 0.5);
    sCol[i * 3] = sColor.r; sCol[i * 3 + 1] = sColor.g; sCol[i * 3 + 2] = sColor.b;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
  starGeo.setAttribute("color", new THREE.BufferAttribute(sCol, 3));
  const starMat = new THREE.PointsMaterial({
    size: 1.5, vertexColors: true, transparent: true, opacity: 0.8,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  group.add(stars);

  // --- progressive texture loading (fallback only — skipped when sheets are
  // pre-baked). Small concurrency queue pulling the 300px art so the 128px atlas
  // cell is a crisp downscale, not an upscale of the 64px thumb. ---
  if (!baked) (async () => {
    const jobs = [];
    for (let i = 0; i < N; i++) if (slotted[i]) jobs.push(i);
    let cursor = 0;
    const dirty = new Set();
    let pending = [];
    let lastFlush = performance.now();
    // Each flush re-uploads a full 2048² atlas to the GPU — cheap on desktop, a
    // visible hitch on mobile. So mobile batches far larger and is time-gated:
    // fewer, fatter uploads instead of a stutter every 24 covers. A min interval
    // keeps the crossfades from all landing at once; a max interval still shows
    // steady progress on slow links.
    const FLUSH_MAX = opts.mobile ? 80 : 24;     // upload once this many are queued…
    const FLUSH_MIN_MS = opts.mobile ? 450 : 0;  // …but not more often than this…
    const FLUSH_MAX_MS = opts.mobile ? 1100 : 700; // …and at least this often.
    const flush = () => {
      dirty.forEach((a) => { atlases[a].texture.needsUpdate = true; });
      dirty.clear();
      for (const i of pending) st[i].tTex = 1; // crossfade only after GPU upload is queued
      if (pending.length) settled = false;
      pending = [];
      lastFlush = performance.now();
    };
    const worker = async () => {
      while (!disposed && cursor < jobs.length) {
        const i = jobs[cursor++];
        const it = items[i];
        const img = await loadImage(it.art || it.artSm);
        if (disposed) return;
        if (!img) continue; // failed: colored quad stays
        const { a, s } = slotted[i];
        try { atlases[a].ctx.drawImage(img, (s % GRID) * CELL, ((s / GRID) | 0) * CELL, CELL, CELL); } catch { continue; }
        dirty.add(a);
        pending.push(i);
        const since = performance.now() - lastFlush;
        if ((pending.length >= FLUSH_MAX && since > FLUSH_MIN_MS) || since > FLUSH_MAX_MS) flush();
      }
    };
    await Promise.all(Array.from({ length: opts.mobile ? 4 : 6 }, worker));
    if (!disposed) flush();
  })();

  // --- interaction ---
  const orbit = makeOrbit(dom, {
    radius: 175, minR: 40, maxR: 330, theta: 0.6, phi: 1.05,
    minPhi: 0.25, maxPhi: Math.PI - 0.35,
    touchAction: opts.mobile ? "pan-y" : "none",
  });
  const tooltip = makeTooltip(container);
  const raycaster = new THREE.Raycaster();
  const _ray = new THREE.Ray(), _inv = new THREE.Matrix4(), _v = new THREE.Vector3(), _ndc = new THREE.Vector2();
  let hoverIdx = -1, focusName = null;

  function applyTargets() {
    for (let i = 0; i < N; i++) {
      const s = st[i];
      const inFocus = !focusName || items[i].by === focusName;
      s.tScale = focusName && inFocus ? 1.6 : 1;
      s.tOpacity = inFocus ? 1 : 0.25;
      s.tBright = focusName && inFocus ? 1.35 : 1;
      s.tDesat = inFocus ? 0 : 0.45;
      s.tPop = 0;
    }
    if (hoverIdx >= 0) {
      const s = st[hoverIdx];
      s.tPop = 3; s.tScale *= 1.18; s.tOpacity = 1; s.tBright = Math.max(s.tBright, 1.15); s.tDesat = 0;
    }
    settled = false;
  }

  function pick(cx, cy) {
    const rect = dom.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    _ndc.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(_ndc, camera);
    group.updateMatrixWorld();
    _inv.copy(group.matrixWorld).invert();
    _ray.copy(raycaster.ray).applyMatrix4(_inv);
    const d = _ray.direction;
    let best = -1, bestT = Infinity;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      _v.set(cs[o] - _ray.origin.x, cs[o + 1] - _ray.origin.y, cs[o + 2] - _ray.origin.z);
      const t = _v.dot(d);
      if (t < 0 || t > bestT) continue;
      const r = cs[o + 3] * 0.62;
      if (_v.lengthSq() - t * t < r * r) { best = i; bestT = t; }
    }
    return best;
  }

  function showTip(i, x, y) {
    const it = items[i];
    const dte = it.ts ? new Date(it.ts) : null;
    const when = dte && !isNaN(dte) ? dte.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "";
    const url = spotifyUrl(it);
    const hint = url
      ? `<br><span style="color:#7cc4dc;opacity:.9">↗ ${opts.mobile ? "tap again to open in Spotify" : "open in Spotify"}</span>`
      : "";
    tooltip.show(
      `<strong>${esc(it.name)}</strong><br>${esc(it.artists || "")}<br>` +
      `<span style="opacity:.7">shared by ${esc(it.by || "?")}${when ? " · " + when : ""}</span>${hint}`, x, y
    );
  }

  function openTrack(i) {
    const url = spotifyUrl(items[i]);
    if (!url) return;
    // window.open works in normal browsers; Brave shields block it from canvas
    // handlers (returns null) — then ride the same click gesture on a real
    // anchor instead, which blockers treat like a genuine link click.
    let w = null;
    try { w = window.open(url, "_blank", "noopener"); } catch { /* blocked */ }
    if (!w) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  function setHover(i, x, y) {
    if (i === hoverIdx) { if (i >= 0) showTip(i, x, y); return; }
    hoverIdx = i;
    applyTargets();
    if (i >= 0) { showTip(i, x, y); dom.style.cursor = "pointer"; }
    else { tooltip.hide(); dom.style.cursor = ""; }
  }

  const onMove = (e) => {
    if (opts.mobile || orbit.dragging) return;
    const rect = dom.getBoundingClientRect();
    setHover(pick(e.clientX, e.clientY), e.clientX - rect.left, e.clientY - rect.top);
  };
  const onClick = (e) => {
    // a real click, not the tail of a drag (orbit tracks movement, threshold
    // 6px; pointerup runs before click so justDragged is already settled).
    // Handled on "click" — the user activation popup blockers trust most.
    if (orbit.justDragged) return;
    const rect = dom.getBoundingClientRect();
    const i = pick(e.clientX, e.clientY);
    if (!opts.mobile) { // desktop: click on a hovered cover opens it on Spotify
      // if the re-pick misses (auto-rotation drifted the cover since the last
      // pointermove), trust the still-shown hover instead
      const j = i >= 0 ? i : hoverIdx;
      if (j >= 0) openTrack(j);
      return;
    }
    // mobile: first tap = tooltip, second tap on the same cover = open
    if (i >= 0 && i === hoverIdx) { openTrack(i); return; }
    setHover(i === hoverIdx ? -1 : i, e.clientX - rect.left, e.clientY - rect.top);
  };
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("click", onClick);

  // --- frame ---
  function tickState(dt) {
    if (settled) return;
    const k = 1 - Math.exp(-7 * dt);
    let res = 0;
    for (let i = 0; i < N; i++) {
      const s = st[i];
      s.scale += (s.tScale - s.scale) * k;
      s.opacity += (s.tOpacity - s.opacity) * k;
      s.bright += (s.tBright - s.bright) * k;
      s.tex += (s.tTex - s.tex) * k;
      s.pop += (s.tPop - s.pop) * k;
      s.desat += (s.tDesat - s.desat) * k;
      res = Math.max(res, Math.abs(s.tScale - s.scale), Math.abs(s.tOpacity - s.opacity),
        Math.abs(s.tTex - s.tex), Math.abs(s.tPop - s.pop) * 0.3);
      const L = loc[i], SA = chunks[L.chunk].state.array, FA = chunks[L.chunk].fx.array;
      for (let v = 0; v < 4; v++) {
        const p4 = (L.idx * 4 + v) * 4, p2 = (L.idx * 4 + v) * 2;
        SA[p4] = s.scale; SA[p4 + 1] = s.opacity; SA[p4 + 2] = s.bright; SA[p4 + 3] = s.tex;
        FA[p2] = s.pop; FA[p2 + 1] = s.desat;
      }
    }
    for (const c of chunks) { c.state.needsUpdate = true; c.fx.needsUpdate = true; }
    if (res < 0.003) settled = true;
  }

  const doResize = () => {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  doResize();
  orbit.apply(camera);

  const loop = new Loop((dt) => {
    orbit.update(dt);
    orbit.apply(camera);
    if (!opts.reducedMotion) group.rotation.y += dt * 0.018;
    tickState(dt);
    renderer.render(scene, camera);
  });

  return {
    start() { if (!disposed) loop.start(); },
    pause() { loop.pause(); },
    resize() { if (!disposed) doResize(); },
    focusPerson(name) {
      if (disposed) return;
      focusName = typeof name === "string" && name ? name : null;
      applyTargets();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      loop.dispose();
      orbit.dispose();
      tooltip.dispose();
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("click", onClick);
      for (const c of chunks) { c.geo.dispose(); c.mat.dispose(); }
      starGeo.dispose(); starMat.dispose();
      for (const a of atlases) a.texture.dispose();
      renderer.dispose();
      dom.remove();
    },
  };
}

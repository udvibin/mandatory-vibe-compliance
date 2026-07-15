# Vibe Compliance Dashboard — Plan

"Spotify Wrapped but with the bois." A stats site for the Mandatory Vibe
Compliance group chat, generated from the same chat exports the sync bot
already uses. Everything free: Spotify Web API, Drive API, Actions, Pages.

## Current status (2026-06-11)

| Piece | State |
|---|---|
| Data pipeline (`dashboard/`) | ✅ done — 987 shares, 951 unique tracks, 13 sharers, Aug 2021 → Jun 2026 |
| Playlist reconciliation | ✅ zero-delta: 951 chat tracks = 951 playlist tracks, every historical mismatch explained & pinned in `resolution_cache.json` |
| Story page (`site/index.html`) | ✅ built + 3 review rounds of polish |
| Nerd view (`site/dashboard.html`) | ✅ done (Chart.js, year filters, instant tooltips) |
| Background (vortex-shedding shader) | ✅ finalized with Uday; his params locked as `BG_DEFAULTS` in `fractal-bg.js` |
| CI deploy (GitHub Pages) | ✅ LIVE — https://udvibin.github.io/mandatory-vibe-compliance/ (deployed 11 Jun, end-to-end verified by Uday in Brave) |
| Privacy | ✅ decided 11 Jun: publish with real first names |

## Tasks to take up

1. ~~First deploy~~ DONE 11 Jun — live at
   https://udvibin.github.io/mandatory-vibe-compliance/ ; still open:
   custom domain decision (is-a.dev subdomain or ~₹400/yr .in)
2. ~~Galaxy wheel-zoom mechanic~~ DECIDED 12 Jun — current behaviour stays
   (ctrl+wheel / pinch zooms, plain wheel scrolls). No further work.
3. **Constellation v2 redesign** — SHIPPED 13 Jun. v1 (cosine similarity
   graph) rejected: overlapping labels, disconnected low-similarity nodes,
   unreadable weights — a data-shape problem (13 nodes is too few for a
   force graph; a cosine matrix shows a *number about* taste, not taste
   itself). Replaced by the **genre nebulae** (artists as stars clustered
   in genre-family fog clouds, each boi a constellation traced through
   their artists). Built as a mock, then polished (Uday: v1 mock "looked
   childish") into a proper astrophotography look and wired into
   `#constellation`. Full design in "Genre nebulae" below. The **time
   machine** mock is PARKED (see Scope creep). Mock page `site/mocks.html`
   stays for reference.
4. ~~Nerd-view CTA~~ DONE 12 Jun — bordered `.nerd-cta` block in the outro
   ("want every chart, every table? open the nerd view →"); footer is now
   just "built with ❤️".
5. ~~Galaxy mobile loading~~ DONE 12 Jun, improved 13 Jun, **SUPERSEDED 14 Jun
   by the pre-baked atlas** (see "Galaxy cover-atlas" below). History: pipeline
   stored `art_sm` (64px) for mobile; later flushes were time-gated to smooth
   uploads (`FLUSH_*` in `visuals/galaxy.js`). That whole client-side per-cover
   loader is now the **fallback path** only — when sheets are baked the client
   loads 4 WebP files instead. `art_sm` still feeds the CSS fallback grid.
6. ~~Glass defaults~~ LOCKED 12 Jun by Uday via ?glass tuner:
   `--glass-fill:0; --glass-blur:7px; --glass-sat:160%` (pure refraction).

## Genre nebulae (SHIPPED 13 Jun — `#constellation` section)

The constellation slot now renders **`site/js/visuals/nebulae.js`**, wired
through `sections/constellation.js` via `lazyVisual` (CSS fallback = genre
families list in `#pairs`). The mock page `site/mocks.html` stays for
reference (still loads the parked time machine too). Verified clean
(0 console errors / 0 failed requests, desktop + mobile) via
`dev/verify_site.py`; screenshots `dev/screens/live-nebulae-*.png`.

- **Concept:** invert the graph. Stars = artists (~200, everything with
  ≥2 shares), clustered inside genre-family nebula clouds (desi, hip hop,
  house & edm, indie & dream, …). People are *constellations*: hover/click
  a person chip and an MST of glowing lines in their color is traced
  through every artist they've shared (animated draw-in via
  `setDrawRange`). Taste becomes literally visible — no percentages.
- **Layout:** all precomputed at init, no per-frame physics. Family
  anchors on a flattened fibonacci sphere + pairwise overlap relaxation;
  artists scattered in flattened balls around their anchor + local
  repulsion. Deterministic (`mulberry32` seeds).
- **Look — the polish pass (Uday: v1 mock "looked childish").** v1 was
  candy-bright rainbow fog blobs + uniform fuzzy star-dots + shouty
  oversized all-caps labels. Reworked toward astrophotography:
  - **Palette** desaturated to cohesive deep-space tones (Hα reds, OIII
    teals, reflection blues, dusty golds) — `FAMILY_COLORS`, now in its
    own three-free module `site/js/visuals/family-colors.js` (re-exported
    by nebulae.js; the section's CSS fallback imports it without pulling
    in WebGL).
  - **Gas.** Texture is **domain-warped** fBm (`fbm(p + W·fbm(p + W·fbm(p)))`)
    baked once into 3 canvas textures (soft rounded `(1-r)²` mask + contrast
    threshold → cloud texture). Each cluster = ~7-15 additive sprites: 2
    brighter `coreCol` central sprites + body sprites at the genre hue with
    per-sprite warm/cool drift, sized by the cluster radius. Aesthetic is
    **explicitly not final** — Uday: revisit the cloud shapes another time.
    (History: pass 1 invisible grey smudges → pass 2/3 soft colour clouds
    → pass 4 tried elongated wisps + connective bridges but they read as
    jagged star-bursts → **reverted to the pass-2/3 soft clouds**, which is
    what ships now. Camera default zoomed out (orbit radius desktop 60 /
    mobile 90, was 46/72).)
  - **Scroll choreography (Uday: "scroll in and scroll out").** The nebula
    handle exposes `setReveal(k)`; `sections/constellation.js` scrubs it with
    scroll (same ramp as `#bg-dim`) to fade + drift the canvas and chips in
    as the section enters and out as it leaves (CSS opacity/transform on the
    canvas — cheap; skips the transform under reduced-motion).
  - **Background (settled 13 Jun, 3rd pass):** the sparse field let the
    fractal bg bleed (bright orange wedge washing out the gas). First tried
    an opaque backdrop sprite — Uday: "too jarring", wanted it "like the
    galaxy". So: **no backdrop** — the canvas stays transparent and the same
    `#bg-dim` scroll-overlay used by the galaxy darkens the fractal, just to
    a deeper peak for this section (galaxy 0.88 → **constellation 0.96**,
    per-section in `initBgDim`). Smooth ramp in/out, near-black at rest, gas
    layered on top, triangle stays down. Plus the layered starfield (far/mid/
    near + faint dust) and a soft CSS **vignette** for depth.
  - **Stars** got sharp cores, wider size variation, a per-star colour
    temperature jitter, and **4-point diffraction spikes** on the ~top-10
    anchors (twinkle in the loop). Glow tint barely whitened (lerp 0.08) so
    stars carry their genre hue.
  - **Labels** (Uday: "barely visible") — `textSprite` now draws a crisp
    dark **outline** (round-join stroke) + soft halo under the fill, so type
    reads over bright gas. Family captions bright (lerp-white .78, ~0.92
    alpha, weight 700); ~top-16 artist names labelled, also outlined.
- **Interaction:** orbit camera (drag / ctrl+wheel, mobile pan-y
  preserved; mobile sits further back, radius 72); star tooltips show
  micro-genres + per-person share breakdown; readout shows the focused
  boi's "home nebula" (hidden on mobile until a boi is picked — it
  collided with the section title and just echoed the subtitle).
- **Dark backdrop:** the `#bg-dim` scroll choreography (was galaxy-only,
  now `initBgDim` covers `#galaxy` + `#constellation`, max of the two)
  fades the fractal bg to near-black while the nebulae own the viewport —
  Uday wanted it darker so the stars read.
- **Genre data — now in the pipeline.** Derivation lives in
  **`dashboard/genres.py`** (`derive_genres(tracks, cache)`), called by
  `generate.py` to emit `data.json["genres"] = {families: {name → stats},
  artists: {name → {family, genres[:3], shares, by}}}` (~25 KB). The
  committed `data.json` was patched in place with this block (offline,
  from `resolution_cache.json` — zero API calls), so the live site works
  before the next CI regen, which produces the identical block. The dev
  mock script `dev/derive_genre_mock.py` is now a thin wrapper over the
  same module (can't drift) and still writes `site/genre-mock.json`.
- **Genre→family mapping:** ordered keyword rules (first match wins;
  "punjabi hip hop" must hit *desi hip hop* before *desi*/*hip hop*).
  **Spotify's 2024 genre purge** left big mainstream artists (Weeknd,
  Frank Ocean, Metro Boomin…) with zero genres — rescued by (1) collab
  inference: inherit majority family of co-credited artists, then
  (2) `GENRE_PINS`, a small hand-pin map in the spirit of the pinned
  resolution cache. Whatever's left stays in an "uncharted" nebula
  (deliberate flavor — only truly obscure stuff lands there).
- **Still open / future prospects (genre):** **nebula cloud aesthetics**
  (Uday parked a deeper visual pass — current soft clouds are "good enough
  to ship", but the smoke/filament look is unsolved); richer per-boi genre
  storytelling (e.g. a "genre fingerprint" stat); tightening the keyword
  rules / `GENRE_PINS` as the catalogue grows; shrinking "uncharted".
  `visuals/constellation.js` (the dead v1 graph) is no longer used by the
  live site, but `visuals-test.html` still imports it — delete both (and
  swap visuals-test to the nebulae) on a future cleanup pass.

## Scope creep (explicitly parked — do not pick up)

- **Two more background variants** — bg-lab iteration; original task
  retired 12 Jun as scope creep.
- **Playable vinyl** — hero record that actually plays the playlist's
  songs. Glorious. Parked.
- **Push notifications** (PWA) — needs per-device subscription storage +
  a VAPID sender; repo has no backend, and committing push endpoints to a
  public repo leaks them. Parked 15 Jul until there's a reason to ping
  the bois (e.g. "new bangers synced").
- **Time machine** (`site/js/visuals/timemachine.js`) — PARKED 13 Jun by
  Uday ("the timeline one … lets park that") in favour of shipping the
  nebulae. Still fully built + mocked at `site/mocks.html` (loads it under
  the nebulae). Idea: every track plotted *when shared* (x) vs *when made*
  (y), with a "release frontier" curve and power-scaled (`t^2.6`) depth
  axis; readout = median age-when-shared / day-one shares / deepest cut.
  100% existing `data.json` (no pipeline changes). Revive by adding a
  `#timemachine` section + module mirroring `sections/constellation.js`.
6. ~~Hero text rewrite~~ DONE 12 Jun — wordmark is now the H1:
   "Mandatory *Vibe* Compliance" (coral italic "Vibe", matching the
   section-title accent); computed stats line moved to a serif-italic
   subline; overline is just "EST. AUG 2021". Fonts kept.
7. ~~Favicon~~ DONE 12 Jun — `site/favicon.svg`, vinyl disc in the
   Currents palette (linked from index + dashboard).
8. ~~Text legibility over the background~~ DONE 12 Jun — liquid-glass
   panels (`.sec.glass` in style.css): every text section sits in a
   rounded frosted card (backdrop blur + saturate boost + bright inset
   rim, low fill so the bg stays visible); galaxy/constellation overlay
   text gets a smaller `.glass-scrim`. Falls back to near-solid panels
   under `prefers-reduced-transparency`.
9. ~~Hero vinyl position~~ DONE 13 Jun — the disc was floating mid-page
   (a big in-flow `margin-top`, and a separate, higher value on mobile).
   `.vinyl-stage` is now `position:absolute` pinned to the hero bottom
   (`left/right:0 + margin-inline:auto` to centre without a transform, so
   the gsap entrance `y` tween still works), `bottom:clamp(...)`. Sits just
   above the page edge on every viewport. The wordmark then sat dead-centre,
   so `.hero` is now `justify-content:flex-start` with
   `padding-top:clamp(7rem,19vh,13.5rem)` — wordmark back in the upper third
   (~29% vh, near its original spot). The absolute vinyl is unaffected.

## Architecture (reference)

**No live backend.** Data changes only when the bot runs (every 2 days);
GitHub Actions is the "backend", the site is fully static.

```
One-time (already run; backfill_history.py deleted 12 Jun — in git history):
  Shridhar archive ─> backfill_history.py ─> dashboard/history.json
  (only ts / sender / track-URI committed; raw chat text never enters git)

Every 2 days (GitHub Actions, same job as the playlist sync):
  scripts/spotify.py            # sync playlist (existing bot)
  dashboard/generate.py         # merge history + live Drive export,
    │                           # resolve links (resolution_cache.json ≈ 0 API
    │                           # calls/run), crunch stats
    └─> site/data.json  ─> upload-pages-artifact ─> deploy-pages
  (log + cache + data.json committed back to the repo each run)
```

**Frontend:** no build step — ES modules + import maps, all pinned jsdelivr
CDN: three@0.165.0, gsap@3.12.5, chart.js@4.4.3. Two pages: `index.html`
(scrollytelling story) and `dashboard.html` (nerd view). Every visual has a
CSS fallback; reduced-motion respected; mobile caps DPR/texture counts.

**data.json schema:** normalized around `tracks` (URI → metadata +
`shared_by`), plus precomputed `people` / `years` / `timeline` /
`similarity` / `genres` (artist→family for the nebulae) / `trendsetters` /
`facts`. Crossovers and re-shares are derived client-side from
`tracks.shared_by`. ~450 KB raw.

## Galaxy cover-atlas (pre-baked in CI — SHIPPED 14 Jun)

The galaxy used to fetch ~950 individual covers and composite the atlas in the
browser. Going all-covers-sharp on mobile meant 950 requests × 30 KB (300px) =
**~29 MB → ~30 s on a phone.** Now `dashboard/atlas.py` bakes the atlas **once in
CI** and the client just loads the sheets: **4 WebP files, ~2.9 MB, ~0 cover
requests.**

- **Layout (must match between baker & client):** `CELL=128`, `GRID=16`,
  `PER=256` covers/sheet, `2048²` sheets. Both `dashboard/atlas.py` and
  `site/js/visuals/galaxy.js` hardcode these — change them together.
- **Permanent, append-only slots.** Track order in `data.json` is first-share
  chronological and append-only, so cover N keeps slot N forever
  (`slot → sheet = slot//PER`, `cell = slot%PER`). Persisted in
  **`dashboard/atlas_manifest.json`** (`uris` list = slot order, `sheets` =
  current filenames, `failed` = slots awaiting a good bake).
- **Delta / frozen sheets.** A sheet is rebuilt only if it has no file, gained a
  new slot, or holds a previously-failed cell. A full sheet with none of those
  is **frozen** — never re-baked. So per-run work is O(new covers): only the
  tail sheet churns. Scales to thousands (lazy-load sheets by camera distance if
  it ever gets huge).
- **Cache-busting:** sheet filename carries a content hash
  (`galaxy-<idx>.<hash>.webp`), referenced from `data.json` → browsers never
  serve a stale sheet. Identical content ⇒ identical hash ⇒ git sees no change.
- **`data.json`:** each baked track gets `cell:[sheet,cellInSheet]`; top-level
  `atlas:{cell,grid,sheets:[...]}`. A track with no `cell` (no art, or a failed
  bake) falls back to the colored-quad / per-cover path — the galaxy never hard-
  breaks, and local dev without baked sheets still works.
- **CI:** `generate.py` calls `bake_atlas` best-effort (a bake error won't sink
  the run). The workflow commits `site/atlas/` (`git add -A`) + the manifest.
- **Force a re-bake** (e.g. an album's art changed): delete that URI's entry
  from `atlas_manifest.json` (à la `apple_link_failures.json`).
- **Security:** covers come from Spotify's CDN but are treated as untrusted —
  Content-Type + byte cap before decode, `Image.MAX_IMAGE_PIXELS` bomb guard,
  per-cover try/except. Sheets are same-origin, which also removes the old
  cross-origin canvas-tainting concern. WebP quality (`WEBP_QUALITY=82`) is the
  size/sharpness knob.

## PWA (SHIPPED 15 Jul — `site/manifest.webmanifest`, `site/sw.js`)

Site is installable to a phone home screen and works offline. No build step, no workbox.

- `site/manifest.webmanifest` — every path is **relative** (`start_url`/`scope` = `./`).
  Pages serves from `/Spotify-Thingy/`, so absolute paths would break install there.
- `site/icon-192.png` / `icon-512.png` — the `favicon.svg` vinyl, centred at ~61% on a
  `#0a161d` square so one pair of icons is valid as both `any` and `maskable`
  (maskable needs the art inside the centre-80% safe circle; a full-bleed vinyl gets
  its grooves cropped by Android's mask). Regenerate by rasterising the SVG, not by hand.
- `site/sw.js` — `data.json` and navigations are **network-first** (CI regenerates
  `data.json` every 2 days; cache-first would pin the site to stale numbers). Everything
  else is cache-first + background refresh, and the jsdelivr/fonts CDNs are cached too —
  without them offline is a blank page, since three/gsap/chart.js are import-mapped there.
- Album covers (i.scdn.co) are cached **as they lazy-load** — whatever you've scrolled
  past works offline; no precache of all ~700. Bump `CACHE` to invalidate everything.
- Cross-origin subresources (covers, fonts) are refetched in **CORS mode** inside the SW:
  their natural no-cors requests yield opaque responses, which `res.ok` rejects and Chrome
  pads by ~MBs in cache storage. Every allowed host sends `ACAO:*`, so this is safe. If a
  new CDN host is ever added to `isCacheable`, it must send `ACAO:*` too.
- Install chip: footer of `index.html`, shown only when `beforeinstallprompt` fires
  (Chrome/Android). iOS never fires it — Safari users go Share → Add to Home Screen.
  Visibility is toggled on the wrapper div, not the button — `.chip`'s `display:inline-flex`
  would override the `hidden` attribute.

## Dither kit (SHIPPED 14 Jul — `site/js/visuals/dither.js`)

Vanilla port of **dither-kit** (tripwire.sh/dither-kit, by ripgrim). Upstream ships
React/TSX + Tailwind via a shadcn registry (deps: motion, d3-scale, d3-shape, clsx,
tailwind-merge) — unusable here (no npm, no build). But none of the *pixels* were React:
the paint math is plain canvas-2D. So the paint core (`palette.ts`, `pixel.ts`,
`dither-paint.ts`) is copied verbatim and the React components became plain mounts.

- `site/js/visuals/dither.js` — **zero imports, zero deps.** Paint core (Bayer matrix,
  `paintColumn`, bloom, FNV-1a + xorshift PRNG), the four variants, sparkles, hover lift,
  plus `ditherButton` / `ditherGradient` / `ditherAvatar`. Liftable to its own repo as-is.
- `site/js/visuals/dither-chartjs.js` — the **only** file that knows Chart.js exists.
  `ditherFillPlugin` paints the dither surface into a Chart.js line chart's plot rect.
  Not from upstream (it renders its own charts, so it never needed a bridge) — ours.
- Live in: `#timeline` (area fill, purple `#a98ad6`), `#leaderboard` (bar fills, each
  boi's hex), `#bois` (96px generative avatars), the nerd-view CTA (dithered button).
  Every one keeps its old CSS as fallback and is wrapped in try/catch.

**How it works, in one line:** one 4×4 Bayer threshold matrix; light a pixel when
`density > BAYER[y&3][x&3]`. Everything (chart fill, button, wash, avatar) differs only
in what feeds `density`. Hover lift *subtracts from the threshold*, so the texture gets
denser, not just brighter.

Not ported (upstream still has them): bar/pie/radar renderers, sparkline, scrub tooltip,
legend spotlight, stacking, multi-series. `paintColumn` already takes the `stacked` /
`dim` / `sparse` args those need — the hooks are in.

## Gotchas & decisions (hard-won, don't relearn)

- **Dither: colour vs opacity.** Every pixel is the series' *one* fill colour; only alpha
  varies ("off" cells are painted at 40% of "on"). Never introduce a lighter shade — it
  reads as stray white specks on a light background. This is why the whole kit survives
  both themes.
- **`fillOf()` takes hex/rgb, not just a hue.** A hue throws away saturation and
  lightness — Ankit's grey `#9db4bd` comes back a *vivid teal* through `hueOfHex`. Pass
  the real hex for anything that must keep its colour.
- **The chart fill must sample the LINE, not the points.** Chart.js draws a bezier
  (`tension`); straight-lining between data points makes the fill cut corners and leak
  past the curve on sharp peaks. Use `meta.dataset.interpolate({x}, "x")`.
- **Re-read the surface every draw.** Chart.js *animates* its points — a surface captured
  once freezes the fill at whatever height the entrance was at (it looked ~40% tall).
- **The entrance reveal must drive its own rAF.** Chart.js stops calling `draw()` the
  moment *its* animation ends, stranding a longer reveal partway — leaves a hard vertical
  edge where the fill just stops.
- **Never wink sparkles through `chart.draw()`.** Re-rendering every axis/tick 10×/sec to
  move a few 1px stars pegs the compositor. Sparkles live on their own overlay canvas and
  ride one shared page-wide 10Hz timer (measured cost of sparkling *everything*: nil —
  60fps, identical median and worst frame).
- **Chart.js config: one `plugins` key only.** A second `plugins:` in the same object
  literal silently shadows the first — the dither plugin vanished with no error at all.
- **Overlay canvases need an explicit CSS size.** The plugin sizes them in *device* px; a
  canvas without `width/height:100%` renders at its intrinsic size and spills out of the
  section.
- A dither fill behind real text needs `opacity` pulled back (and/or the `dotted`
  variant): a solid `gradient` coral swallowed the coral CTA label whole.

- **Shridhar archive is in UK time** (exported on his phone) — timestamps
  converted Europe/London → IST in backfill (validated on overlap).
- The two phones use different contact names for the same people:
  `NAME_MAP` in `dashboard/common.py` reconciles; `DISPLAY_NAMES` controls
  public names (currently first names) — edit + regenerate to change.
- Both WhatsApp export formats handled (old `DD/MM/YYYY, HH:MM` and new
  `DD/MM/YY, h:mm am/pm`).
- `resolution_cache.json` is **pinned** in places: re-shares/version variants
  resolve to the playlist's URI so chat data and playlist agree 1:1. Don't
  blow the cache away.
- Spotify audio features (energy/valence) are deprecated for new apps —
  mood features were skipped by design.
- Bot dedup normalizes version suffixes ("- 2014 Remaster" etc.) but keeps
  deliberate different recordings ("- southstar remix") distinct —
  `normalize_track_detail()` in `scripts/spotify.py`, tested against all
  known historical pairs.
- **Headless Chromium delivers popups erratically** (even from real button
  clicks) — verify scripts assert the `window.open` invocation instead of
  waiting for a popup page. Real-browser link behavior was verified headed.
- Galaxy links bug (v3): the section never passed `uri` into the visual's
  items — if links die again, check the data plumbing before blaming popups.

## Dev tooling

- `cd site && python -m http.server 8901` → http://localhost:8901/
- `site/bg-lab.html` — background tuning lab (all params live, copy-params)
- `index.html?glass` — frosted-glass tuner (fill/blur/saturate sliders,
  copy values → paste into the `--glass-*` vars in `:root` in style.css)
- `site/visuals-test.html` — isolated visuals page (?real=1 / ?mobile=1)
- `dev/verify_site.py` — full-page Playwright check (console errors, failed
  requests, screenshots per section into `dev/screens/`, gitignored)
- `dev/verify_bg.py` — background-specific screenshots/check
- `site/dither-lab.html` — dither kit lab: the timeline fill (before/after, stacked),
  leaderboard bars, the 13 avatars, buttons and gradient washes, all on real `data.json`,
  with live knobs (variant / colour / bloom / cell / sparkles). Use it to tune before
  touching a section.
- `site/mocks.html` — reference mock page: the shipped genre nebulae +
  the PARKED time machine, real data; `dev/verify_mocks.py` checks +
  screenshots. (The nebulae itself is live in `#constellation`.)
- `dashboard/genres.py` — the genre-family derivation (`derive_genres`,
  `FAMILY_COLORS` source is `site/js/visuals/family-colors.js`); imported
  by `generate.py` (emits `data.json["genres"]`) and by the dev script
- `dev/derive_genre_mock.py` — thin wrapper over `dashboard/genres.py`
  that writes `site/genre-mock.json` for the mock page (offline, no auth);
  `dev/genre_freq.py` dumps share-weighted genre frequencies (used to
  design the family mapping)

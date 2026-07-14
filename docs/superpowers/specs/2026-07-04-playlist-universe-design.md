# Playlist Universe — Design Spec (2026-07-04)

**Paste a public Spotify playlist URL → get a cinematic universe of it** (the
galaxy + genre nebulae + a stats hero), shareable by URL. A generalization of
the Mandatory Vibe Compliance site's visuals to any playlist, for anyone.

## Product

- Landing page with a paste box. User pastes `open.spotify.com/playlist/<id>`
  (or a raw ID / `spotify:playlist:` URI).
- Renders: hero stats (track count, date span, top artists), the **galaxy**
  (album covers in `added_at` chronological order), the **genre nebulae**
  (artists as stars in genre-family clouds).
- **Share = URL.** `?p=<playlist-id>` — a friend opening the link re-fetches
  and re-renders client-side. Nothing stored anywhere; the playlist is the
  database. Links always show the playlist's *current* state (live-updating
  is a feature, not a bug).
- The ID in the URL exposes nothing Spotify's own share link doesn't.

### v1 scope

Paste box → hero stats → galaxy → nebulae. Nothing else.

### Explicit non-goals for v1 (data already in hand when wanted)

- Collaborative-playlist people mode (`added_by` → crossovers, per-person
  constellations — the full "wrapped with the bois" for any group playlist).
- Eras / deep-cuts stat cards (release decades, popularity-score obscurity).
- Time machine viz (added-date × release-date scatter — parked module exists).
- PKCE login (see Phase 2).
- Frozen/snapshot share links, image export.

## Architecture

Two pieces, one origin, one deploy:

```
GitHub repo (source of truth)
   └─ push → deploy → ONE Cloudflare Worker (free tier, workers.dev domain)
        ├─ serves the static app (HTML/JS — no build step, ES modules)
        └─ /api/* : locked Spotify proxy (the only non-static code, ~30 lines)
```

- **Worker proxy:** holds the Spotify client secret (Worker env var, never in
  repo), mints/caches an app token (client-credentials flow — no user login),
  and relays exactly two things: playlist items (100/page) and artist batches
  (50/batch, for genres). Responses cached **24h per playlist ID** — repeat
  views and shared-link opens cost ~0 Spotify calls.
- **Client app:** reads `?p=` or shows the paste box, fetches via `/api/*`,
  transforms the response into **the same `data.json` shape the existing site
  eats** — so `galaxy.js`, `nebulae.js`, and section modules are reused with
  near-zero changes. Genre families: port `dashboard/genres.py`'s ordered
  keyword rules (+ collab inference where co-credit data exists) to JS.
- **Shared modules:** the app lives in a new `universe/` dir and reuses
  `site/js/visuals/*` in place (served via assetsignore-allowlisting, or the
  modules move to a shared dir — settled in implementation; no copies, no
  drift).
- **This repo's existing GitHub Pages / CI pipeline: untouched.**

## Limits & ceilings (known, accepted)

| Ceiling | Reality | Upgrade path |
|---|---|---|
| Cloudflare free tier | 100k req/day ≈ ~5k full renders/day | not our problem |
| Spotify rate limit | rolling ~30s window, shared app-wide, lower in dev mode; 24h cache means it only gates *new distinct* playlists | extended quota mode when justified |
| Dev-mode user cap (25) | irrelevant to v1 — client-credentials has no users; only gates Phase 2 login | extended quota review |
| Spotify-owned playlists | blocked for new apps (Nov 2024) — Discover Weekly etc. will fail | none; friendly error |
| Huge playlists | cap galaxy ~3k covers with a note | lazy-load by camera distance |

## Errors (all friendly, all client-rendered)

- Spotify-owned playlist → "Spotify blocks apps from their own playlists —
  try one you (or a friend) made."
- Private/unfetchable → "This playlist looks private — flip it to public in
  Spotify (2 taps) and paste again." (Whether the API serves 'private'
  unlisted playlists is verified empirically during build; assume not.)
- Bad URL/ID → inline validation on the paste box.
- Partial artist-genre failures → tracks land in the "uncharted" nebula
  (existing behavior), never a hard failure.

## Security

- Proxy is **locked**: two hardcoded endpoint shapes only, playlist/artist
  IDs regex-validated, no general forwarding.
- Client secret in Worker env only. `.env`/secrets never in served assets.
- CORS pinned to our origin (mostly moot — same origin serves both).
- Per-IP rate limiting: not in v1; the named knob if abuse shows up.
- Phase 2 login tokens live in the browser only, never sent to the Worker.

## Phase 2 — PKCE login (small, additive)

"Connect Spotify" button → browser talks to Spotify directly with the user's
token (no Worker involvement, no secret) → user can render their **own
private** playlists and pick from a playlist list instead of pasting.
Constraints: 25-account allowlist until extended quota; private-playlist
share links can't work for viewers by nature (owner-only visibility).

## Monetization stance (recorded honestly)

Reach/portfolio/viral play, tip-jar at most. Spotify's developer terms
restrict charging for their data; category precedent (Receiptify, stats.fm)
is free + one-time unlock. No monetization built in v1.

## Dev & deploy flow

- Branch `playlist-universe` in this repo; Uday pushes, Claude never pushes.
- Local dev: `wrangler dev` (serves assets + proxy together, replaces
  `http.server` for this app). Spotify dev app credentials in `.env`-style
  Worker dev vars (gitignored).
- Deploy: push → GitHub Actions step (or CF git integration) → Worker.
  Cloudflare API token in repo secrets. One-time setup: free CF account,
  free `workers.dev` subdomain, Spotify dev app creation.

## Verification

- Worker: curl the two `/api` routes against a real playlist (happy path,
  bad ID, Spotify-owned ID, oversized page params).
- App: Playwright script in the `dev/verify_*.py` mold — paste flow, `?p=`
  deep link, console errors, failed requests, screenshots.
- Transform: one small self-check asserting a fetched playlist produces a
  `data.json`-shaped object the existing sections accept (keys + types).

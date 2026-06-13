// 3 · galaxy — every cover ever shared, person filter chips
import { $, el, chip, colorOf } from "../data.js";

export function initGalaxy(ctx) {
  const sec = $("#galaxy");
  const stage = $("#galaxy-stage");
  const { tracks, people } = ctx.data;

  const items = Object.entries(tracks).map(([uri, t]) => ({
    uri, // "spotify:track:<id>" — the visual builds the open.spotify.com link from it
    art: t.art,
    artSm: t.art_sm || "",
    cell: t.cell, // [sheet, cellInSheet] into the pre-baked atlas, if present
    name: t.name,
    artists: (t.artists || []).join(", "),
    by: t.first?.by || "",
    ts: t.first?.ts || "",
    color: colorOf(t.first?.by),
  }));

  let handle = null;
  let fallbackBuilt = false;

  // CSS fallback: plain grid of cover art
  function buildFallback() {
    if (fallbackBuilt) return;
    fallbackBuilt = true;
    const grid = $("#galaxy-fallback");
    const count = ctx.mobile ? 48 : 96;
    for (const it of items.slice(-count)) { // most recent covers
      const img = el("img");
      img.src = (ctx.mobile && it.artSm) || it.art;
      img.alt = `${it.name} — ${it.artists}`;
      img.loading = "lazy"; img.dataset.by = it.by;
      grid.append(img);
    }
  }

  // chips: All + each person (sorted by shares)
  const wrap = $("#galaxy-chips");
  const names = Object.keys(people).sort((a, b) => people[b].totals.shares - people[a].totals.shares);
  const select = (name, btn) => {
    wrap.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    if (handle) {
      try { handle.focusPerson(name); } catch (e) { console.warn(e); }
    } else if (fallbackBuilt) {
      $("#galaxy-fallback").querySelectorAll("img").forEach((img) =>
        img.classList.toggle("dim", !!name && img.dataset.by !== name));
    }
  };
  const all = chip("All", null, () => select(null, all));
  all.classList.add("active");
  wrap.append(all);
  for (const n of names) {
    const c = chip(n, n, () => select(n, c));
    wrap.append(c);
  }

  ctx.lazyVisual(sec, async () => {
    const mod = await import("../visuals/galaxy.js");
    return mod.initGalaxy(stage, items, ctx.visualOpts({ atlas: ctx.data.atlas }));
  }, buildFallback, (h) => { handle = h; });

  // pin the stage on desktop for a beat; mobile keeps natural flow
  if (ctx.gsap && ctx.ScrollTrigger && !ctx.reduced) {
    ctx.gsap.matchMedia().add("(min-width: 821px)", () => {
      const st = ctx.ScrollTrigger.create({
        trigger: sec, start: "top top", end: "+=55%", pin: true, pinSpacing: true,
      });
      return () => st.kill();
    });
  }
}

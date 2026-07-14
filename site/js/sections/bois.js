// 5 · the bois — one card per person, scroll-snap carousel
import { $, el, colorOf, argmax, fmtDate, esc, trackUrl } from "../data.js";
import { ditherAvatar } from "../visuals/dither.js";

const HOUR_LABELS = ["night gremlin", "morning curator", "afternoon shift", "evening DJ"];
const hourVibe = (h) => HOUR_LABELS[Math.floor(h / 6)];
const tasteLabel = (pop) =>
  pop < 40 ? "underground sommelier" : pop <= 60 ? "tastefully off-mainstream" : "chart enjoyer";

const shorten = (s, n = 26) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function initBois(ctx) {
  const { people, tracks } = ctx.data;
  const wrap = $("#cards");
  const names = Object.keys(people).sort((a, b) => people[b].totals.shares - people[a].totals.shares);

  /* a track row value: linked name when we know the track, plain date otherwise */
  function trackLink(uri, fallbackText) {
    const t = uri ? tracks[uri] : null;
    if (!t) return fallbackText ? esc(fallbackText) : null;
    const title = `${t.name} — ${(t.artists || []).join(", ")}`;
    return `<a class="ext" href="${trackUrl(uri)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(shorten(t.name))}<span class="out">↗</span></a>`;
  }

  for (const name of names) {
    const p = people[name];
    const card = el("article", "card");
    card.dataset.reveal = "";
    card.style.setProperty("--pc", colorOf(name));

    const rows = [];
    const row = (k, v) => rows.push(`<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`);

    const topArtist = p.top_artists?.[0]?.[0];
    if (topArtist) row("top artist", esc(topArtist));
    const topGenre = p.top_genres?.[0]?.[0];
    if (topGenre) row("top genre", esc(topGenre));
    if (p.avg_popularity != null)
      row("taste check", `${tasteLabel(p.avg_popularity)} <small>(${Math.round(p.avg_popularity)})</small>`);
    if (p.hours?.length === 24) {
      const peak = argmax(p.hours);
      row("peak hour", `${hourVibe(peak)} <small>(${String(peak).padStart(2, "0")}:00)</small>`);
    }
    const decades = Object.entries(p.decades || {}).filter(([d]) => d !== "0000s");
    if (decades.length) row("home decade", decades.sort((a, b) => b[1] - a[1])[0][0]);
    if (p.totals.bangers) row("said “banger”", `${p.totals.bangers}×`);
    if (p.first_share?.ts) {
      const link = trackLink(p.first_share.uri);
      row("first share", link
        ? `${link} <small>${fmtDate(p.first_share.ts)}</small>`
        : fmtDate(p.first_share.ts));
    }
    const oldest = trackLink(p.extremes?.oldest);
    if (oldest) row("deepest cut", oldest);

    card.innerHTML = `
      <h3>${esc(p.display || name)}</h3>
      <div class="big">${p.totals.shares}<small>shares · ${p.totals.unique} unique</small></div>
      ${rows.join("")}
    `;

    // generative glyph in the card's top-right dead space — seeded from the display name,
    // so a boi's avatar never changes, painted in his own colour
    const glyph = el("div", "card-av");
    card.prepend(glyph);
    try {
      ditherAvatar(glyph, {
        name: p.display || name,
        color: colorOf(name),
        sparkles: !ctx.reduced,
        animate: !ctx.reduced,
      });
    } catch (err) {
      console.warn("[viz fallback] boi avatar:", err);
      glyph.remove();
    }

    // 24-bar hour sparkline in the person's colour, instant value on hover/tap
    if (p.hours?.length === 24) {
      const spark = el("div", "spark");
      spark.setAttribute("aria-label", "shares by hour of day");
      const max = Math.max(...p.hours, 1);
      const bars = p.hours.map((v) => {
        const bar = el("i");
        bar.style.height = `${Math.max(6, (v / max) * 100)}%`;
        spark.append(bar);
        return bar;
      });
      const cap = el("span", "spark-cap", "00h → 23h");
      const resetCap = () => {
        bars.forEach((b) => b.classList.remove("lit"));
        cap.textContent = "00h → 23h";
      };
      const reveal = (clientX) => {
        const r = spark.getBoundingClientRect();
        const i = Math.min(23, Math.max(0, Math.floor(((clientX - r.left) / r.width) * 24)));
        bars.forEach((b, j) => b.classList.toggle("lit", j === i));
        const v = p.hours[i];
        cap.innerHTML = `${String(i).padStart(2, "0")}:00 — <b>${v}</b> share${v === 1 ? "" : "s"}`;
      };
      spark.addEventListener("pointermove", (e) => reveal(e.clientX), { passive: true });
      spark.addEventListener("pointerdown", (e) => reveal(e.clientX), { passive: true });
      spark.addEventListener("pointerleave", resetCap);
      card.append(spark, cap);
    }
    wrap.append(card);
  }
}

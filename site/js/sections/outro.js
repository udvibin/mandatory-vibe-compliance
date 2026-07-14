// 10 · outro — authored facts + last sync
import { $, el, esc, trackUrl } from "../data.js";
import { ditherButton } from "../visuals/dither.js";

export function initOutro(ctx) {
  const wrap = $("#facts");

  /* facts are plain text (no URIs), but two of them describe tracks we can
     re-derive exactly from `tracks`: the first song ever and the most
     re-shared. If a fact's text contains that track's name, link it. */
  const entries = Object.entries(ctx.data.tracks || {});
  const candidates = [];
  if (entries.length) {
    const firstEver = entries.reduce((a, b) =>
      (b[1].first?.ts || "9999") < (a[1].first?.ts || "9999") ? b : a);
    const mostReshared = entries.reduce((a, b) => {
      const n = (t) => Object.values(t.shared_by || {}).reduce((s, v) => s + v, 0);
      return n(b[1]) > n(a[1]) ? b : a;
    });
    for (const [uri, t] of [firstEver, mostReshared])
      if (t.name) candidates.push({ uri, name: t.name });
  }

  function factHtml(text) {
    for (const { uri, name } of candidates) {
      const i = text.indexOf(name);
      if (i === -1) continue;
      return esc(text.slice(0, i)) +
        `<a class="ext tlink" href="${trackUrl(uri)}" target="_blank" rel="noopener">${esc(name)}<span class="out">↗</span></a>` +
        esc(text.slice(i + name.length));
    }
    return esc(text);
  }

  for (const f of ctx.data.facts || []) {
    const card = el("article", "fact");
    card.dataset.reveal = "";
    card.append(el("h3", null, esc(f.title)), el("p", null, factHtml(f.text)));
    wrap.append(card);
  }

  // the nerd-view CTA gets the dither fill: it thickens on hover, denser still on press.
  // It stays a real <a> — the canvas mounts behind the existing text.
  const cta = $(".nerd-cta");
  if (cta) {
    try {
      // the site's cyan (what the heartbeat used before it went purple). `gradient` gives
      // a real density ramp — dense at the floor, dissolving upward — where `dotted` was
      // a flat, even field. Pulled back so the label keeps its contrast.
      ditherButton(cta, {
        color: "#7cc4dc", variant: "gradient", opacity: 0.55, sparkles: !ctx.reduced,
      });
      cta.classList.add("dith"); // only now: drops the CSS background fallback
    } catch (err) {
      console.warn("[viz fallback] nerd cta:", err);
    }
  }

  const gen = ctx.data.meta?.generated;
  if (gen) {
    const d = new Date(gen);
    $("#sync-date").textContent = isNaN(d) ? gen
      : d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
}

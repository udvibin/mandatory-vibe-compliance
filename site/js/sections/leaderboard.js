// 4 · leaderboard — chunky DOM bars, year filter, instant per-row tooltip.
// Each bar's fill is a dithered wash in the boi's own colour (visuals/dither.js); if that
// import fails the CSS gradient underneath still shows, so the section never goes blank.
import { $, el, chip, colorOf, esc, instantTip } from "../data.js";
import { ditherGradient } from "../visuals/dither.js";

export function initLeaderboard(ctx) {
  const { people, years } = ctx.data;
  const barsEl = $("#bars");
  const pillsEl = $("#year-pills");
  const tip = instantTip();
  let current = "All";
  let barWashes = []; // cleanups — re-rendered on every year filter change
  addEventListener("scroll", tip.hide, { passive: true });

  /* instant tooltip: exact count + year-by-year breakdown */
  function tipHtml(name, count, year) {
    const py = people[name].per_year || {};
    const yrs = Object.keys(py).sort()
      .map((y) => `${y === year ? `<i>${y}</i>` : y} · ${py[y]}`)
      .join("&ensp;");
    const what = year === "All" ? "shares all-time" : `share${count === 1 ? "" : "s"} in ${year}`;
    return `<b>${esc(name)}</b> — ${count} ${what}<span class="yrs">${yrs}</span>`;
  }

  function wireTip(row, name, count) {
    const move = (e) => tip.show(e.clientX, e.clientY, tipHtml(name, count, current));
    row.addEventListener("pointerenter", move);
    row.addEventListener("pointermove", move, { passive: true });
    row.addEventListener("pointerdown", move);
    row.addEventListener("pointerleave", tip.hide);
  }

  function counts(year) {
    return Object.keys(people)
      .map((n) => [n, year === "All" ? people[n].totals.shares : (people[n].per_year?.[year] || 0)])
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1]);
  }

  function render(year) {
    current = year;
    barWashes.forEach((off) => off());
    barWashes = [];
    barsEl.innerHTML = "";
    const rows = counts(year);
    const max = rows[0]?.[1] || 1;
    const built = rows.map(([name, count]) => {
      const row = el("div", "bar-row");
      row.style.setProperty("--pc", colorOf(name));
      const bar = el("div", "bar");
      row.append(bar, el("div", "bar-label", `<b>${esc(name)}</b><span>${count}</span>`));
      wireTip(row, name, count);
      barsEl.append(row);
      try {
        // hoverTarget is the row, so the bar lifts wherever the pointer enters it —
        // not only over the (possibly short) bar itself
        barWashes.push(ditherGradient(bar, {
          from: colorOf(name), direction: "right", cell: 2,
          hover: true, hoverTarget: row, sparkles: !ctx.reduced,
        }));
        bar.classList.add("dith"); // only now: drops the CSS gradient fallback
      } catch (err) {
        console.warn("[viz fallback] leaderboard bar:", err);
      }
      return { bar, w: Math.max(8, (count / max) * 100) };
    });
    // animate widths — gsap when available, CSS transition otherwise
    if (ctx.gsap && !ctx.reduced) {
      ctx.gsap.to(built.map((b) => b.bar), {
        width: (i) => built[i].w + "%", duration: 0.9, stagger: 0.06, ease: "power3.out",
      });
    } else {
      built.forEach(({ bar, w }, i) => {
        bar.style.transition = ctx.reduced ? "none" : `width .8s ${i * 0.05}s cubic-bezier(.2,.7,.2,1)`;
        requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = w + "%"; }));
      });
    }
  }

  // pills: All + each year present in data
  const mk = (label) => {
    const p = chip(label, null, () => {
      pillsEl.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      p.classList.add("active");
      render(label);
    });
    p.querySelector(".dot").remove(); // plain pills, no dots
    pillsEl.append(p);
    return p;
  };
  mk("All").classList.add("active");
  Object.keys(years).sort().forEach((y) => mk(y));

  ctx.onEnter($("#leaderboard"), () => { if (!barsEl.children.length) render(current); }, "-40px");
}

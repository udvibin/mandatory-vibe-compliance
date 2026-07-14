// 8 · the heartbeat — monthly shares, Chart.js with a div-bar fallback.
// The area fill is the dither texture (see visuals/dither.js); Chart.js still owns the
// axes, tooltip, line and animation.
import { $, el, fmtMonth, argmax } from "../data.js";
import { ditherFillPlugin } from "../visuals/dither-chartjs.js";

// the violet already in the person palette (Shaury) — in-family with the cream/coral
// tokens, and it reads against the orange the background shader blooms through here
const TL_PURPLE = "#a98ad6";

export function initTimeline(ctx) {
  const sec = $("#timeline");
  const months = Object.keys(ctx.data.timeline).sort();
  const vals = months.map((m) => ctx.data.timeline[m].total);
  const peak = argmax(vals);

  function buildFallback() {
    const wrap = $("#timeline-fallback");
    const max = Math.max(...vals, 1);
    for (let i = 0; i < vals.length; i++) {
      const bar = el("i");
      bar.style.height = `${(vals[i] / max) * 92}%`;
      bar.title = `${fmtMonth(months[i])}: ${vals[i]}`;
      wrap.append(bar);
    }
    wrap.append(el("span", "axis",
      `<span>${months[0].slice(0, 4)}</span><span>peak ${fmtMonth(months[peak])} · ${vals[peak]}</span><span>${months.at(-1).slice(0, 4)}</span>`));
  }

  ctx.onEnter(sec, async () => {
    try {
      const { default: Chart } = await import("chart.js/auto");
      const canvas = $("#timeline-chart");
      sec.classList.add("viz-on");

      // ordered-dither area fill: dense at the floor, dissolving up into the line, with
      // winking sparkles and a hover lift. `fill: false` so Chart.js paints no gradient
      // underneath it.
      const dither = ditherFillPlugin({
        color: TL_PURPLE,
        variant: "gradient",
        bloom: "off",               // ponytail: needs a 3rd canvas; add if it wants a glow
        starCanvas: $("#timeline-stars"),
        sparkles: !ctx.reduced,
        hoverLift: !ctx.reduced,
        animate: !ctx.reduced,
      });

      new Chart(canvas, {
        type: "line",
        data: {
          labels: months,
          datasets: [{
            data: vals,
            borderColor: TL_PURPLE,
            borderWidth: 2,
            tension: 0.35,
            fill: false,
            pointRadius: (c) => (c.dataIndex === peak ? 4 : 0),
            pointBackgroundColor: "#e4593b",
            pointHoverRadius: 5,
          }],
        },
        options: {
          maintainAspectRatio: false,
          animation: ctx.reduced ? false : { duration: 1100 },
          // tooltip anywhere along the x position, instantly — no need to hit a point
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              displayColors: false,
              animation: { duration: 60 },
              callbacks: { title: (it) => fmtMonth(months[it[0].dataIndex]), label: (it) => `${it.parsed.y} songs` },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                color: "#9db4bd", autoSkip: false, maxRotation: 0,
                callback: (_, i) => (months[i].endsWith("-01") ? months[i].slice(0, 4) : ""),
              },
            },
            y: {
              beginAtZero: true,
              grid: { color: "rgba(157,180,189,.08)" },
              ticks: { color: "#9db4bd", maxTicksLimit: 5 },
            },
          },
        },
        // one plugins array only — a second key here would silently shadow the first
        plugins: [dither, {
          id: "peakLabel", // annotate the biggest month
          afterDatasetsDraw(chart) {
            const pt = chart.getDatasetMeta(0).data[peak];
            if (!pt) return;
            const g = chart.ctx;
            g.save();
            g.font = "700 12px 'Space Grotesk', sans-serif";
            g.fillStyle = "#e4593b";
            g.textAlign = pt.x > chart.chartArea.right - 90 ? "right" : "center";
            g.fillText(`${fmtMonth(months[peak])} · ${vals[peak]} songs`, pt.x, Math.max(chart.chartArea.top + 14, pt.y - 12));
            g.restore();
          },
        }],
      });
    } catch (err) {
      console.warn("[viz fallback] timeline chart:", err);
      sec.classList.add("viz-fail");
      buildFallback();
    }
  });
}

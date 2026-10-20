import DeadlockTierStats from "./tier-stats.js";
import { request, errorMessage, dateTime, cell, portrait, assetCatalog } from "./common.js";

// Aggregate hero chart: API loading here, count validation in tier-stats.js.
const tierForm = document.querySelector("#tier-filters");
const tierStatus = document.querySelector("#tier-status");
const tierChart = document.querySelector("#tier-chart");
const tierTooltip = document.querySelector("#tier-chart-tooltip");
const tierRetry = document.querySelector("#tier-retry");
const rankField = document.querySelector("#tier-rank-field");
const svgNS = "http://www.w3.org/2000/svg";
let tierController;

function svgNode(tag, attributes = {}, text) {
  const element = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function hideTooltip() {
  tierTooltip.hidden = true;
}

function showTooltip(hero, name, icon, event) {
  const heading = document.createElement("div");
  heading.className = "hero-chart-tooltip-heading";
  const details = document.createElement("span");
  details.className = "hero-chart-tooltip-details";
  details.append(
    cell("strong", name),
    cell("span", `Pick rate ${(hero.pickRate * 100).toFixed(2)}%`),
    cell("span", `Win rate ${(hero.rate * 100).toFixed(2)}%`),
  );
  heading.append(
    portrait(icon, name, "hero-portrait hero-chart-tooltip-portrait"),
    details,
  );
  tierTooltip.replaceChildren(
    heading,
    cell("small", `${hero.matches.toLocaleString()} picks · ${hero.scored.toLocaleString()} scored matches`),
  );
  tierTooltip.hidden = false;
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = Number.isFinite(event.clientX) && event.clientX
    ? event.clientX
    : bounds.left + bounds.width / 2;
  const y = Number.isFinite(event.clientY) && event.clientY
    ? event.clientY
    : bounds.top;
  tierTooltip.style.left = `${Math.max(8, Math.min(x + 14, window.innerWidth - tierTooltip.offsetWidth - 8))}px`;
  tierTooltip.style.top = `${Math.max(8, Math.min(y + 14, window.innerHeight - tierTooltip.offsetHeight - 8))}px`;
}

function chartTick(value) {
  return `${Math.round(value * 100)}%`;
}

function drawChart(heroes, heroAssets) {
  const title = tierChart.querySelector("#tier-chart-title");
  const description = tierChart.querySelector("#tier-chart-description");
  tierChart.replaceChildren(title, description);
  if (!heroes.length) return;

  const plot = { left: 92, right: 968, top: 34, bottom: 526 };
  const width = plot.right - plot.left;
  const height = plot.bottom - plot.top;
  const maxPick = Math.max(...heroes.map((hero) => hero.pickRate));
  const xMax = Math.max(0.05, Math.ceil(maxPick * 1.2 * 20) / 20);
  const minRate = Math.min(0.5, ...heroes.map((hero) => hero.rate));
  const maxRate = Math.max(0.5, ...heroes.map((hero) => hero.rate));
  const yMin = Math.max(0, Math.floor((minRate - 0.035) * 20) / 20);
  const yMax = Math.min(1, Math.ceil((maxRate + 0.035) * 20) / 20);
  const yStep = yMax - yMin > 0.3 ? 0.1 : 0.05;
  const x = (value) => plot.left + (value / xMax) * width;
  const y = (value) => plot.bottom - ((value - yMin) / (yMax - yMin)) * height;
  const medianPick = [...heroes].sort((a, b) => a.pickRate - b.pickRate)[
    Math.floor(heroes.length / 2)
  ].pickRate;
  const middleX = x(medianPick);
  const middleY = y(0.5);

  tierChart.append(
    svgNode("rect", {
      x: plot.left,
      y: plot.top,
      width: Math.max(0, middleX - plot.left),
      height: Math.max(0, middleY - plot.top),
      class: "chart-zone chart-zone-strong",
    }),
    svgNode("rect", {
      x: middleX,
      y: plot.top,
      width: Math.max(0, plot.right - middleX),
      height: Math.max(0, middleY - plot.top),
      class: "chart-zone chart-zone-strong",
    }),
    svgNode("rect", {
      x: plot.left,
      y: middleY,
      width: Math.max(0, middleX - plot.left),
      height: Math.max(0, plot.bottom - middleY),
      class: "chart-zone chart-zone-weak",
    }),
    svgNode("rect", {
      x: middleX,
      y: middleY,
      width: Math.max(0, plot.right - middleX),
      height: Math.max(0, plot.bottom - middleY),
      class: "chart-zone chart-zone-weak",
    }),
  );

  for (let index = 0; index <= 5; index++) {
    const value = (xMax * index) / 5;
    const tickX = x(value);
    tierChart.append(
      svgNode("line", {
        x1: tickX,
        y1: plot.top,
        x2: tickX,
        y2: plot.bottom,
        class: "chart-grid",
      }),
      svgNode("text", {
        x: tickX,
        y: plot.bottom + 25,
        "text-anchor": "middle",
        class: "chart-tick",
      }, chartTick(value)),
    );
  }
  const firstTick = Math.ceil(yMin / yStep) * yStep;
  for (let value = firstTick; value <= yMax + 0.001; value += yStep) {
    const tickY = y(value);
    tierChart.append(
      svgNode("line", {
        x1: plot.left,
        y1: tickY,
        x2: plot.right,
        y2: tickY,
        class: "chart-grid",
      }),
      svgNode("text", {
        x: plot.left - 14,
        y: tickY + 4,
        "text-anchor": "end",
        class: "chart-tick",
      }, chartTick(value)),
    );
  }

  tierChart.append(
    svgNode("line", {
      x1: middleX,
      y1: plot.top,
      x2: middleX,
      y2: plot.bottom,
      class: "chart-threshold",
    }),
    svgNode("line", {
      x1: plot.left,
      y1: middleY,
      x2: plot.right,
      y2: middleY,
      class: "chart-threshold",
    }),
    svgNode("line", {
      x1: plot.left,
      y1: plot.top,
      x2: plot.left,
      y2: plot.bottom,
      class: "chart-axis",
    }),
    svgNode("line", {
      x1: plot.left,
      y1: plot.bottom,
      x2: plot.right,
      y2: plot.bottom,
      class: "chart-axis",
    }),
    svgNode("text", {
      x: (plot.left + plot.right) / 2,
      y: 584,
      "text-anchor": "middle",
      class: "chart-axis-label",
    }, "PICK RATE · SHARE OF HERO PICKS"),
    svgNode("text", {
      x: 25,
      y: (plot.top + plot.bottom) / 2,
      transform: `rotate(-90 25 ${(plot.top + plot.bottom) / 2})`,
      "text-anchor": "middle",
      class: "chart-axis-label",
    }, "WIN RATE"),
    svgNode("text", {
      x: plot.left + 16,
      y: plot.top + 24,
      class: "chart-zone-label",
    }, "UNDERPICKED · ABOVE 50%"),
    svgNode("text", {
      x: middleX + 16,
      y: plot.top + 24,
      class: "chart-zone-label",
    }, "HIGH PICK RATE · ABOVE 50%"),
    svgNode("text", {
      x: plot.left + 16,
      y: plot.bottom - 16,
      class: "chart-zone-label",
    }, "UNDERPICKED · BELOW 50%"),
    svgNode("text", {
      x: middleX + 16,
      y: plot.bottom - 16,
      class: "chart-zone-label",
    }, "HIGH PICK RATE · BELOW 50%"),
  );

  for (const hero of heroes) {
    const metadata = heroAssets.get(hero.id);
    const name = metadata?.name || `Hero ${hero.id}`;
    const centerX = x(hero.pickRate);
    const centerY = y(hero.rate);
    const group = svgNode("g", {
      class: "hero-point",
      tabindex: "0",
      role: "img",
      "aria-label": `${name}: ${(hero.pickRate * 100).toFixed(2)}% pick rate, ${(hero.rate * 100).toFixed(2)}% win rate, ${hero.matches.toLocaleString()} picks`,
      "aria-describedby": "tier-chart-tooltip",
    });
    group.append(
      svgNode("circle", {
        cx: centerX,
        cy: centerY,
        r: 13,
        class: "hero-point-backdrop",
      }),
    );
    const icon =
      metadata?.images?.icon_image_small_webp ||
      metadata?.images?.icon_image_small;
    if (typeof icon === "string" && /^https:\/\//i.test(icon)) {
      group.append(
        svgNode("image", {
          x: centerX - 11,
          y: centerY - 11,
          width: 22,
          height: 22,
          href: icon,
          preserveAspectRatio: "xMidYMid slice",
          class: "hero-point-image",
        }),
      );
    } else {
      group.append(
        svgNode("text", {
          x: centerX,
          y: centerY + 4,
          "text-anchor": "middle",
          class: "hero-point-initial",
        }, name.slice(0, 1).toUpperCase()),
      );
    }
    group.addEventListener("pointermove", (event) =>
      showTooltip(hero, name, icon, event),
    );
    group.addEventListener("pointerleave", hideTooltip);
    group.addEventListener("focus", (event) =>
      showTooltip(hero, name, icon, event),
    );
    group.addEventListener("blur", hideTooltip);
    tierChart.append(group);
  }
}

async function loadTiers() {
  tierController?.abort();
  const controller = new AbortController();
  tierController = controller;
  const days = Number(document.querySelector("#tier-days").value);
  const mode = document.querySelector("#tier-mode").value;
  const minimum = Number(document.querySelector("#tier-minimum").value);
  const end = Math.floor(Date.now() / 3600000) * 3600;
  const start = end - days * 86400;
  const params = new URLSearchParams({
    bucket: "no_bucket",
    game_mode: "normal",
    match_mode: mode,
    min_unix_timestamp: String(start),
    max_unix_timestamp: String(end),
  });
  if (mode === "ranked")
    params.set("min_average_badge", document.querySelector("#tier-rank").value);

  tierChart.replaceChildren(
    tierChart.querySelector("#tier-chart-title"),
    tierChart.querySelector("#tier-chart-description"),
  );
  hideTooltip();
  tierRetry.hidden = true;
  tierForm.setAttribute("aria-busy", "true");
  document.querySelector("#tier-count").textContent = "";
  document.querySelector("#tier-caption").textContent = "";
  tierStatus.textContent = "Loading aggregate hero statistics…";
  try {
    const [stats, assets] = await Promise.allSettled([
      request(`/v1/analytics/hero-stats?${params}`, controller.signal, 300000),
      assetCatalog("heroes", controller.signal),
    ]);
    if (controller.signal.aborted) return;
    if (stats.status === "rejected") throw stats.reason;
    const heroes = new Map(
      assets.status === "fulfilled"
        ? assets.value.data.map((hero) => [hero.id, hero])
        : [],
    );
    const chartHeroes = DeadlockTierStats.chartHeroes(
      stats.value.data,
      minimum,
    );
    drawChart(chartHeroes, heroes);
    const modeLabel = mode === "ranked" ? "Ranked" : "Unranked";
    const rankLabel =
      mode === "ranked"
        ? ` · ${document.querySelector("#tier-rank option:checked").textContent}`
        : "";
    const filters = `${modeLabel}${rankLabel} · ${dateTime(start)} – ${dateTime(end)} · Minimum ${minimum.toLocaleString()} scored matches`;
    document.querySelector("#tier-chart-description").textContent =
      `${chartHeroes.length} heroes plotted by pick rate and win rate. ${filters}. Focus or hover over a marker for details.`;
    document.querySelector("#tier-caption").textContent =
      `${filters}. Pick rate is share of all recorded hero picks; heroes below the sample filter remain in its denominator.`;
    document.querySelector("#tier-count").textContent =
      `${chartHeroes.length} heroes`;
    tierStatus.textContent = `${chartHeroes.length ? filters : `No heroes meet these filters. ${filters}`}. Retrieved ${stats.value.fetchedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.${assets.status === "rejected" ? " Hero names unavailable; markers use initials." : ""}`;
  } catch (error) {
    if (controller.signal.aborted) return;
    tierChart.replaceChildren(
      tierChart.querySelector("#tier-chart-title"),
      tierChart.querySelector("#tier-chart-description"),
    );
    tierStatus.textContent =
      error.status === 404
        ? "No aggregate data is available for these filters. Try another time window or queue."
        : errorMessage(error);
    tierRetry.hidden = false;
  } finally {
    if (!controller.signal.aborted) tierForm.setAttribute("aria-busy", "false");
  }
}

function updateRankVisibility() {
  rankField.hidden = document.querySelector("#tier-mode").value !== "ranked";
}

document.querySelector("#tier-mode").addEventListener("change", updateRankVisibility);
tierForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadTiers();
});
tierRetry.addEventListener("click", loadTiers);
window.addEventListener("pagehide", () => tierController?.abort());
window.addEventListener("scroll", hideTooltip, true);
window.addEventListener("resize", hideTooltip);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideTooltip();
});
updateRankVisibility();
loadTiers();

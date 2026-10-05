"use strict";

const tierForm = document.querySelector("#tier-filters");
const tierStatus = document.querySelector("#tier-status");
const tierBody = document.querySelector("#tier-results");
const tierRetry = document.querySelector("#tier-retry");
let tierController;

async function loadTiers() {
  tierController?.abort();
  const controller = new AbortController();
  tierController = controller;
  const days = Number(document.querySelector("#tier-days").value);
  const mode = document.querySelector("#tier-mode").value;
  const minimum = Number(document.querySelector("#tier-minimum").value);
  // Round to the hour so identical filters reuse cached aggregate queries.
  const end = Math.floor(Date.now() / 3600000) * 3600;
  const start = end - days * 86400;
  const params = new URLSearchParams({
    bucket: "no_bucket",
    game_mode: "normal",
    match_mode: mode,
    min_unix_timestamp: String(start),
    max_unix_timestamp: String(end),
  });
  tierBody.replaceChildren();
  tierRetry.hidden = true;
  tierForm.setAttribute("aria-busy", "true");
  document.querySelector("#tier-count").textContent = "";
  tierStatus.textContent = "Loading aggregate hero statistics…";
  try {
    const [stats, assets] = await Promise.allSettled([
      request(`/v1/analytics/hero-stats?${params}`, controller.signal, 300000),
      request("/v1/assets/heroes", controller.signal, 3600000),
    ]);
    if (controller.signal.aborted) return;
    if (stats.status === "rejected") throw stats.reason;
    const heroes = new Map(
      assets.status === "fulfilled"
        ? assets.value.data.map((hero) => [hero.id, hero])
        : [],
    );
    const ranked = DeadlockTierStats.rankHeroes(stats.value.data, minimum);
    ranked.forEach((hero, index) => {
      const metadata = heroes.get(hero.id);
      const name = metadata?.name || `Hero ${hero.id}`;
      const row = document.createElement("tr");
      const heading = cell("th", "");
      const identity = document.createElement("span");
      identity.className = "hero-identity";
      identity.append(
        portrait(
          metadata?.images?.icon_image_small_webp ||
            metadata?.images?.icon_image_small,
          name,
          "hero-portrait",
        ),
        cell("span", name),
      );
      heading.append(identity);
      const winRate = cell("td", "");
      const rate = document.createElement("span");
      rate.className = "rate";
      const track = document.createElement("span");
      track.className = "rate-track";
      track.setAttribute("aria-hidden", "true");
      const fill = document.createElement("span");
      fill.className = "rate-fill";
      fill.style.width = `${hero.rate * 100}%`;
      track.append(fill);
      const number = cell("span", `${(hero.rate * 100).toFixed(2)}%`);
      number.className = "rate-number";
      rate.append(track, number);
      winRate.append(rate);
      row.append(
        cell("td", index + 1),
        heading,
        winRate,
        ...[hero.scored, hero.wins, hero.losses].map((value) =>
          cell("td", value.toLocaleString()),
        ),
      );
      tierBody.append(row);
    });
    const modeLabel =
      mode === "ranked,unranked"
        ? "Ranked + unranked"
        : mode === "ranked"
          ? "Ranked only"
          : "Unranked only";
    const filters = `${modeLabel} · ${dateTime(start)} – ${dateTime(end)} · Minimum ${minimum.toLocaleString()} scored matches`;
    document.querySelector("#tier-caption").textContent =
      `Hero win-rate rankings: ${filters}`;
    document.querySelector("#tier-count").textContent =
      `${ranked.length} heroes`;
    tierStatus.textContent = `${ranked.length ? filters : `No heroes meet these filters. ${filters}`}. Retrieved ${stats.value.fetchedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.${assets.status === "rejected" ? " Hero names unavailable; numeric hero IDs shown." : ""}`;
  } catch (error) {
    if (controller.signal.aborted) return;
    tierBody.replaceChildren();
    tierStatus.textContent =
      error.status === 404
        ? "No aggregate data is available for these filters. Try another time window or mode."
        : errorMessage(error);
    tierRetry.hidden = false;
  } finally {
    if (!controller.signal.aborted) tierForm.setAttribute("aria-busy", "false");
  }
}

tierForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadTiers();
});
tierRetry.addEventListener("click", loadTiers);
window.addEventListener("pagehide", () => tierController?.abort());
loadTiers();

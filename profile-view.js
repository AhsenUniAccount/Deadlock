import { cell, portrait } from "./common.js";

// Renders the player profile sections. Calculations live in player-percentiles.js
// and player-trends.js; this module only builds DOM from their results.
const ProfileView = (() => {
  const byId = (id) => document.querySelector(`#${id}`);

  function renderPercentiles(rows, scope) {
    const grid = byId("percentile-grid");
    grid.replaceChildren();
    byId("stats-scope").textContent = scope;
    if (!rows.length) {
      grid.append(cell("p", "Not enough recent standard matches to compare."));
      return;
    }
    for (const row of rows) {
      const card = document.createElement("article");
      card.className = "stat-card";
      card.dataset.tone = row.tone;
      const bar = document.createElement("span");
      bar.className = "stat-bar";
      bar.setAttribute("aria-hidden", "true");
      const fill = document.createElement("span");
      fill.style.width = `${Math.max(2, Math.min(100, row.percentile))}%`;
      bar.append(fill);
      const rank = cell("span", row.display);
      rank.className = "stat-rank";
      card.append(
        cell("h3", row.label),
        cell("strong", row.value),
        bar,
        rank,
        cell("small", `Typical game at this rank: ${row.typical}`),
      );
      card.setAttribute("aria-label", `${row.label}: ${row.value}, ${row.display} of games at this rank`);
      grid.append(card);
    }
  }

  function renderPatterns(result) {
    const list = byId("pattern-points");
    const form = byId("form-strip");
    list.replaceChildren();
    form.replaceChildren();
    for (const outcome of result.form) {
      const pip = cell("span", outcome);
      pip.className = `form-pip form-${outcome === "W" ? "win" : "loss"}`;
      pip.setAttribute("aria-label", outcome === "W" ? "Win" : "Loss");
      form.append(pip);
    }
    byId("patterns-scope").textContent = `${result.games} standard matches · ${result.wins} wins`;
    if (!result.points.length) {
      list.append(cell("li", "No strong patterns yet. More games will reveal them."));
      return;
    }
    for (const point of result.points) {
      const item = document.createElement("li");
      item.dataset.impact = point.tone;
      const text = document.createElement("div");
      text.append(cell("strong", point.title), cell("p", point.detail));
      item.append(cell("span", ""), text);
      list.append(item);
    }
  }

  function renderComparison(heroes, names, scopeLabel) {
    const container = byId("compare-list");
    container.replaceChildren();
    byId("compare-scope").textContent = scopeLabel;
    if (!heroes.length) {
      container.append(cell("p", "Play at least 3 games on a hero in this mode to compare it with other players."));
      return;
    }
    const fmt = (metric, value) =>
      value === null ? "—" : metric.percent ? `${Math.round(value * 100)}%` : metric.label === "Souls" ? Math.round(value).toLocaleString("en-US") : value.toFixed(1);
    for (const hero of heroes) {
      const info = names.get(hero.heroId);
      const name = info?.name || `Hero ${hero.heroId}`;
      const section = document.createElement("section");
      section.className = "compare-hero";
      const heading = document.createElement("h3");
      heading.append(
        portrait(info?.images?.icon_image_small_webp || info?.images?.icon_image_small, name, "hero-portrait"),
        cell("span", name),
        cell("small", `${hero.games} of your games · ${hero.cohortMatches.toLocaleString("en-US")} games by others`),
      );
      const table = document.createElement("table");
      table.className = "compare-table";
      const head = document.createElement("tr");
      for (const label of ["", "You", "Others", ""]) head.append(cell("th", label));
      table.append(head);
      for (const metric of hero.metrics) {
        const row = document.createElement("tr");
        const diff =
          metric.you === null || metric.them === null || metric.them === 0
            ? null
            : (metric.you - metric.them) / Math.abs(metric.them);
        const better = diff === null ? null : metric.higherIsBetter ? diff > 0.1 : diff < -0.1;
        const worse = diff === null ? null : metric.higherIsBetter ? diff < -0.1 : diff > 0.1;
        const verdict = cell("td", better ? "Better" : worse ? "Worse" : diff === null ? "" : "Similar");
        verdict.className = `compare-verdict ${better ? "positive" : worse ? "negative" : ""}`;
        row.append(cell("th", metric.label), cell("td", fmt(metric, metric.you)), cell("td", fmt(metric, metric.them)), verdict);
        table.append(row);
      }
      section.append(heading, table);
      container.append(section);
    }
  }

  return { renderPercentiles, renderPatterns, renderComparison };
})();

export default ProfileView;

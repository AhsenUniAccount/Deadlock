import { cell, portrait } from "../core/common.js";

// Renders the player profile sections. Calculations live in player-percentiles.js
// and player-trends.js; this module only builds DOM from their results.
const ProfileView = (() => {
  const byId = (id) => document.querySelector(`#${id}`);

  const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const heroImage = (info) => info?.images?.icon_image_small_webp || info?.images?.icon_image_small;

  // One row per stat: name and typical value, your value, a bar with a median
  // tick, and the percentile chip. Tone colours mark the top and bottom quarters.
  function renderPercentiles(rows, scope, badge = "") {
    const list = byId("percentile-grid");
    list.replaceChildren();
    byId("stats-scope").textContent = scope;
    byId("stats-badge").textContent = badge;
    byId("stats-badge").hidden = !badge;
    for (const row of rows) {
      const item = document.createElement("div");
      item.className = `percentile-row tone-${row.tone}`;
      item.setAttribute("role", "group");
      item.setAttribute("aria-label", `${row.label}: ${row.value}, ${row.display} of games at this rank`);
      const label = document.createElement("div");
      label.className = "percentile-label";
      label.append(cell("b", row.label), cell("small", `Typical: ${row.typical}${row.key === "deaths" ? " · lower is better" : ""}`));
      const value = cell("div", row.value);
      value.className = "percentile-value";
      const bar = document.createElement("div");
      bar.className = "percentile-bar";
      bar.setAttribute("aria-hidden", "true");
      bar.style.setProperty("--p", `${Math.max(2, Math.min(100, row.percentile))}%`);
      const chip = cell("span", row.display);
      chip.className = "percentile-chip";
      item.append(label, value, bar, chip);
      list.append(item);
    }
  }

  function renderTopHeroes(heroes, names) {
    const list = byId("top-heroes");
    list.replaceChildren();
    if (!heroes.length) {
      list.append(cell("p", "No standard matches in the last 30 days."));
      return;
    }
    for (const hero of heroes) {
      const info = names.get(hero.heroId);
      const name = info?.name || `Hero ${hero.heroId}`;
      const row = document.createElement("div");
      row.className = "overview-hero";
      const text = document.createElement("div");
      const kda = [hero.kills, hero.deaths, hero.assists].every((n) => n !== null)
        ? ` · ${hero.kills.toFixed(1)} / ${hero.deaths.toFixed(1)} / ${hero.assists.toFixed(1)}`
        : "";
      text.append(cell("b", name), cell("small", `${hero.games} game${hero.games === 1 ? "" : "s"}${kda}`));
      const rate = cell("div", `${Math.round(hero.winRate * 100)}%`);
      rate.className = "overview-hero-rate";
      const bar = document.createElement("i");
      bar.style.setProperty("--w", `${Math.round(hero.winRate * 100)}%`);
      rate.append(bar);
      row.append(portrait(heroImage(info), name, "hero-portrait"), text, rate);
      list.append(row);
    }
  }

  // The latest match from history, shown immediately; addRecentSummary adds
  // the lobby rank and top summary point once the match metadata loads.
  function renderRecentMatch(match, names, url) {
    const container = byId("recent-match");
    container.replaceChildren();
    byId("recent-card").dataset.result = "";
    if (!match) {
      container.append(cell("p", "No recorded matches yet."));
      return;
    }
    const info = names.get(match.hero_id);
    const name = info?.name || `Hero ${match.hero_id}`;
    const outcome = match.player_match_outcome === 1 ? "Win" : match.player_match_outcome === 2 ? "Loss" : "Other";
    byId("recent-card").dataset.result = outcome.toLowerCase();
    const top = document.createElement("div");
    top.className = "overview-match-top";
    const text = document.createElement("div");
    const when = new Date(match.start_time * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    text.append(cell("b", name), cell("small", `${when}${Number.isFinite(match.match_duration_s) ? ` · ${clock(match.match_duration_s)}` : ""}`));
    const stamp = cell("span", outcome);
    stamp.className = `outcome-stamp outcome-${outcome.toLowerCase()}`;
    top.append(portrait(heroImage(info), name, "hero-portrait"), text, stamp);
    const kda = cell(
      "div",
      [match.player_kills, match.player_deaths, match.player_assists].map((n) => (Number.isFinite(n) ? n : "—")).join(" / "),
    );
    kda.className = "overview-kda";
    const detail = cell("small", "");
    detail.id = "recent-detail";
    const point = document.createElement("div");
    point.id = "recent-point";
    point.className = "overview-point";
    point.hidden = true;
    const link = cell("a", "View breakdown ↗");
    link.className = "history-button";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    container.append(top, kda, detail, point, link);
  }

  function addRecentSummary(you, point, lobbySize) {
    const detail = document.querySelector("#recent-detail");
    const box = document.querySelector("#recent-point");
    if (!detail || !box) return;
    const parts = [];
    if (you.finalSoulsRankInLobby) parts.push(`${ordinal(you.finalSoulsRankInLobby)}${lobbySize ? ` of ${lobbySize}` : ""} in souls`);
    if (you.mvpRank) parts.push(`MVP #${you.mvpRank}`);
    detail.textContent = parts.join(" · ");
    if (point) {
      box.replaceChildren();
      box.dataset.impact = point.tone;
      if (point.timeS !== null) box.append(cell("b", clock(point.timeS)));
      box.append(cell("span", point.title));
      box.hidden = false;
    }
  }
  const ordinal = (n) => {
    const tens = n % 100;
    return `${n}${tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
  };

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

  return { renderPercentiles, renderTopHeroes, renderRecentMatch, addRecentSummary, renderPatterns, renderComparison };
})();

export default ProfileView;

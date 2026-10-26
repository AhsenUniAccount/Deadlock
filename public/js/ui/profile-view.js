import { cell, portrait } from "../core/common.js";

// Renders the player profile sections. Calculations live in player-percentiles.js
// and player-trends.js; this module only builds DOM from their results.
const ProfileView = (() => {
  const byId = (id) => document.querySelector(`#${id}`);

  const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const heroImage = (info) => info?.images?.icon_image_small_webp || info?.images?.icon_image_small;
  // Hero portraits use the larger card art when the catalog provides it.
  const heroCard = (info) =>
    info?.images?.icon_hero_card_webp || info?.images?.icon_hero_card || heroImage(info);
  const ordinal = (n) => {
    const tens = n % 100;
    return `${n}${tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
  };
  const div = (className, ...children) => {
    const element = document.createElement("div");
    element.className = className;
    element.append(...children);
    return element;
  };
  // New content rises in, staggered by position (see .reveal in deco.css).
  const reveal = (element, index) => {
    element.className += " reveal";
    element.style.setProperty("--i", String(index));
    return element;
  };

  // ----- Loading placeholders: gold shimmer shapes in place of the real content. -----
  const PLAQUES = ["overall-rate", "record-detail", "latest-result"];
  const skeletonLine = (width) => {
    const line = div("skel skel-line");
    line.style.width = `${width}%`;
    return line;
  };
  function showSkeleton() {
    for (const id of PLAQUES) {
      byId(id).className = "skel-text";
      byId(id).textContent = "00";
    }
    byId("rank-crest").hidden = true;
    byId("player-rank").className = "skel-text";
    byId("player-rank").textContent = "Loading";
    byId("top-heroes").replaceChildren(
      ...[0, 1, 2].map((i) =>
        div("arch skel-arch", div("arch-win skel"), div("arch-plate skel", cell("b", "Hero"), cell("small", "00 games"))),
      ),
    );
    byId("top-heroes").setAttribute("aria-busy", "true");
    byId("recent-match").replaceChildren(
      div("skel skel-crest"),
      div("", ...[70, 95, 60].map(skeletonLine)),
      div("skel skel-line"),
    );
    byId("percentile-grid").replaceChildren(
      ...Array.from({ length: 10 }, (_, i) =>
        div("gauge skel-gauge", div("skel skel-line"), div("skel skel-line")),
      ),
    );
    byId("percentile-grid").setAttribute("aria-busy", "true");
  }
  // Shown the moment a shared profile link opens, before the player lookup returns.
  function showIdentitySkeleton() {
    byId("selected-player").replaceChildren(div("skel skel-avatar"), div("skel skel-name"));
    showSkeleton();
  }
  function clearPlaqueSkeleton() {
    for (const id of PLAQUES) byId(id).className = "";
    byId("player-rank").className = "";
  }

  // ----- Identity -----
  function renderRank(label, rank) {
    const name = byId("player-rank");
    const crest = byId("rank-crest");
    name.className = "";
    name.textContent = label || "Unranked";
    const line = name.parentElement?.parentElement;
    if (rank?.color) line?.style.setProperty("--rank", rank.color);
    const url = rank?.images?.large_webp || rank?.images?.large;
    crest.hidden = !url;
    if (url) {
      crest.src = url;
      crest.alt = `${rank.name} rank crest`;
    }
  }

  // One gauge per stat: name and value, a gold track with a diamond at your
  // percentile and a tick at the median game, then the typical value and rank.
  function renderPercentiles(rows, scope, badge = "") {
    const list = byId("percentile-grid");
    list.replaceChildren();
    list.removeAttribute("aria-busy");
    byId("stats-scope").textContent = scope;
    byId("stats-badge").textContent = badge;
    rows.forEach((row, index) => {
      const item = div(`gauge tone-${row.tone}`);
      item.style.setProperty("--p", `${Math.max(2, Math.min(98, row.percentile))}%`);
      item.setAttribute("role", "group");
      item.setAttribute("aria-label", `${row.label}: ${row.value}, ${row.display} of games at this rank`);
      const track = div("gauge-track", div("gauge-fill"), div("gauge-median"), div("gauge-diamond"));
      track.setAttribute("aria-hidden", "true");
      item.append(
        div("gauge-head", cell("b", row.label), cell("span", row.value)),
        track,
        div(
          "gauge-sub",
          cell("span", `Typical ${row.typical}${row.key === "deaths" ? " · lower is better" : ""}`),
          cell("i", row.display),
        ),
      );
      // The gauge fill and diamond animate with their own delays.
      item.style.setProperty("--i", String(Math.floor(index / 2)));
      list.append(reveal(item, Math.floor(index / 2)));
    });
  }

  // Replaces the gauges with a message when the comparison is unavailable.
  function statsMessage(text) {
    const list = byId("percentile-grid");
    list.removeAttribute("aria-busy");
    list.replaceChildren(cell("p", text));
    byId("stats-scope").textContent = "";
  }

  function renderTopHeroes(heroes, names) {
    const list = byId("top-heroes");
    list.removeAttribute("aria-busy");
    list.replaceChildren();
    if (!heroes.length) {
      list.append(cell("p", "No standard matches in the last 30 days."));
      return;
    }
    heroes.forEach((hero, index) => {
      const info = names.get(hero.heroId);
      const name = info?.name || `Hero ${hero.heroId}`;
      const kda = [hero.kills, hero.deaths, hero.assists].every((n) => n !== null)
        ? ` · ${hero.kills.toFixed(1)} / ${hero.deaths.toFixed(1)} / ${hero.assists.toFixed(1)}`
        : "";
      const win = div(
        "arch-win",
        portrait(heroCard(info), name, "arch-pic"),
        div("arch-big", document.createTextNode(`${Math.round(hero.winRate * 100)}%`)),
      );
      const plate = div(
        "arch-plate",
        cell("b", name),
        cell("small", `${hero.games} game${hero.games === 1 ? "" : "s"}${kda}`),
      );
      list.append(reveal(div("arch", win, plate), index));
    });
  }

  // The latest match, shown straight away; addRecentSummary adds the lobby rank
  // and top finding once the match metadata loads.
  function renderRecentMatch(match, names, url) {
    const container = byId("recent-match");
    container.replaceChildren();
    const result = byId("latest-result");
    result.className = "";
    if (!match) {
      container.append(cell("p", "No recorded matches yet."));
      result.textContent = "—";
      return;
    }
    const info = names.get(match.hero_id);
    const name = info?.name || `Hero ${match.hero_id}`;
    const outcome = match.player_match_outcome === 1 ? "win" : match.player_match_outcome === 2 ? "loss" : "other";
    const label = { win: "Victory", loss: "Defeat", other: "Played" }[outcome];
    result.textContent = { win: "Win", loss: "Loss", other: "—" }[outcome];
    result.dataset.result = outcome;
    const when = new Date(match.start_time * 1000).toLocaleString([], { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    byId("recent-when").textContent = `${when}${Number.isFinite(match.match_duration_s) ? ` · ${clock(match.match_duration_s)}` : ""}`;
    const kda = [match.player_kills, match.player_deaths, match.player_assists]
      .map((n) => (Number.isFinite(n) ? n : "—"))
      .join(" / ");
    const title = cell("h3", `${name} `);
    title.append(cell("small", kda));
    // Until the match's detailed data loads, describe the game from history alone.
    const perMinute =
      Number.isFinite(match.net_worth) && match.match_duration_s > 0
        ? ` ${Math.round(match.net_worth / (match.match_duration_s / 60)).toLocaleString("en-US")} souls per minute.`
        : "";
    const line = cell("div", `Played for ${Number.isFinite(match.match_duration_s) ? clock(match.match_duration_s) : "an unknown time"}.${perMinute}`);
    line.id = "recent-line";
    line.className = "ticket-line";
    const link = cell("a", "View breakdown");
    link.className = "history-button";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const verdict = cell("b", label);
    verdict.dataset.result = outcome;
    container.append(
      portrait(heroCard(info), name, "ticket-crest"),
      div("", title, line),
      div("ticket-result", verdict, cell("small", `Match #${match.match_id}`), link),
    );
    container.className = "ticket fade";
  }

  function addRecentSummary(you, point, lobbySize) {
    const line = document.querySelector("#recent-line");
    if (!line) return;
    const parts = [];
    if (point) parts.push(`${point.title}${point.timeS === null ? "" : ` at ${clock(point.timeS)}`}.`);
    if (you.finalSoulsRankInLobby)
      parts.push(`${ordinal(you.finalSoulsRankInLobby)}${lobbySize ? ` of ${lobbySize}` : ""} in souls${you.mvpRank ? `, and Match MVP number ${you.mvpRank}` : ""}.`);
    else if (you.mvpRank) parts.push(`Match MVP number ${you.mvpRank}.`);
    line.textContent = parts.join(" ");
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

  return {
    showSkeleton,
    showIdentitySkeleton,
    clearPlaqueSkeleton,
    renderRank,
    renderPercentiles,
    statsMessage,
    renderTopHeroes,
    renderRecentMatch,
    addRecentSummary,
    renderPatterns,
    renderComparison,
  };
})();

export default ProfileView;

"use strict";

// Standalone match-page controller. Data normalization lives in match-stats.js;
// charts and historical comparisons have their own rendering modules.
const matchParameters = new URLSearchParams(window.location.search);
const selectedAccountId = Number(matchParameters.get("player"));
let heroNames;
const matchStatus = document.querySelector("#match-status");
const matchContent = document.querySelector("#match-content");
const retryMatch = document.querySelector("#retry-match");
let matchController;
let currentMatchId;
let matchView;
let itemCatalog;

function displayCount(value) {
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}
function teamName(team) {
  return team === 0
    ? "The Hidden King"
    : team === 1
      ? "The ArchMother"
      : `Team ${team ?? "unknown"}`;
}
function matchDuration(seconds) {
  return Number.isFinite(seconds)
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    : "Unknown duration";
}

// Render metadata first, then enrich identities and shop items independently.
// Cancelling the previous load prevents its response from replacing a new match.
async function openMatch(id) {
  if (
    !/^\d+$/.test(String(id)) ||
    !Number.isSafeInteger(Number(id)) ||
    Number(id) <= 0
  ) {
    matchStatus.textContent =
      "No valid match ID was provided. Return to Player search and open a match.";
    return;
  }
  matchController?.abort();
  const controller = new AbortController();
  matchController = controller;
  currentMatchId = Number(id);
  matchView = null;
  matchContent.hidden = true;
  retryMatch.hidden = true;
  document.querySelector("#match-scoreboard").replaceChildren();
  document.querySelector("#match-title").textContent = `Match #${id}`;
  matchStatus.textContent = "Loading match statistics…";
  document.title = `Match #${id} • Deadlock Tracker`;
  try {
    const result = await request(
      `/v1/matches/${id}/metadata`,
      controller.signal,
      1800000,
      false,
      true,
    );
    if (controller.signal.aborted) return;
    const match = DeadlockMatchStats.summarizeMatch(result.data, id);
    matchView = {
      match,
      profiles: new Map(),
      heroes: new Map((heroNames || []).map((hero) => [hero.id, hero])),
      items: itemCatalog,
      itemsLoading: !itemCatalog,
      selectedSlot:
        match.players.find((player) => player.accountId === selectedAccountId)
          ?.slot ?? match.players[0].slot,
    };
    renderMatch();
    matchContent.hidden = false;
    matchStatus.textContent =
      "Match loaded. Fetching player names, portraits, and items…";
    const ids = [
      ...new Set(
        match.players.map((player) => player.accountId).filter((id) => id > 0),
      ),
    ].join(",");
    const [profilesResult, heroesResult, itemsResult] =
      await Promise.allSettled([
        ids
          ? request(
              `/v1/players/steam?account_ids=${ids}`,
              controller.signal,
              300000,
            )
          : Promise.resolve({ data: [] }),
        heroNames
          ? Promise.resolve({ data: heroNames })
          : request("/v1/assets/heroes", controller.signal, 3600000),
        itemCatalog
          ? Promise.resolve({ data: [...itemCatalog.values()] })
          : request("/v1/assets/items", controller.signal, 3600000),
      ]);
    if (controller.signal.aborted) return;
    const warnings = [];
    if (profilesResult.status === "fulfilled")
      matchView.profiles = new Map(
        profilesResult.value.data
          .filter((profile) => typeof profile?.personaname === "string")
          .map((profile) => [profile.account_id, profile]),
      );
    else warnings.push("Steam names unavailable; account IDs shown.");
    if (heroesResult.status === "fulfilled") {
      heroNames = heroesResult.value.data;
      matchView.heroes = new Map(heroNames.map((hero) => [hero.id, hero]));
    } else warnings.push("Hero names unavailable; hero IDs shown.");
    matchView.itemsLoading = false;
    if (itemsResult.status === "fulfilled") {
      itemCatalog = new Map(
        itemsResult.value.data.map((item) => [item.id, item]),
      );
      matchView.items = itemCatalog;
    }
    renderMatch();
    const winner = [0, 1].includes(match.winningTeam)
      ? `${teamName(match.winningTeam)} victory`
      : "Winner unavailable";
    matchStatus.textContent = `${Number.isFinite(match.startTime) ? dateTime(match.startTime) : "Date unavailable"} · ${matchDuration(match.duration)} · ${winner} · ${match.players.length} players. ${warnings.join(" ")}`;
  } catch (error) {
    if (controller.signal.aborted) return;
    matchContent.hidden = true;
    matchStatus.textContent =
      error.status === 404
        ? "Detailed data for this match is not available from the API yet. Try another match or retry later."
        : errorMessage(error);
    retryMatch.hidden = false;
  }
}

function matchIdentity(player) {
  const profile = matchView.profiles.get(player.accountId);
  const hero = matchView.heroes.get(player.heroId);
  const name =
    profile?.personaname ||
    (player.accountId
      ? `Account ${player.accountId}`
      : `Player slot ${player.slot}`);
  const heroName = hero?.name || `Hero ${player.heroId}`;
  const identity = document.createElement("span");
  identity.className = "hero-identity";
  const label = cell("span", name);
  label.append(
    cell(
      "small",
      `${heroName} · ${player.accountId ? `ID ${player.accountId}` : `Slot ${player.slot}`}`,
    ),
  );
  identity.append(
    portrait(
      hero?.images?.icon_image_small_webp || hero?.images?.icon_image_small,
      heroName,
      "hero-portrait",
    ),
    label,
  );
  return { identity, name, heroName };
}

function renderMatch() {
  renderMatchHighlights();
  renderAllPurchases();
  renderKillTimeline();
  const body = document.querySelector("#match-scoreboard");
  body.replaceChildren();
  const teamBodies = new Map();
  for (const team of [
    ...new Set(matchView.match.players.map((player) => player.team)),
  ]) {
    const section = document.createElement("section");
    section.className = "team-scoreboard";
    const title = cell("h3", teamName(team));
    title.id = `scoreboard-team-${team ?? "unknown"}`;
    section.setAttribute("aria-labelledby", title.id);
    const header = document.createElement("div");
    header.className = "team-scoreboard-header";
    const subtitle =
      team === 0 ? "Amber" : team === 1 ? "Sapphire" : "Unknown team";
    header.append(
      title,
      cell(
        "span",
        subtitle + (team === matchView.match.winningTeam ? " · Victory" : ""),
      ),
    );
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", `${teamName(team)} scoreboard`);
    const table = document.createElement("table");
    table.className = "scoreboard";
    const caption = cell(
      "caption",
      `${teamName(team)} player kills, deaths, assists, and final souls`,
    );
    caption.className = "sr-only";
    const head = document.createElement("thead");
    const headings = document.createElement("tr");
    for (const label of [
      "Player / hero",
      "Kills",
      "Deaths",
      "Assists",
      "Souls",
    ]) {
      const th = cell("th", label);
      th.scope = "col";
      headings.append(th);
    }
    head.append(headings);
    const rows = document.createElement("tbody");
    teamBodies.set(team, rows);
    table.append(caption, head, rows);
    scroll.append(table);
    section.append(header, scroll);
    body.append(section);
  }
  for (const player of matchView.match.players) {
    const row = document.createElement("tr");
    row.dataset.slot = String(player.slot);
    const heading = cell("th", "");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scoreboard-player";
    button.setAttribute(
      "aria-controls",
      "items-purchased souls-graph match-analysis",
    );
    button.setAttribute(
      "aria-pressed",
      String(player.slot === matchView.selectedSlot),
    );
    const { identity, name } = matchIdentity(player);
    button.setAttribute("aria-label", `Highlight ${name}`);
    button.append(identity);
    button.addEventListener("click", () => selectMatchPlayer(player.slot));
    heading.append(button);
    row.append(
      heading,
      ...[player.kills, player.deaths, player.assists, player.souls].map(
        (value) => cell("td", displayCount(value)),
      ),
    );
    teamBodies.get(player.team).append(row);
  }
  renderPlayerSelection();
  SoulsChart.render(matchView);
  MatchAnalysis.render(matchView);
}

// Both the scoreboard and chart dropdown use the same selection path.
function selectMatchPlayer(slot) {
  if (
    !matchView ||
    !matchView.match.players.some((player) => player.slot === slot)
  )
    return;
  matchView.selectedSlot = slot;
  renderPlayerSelection();
  SoulsChart.render(matchView);
  MatchAnalysis.render(matchView);
}
document.addEventListener("match-player-select", (event) =>
  selectMatchPlayer(event.detail?.slot),
);

// Keep the selected player consistent across the scoreboard, items, and analysis.
// Selection is independent of the data-loading and chart-rendering functions.
function renderPlayerSelection() {
  const { selectedSlot } = matchView;
  for (const row of document.querySelectorAll("#match-scoreboard tbody tr")) {
    const active = row.dataset.slot === String(selectedSlot);
    row.classList.toggle("selected-row", active);
    row.querySelector("button").setAttribute("aria-pressed", String(active));
  }
  for (const row of document.querySelectorAll(".player-purchases")) {
    row.classList.toggle(
      "highlighted-purchases",
      row.dataset.slot === String(selectedSlot),
    );
  }
}

// The API includes ability upgrades alongside shop purchases. The pure helper
// filters those out; each remaining entry retains its own purchase/removal time.
function renderPurchases(player, grid, status) {
  grid.replaceChildren();
  if (!matchView.items) {
    status.textContent = matchView.itemsLoading
      ? "Loading item names and icons…"
      : "Item names are unavailable. Reload this page to retry.";
    return;
  }
  const items = DeadlockMatchStats.purchases(player, matchView.items);
  if (items === null) {
    status.textContent = "No purchase history was provided for this player.";
    return;
  }
  const unknown = player.items.filter(
    (item) => !item || !matchView.items.has(item.item_id),
  ).length;
  status.textContent = `${items.length} recorded purchases, in order. Removal times include sales or replacement by upgrades. Names and icons use the current item catalog.${unknown ? ` ${unknown} unidentified entries could not be displayed.` : ""}`;
  if (!items.length && !unknown)
    status.textContent = "No shop-item purchases recorded for this player.";
  for (const purchase of items) {
    const item = matchView.items.get(purchase.id);
    const card = document.createElement("details");
    card.className = "purchase-card";
    const name = item.name || `Item ${purchase.id}`;
    const description = document.createElement("div");
    description.append(
      cell(
        "small",
        `Bought ${purchase.bought === null ? "at unknown time" : matchDuration(purchase.bought)}`,
      ),
    );
    if (purchase.removed !== null)
      description.append(
        cell("small", `Sold / replaced ${matchDuration(purchase.removed)}`),
      );
    const itemSummary = document.createElement("summary");
    itemSummary.append(
      portrait(
        item.shop_image_webp ||
          item.shop_image ||
          item.image_webp ||
          item.image,
        name,
        "item-portrait",
      ),
      cell("strong", name),
    );
    card.append(itemSummary, description);
    grid.append(card);
  }
}

function renderMatchHighlights() {
  const container = document.querySelector("#match-mvps");
  container.replaceChildren();
  const mvps = DeadlockMatchStats.matchMvps(matchView.match.players);
  if (!mvps.length) {
    container.append(
      cell("p", "The API has not provided MVP rankings for this match."),
    );
    return;
  }
  for (const player of mvps) {
    const card = document.createElement("section");
    card.className = "mvp-team match-mvp";
    card.append(
      cell("h3", `#${player.mvpRank} MVP`),
      matchIdentity(player).identity,
    );
    const kda = document.createElement("div");
    kda.className = "mvp-kda";
    kda.append(
      cell(
        "strong",
        `${displayCount(player.kills)} / ${displayCount(player.deaths)} / ${displayCount(player.assists)}`,
      ),
      cell("small", "Kills / Deaths / Assists"),
    );
    card.append(kda, cell("p", teamName(player.team)));
    container.append(card);
  }
}

function renderAllPurchases() {
  const container = document.querySelector("#all-player-purchases");
  container.replaceChildren();
  for (const team of [
    ...new Set(matchView.match.players.map((player) => player.team)),
  ]) {
    const group = document.createElement("section");
    group.className = "purchase-team";
    group.append(cell("h3", teamName(team)));
    for (const player of matchView.match.players.filter(
      (person) => person.team === team,
    )) {
      const row = document.createElement("section");
      row.className = "player-purchases";
      row.dataset.slot = String(player.slot);
      const heading = document.createElement("h4");
      heading.append(matchIdentity(player).identity);
      const status = cell("p", "");
      status.className = "purchase-status";
      const grid = document.createElement("div");
      grid.className = "purchase-grid";
      renderPurchases(player, grid, status);
      row.append(heading, status, grid);
      group.append(row);
    }
    container.append(group);
  }
}

// Render only reported events; unknown killers and timestamps remain explicit.
function renderKillTimeline() {
  const events = DeadlockMatchStats.killTimeline(matchView.match);
  const list = document.querySelector("#kill-events");
  list.replaceChildren();
  document.querySelector("#kill-timeline-note").textContent = events.length
    ? `${events.length} recorded deaths, ordered by game time.${matchView.match.incomplete ? " Event logs are incomplete or differ from the scoreboard." : ""}${events.some((event) => event.time === null) ? " Events without a valid timestamp appear last." : ""}`
    : "No death events were provided for this match.";
  for (const event of events) {
    const row = document.createElement("li");
    const time = cell(
      "span",
      event.time === null ? "Time unknown" : matchDuration(event.time),
    );
    time.className = "kill-time";
    const killer = event.killer
      ? matchIdentity(event.killer).identity
      : cell("span", "Unknown / non-player source");
    const action = cell(
      "span",
      event.killer?.slot === event.victim.slot
        ? "self-attributed death →"
        : "killed →",
    );
    action.className = "kill-action";
    row.append(time, killer, action, matchIdentity(event.victim).identity);
    list.append(row);
  }
}

// All renderers are defined above; start the initial URL-based load last.
retryMatch.addEventListener("click", () => openMatch(currentMatchId));
window.addEventListener("pagehide", () => {
  matchController?.abort();
});
openMatch(matchParameters.get("id"));

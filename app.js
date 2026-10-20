import DeadlockStats from "./stats.js";
import DeadlockMatchStats from "./match-stats.js";
import MatchDigest from "./match-digest.js";
import MatchSummary from "./match-summary.js";
import PlayerTrends from "./player-trends.js";
import { request, errorMessage, dateTime, cell, portrait, heroCell } from "./common.js";
import PlayerPercentiles from "./player-percentiles.js";
import ProfileView from "./profile-view.js";

// Overview page controller: search suggestions, selected profile, then match history.
// Statistics stay in stats.js so they can be tested without a browser.
const { formatWinRate, accountIdFromQuery, summarize } = DeadlockStats;
const searchInput = document.querySelector("#search-query");
const suggestions = document.querySelector("#player-suggestions");
const selectedPlayer = document.querySelector("#selected-player");
const resultsBody = document.querySelector("#hero-results");
const summary = document.querySelector("#summary");
const searchStatus = document.querySelector("#search-status");
const searchForm = document.querySelector("#search-form");
// Search and history have independent cancellation: typing must invalidate both
// old suggestions and any pending statistics for the previously selected player.
let profiles = [];
let searchController;
let historyController;
let heroNames;
let selectedProfile;
let activeIndex = -1;
let searchTimer;
let composing = false;
let suggestionsDismissed = false;

// Clear statistics when the search changes so the previous player’s results cannot linger.
function resetResults(message) {
  for (const id of ["#latest-match", "#player-patterns", "#hero-compare"])
    document.querySelector(id).hidden = true;
  for (const id of ["#top-heroes", "#recent-match", "#percentile-grid"])
    document.querySelector(id).replaceChildren();
  document.querySelector("#player-rank").textContent = "";
  document.querySelector("#stats-scope").textContent = "";
  document.querySelector("#history-link").hidden = true;
  resultsBody.replaceChildren();
  summary.textContent = message;
  document.querySelector("#overall-rate").textContent = "—";
  document.querySelector("#record-detail").textContent = "—";
  document.querySelector("#results-scope").textContent =
    "Latest 20 recorded matches";
  document.querySelector("#table-caption").textContent =
    "Hero results for the selected player";
}

// Build the avatar, display name and account ID shared by suggestions and the selected profile.
function profileContent(profile) {
  const identity = document.createElement("span");
  identity.className = "profile-identity";
  identity.append(
    cell("span", profile.personaname),
    cell("small", `Account ${profile.account_id}`),
  );
  return [
    portrait(
      profile.avatarmedium || profile.avatarfull || profile.avatar,
      profile.personaname,
    ),
    identity,
  ];
}

// Hide the suggestion list and reset its keyboard-accessibility state.
function closeSuggestions() {
  suggestions.hidden = true;
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
  for (const option of suggestions.children)
    option.setAttribute("aria-selected", "false");
  activeIndex = -1;
}

// Show current suggestions unless the user explicitly dismissed them.
function openSuggestions() {
  if (!profiles.length || suggestionsDismissed) return;
  suggestions.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");
}

// Move keyboard selection without moving focus away from the search field.
function setActive(index) {
  activeIndex = index;
  for (let i = 0; i < suggestions.children.length; i++) {
    suggestions.children[i].setAttribute("aria-selected", String(i === index));
  }
  const option = suggestions.children[index];
  if (option) {
    searchInput.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  } else {
    searchInput.removeAttribute("aria-activedescendant");
  }
}

// Rebuild clickable account suggestions from the latest search response.
function setPlayerOptions() {
  closeSuggestions();
  suggestions.replaceChildren();
  for (const [index, profile] of profiles.entries()) {
    const option = document.createElement("div");
    option.id = `player-option-${index}`;
    option.className = "player-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.append(...profileContent(profile));
    option.addEventListener("pointerdown", (event) => event.preventDefault());
    option.addEventListener("click", () => choosePlayer(profile));
    suggestions.append(option);
  }
  openSuggestions();
}

// Commit a chosen account, stop pending searches and load its recent statistics.
async function choosePlayer(profile) {
  clearTimeout(searchTimer);
  searchController?.abort();
  searchForm.setAttribute("aria-busy", "false");
  selectedProfile = profile;
  // "compact" stays on while searching again, so the search bar never jumps.
  document.body?.classList.add("has-player", "compact");
  selectedPlayer.replaceChildren(...profileContent(profile));
  searchInput.value = profile.personaname;
  closeSuggestions();
  searchStatus.textContent = `Selected ${profile.personaname} · Account ${profile.account_id}. Type another name to change player.`;
  // The profile URL can be bookmarked or shared; it reopens this player.
  if (globalThis.history?.replaceState)
    history.replaceState(null, "", `?player=${profile.account_id}`);
  await loadPlayer();
}

// Clear old selection before the debounce timer starts; late responses must not
// overwrite the next search, even if the API completes out of order.
function prepareSearch() {
  clearTimeout(searchTimer);
  searchController?.abort();
  historyController?.abort();
  searchForm.setAttribute("aria-busy", "false");
  profiles = [];
  selectedProfile = null;
  // Back to the landing layout until a player is chosen.
  document.body?.classList.remove("has-player");
  selectedPlayer.replaceChildren();
  selectedPlayer.textContent = "No player selected";
  setPlayerOptions();
}

// Resolve numeric IDs locally or search indexed Steam names; ignore cancelled responses.
async function searchPlayers(explicit = false) {
  const query = searchInput.value.trim();
  prepareSearch();
  if (query.length < (explicit ? 1 : 2)) {
    searchStatus.textContent =
      "Type at least 2 characters to search for a player.";
    resetResults("Find a player to retrieve their recent statistics.");
    return;
  }
  const controller = new AbortController();
  searchController = controller;
  searchForm.setAttribute("aria-busy", "true");
  resetResults("Searching for players…");
  searchStatus.textContent = "Searching public player profiles…";
  try {
    const directId = accountIdFromQuery(query);
    if (directId !== null) {
      profiles = [{ account_id: directId, personaname: `Account ${directId}` }];
    } else {
      const params = new URLSearchParams({
        search_query: query,
        limit: "20",
        min_matches_played_last_30d: "0",
      });
      const result = await request(
        `/v1/players/steam-search?${params}`,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      profiles = result.data.filter(
        (profile) =>
          Number.isInteger(profile?.account_id) &&
          typeof profile.personaname === "string",
      );
    }
    if (controller.signal.aborted) return;
    setPlayerOptions();
    searchStatus.textContent = profiles.length
      ? `${profiles.length} matching account${profiles.length === 1 ? "" : "s"}. Use ↑ and ↓ to browse, Enter to select.`
      : "No matching profiles are indexed. Try the player's numeric account ID or SteamID64.";
    resetResults(
      profiles.length
        ? "Choose a player to load their latest recorded matches."
        : "No player found. Try another name or an account ID.",
    );
    if (directId !== null && explicit) await choosePlayer(profiles[0]);
  } catch (error) {
    if (controller.signal.aborted) return;
    profiles = [];
    setPlayerOptions();
    searchStatus.textContent = errorMessage(error);
    resetResults("No match data loaded. Try searching again.");
  } finally {
    if (!controller.signal.aborted)
      searchForm.setAttribute("aria-busy", "false");
  }
}

// Debounce typing for 300 ms, avoiding requests for short or unfinished IME input.
function scheduleSearch() {
  prepareSearch(); // Invalidate old requests immediately, before the debounce delay.
  suggestionsDismissed = false;
  const query = searchInput.value.trim();
  resetResults("Find a player to retrieve their recent statistics.");
  if (composing || query.length < 2) {
    searchStatus.textContent =
      "Type at least 2 characters to search for a player.";
    return;
  }
  searchStatus.textContent = "Waiting for you to finish typing…";
  searchTimer = setTimeout(() => searchPlayers(), 300);
}

searchInput.addEventListener("input", scheduleSearch);
searchInput.addEventListener("compositionstart", () => {
  composing = true;
  prepareSearch();
});
searchInput.addEventListener("compositionend", () => {
  composing = false;
  scheduleSearch();
});
searchInput.addEventListener("focus", () => {
  suggestionsDismissed = false;
  openSuggestions();
});
searchInput.addEventListener("keydown", (event) => {
  if (event.isComposing || composing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    suggestionsDismissed = true;
    closeSuggestions();
  } else if (
    (event.key === "ArrowDown" || event.key === "ArrowUp") &&
    profiles.length
  ) {
    event.preventDefault();
    suggestionsDismissed = false;
    openSuggestions();
    setActive(
      event.key === "ArrowDown"
        ? (activeIndex + 1) % profiles.length
        : (activeIndex <= 0 ? profiles.length : activeIndex) - 1,
    );
  } else if (event.key === "Enter" && !suggestions.hidden && activeIndex >= 0) {
    event.preventDefault();
    choosePlayer(profiles[activeIndex]);
  } else if (event.key === "Tab") {
    suggestionsDismissed = true;
    closeSuggestions();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!searchForm.contains(event.target)) {
    suggestionsDismissed = true;
    closeSuggestions();
  }
});
searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (composing) return;
  suggestionsDismissed = false;
  await searchPlayers(true);
});

// Enrich history with hero names when available; IDs remain a valid fallback.
async function loadPlayer() {
  historyController?.abort();
  const controller = new AbortController();
  historyController = controller;
  const player = selectedProfile;
  if (!player) {
    resetResults("Choose a player to load their latest recorded matches.");
    return;
  }
  resetResults(`Loading recent matches for ${player.personaname}…`);
  try {
    const [historyResult, namesResult] = await Promise.allSettled([
      request(
        `/v1/players/${player.account_id}/match-history`,
        controller.signal,
        300000,
        true,
      ),
      heroNames
        ? Promise.resolve({ data: heroNames })
        : request("/v1/assets/heroes", controller.signal, 3600000),
    ]);
    if (controller.signal.aborted) return;
    if (historyResult.status === "rejected") throw historyResult.reason;
    let namesWarning = "";
    if (namesResult.status === "fulfilled") {
      heroNames = namesResult.value.data;
    } else {
      namesWarning = " Hero names are unavailable; numeric hero IDs are shown.";
    }
    const names = new Map((heroNames || []).map((hero) => [hero.id, hero]));
    const result = summarize(historyResult.value.data, player.account_id);
    renderResults(player, result, names);
    const link = document.querySelector("#history-link");
    link.href = `history.html?player=${player.account_id}`;
    link.hidden = false;
    // The recent-match card shows straight away; the summary adds detail to it.
    const latest = result.recent.find((match) => match.game_mode === 1) || result.recent[0];
    ProfileView.renderRecentMatch(
      latest,
      names,
      latest ? `match.html?id=${latest.match_id}&player=${player.account_id}` : "#",
    );
    loadLatestSummary(player, result.recent, names, controller);
    loadProfile(player, historyResult.value.data, names, controller);
    if (!result.recent.length) {
      summary.textContent = `No recorded matches are available for ${player.personaname}. The API may not have indexed this account yet.`;
      return;
    }
    const newest = dateTime(result.recent[0].start_time);
    const oldest = dateTime(result.recent.at(-1).start_time);
    summary.textContent = `${player.personaname} · ${result.recent.length} latest recorded matches · ${oldest} – ${newest}. Retrieved ${historyResult.value.fetchedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.${historyResult.value.storedFallback ? " API rate limit reached; showing its stored history." : ""}${namesWarning}`;
  } catch (error) {
    if (controller.signal.aborted) return;
    resetResults(
      `${player.personaname}: ${errorMessage(error)} Search again to retry.`,
    );
  }
}

const RANK_TIERS = new Map();
const rankLabel = (badge) =>
  `${RANK_TIERS.get(Math.floor(badge / 10)) || `Tier ${Math.floor(badge / 10)}`} ${badge % 10}`;

// Percentiles, patterns and hero comparisons over the last 30 days. Each part
// fails independently; a missing comparison never hides the rest.
async function loadProfile(player, history, names, controller) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 30 * 86400;
  const recent = history
    .filter((row) => row.account_id === player.account_id && row.start_time >= from)
    .sort((a, b) => b.start_time - a.start_time)
    .slice(0, 200);
  const games = PlayerTrends.scoredGames(recent).length;
  const patterns = PlayerTrends.patterns(recent, (id) => names.get(id)?.name || `Hero ${id}`);
  ProfileView.renderTopHeroes(PlayerTrends.topHeroes(recent), names);
  ProfileView.renderPatterns(patterns);
  document.querySelector("#player-patterns").hidden = !games;
  if (!games) {
    document.querySelector("#stats-scope").textContent = "No standard matches in the last 30 days to compare.";
    return;
  }
  document.querySelector("#stats-scope").textContent = "Loading percentiles…";
  // Private lobbies and bot games have no comparable population.
  const scope = PlayerTrends.comparisonScope(recent) || { mode: null, tier: null, games: [] };
  const rankRange = scope.tier
    ? { min_average_badge: String(scope.tier * 10 + 1), max_average_badge: String(scope.tier * 10 + 6) }
    : {};
  const base = { game_mode: "normal", min_unix_timestamp: String(from), max_unix_timestamp: String(now) };
  const [ranks, mine, population, cohort] = await Promise.allSettled([
    RANK_TIERS.size ? Promise.resolve(null) : request("/v1/assets/ranks", controller.signal, 3600000),
    request(`/v1/analytics/player-stats/metrics?${new URLSearchParams({ ...base, account_ids: String(player.account_id) })}`, controller.signal, 600000, false, true),
    request(`/v1/analytics/player-stats/metrics?${new URLSearchParams({ ...base, ...rankRange })}`, controller.signal, 3600000, false, true),
    scope.mode
      ? request(`/v1/analytics/hero-stats?${new URLSearchParams({ ...base, bucket: "avg_badge", match_mode: scope.mode, ...rankRange })}`, controller.signal, 3600000)
      : Promise.reject(new Error("No ranked or unranked games.")),
  ]);
  if (controller.signal.aborted) return;
  if (ranks.status === "fulfilled" && ranks.value)
    for (const rank of ranks.value.data) RANK_TIERS.set(rank.tier, rank.name);
  const peers = scope.tier ? `${RANK_TIERS.get(scope.tier) || `Tier ${scope.tier}`} players` : "players of all ranks";
  const badge = recent.find((row) => row.ranked_display_badge > 0)?.ranked_display_badge;
  document.querySelector("#player-rank").textContent = badge ? rankLabel(badge) : "Unranked";

  if (mine.status === "fulfilled" && population.status === "fulfilled") {
    ProfileView.renderPercentiles(
      PlayerPercentiles.build(mine.value.data, population.value.data),
      `Your average over ${games} standard match${games === 1 ? "" : "es"}, placed among every game played by ${peers}. The tick marks the median game.`,
      `vs ${scope.tier ? RANK_TIERS.get(scope.tier) || `Tier ${scope.tier}` : "all ranks"} · 30 days`,
    );
  } else {
    document.querySelector("#stats-scope").textContent = "Percentiles are unavailable right now. Try again later.";
  }
  if (cohort.status === "fulfilled") {
    ProfileView.renderComparison(
      PlayerTrends.compare(scope, cohort.value.data),
      names,
      `Your ${scope.mode} games on each hero against ${peers} on the same hero, last 30 days. Per-game averages; longer games raise totals.`,
    );
    document.querySelector("#hero-compare").hidden = false;
  }
}

// Open a shared profile link (?player=ACCOUNT_ID) directly.
async function openFromUrl() {
  const id = Number(new URLSearchParams(globalThis.location?.search || "").get("player"));
  if (!Number.isSafeInteger(id) || id <= 0 || id > 4294967295) return;
  let profile = { account_id: id, personaname: `Account ${id}` };
  try {
    const result = await request(`/v1/players/steam?account_ids=${id}`, new AbortController().signal, 300000);
    const found = result.data.find((p) => p?.account_id === id && typeof p.personaname === "string");
    if (found) profile = found;
  } catch {
    // The account ID alone is enough to load statistics.
  }
  await choosePlayer(profile);
}

// Summarize the most recent standard match, so the first thing a player sees is
// why their last game went the way it did. One metadata request; failures only
// hide the card, never the rest of the page.
async function loadLatestSummary(player, recent, names, controller) {
  const card = document.querySelector("#latest-match");
  const latest = recent.find((match) => match.game_mode === 1);
  if (!latest) return;
  const status = document.querySelector("#latest-status");
  const headline = document.querySelector("#latest-headline");
  const list = document.querySelector("#latest-points");
  const link = document.querySelector("#latest-link");
  const url = `match.html?id=${latest.match_id}&player=${player.account_id}`;
  link.href = url;
  headline.textContent = "";
  list.replaceChildren();
  status.textContent = `Summarizing your match from ${dateTime(latest.start_time)}…`;
  card.hidden = false;
  try {
    const metadata = await request(`/v1/matches/${latest.match_id}/metadata`, controller.signal, 1800000, false, true);
    if (controller.signal.aborted) return;
    const match = DeadlockMatchStats.summarizeMatch(metadata.data, latest.match_id);
    const slot = match.players.find((p) => p.accountId === player.account_id)?.slot;
    if (slot === undefined) throw new Error("Player not found in match.");
    const digest = MatchDigest.build(match, { heroes: names, items: new Map() }, slot);
    const summary = MatchSummary.build(digest);
    ProfileView.addRecentSummary(digest.you, summary.points[0], digest.roster.length);
    headline.textContent = summary.headline;
    status.textContent = `Match from ${dateTime(latest.start_time)}.`;
    for (const point of summary.points.slice(0, 5)) {
      const item = document.createElement("li");
      item.dataset.impact = point.tone;
      const time = cell("span", point.timeS === null ? "" : `${Math.floor(point.timeS / 60)}:${String(point.timeS % 60).padStart(2, "0")}`);
      time.className = "kill-time";
      const text = document.createElement("div");
      text.append(cell("strong", point.title), cell("p", point.detail));
      item.append(time, text);
      list.append(item);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    status.textContent =
      error.status === 404
        ? "Detailed data for your latest match is not available yet. Open it for the basic breakdown."
        : "A summary of your latest match is not available right now.";
  }
}

// Populate overview totals and hero win rates.
function renderResults(player, { totals, heroes }, names) {
  for (const hero of heroes) {
    const row = document.createElement("tr");
    row.append(heroCell(names, hero.id));
    for (const value of [hero.matches, hero.wins, hero.losses, hero.other])
      row.append(cell("td", value));
    const rateCell = document.createElement("td");
    const rate = document.createElement("span");
    rate.className = "rate";
    const track = document.createElement("span");
    track.className = "rate-track";
    track.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.className = "rate-fill";
    const scored = hero.wins + hero.losses;
    fill.style.width = `${scored === 0 ? 0 : (hero.wins / scored) * 100}%`;
    track.append(fill);
    const number = cell("span", formatWinRate(hero.wins, scored));
    number.className = "rate-number";
    rate.append(track, number);
    rateCell.append(rate);
    row.append(rateCell);
    resultsBody.append(row);
  }
  document.querySelector("#table-caption").textContent =
    `Recent hero results for ${player.personaname}`;
  document.querySelector("#overall-rate").textContent = formatWinRate(
    totals.wins,
    totals.wins + totals.losses,
  );
  document.querySelector("#record-detail").textContent = `${totals.wins}W – ${totals.losses}L`;
  document.querySelector("#results-scope").textContent =
    `${totals.matches} recorded matches · ${heroes.length} heroes`;
}

// Share the profile URL (?player=ID) as-is.
const copyProfile = document.querySelector("#copy-profile");
copyProfile.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    copyProfile.textContent = "Link copied ✓";
  } catch {
    copyProfile.textContent = "Copy failed";
  }
  setTimeout(() => (copyProfile.textContent = "Copy profile link"), 2000);
});

openFromUrl();

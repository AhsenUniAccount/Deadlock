"use strict";

// Overview page controller: search suggestions, selected profile, then match history.
// Statistics stay in stats.js so they can be tested without a browser.
const { formatWinRate, accountIdFromQuery, summarize } = DeadlockStats;
const searchInput = document.querySelector("#search-query");
const suggestions = document.querySelector("#player-suggestions");
const selectedPlayer = document.querySelector("#selected-player");
const resultsBody = document.querySelector("#hero-results");
const recentBody = document.querySelector("#recent-results");
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

function resetResults(message) {
  resultsBody.replaceChildren();
  recentBody.replaceChildren();
  summary.textContent = message;
  document.querySelector("#overall-rate").textContent = "—";
  document.querySelector("#record-detail").textContent = "No match data loaded";
  document.querySelector("#results-scope").textContent =
    "Latest 20 recorded matches";
  document.querySelector("#kda-summary").textContent =
    "Kills / deaths / assists";
  document.querySelector("#table-caption").textContent =
    "Hero results for the selected player";
}

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

function closeSuggestions() {
  suggestions.hidden = true;
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
  for (const option of suggestions.children)
    option.setAttribute("aria-selected", "false");
  activeIndex = -1;
}

function openSuggestions() {
  if (!profiles.length || suggestionsDismissed) return;
  suggestions.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");
}

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

async function choosePlayer(profile) {
  clearTimeout(searchTimer);
  searchController?.abort();
  searchForm.setAttribute("aria-busy", "false");
  selectedProfile = profile;
  selectedPlayer.replaceChildren(...profileContent(profile));
  searchInput.value = profile.personaname;
  closeSuggestions();
  searchStatus.textContent = `Selected ${profile.personaname} · Account ${profile.account_id}. Type another name to change player.`;
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
  selectedPlayer.replaceChildren();
  selectedPlayer.textContent = "No player selected";
  setPlayerOptions();
}

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

function renderResults(player, { totals, heroes, recent }, names) {
  function heroCell(id, matchId) {
    const metadata = names.get(id);
    const name = metadata?.name || `Hero ${id}`;
    const th = cell("th", "");
    const identity = document.createElement("span");
    identity.className = "hero-identity";
    const label = cell("span", name);
    if (matchId !== undefined) label.append(cell("small", `#${matchId}`));
    const images = metadata?.images;
    identity.append(
      portrait(
        images?.icon_image_small_webp || images?.icon_image_small,
        name,
        "hero-portrait",
      ),
      label,
    );
    th.append(identity);
    return th;
  }
  for (const hero of heroes) {
    const row = document.createElement("tr");
    row.append(heroCell(hero.id));
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
  for (const match of recent) {
    const row = document.createElement("tr");
    const hero = heroCell(match.hero_id, match.match_id);
    const outcome =
      match.player_match_outcome === 1
        ? "Win"
        : match.player_match_outcome === 2
          ? "Loss"
          : "Other";
    const kda = [match.player_kills, match.player_deaths, match.player_assists]
      .map((value) => (Number.isFinite(value) ? value : "—"))
      .join(" / ");
    const duration = Number.isFinite(match.match_duration_s)
      ? `${Math.floor(match.match_duration_s / 60)}:${String(match.match_duration_s % 60).padStart(2, "0")}`
      : "—";
    row.append(
      hero,
      cell("td", dateTime(match.start_time)),
      cell("td", outcome),
      cell("td", kda),
      cell("td", duration),
    );
    const action = document.createElement("td");
    const open = cell("a", "View match ↗");
    open.href = `match.html?id=${match.match_id}&player=${player.account_id}`;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.className = "secondary-button";
    open.setAttribute(
      "aria-label",
      `View match ${match.match_id} in a new tab`,
    );
    action.append(open);
    row.append(action);
    recentBody.append(row);
  }
  document.querySelector("#table-caption").textContent =
    `Recent hero results for ${player.personaname}`;
  document.querySelector("#overall-rate").textContent = formatWinRate(
    totals.wins,
    totals.wins + totals.losses,
  );
  document.querySelector("#record-detail").textContent =
    `${totals.matches} matches / ${totals.wins} wins / ${totals.losses} losses${totals.other ? ` / ${totals.other} other` : ""}`;
  document.querySelector("#results-scope").textContent =
    `${totals.matches} recorded matches · ${heroes.length} heroes`;
}

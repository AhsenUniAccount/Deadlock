import DeadlockStats from "../core/stats.js";
import PlayerTrends from "../core/player-trends.js";
import { request, errorMessage, dateTime, cell, portrait, heroCell, assetCatalog } from "../core/common.js";

// Match history tab, opened from the player profile as history.html?player=ID.
// Each row links to the match breakdown with this player selected.
const LIMIT = 50;
const status = document.querySelector("#history-status");
const body = document.querySelector("#recent-results");
const identity = document.querySelector("#history-player");
const controller = new AbortController();

const clock = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "—");

function renderRow(match, names, accountId, games) {
  const row = document.createElement("tr");
  const outcome =
    match.player_match_outcome === 1 ? "Win" : match.player_match_outcome === 2 ? "Loss" : "Other";
  const stamp = cell("span", outcome);
  stamp.className = `outcome-stamp outcome-${outcome.toLowerCase()}`;
  const outcomeCell = cell("td", "");
  outcomeCell.append(stamp);
  const kda = [match.player_kills, match.player_deaths, match.player_assists]
    .map((value) => (Number.isFinite(value) ? value : "—"))
    .join(" / ");
  // One factual takeaway per game, relative to the player's other listed games.
  const verdict = PlayerTrends.rowVerdict(match, games);
  const takeaway = cell("td", "");
  if (verdict) {
    const note = cell("span", verdict.text);
    note.className = "row-verdict";
    note.dataset.tone = verdict.tone;
    takeaway.append(note);
  }
  const action = document.createElement("td");
  const open = cell("a", "Breakdown ↗");
  open.href = `match.html?id=${match.match_id}&player=${accountId}`;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.className = "secondary-button";
  open.setAttribute("aria-label", `View match ${match.match_id} in a new tab`);
  action.append(open);
  row.append(
    heroCell(names, match.hero_id, match.match_id),
    cell("td", dateTime(match.start_time)),
    outcomeCell,
    cell("td", kda),
    cell("td", clock(match.match_duration_s)),
    takeaway,
    action,
  );
  return row;
}

async function load() {
  const id = Number(new URLSearchParams(window.location.search).get("player"));
  if (!Number.isSafeInteger(id) || id <= 0 || id > 4294967295) {
    identity.textContent = "No player selected";
    status.textContent = "Open match history from a player profile.";
    return;
  }
  document.querySelector("#profile-link").href = `index.html?player=${id}`;
  status.textContent = "Loading match history…";
  const [history, heroes, profiles] = await Promise.allSettled([
    request(`/v1/players/${id}/match-history`, controller.signal, 300000, true),
    assetCatalog("heroes", controller.signal),
    request(`/v1/players/steam?account_ids=${id}`, controller.signal, 300000),
  ]);
  const profile =
    (profiles.status === "fulfilled" && profiles.value.data.find((p) => p?.account_id === id)) || null;
  const name = profile?.personaname || `Account ${id}`;
  identity.replaceChildren(
    portrait(profile?.avatarmedium || profile?.avatar, name),
    cell("span", name),
  );
  document.title = `${name} · Match history | DeadStats`;
  if (history.status === "rejected") {
    status.textContent = errorMessage(history.reason);
    return;
  }
  const names = new Map(heroes.status === "fulfilled" ? heroes.value.data.map((h) => [h.id, h]) : []);
  let recent;
  try {
    recent = DeadlockStats.summarize(history.value.data, id, LIMIT).recent;
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  const games = PlayerTrends.scoredGames(recent);
  body.replaceChildren(...recent.map((match) => renderRow(match, names, id, games)));
  document.querySelector("#history-scope").textContent = `Latest ${recent.length} recorded matches`;
  status.textContent = recent.length
    ? `${recent.length} matches, ${dateTime(recent.at(-1).start_time)} – ${dateTime(recent[0].start_time)}.${history.value.storedFallback ? " API rate limit reached; showing its stored history." : ""}${heroes.status === "rejected" ? " Hero names unavailable." : ""}`
    : "No recorded matches are available for this player yet.";
}

window.addEventListener("pagehide", () => controller.abort());
load();

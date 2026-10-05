"use strict";

// Shared calculations use the API's player_match_outcome, not the winning team's ID.
const DeadlockStats = (() => {
  // Display a win percentage, keeping an empty scored sample distinct from zero wins.
  function formatWinRate(wins, scored) {
    return scored === 0 ? "—" : `${((wins / scored) * 100).toFixed(1)}%`;
  }

  // Recognize numeric IDs; BigInt preserves SteamID64 precision during conversion.
  function accountIdFromQuery(query) {
    if (!/^\d+$/.test(query)) return null;
    let id = BigInt(query);
    if (query.length === 17) id -= 76561197960265728n;
    if (id < 1n || id > 4294967295n)
      throw new Error("Enter a valid numeric Steam account ID or SteamID64.");
    return Number(id);
  }

  // Validate one account’s history, deduplicate and select recent games, then total outcomes by hero.
  function summarize(history, accountId, limit = 20) {
    if (!Array.isArray(history))
      throw new Error("The API returned an unexpected match-history format.");
    const unique = new Map();
    for (const match of history) {
      if (
        !match ||
        !Number.isSafeInteger(match.match_id) ||
        !Number.isInteger(match.hero_id) ||
        !Number.isFinite(match.start_time) ||
        match.start_time <= 0 ||
        match.account_id !== accountId
      ) {
        throw new Error(
          "The API returned an invalid match record. Please try again later.",
        );
      }
      unique.set(match.match_id, match);
    }
    const recent = [...unique.values()]
      .sort((a, b) => b.start_time - a.start_time || b.match_id - a.match_id)
      .slice(0, limit);
    const heroes = new Map();
    const totals = { matches: recent.length, wins: 0, losses: 0, other: 0 };
    for (const match of recent) {
      const key =
        match.player_match_outcome === 1
          ? "wins"
          : match.player_match_outcome === 2
            ? "losses"
            : "other";
      const hero = heroes.get(match.hero_id) || {
        id: match.hero_id,
        matches: 0,
        wins: 0,
        losses: 0,
        other: 0,
      };
      hero.matches++;
      hero[key]++;
      totals[key]++;
      heroes.set(match.hero_id, hero);
    }
    return {
      recent,
      totals,
      heroes: [...heroes.values()].sort(
        (a, b) => b.matches - a.matches || a.id - b.id,
      ),
    };
  }
  return { formatWinRate, accountIdFromQuery, summarize };
})();
if (typeof module !== "undefined") module.exports = DeadlockStats;

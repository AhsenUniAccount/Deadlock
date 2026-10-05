"use strict";

const DeadlockTierStats = (() => {
  function rankHeroes(data, minimumMatches = 1000) {
    if (!Array.isArray(data))
      throw new Error("Unexpected hero statistics response.");
    const seen = new Set();
    const heroes = data.map((row) => {
      if (
        !row ||
        !Number.isInteger(row.hero_id) ||
        seen.has(row.hero_id) ||
        ![row.wins, row.losses, row.matches].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        row.wins + row.losses > row.matches
      ) {
        throw new Error(
          "The API returned invalid or duplicate hero statistics.",
        );
      }
      seen.add(row.hero_id);
      const scored = row.wins + row.losses;
      return {
        id: row.hero_id,
        wins: row.wins,
        losses: row.losses,
        matches: row.matches,
        scored,
        rate: scored ? row.wins / scored : null,
      };
    });
    return heroes
      .filter((hero) => hero.scored >= minimumMatches && hero.rate !== null)
      .sort((a, b) => b.rate - a.rate || b.scored - a.scored || a.id - b.id);
  }
  return { rankHeroes };
})();
if (typeof module !== "undefined") module.exports = DeadlockTierStats;

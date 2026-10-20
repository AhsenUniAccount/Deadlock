const DeadlockTierStats = (() => {
  // Validate aggregate counts and express each hero's picks as a share of all picks.
  function chartHeroes(data, minimumMatches = 1000) {
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
    const totalPicks = heroes.reduce((sum, hero) => sum + hero.matches, 0);
    return heroes
      .filter((hero) => hero.scored >= minimumMatches && hero.rate !== null)
      .map((hero) => ({
        ...hero,
        pickRate: totalPicks ? hero.matches / totalPicks : 0,
      }))
      .sort((a, b) => a.pickRate - b.pickRate || a.id - b.id);
  }
  // Retain the ranking helper for callers that still consume the previous table model.
  function rankHeroes(data, minimumMatches = 1000) {
    return chartHeroes(data, minimumMatches).sort(
      (a, b) => b.rate - a.rate || b.scored - a.scored || a.id - b.id,
    );
  }
  return { chartHeroes, rankHeroes };
})();
export default DeadlockTierStats;

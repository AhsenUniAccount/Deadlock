// Patterns across a player's recent matches, from match-history rows only (no
// per-match downloads). Comparisons with other players use the API's per-hero,
// per-rank aggregates. Every figure is computed here; nothing is estimated.
const PlayerTrends = (() => {
  const MIN_SPLIT = 3; // games needed on each side of a comparison (wins/losses, short/long)
  const MIN_HERO_GAMES = 3;
  const MIN_COHORT_MATCHES = 100;
  const LONG_GAME_S = 1800;

  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const one = (n) => (Math.round(n * 10) / 10).toLocaleString("en-US");
  const whole = (n) => Math.round(n).toLocaleString("en-US");
  const pct = (n) => `${Math.round(n * 100)}%`;
  const valid = (n) => Number.isFinite(n) && n >= 0;
  const soulsPerMin = (row) =>
    valid(row.net_worth) && row.match_duration_s > 0 ? row.net_worth / (row.match_duration_s / 60) : null;

  // Standard 6v6 games with a win or loss; other modes and unscored games would skew averages.
  function scoredGames(rows) {
    return rows.filter(
      (row) => row.game_mode === 1 && [1, 2].includes(row.player_match_outcome) && row.match_duration_s > 0,
    );
  }

  // One factual line per match, relative to the player's own recent games.
  function rowVerdict(row, games) {
    if (row.game_mode !== 1 || !games.length) return null;
    const spm = soulsPerMin(row);
    const rates = games.map(soulsPerMin).filter((n) => n !== null);
    const avgDeaths = mean(games.map((g) => g.player_deaths).filter(valid));
    const avgKills = mean(games.map((g) => g.player_kills).filter(valid));
    if (row.player_deaths === 0) return { tone: "positive", text: "Deathless game" };
    if (spm !== null && rates.length >= 5 && spm >= Math.max(...rates))
      return { tone: "positive", text: `Best farm of these games: ${whole(spm)} souls/min` };
    if (valid(row.player_deaths) && avgDeaths !== null && row.player_deaths >= avgDeaths + 3)
      return { tone: "negative", text: `${row.player_deaths} deaths, ${one(row.player_deaths - avgDeaths)} above your average` };
    if (spm !== null && rates.length >= 5 && spm <= Math.min(...rates))
      return { tone: "negative", text: `Lowest farm of these games: ${whole(spm)} souls/min` };
    if (valid(row.player_kills) && avgKills !== null && row.player_kills >= avgKills + 4)
      return { tone: "positive", text: `${row.player_kills} kills, ${one(row.player_kills - avgKills)} above your average` };
    return spm === null ? null : { tone: "neutral", text: `${whole(spm)} souls/min` };
  }

  function patterns(rows, heroName = (id) => `Hero ${id}`) {
    const games = scoredGames(rows);
    const wins = games.filter((g) => g.player_match_outcome === 1);
    const losses = games.filter((g) => g.player_match_outcome === 2);
    const points = [];
    const add = (tone, title, detail) => points.push({ tone, title, detail });

    if (wins.length >= MIN_SPLIT && losses.length >= MIN_SPLIT) {
      const dW = mean(wins.map((g) => g.player_deaths).filter(valid));
      const dL = mean(losses.map((g) => g.player_deaths).filter(valid));
      if (dW !== null && dL !== null && dL - dW >= 1)
        add("negative", "Deaths decide your games", `You die ${one(dL)} times per loss on average, against ${one(dW)} per win.`);
      const sW = mean(wins.map(soulsPerMin).filter((n) => n !== null));
      const sL = mean(losses.map(soulsPerMin).filter((n) => n !== null));
      if (sW !== null && sL !== null && Math.abs(sW - sL) >= 50)
        add(
          sW > sL ? "neutral" : "positive",
          sW > sL ? "Farm drops in losses" : "You keep farming when losing",
          `You average ${whole(sW)} souls/min in wins and ${whole(sL)} in losses.`,
        );
    }

    const short = games.filter((g) => g.match_duration_s < LONG_GAME_S);
    const long = games.filter((g) => g.match_duration_s >= LONG_GAME_S);
    if (short.length >= MIN_SPLIT && long.length >= MIN_SPLIT) {
      const rate = (list) => list.filter((g) => g.player_match_outcome === 1).length / list.length;
      const [rS, rL] = [rate(short), rate(long)];
      if (Math.abs(rS - rL) >= 0.2)
        add(
          "neutral",
          rS > rL ? "Stronger in short games" : "Stronger in long games",
          `You win ${pct(rS)} of games under ${clock(LONG_GAME_S)} (${short.length}) and ${pct(rL)} of longer ones (${long.length}).`,
        );
    }

    const byHero = new Map();
    for (const g of games) byHero.set(g.hero_id, [...(byHero.get(g.hero_id) || []), g]);
    const heroRates = [...byHero]
      .filter(([, list]) => list.length >= MIN_HERO_GAMES)
      .map(([id, list]) => ({ id, games: list.length, rate: list.filter((g) => g.player_match_outcome === 1).length / list.length }))
      .sort((a, b) => b.rate - a.rate || b.games - a.games);
    if (heroRates.length >= 2) {
      const best = heroRates[0];
      const worst = heroRates.at(-1);
      if (best.rate - worst.rate >= 0.2)
        add(
          "neutral",
          "Best and worst hero",
          `${heroName(best.id)}: ${pct(best.rate)} wins over ${best.games} games. ${heroName(worst.id)}: ${pct(worst.rate)} over ${worst.games}.`,
        );
    }

    const form = games
      .slice()
      .sort((a, b) => b.start_time - a.start_time)
      .slice(0, 5)
      .map((g) => (g.player_match_outcome === 1 ? "W" : "L"));
    return { games: games.length, wins: wins.length, form, points };
  }

  // Ranked games compare with ranked players in the same tier; otherwise with
  // unranked games across all ranks.
  function comparisonScope(rows) {
    const games = scoredGames(rows);
    const ranked = games.filter((g) => g.match_mode === 4);
    const unranked = games.filter((g) => g.match_mode === 1);
    if (!ranked.length && !unranked.length) return null;
    if (ranked.length >= unranked.length) {
      const badge = ranked.find((g) => g.ranked_display_badge > 0)?.ranked_display_badge ?? null;
      return { mode: "ranked", tier: badge ? Math.floor(badge / 10) : null, games: ranked };
    }
    return { mode: "unranked", tier: null, games: unranked };
  }

  // Per-game averages against the same hero in the cohort. Totals scale with
  // game length, which the aggregates cannot control for; the page says so.
  function compare(scope, cohortRows) {
    if (!scope || !Array.isArray(cohortRows)) return [];
    const byHero = new Map();
    for (const g of scope.games) byHero.set(g.hero_id, [...(byHero.get(g.hero_id) || []), g]);
    const heroes = [...byHero]
      .filter(([, list]) => list.length >= MIN_HERO_GAMES)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 2);
    const metrics = [
      ["Kills", "player_kills", "total_kills", true],
      ["Deaths", "player_deaths", "total_deaths", false],
      ["Assists", "player_assists", "total_assists", true],
      ["Souls", "net_worth", "total_net_worth", true],
      ["Last hits", "last_hits", "total_last_hits", true],
    ];
    return heroes.flatMap(([heroId, list]) => {
      const rows = cohortRows.filter(
        (r) => r.hero_id === heroId && (scope.tier === null || Math.floor(r.bucket / 10) === scope.tier),
      );
      const matches = rows.reduce((sum, r) => sum + (r.matches || 0), 0);
      if (matches < MIN_COHORT_MATCHES) return [];
      const wins = rows.reduce((sum, r) => sum + (r.wins || 0), 0);
      const losses = rows.reduce((sum, r) => sum + (r.losses || 0), 0);
      const yourWins = list.filter((g) => g.player_match_outcome === 1).length;
      const result = [
        {
          label: "Win rate",
          you: yourWins / list.length,
          them: wins + losses ? wins / (wins + losses) : null,
          higherIsBetter: true,
          percent: true,
        },
      ];
      for (const [label, own, total, higherIsBetter] of metrics) {
        const values = list.map((g) => g[own]).filter(valid);
        const sum = rows.reduce((s, r) => s + (Number.isFinite(r[total]) ? r[total] : NaN), 0);
        result.push({
          label,
          you: values.length === list.length ? mean(values) : null,
          them: Number.isFinite(sum) ? sum / matches : null,
          higherIsBetter,
          percent: false,
        });
      }
      return [{ heroId, games: list.length, cohortMatches: matches, metrics: result }];
    });
  }

  return { scoredGames, rowVerdict, patterns, comparisonScope, compare };
})();

export default PlayerTrends;

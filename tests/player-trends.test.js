import test from "node:test";
import assert from "node:assert/strict";
import PlayerTrends from "../public/js/core/player-trends.js";

const game = (id, extra = {}) => ({
  match_id: id,
  start_time: id,
  game_mode: 1,
  match_mode: 4,
  hero_id: 1,
  player_match_outcome: 1,
  player_kills: 5,
  player_deaths: 4,
  player_assists: 8,
  net_worth: 30000,
  match_duration_s: 1800,
  ...extra,
});
const games = [game(1), game(2), game(3), game(4, { net_worth: 45000 }), game(5, { net_worth: 15000 }), game(6)];

test("scored games exclude other modes, unscored outcomes and missing durations", () => {
  const rows = [game(1), game(2, { game_mode: 4 }), game(3, { player_match_outcome: 5 }), game(4, { match_duration_s: 0 })];
  assert.deepEqual(PlayerTrends.scoredGames(rows).map((g) => g.match_id), [1]);
});
test("row takeaways compare each match with the player's own recent games", () => {
  const verdict = (row) => PlayerTrends.rowVerdict(row, games);
  assert.deepEqual(verdict(game(9, { player_deaths: 0 })), { tone: "positive", text: "Deathless game" });
  assert.deepEqual(verdict(games[3]), { tone: "positive", text: "Best farm of these games: 1,500 souls/min" });
  assert.deepEqual(verdict(games[4]), { tone: "negative", text: "Lowest farm of these games: 500 souls/min" });
  assert.equal(verdict(game(9, { player_deaths: 9 })).text, "9 deaths, 5 above your average");
  assert.equal(verdict(game(9, { player_kills: 12 })).text, "12 kills, 7 above your average");
  assert.deepEqual(verdict(games[0]), { tone: "neutral", text: "1,000 souls/min" });
  assert.equal(verdict(game(9, { game_mode: 4 })), null);
});
test("patterns compare wins with losses, short with long games, and heroes", () => {
  const rows = [
    ...[1, 2, 3].map((id) => game(id, { player_deaths: 3, net_worth: 36000, match_duration_s: 1200 })),
    ...[4, 5, 6].map((id) => game(id, { player_match_outcome: 2, player_deaths: 9, net_worth: 30000, hero_id: 2, match_duration_s: 2400 })),
  ];
  const result = PlayerTrends.patterns(rows, (id) => `H${id}`);
  assert.deepEqual(result.form, ["L", "L", "L", "W", "W"]);
  assert.deepEqual(
    result.points.map((p) => p.title),
    ["Deaths decide your games", "Farm drops in losses", "Stronger in short games", "Best and worst hero"],
  );
  assert.match(result.points[0].detail, /9 times per loss on average, against 3 per win/);
  assert.match(result.points[3].detail, /H1: 100% wins over 3 games\. H2: 0% over 3\./);
});
test("hero comparison uses the player's ranked tier and needs enough games on both sides", () => {
  const rows = [1, 2, 3].map((id) => game(id, { ranked_display_badge: 85, player_kills: 8 }));
  const scope = PlayerTrends.comparisonScope(rows);
  assert.deepEqual([scope.mode, scope.tier], ["ranked", 8]);
  const cohort = [
    { hero_id: 1, bucket: 81, matches: 150, wins: 75, losses: 75, total_kills: 600, total_deaths: 900, total_assists: 1200, total_net_worth: 4.5e6, total_last_hits: 15000 },
    { hero_id: 1, bucket: 91, matches: 5000, wins: 0, losses: 5000, total_kills: 0, total_deaths: 0, total_assists: 0, total_net_worth: 0, total_last_hits: 0 },
  ];
  const [hero] = PlayerTrends.compare(scope, cohort);
  assert.equal(hero.cohortMatches, 150);
  const kills = hero.metrics.find((m) => m.label === "Kills");
  assert.deepEqual([kills.you, kills.them], [8, 4]);
  assert.equal(hero.metrics[0].them, 0.5);
  assert.deepEqual(PlayerTrends.compare(scope, cohort.slice(1)), []);
  assert.deepEqual(PlayerTrends.compare(PlayerTrends.comparisonScope(rows.slice(0, 2)), cohort), []);
});
test("top heroes are ranked by games played, with win rate and average K/D/A", () => {
  const rows = [
    game(1, { hero_id: 2, player_kills: 10 }),
    game(2, { hero_id: 2, player_match_outcome: 2, player_kills: 4 }),
    game(3, { hero_id: 1 }),
    game(4, { hero_id: 3 }),
    game(5, { hero_id: 4, game_mode: 4 }),
  ];
  const top = PlayerTrends.topHeroes(rows, 2);
  assert.deepEqual(top.map((h) => [h.heroId, h.games, h.winRate, h.kills]), [
    [2, 2, 0.5, 7],
    [1, 1, 1, 5],
  ]);
});

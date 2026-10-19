import test from "node:test";
import assert from "node:assert/strict";
import PlayerTrends from "../player-trends.js";

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

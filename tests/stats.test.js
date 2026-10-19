const test = require("node:test");
const assert = require("node:assert/strict");
const { formatWinRate, accountIdFromQuery, summarize } = require("../stats.js");
const match = (id, outcome, extra = {}) => ({
  account_id: 42,
  match_id: id,
  start_time: 1000 + id,
  hero_id: 1,
  player_match_outcome: outcome,
  ...extra,
});

test("sorts, deduplicates and selects latest 20 before calculating rates", () => {
  const history = Array.from({ length: 25 }, (_, i) =>
    match(i + 1, i % 2 ? 1 : 2),
  );
  const result = summarize([...history, history[0]], 42);
  assert.equal(result.recent.length, 20);
  assert.equal(result.recent[0].match_id, 25);
  assert.equal(result.recent.at(-1).match_id, 6);
  assert.deepEqual(result.totals, {
    matches: 20,
    wins: 10,
    losses: 10,
    other: 0,
  });
});
test("uses player outcome, excludes other outcomes and weights rates by matches", () => {
  const result = summarize(
    [
      match(1, 1, { player_team: 0, match_result: 1 }),
      match(2, 2),
      match(3, 2),
      match(4, 1, { hero_id: 2 }),
      match(5, 3),
      match(6, 0),
      match(7, 4),
      match(8, 5),
    ],
    42,
  );
  assert.deepEqual(result.totals, { matches: 8, wins: 2, losses: 2, other: 4 });
  assert.equal(
    formatWinRate(
      result.totals.wins,
      result.totals.wins + result.totals.losses,
    ),
    "50.0%",
  );
  assert.equal(
    formatWinRate(
      result.heroes[0].wins,
      result.heroes[0].wins + result.heroes[0].losses,
    ),
    "33.3%",
  );
});
test("empty or entirely unscored histories have no win rate", () => {
  assert.equal(summarize([], 42).totals.matches, 0);
  const { totals } = summarize([match(1, 5)], 42);
  assert.equal(formatWinRate(totals.wins, totals.wins + totals.losses), "—");
});
test("rejects malformed and wrong-account histories", () => {
  for (const history of [
    null,
    {},
    [null],
    [match(1, 1, { account_id: 7 })],
    [match(1, 1, { start_time: null })],
  ]) {
    assert.throws(() => summarize(history, 42));
  }
});
test("accepts names, account IDs and losslessly converts SteamID64", () => {
  assert.equal(accountIdFromQuery("Shroud"), null);
  assert.equal(accountIdFromQuery("211776018"), 211776018);
  assert.equal(accountIdFromQuery("76561198172041746"), 211776018);
  assert.throws(() => accountIdFromQuery("0"));
  assert.throws(() => accountIdFromQuery("99999999999999999"));
});

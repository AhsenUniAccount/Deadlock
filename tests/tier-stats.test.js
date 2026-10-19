const test = require("node:test");
const assert = require("node:assert/strict");
const { rankHeroes } = require("../tier-stats.js");
const row = (hero_id, wins, losses, matches = wins + losses) => ({
  hero_id,
  wins,
  losses,
  matches,
});
test("orders heroes by unrounded win rate, then sample size and ID", () => {
  const ranked = rankHeroes(
    [row(2, 5, 5), row(1, 50, 50), row(3, 51, 49), row(4, 0, 10), row(5, 0, 0)],
    1,
  );
  assert.deepEqual(
    ranked.map((h) => h.id),
    [3, 1, 2, 4],
  );
  assert.equal(ranked[0].rate, 0.51);
});
test("minimum uses scored matches and unscored records do not affect win rate", () => {
  const ranked = rankHeroes([row(1, 6, 4, 100), row(2, 7, 5, 12)], 11);
  assert.deepEqual(
    ranked.map((h) => h.id),
    [2],
  );
  assert.equal(rankHeroes([row(1, 6, 4, 100)], 1)[0].rate, 0.6);
  assert.deepEqual(rankHeroes([], 1000), []);
});
test("rejects malformed, negative, inconsistent and duplicate statistics", () => {
  for (const data of [
    null,
    [null],
    [row(1, -1, 5)],
    [row(1, 5, 5, 9)],
    [row(1, 5, 5), row(1, 5, 5)],
  ])
    assert.throws(() => rankHeroes(data, 1));
});

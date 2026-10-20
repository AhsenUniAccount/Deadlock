import test from "node:test";
import assert from "node:assert/strict";
import PlayerPercentiles from "../public/js/core/player-percentiles.js";

const curve = { avg: 5, percentile1: 0, percentile5: 1, percentile10: 2, percentile25: 3, percentile50: 5, percentile75: 7, percentile90: 9, percentile95: 10, percentile99: 14 };

test("values are placed on the quantile curve by linear interpolation and clamped at the tails", () => {
  assert.deepEqual(PlayerPercentiles.percentileOf(5, curve), { value: 50, clamped: null });
  assert.deepEqual(PlayerPercentiles.percentileOf(6, curve), { value: 62.5, clamped: null });
  assert.deepEqual(PlayerPercentiles.percentileOf(20, curve), { value: 99, clamped: "high" });
  assert.deepEqual(PlayerPercentiles.percentileOf(-1, curve), { value: 1, clamped: "low" });
  assert.equal(PlayerPercentiles.percentileOf(NaN, curve), null);
  assert.equal(PlayerPercentiles.percentileOf(5, { ...curve, percentile50: null }), null);
});
test("lower-is-better metrics are flipped so the percentile always means 'better than'", () => {
  const rows = PlayerPercentiles.build({ kills: { avg: 9 }, deaths: { avg: 9 } }, { kills: curve, deaths: curve });
  const kills = rows.find((r) => r.key === "kills");
  const deaths = rows.find((r) => r.key === "deaths");
  assert.equal(kills.percentile, 90);
  assert.equal(kills.display, "Top 10%");
  assert.equal(kills.tone, "positive");
  assert.equal(deaths.percentile, 10);
  assert.equal(deaths.display, "Bottom 10%");
  assert.equal(deaths.tone, "negative");
});
test("metrics missing from either side are left out instead of shown as zero", () => {
  const rows = PlayerPercentiles.build({ kills: { avg: 5 } }, { kills: curve, assists: curve });
  assert.deepEqual(rows.map((r) => r.key), ["kills"]);
  assert.equal(rows[0].typical, "5.0");
  assert.equal(PlayerPercentiles.build({ deaths: { avg: 99 } }, { deaths: curve })[0].display, "Bottom 1%");
});

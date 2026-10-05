const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../analysis-stats.js");
const M = require("../match-stats.js");
const player = (slot, team, stats, extra = {}) => ({
  player_slot: slot,
  team,
  account_id: 100 + slot,
  hero_id: 1,
  kills: 0,
  deaths: 0,
  assists: 0,
  stats: stats.map(([time_stamp_s, net_worth]) => ({
    time_stamp_s,
    net_worth,
  })),
  death_details: [],
  ...extra,
});
const match = (players) =>
  M.summarizeMatch(
    { match_info: { match_id: 1, start_time: 1000, duration_s: 650, players } },
    1,
  );
test("team advantage uses simultaneous complete snapshots, including spent-souls decreases", () => {
  const m = match([
    player(0, 0, [
      [0, 100],
      [60, 300],
      [120, 200],
    ]),
    player(9, 1, [
      [0, 100],
      [120, 500],
    ]),
  ]);
  assert.deepEqual(A.advantage(m), [
    { time: 0, souls: 0 },
    { time: 120, souls: -300 },
  ]);
  m.players.push({ team: 0, soulSamples: [] });
  assert.deepEqual(A.advantage(m), []);
});
test("timed counts exclude untimed deaths and count boundary events once", () => {
  const m = match([
    player(0, 0, [], {
      death_details: [
        { game_time_s: 300, killer_player_slot: 9 },
        { killer_player_slot: 9 },
      ],
    }),
    player(9, 1, []),
  ]);
  assert.deepEqual(A.counts(m, m.players[0], 0, 300), { kills: 0, deaths: 1 });
  assert.deepEqual(A.counts(m, m.players[0], 300, 600), {
    kills: 0,
    deaths: 0,
  });
});
test("personal baseline excludes current/future games, other players and heroes and deduplicates", () => {
  const p = { accountId: 100, heroId: 1 },
    m = { id: 1, startTime: 1000 };
  const h = (id, start, extra = {}) => ({
    match_id: id,
    start_time: start,
    account_id: 100,
    hero_id: 1,
    ...extra,
  });
  assert.deepEqual(
    A.candidates(
      [
        h(1, 500),
        h(2, 900),
        h(2, 900),
        h(3, 1100),
        h(4, 800, { hero_id: 2 }),
        h(5, 700, { account_id: 101 }),
        h(6, 600),
      ],
      p,
      m,
    ).map((h) => h.match_id),
    [2, 6],
  );
});
test("first purchases keep time zero and ignore abilities, unknown items and missing times", () => {
  const catalog = new Map([
    [1, { type: "upgrade" }],
    [2, { type: "ability" }],
  ]);
  const p = {
    items: [
      { item_id: 1, game_time_s: 30 },
      { item_id: 1, game_time_s: 0 },
      { item_id: 2, game_time_s: 5 },
      { item_id: 3, game_time_s: 10 },
    ],
  };
  assert.deepEqual([...A.firstBuys(p, catalog)], [[1, 0]]);
  assert.equal(A.mean([null, undefined]), null);
  assert.equal(A.mean([null, 0, 20]), 10);
});

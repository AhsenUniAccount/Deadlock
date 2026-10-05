const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeMatch, killTimeline } = require("../match-stats.js");
const player = (slot, extra = {}) => ({
  player_slot: slot,
  account_id: 100 + slot,
  hero_id: 1 + slot,
  team: slot === 0 ? 0 : 1,
  kills: 0,
  deaths: 0,
  assists: 0,
  net_worth: 10000,
  death_details: [],
  ...extra,
});
const metadata = (players) => ({
  match_info: { match_id: 55, players, winning_team: 0 },
});

test("maps sparse player slots including zero to kills and deaths, not account IDs or array indexes", () => {
  const match = summarizeMatch(
    metadata([
      player(9, {
        deaths: 2,
        death_details: [{ killer_player_slot: 0 }, { killer_player_slot: 0 }],
      }),
      player(0, { kills: 2, assists: 7, net_worth: 43123 }),
      player(4),
    ]),
    55,
  );
  const events = killTimeline(match);
  assert.equal(events.length, 2);
  assert.ok(
    events.every((event) => event.killer.slot === 0 && event.victim.slot === 9),
  );
  assert.equal(match.players.find((p) => p.slot === 0).souls, 43123);
  assert.equal(match.players.find((p) => p.slot === 0).assists, 7);
  assert.equal(match.incomplete, false);
});
test("missing and partial death logs remain marked incomplete", () => {
  const match = summarizeMatch(
    metadata([
      player(0, { kills: 4 }),
      player(4, { deaths: 3, death_details: [{ killer_player_slot: 0 }] }),
      player(9, { deaths: 1, death_details: undefined }),
    ]),
    55,
  );
  assert.equal(killTimeline(match).length, 1);
  assert.equal(
    match.players.find((player) => player.slot === 4).deathsComplete,
    false,
  );
  assert.equal(
    match.players.find((player) => player.slot === 9).deathsComplete,
    false,
  );
  assert.equal(match.incomplete, true);
});
test("keeps unassigned killers and self-attributed deaths separate", () => {
  const match = summarizeMatch(
    metadata([
      player(0, {
        deaths: 3,
        death_details: [
          { killer_player_slot: 999 },
          { killer_player_slot: null },
          { killer_player_slot: 0 },
        ],
      }),
      player(9),
    ]),
    55,
  );
  assert.equal(
    killTimeline(match).filter((event) => event.killer === null).length,
    2,
  );
  assert.equal(
    killTimeline(match).filter(
      (event) => event.killer?.slot === event.victim.slot,
    ).length,
    1,
  );
});
test("missing totals remain unavailable while genuine zero values remain zero", () => {
  const match = summarizeMatch(
    metadata([
      player(0, { kills: null, net_worth: undefined }),
      player(9, { net_worth: 0 }),
    ]),
    55,
  );
  assert.equal(match.players[0].kills, null);
  assert.equal(match.players[0].souls, null);
  assert.equal(match.players[1].souls, 0);
});
test("rejects incorrect match IDs, duplicate slots, and malformed rosters", () => {
  assert.throws(() => summarizeMatch(metadata([player(0)]), 66));
  assert.throws(() => summarizeMatch(metadata([player(0), player(0)]), 55));
  for (const value of [null, {}, metadata([]), metadata([null])])
    assert.throws(() => summarizeMatch(value, 55));
});

test("purchases omit abilities, retain repeat buys, preserve time zero and removal times", () => {
  const { purchases } = require("../match-stats.js");
  const catalog = new Map([
    [1, { type: "upgrade" }],
    [2, { type: "ability" }],
  ]);
  const entries = [
    { item_id: 1, game_time_s: 100, sold_time_s: 200 },
    { item_id: 2, game_time_s: 10 },
    { item_id: 1, game_time_s: 0, sold_time_s: 0 },
    { item_id: 999, game_time_s: 20 },
  ];
  assert.deepEqual(purchases({ items: entries }, catalog), [
    { id: 1, bought: 0, removed: null },
    { id: 1, bought: 100, removed: 200 },
  ]);
  assert.equal(purchases({ items: null }, catalog), null);
  assert.deepEqual(purchases({ items: [] }, catalog), []);
});

test("souls timeline sorts snapshots, preserves decreases and zeroes, and excludes invalid samples", () => {
  const { soulSamples } = require("../match-stats.js");
  assert.deepEqual(
    soulSamples(
      [
        { time_stamp_s: 120, net_worth: 3000 },
        { time_stamp_s: 0, net_worth: 0 },
        { time_stamp_s: 60, net_worth: 3500 },
        { time_stamp_s: 120, net_worth: 3200 },
        { time_stamp_s: 180, net_worth: null },
        { time_stamp_s: 400, net_worth: 6000 },
        { time_stamp_s: -1, net_worth: 100 },
        null,
      ],
      200,
    ),
    [
      { time: 0, souls: 0 },
      { time: 60, souls: 3500 },
      { time: 120, souls: 3200 },
    ],
  );
  assert.deepEqual(soulSamples(null, 200), []);
});

test("match MVPs use only API ranks across both teams, never calculated KDA", () => {
  const { matchMvps } = require("../match-stats.js");
  const match = summarizeMatch(
    metadata([
      player(0, { mvp_rank: 3 }),
      player(1, { mvp_rank: 1 }),
      player(2, { mvp_rank: 2 }),
      player(3, { kills: 100, mvp_rank: null }),
      player(4, { mvp_rank: 0 }),
      player(5, { mvp_rank: 4 }),
    ]),
    55,
  );
  assert.deepEqual(
    matchMvps(match.players).map((p) => p.slot),
    [1, 2, 0],
  );
  assert.deepEqual(
    matchMvps(summarizeMatch(metadata([player(0)]), 55).players),
    [],
  );
});

test("kill timeline orders deaths by game time, resolves sparse slots and retains unknown sources and times", () => {
  const { killTimeline } = require("../match-stats.js");
  const data = metadata([
    player(9, {
      death_details: [
        { game_time_s: 80, killer_player_slot: 0 },
        { game_time_s: 0, killer_player_slot: 99 },
        { killer_player_slot: 0 },
      ],
    }),
    player(0, {
      death_details: [
        { game_time_s: 20, killer_player_slot: 0 },
        { game_time_s: 999, killer_player_slot: 9 },
        null,
      ],
    }),
  ]);
  data.match_info.duration_s = 100;
  const events = killTimeline(summarizeMatch(data, 55));
  assert.deepEqual(
    events.map((e) => [e.time, e.killer?.slot ?? null, e.victim.slot]),
    [
      [0, null, 9],
      [20, 0, 0],
      [80, 0, 9],
      [null, 9, 0],
      [null, 0, 9],
    ],
  );
  assert.deepEqual(killTimeline(summarizeMatch(metadata([player(0)]), 55)), []);
});

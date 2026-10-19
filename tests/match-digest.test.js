import test from "node:test";
import assert from "node:assert/strict";
import M from "../match-stats.js";
import MatchDigest from "../match-digest.js";

const snapshots = (rows) =>
  rows.map(([time_stamp_s, net_worth, gold_death_loss = 0]) => ({
    time_stamp_s,
    net_worth,
    gold_death_loss,
    player_damage: net_worth / 2,
  }));
const player = (slot, team, lane, stats, extra = {}) => ({
  player_slot: slot,
  team,
  account_id: 100 + slot,
  hero_id: slot,
  assigned_lane: lane,
  kills: 0,
  deaths: 0,
  assists: 0,
  net_worth: stats.at(-1)[1],
  stats: snapshots(stats),
  death_details: [],
  ...extra,
});
const heroes = new Map([1, 2, 3, 4].map((id) => [id, { name: `Hero${id}` }]));
const items = new Map([
  [50, { name: "Monster Rounds", type: "upgrade", item_slot_type: "weapon", item_tier: 1, cost: 800 }],
  [60, { name: "Ability point", type: "ability" }],
]);
function fixture() {
  return M.summarizeMatch(
    {
      match_info: {
        match_id: 9,
        duration_s: 900,
        winning_team: 1,
        players: [
          player(1, 0, 4, [[300, 3000], [900, 9000]], {
            deaths: 1,
            death_details: [{ game_time_s: 700, killer_player_slot: 3, death_duration_s: 30 }],
            items: [
              { item_id: 50, game_time_s: 120, sold_time_s: 0 },
              { item_id: 60, game_time_s: 10, sold_time_s: 0 },
            ],
          }),
          player(2, 0, 1, [[300, 2000], [900, 8000]]),
          player(3, 1, 4, [[300, 4000], [900, 12000]], { kills: 1 }),
          player(4, 1, 1, [[300, 2500]]),
        ],
        objectives: [{ team_objective_id: 1, team: 0, destroyed_time_s: 710 }],
        mid_boss: [{ destroyed_time_s: 800, team_claimed: 1 }],
      },
    },
    9,
  );
}

test("digest is relative to the focus player, with lane opponents from assigned_lane", () => {
  const digest = MatchDigest.build(fixture(), { heroes, items }, 1);
  assert.equal(digest.match.result, "loss");
  assert.equal(digest.match.yourTeam, "The Hidden King");
  assert.deepEqual(digest.you.laneOpponents, ["Hero3"]);
  assert.deepEqual(digest.you.lanePartners, []);
  assert.equal(digest.you.finalSoulsRankInLobby, 2);
  assert.deepEqual(
    digest.roster.map((p) => p.side),
    ["you", "ally", "enemy", "enemy"],
  );
});
test("checkpoints use exact shared snapshots and flip the team lead to the focus side", () => {
  const [early, late] = MatchDigest.build(fixture(), { heroes, items }, 1).checkpoints;
  // (3000 + 2000) - (4000 + 2500): every player has a 300 s snapshot.
  assert.equal(early.teamSoulsLead, -1500);
  assert.equal(early.soulsVsLaneOpponentsAverage, -1000);
  assert.equal(early.soulsRankInLobby, 2);
  // One player has no 900 s snapshot, so the team lead is unavailable rather than partial.
  assert.equal(late.teamSoulsLead, null);
  assert.equal(late.playersWithSnapshot, 3);
  assert.equal(late.playerDamage, 4500);
});
test("deaths, objectives and purchases carry times without inventing missing facts", () => {
  const digest = MatchDigest.build(fixture(), { heroes, items }, 1);
  assert.deepEqual(digest.deaths, [
    {
      timeS: 700,
      killedBy: "Hero3 [enemy]",
      deadForS: 30,
      teamSoulsLeadAtPreviousSnapshot: -1500,
      previousSnapshotS: 300,
    },
  ]);
  assert.deepEqual(digest.objectives, [
    { timeS: 710, type: "Guardian", destroyed: "your team's structure", youWereDead: true },
    { timeS: 800, type: "Mid Boss", claimedBy: "enemy team", youWereDead: false },
  ]);
  // Ability unlocks are not shop purchases.
  assert.deepEqual(digest.purchases, [
    { timeS: 120, item: "Monster Rounds", category: "weapon", tier: 1, cost: 800, soldOrReplacedS: null },
  ]);
  assert.deepEqual(
    digest.phases.map((p) => [p.phase, p.yourDeaths, p.teamKills]),
    [
      ["laning (0-10 min)", 0, 0],
      ["mid game (10-20 min)", 1, 0],
    ],
  );
});
test("perspective from the other team mirrors results and the lead", () => {
  const digest = MatchDigest.build(fixture(), { heroes, items }, 3);
  assert.equal(digest.match.result, "win");
  assert.equal(digest.checkpoints[0].teamSoulsLead, 1500);
  assert.deepEqual(digest.kills, [{ timeS: 700, victim: "Hero1 [enemy]" }]);
  assert.equal(digest.objectives[0].destroyed, "enemy structure");
});
test("unknown death durations make 'was dead' unavailable, and bad slots are rejected", () => {
  const match = fixture();
  match.players[0].events[0].death_duration_s = undefined;
  const digest = MatchDigest.build(match, { heroes, items }, 1);
  assert.equal(digest.objectives[0].youWereDead, null);
  assert.match(digest.dataQuality.notes.join(" "), /youWereDead/);
  assert.throws(() => MatchDigest.build(match, { heroes, items }, 42), /not in this match/);
});

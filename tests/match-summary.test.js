import test from "node:test";
import assert from "node:assert/strict";
import MatchSummary from "../match-summary.js";

// Digest-shaped input; each test overrides only the fields its rule reads.
const checkpoint = (timeS, extra = {}) => ({
  timeS,
  souls: 1000,
  soulsRankInLobby: 3,
  playersWithSnapshot: 12,
  teamSoulsLead: null,
  soulsVsLaneOpponentsAverage: null,
  laneSoulsLead: null,
  soulsFrom: { players: null, laneCreeps: null, neutrals: null, bosses: null },
  ...extra,
});
function digest(overrides = {}) {
  return {
    match: { durationS: 1800, result: "loss", ...overrides.match },
    you: {
      hero: "Haze",
      lanePartners: ["Venator"],
      laneOpponents: ["Ivy", "Billy"],
      kills: 3,
      deaths: 2,
      assists: 4,
      finalSoulsRankInLobby: 2,
      finalSoulsRankOnTeam: 3,
      mvpRank: null,
      ...overrides.you,
    },
    roster: overrides.roster || [
      { side: "you", kills: 3 },
      { side: "ally", kills: 5 },
      { side: "enemy", kills: 9 },
    ],
    checkpoints: overrides.checkpoints || [],
    phases: overrides.phases || [{ phase: "laning (0-10 min)", yourDeaths: 0 }],
    deaths: overrides.deaths || [],
    objectives: overrides.objectives || [],
  };
}
const titles = (summary) => summary.points.map((p) => p.title);

test("headline states result, hero, K/D/A and souls rank", () => {
  assert.equal(MatchSummary.build(digest()).headline, "Loss as Haze · 3/2/4 · 2nd of 3 in souls");
});
test("lane verdict uses lane totals at the last snapshot within ten minutes", () => {
  const summary = MatchSummary.build(
    digest({
      checkpoints: [
        checkpoint(540, { laneSoulsLead: -900, soulsVsLaneOpponentsAverage: 200 }),
        checkpoint(720, { laneSoulsLead: 5000 }),
      ],
    }),
  );
  const [lane] = summary.points;
  assert.equal(lane.title, "Lost your lane");
  assert.equal(lane.tone, "negative");
  assert.equal(lane.timeS, 540);
  assert.match(lane.detail, /your lane \(you and Venator\) had 900 souls fewer than Ivy and Billy/);
  assert.match(lane.detail, /You personally had 200 more than the average of Ivy and Billy/);
});
test("missing lane data produces no lane point rather than a guess", () => {
  const summary = MatchSummary.build(digest({ checkpoints: [checkpoint(540)] }));
  assert.ok(!titles(summary).some((t) => /lane/i.test(t)));
});
test("a lost lead and a comeback are reported from the player's side", () => {
  const swings = [checkpoint(300, { teamSoulsLead: 2500 }), checkpoint(900, { teamSoulsLead: -4000 })];
  assert.match(
    MatchSummary.build(digest({ checkpoints: swings })).points[0].detail,
    /led by 2,500 souls at 5:00, but trailed by 4,000 at 15:00/,
  );
  const comeback = [checkpoint(300, { teamSoulsLead: -3000 }), checkpoint(900, { teamSoulsLead: 1000 })];
  assert.deepEqual(titles(MatchSummary.build(digest({ match: { result: "win" }, checkpoints: comeback }))), [
    "Came back from behind",
  ]);
});
test("deaths: time dead, clustering and structures lost while respawning", () => {
  const summary = MatchSummary.build(
    digest({
      you: { deaths: 3 },
      deaths: [{ deadForS: 60 }, { deadForS: 70 }, { deadForS: 70 }],
      phases: [
        { phase: "laning (0-10 min)", yourDeaths: 0 },
        { phase: "late game (20+ min)", yourDeaths: 3 },
      ],
      objectives: [
        { timeS: 1500, type: "Walker", destroyed: "your team's structure", youWereDead: true },
        { timeS: 1510, type: "Guardian", destroyed: "enemy structure", youWereDead: true },
        { timeS: 1600, type: "Shrine", destroyed: "your team's structure", youWereDead: null },
      ],
    }),
  );
  assert.deepEqual(titles(summary), [
    "Time spent dead",
    "Deaths clustered in one phase",
    "Structures fell while you were dead",
  ]);
  assert.match(summary.points[0].detail, /3:20 across 3 deaths, 11% of the match/);
  assert.match(summary.points[2].detail, /lost Walker at 25:00 while/);
});
test("unknown respawn durations omit the time-dead point; zero deaths is a strength", () => {
  const unknown = MatchSummary.build(digest({ deaths: [{ deadForS: 30 }, { deadForS: null }] }));
  assert.ok(!titles(unknown).includes("Time spent dead"));
  assert.deepEqual(titles(MatchSummary.build(digest({ you: { deaths: 0 } }))), ["No deaths"]);
});
test("top kills on the team are compared with souls, and MVP and souls sources are listed", () => {
  const summary = MatchSummary.build(
    digest({
      you: { kills: 9, finalSoulsRankOnTeam: 5, mvpRank: 2 },
      roster: [
        { side: "you", kills: 9 },
        { side: "ally", kills: 2 },
      ],
      checkpoints: [
        checkpoint(1800, { soulsFrom: { players: 1000, laneCreeps: 3000, neutrals: 0, bosses: 0 } }),
      ],
    }),
  );
  assert.deepEqual(titles(summary), ["Kills did not turn into souls", "Match MVP #2", "Where your souls came from"]);
  assert.match(summary.points.at(-1).detail, /lane creeps 75%, kills on players 25%\.$/);
});
test("plain-text summary lists each point and ends with the link", () => {
  const text = MatchSummary.toText(
    { headline: "Win as Haze", points: [{ title: "Won your lane", detail: "Up 900 souls." }] },
    "https://example.test/match?id=1",
  );
  assert.equal(text, "Win as Haze\n• Won your lane: Up 900 souls.\nhttps://example.test/match?id=1");
});

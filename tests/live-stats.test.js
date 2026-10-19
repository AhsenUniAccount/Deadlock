import { test } from "node:test";
import assert from "node:assert/strict";
import S from "../live-stats.js";
import D from "../live-data.js";

const population = { rate: .5, n: 1000, matches: 1000, kills: 6, assists: 8, deaths: 6, rankAdjusted: true };
const game = (id, overrides = {}) => ({ match_id: id, start_time: id * 100, match_duration_s: 60, game_mode: 1, match_mode: 4, hero_id: 1, player_match_outcome: 1, player_kills: 5, player_deaths: 4, player_assists: 6, ...overrides });

test("roster validates account/team, deduplicates and retains unknown heroes", () => {
  assert.deepEqual(S.roster([{ account_id: 1, hero_id: 3, team: 0 }, { account_id: 1, team: 1 }, { account_id: 2, team: 1 }, { account_id: 3, team: 9 }, { account_id: 0, team: 0 }]), [
    { accountId: 1, heroId: 3, team: 0 }, { accountId: 2, heroId: null, team: 1 },
  ]);
});
test("rank percentiles use unequal population counts and preserve unknown badges", () => {
  const rows = [{ badge: 11, players: 80 }, { badge: 81, players: 15 }, { badge: 116, players: 5 }];
  assert.equal(S.percentile(81, rows), 87.5);
  assert.equal(S.percentile(82, rows), null);
  assert.equal(S.percentile(null, rows), null);
  assert.equal(S.percentile(0, rows), null);
});
test("hero population is restricted to the selected hero and rank tier", () => {
  const rows = [{ hero_id: 1, bucket: 81, wins: 20, losses: 10, matches: 30 }, { hero_id: 1, bucket: 91, wins: 1, losses: 19, matches: 20 }];
  assert.equal(S.baseline(rows, 1, 86).rate, 2 / 3);
  assert.equal(S.baseline(rows, 1).n, 50);
  assert.equal(S.baseline(rows, 2), null);
  assert.equal(S.baseline(rows, 1, 81).kills, null);
});
test("recent form excludes current, future, unfinished, duplicate, unscored and wrong-mode games", () => {
  const rows = [game(1), game(2), game(3), game(4), game(4), game(5), game(6, { player_match_outcome: 5 }), game(7, { match_mode: 1 }), game(8, { match_duration_s: 1000 }), game(11)];
  assert.deepEqual(S.recentGames(rows, 1000, 4, 5).map((g) => g.match_id), [4, 3, 2]);
});
test("unknown queue combines ranked/unranked only, rather than including private or bot games", () => {
  assert.deepEqual(S.recentGames([game(1, { match_mode: 2 }), game(2, { match_mode: 1 }), game(3, { match_mode: 3 }), game(4)], 1000, null, 99).map((g) => g.match_id), [4, 2]);
});
test("small samples shrink toward the baseline rather than appearing perfect", () => {
  assert.ok(S.shrink(3, 3, .5).rate < .6);
  assert.ok(S.shrink(90, 100, .5).rate > .8);
  assert.equal(S.shrink(0, 0, .5), null);
  assert.equal(S.shrink(5, 3, .5), null);
});
test("rank-only evidence cannot produce a top-three threat recommendation", () => {
  const s = S.scout({ rankPercentile: 90, friendlyPercentiles: [30, 40, 50] });
  assert.equal(s.eligible, false);
  assert.equal(s.heroMatches, 0);
  assert.equal(s.components[0].effectiveWeight, 1);
  assert.equal(S.scout({}).score, null);
});
test("missing components are renormalized; missing form does not become a loss", () => {
  const s = S.scout({ hero: { matches_played: 30, wins: 20 }, population, games: [game(1)] });
  assert.equal(s.components.length, 1);
  assert.equal(s.components[0].effectiveWeight, 1);
  assert.equal(s.eligible, true);
  assert.equal(s.quality, "Limited evidence");
});
test("three-game form is shrunk and requires matching population evidence", () => {
  const s = S.scout({ hero: { matches_played: 30, wins: 15 }, population, games: [game(1), game(2), game(3)], formPopulations: [population, null, population] });
  assert.equal(s.form.length, 2);
  assert.ok(Math.abs(s.components.find((c) => c.name === "Recent form").score - 50) < 10);
});
test("sparse stream updates preserve zero and ignore older observations", () => {
  const stream = new S.StreamState();
  stream.apply({ kind: "player", tick: 100, entity_index: 1, account_id: 42, team: 2, hero_id: 3, souls: 10, kills: 5 }, 1000);
  stream.apply({ kind: "player", tick: 101, entity_index: 1, souls: 0, kills: null }, 1100);
  stream.apply({ kind: "player", tick: 99, entity_index: 1, souls: 999 }, 1200);
  assert.equal(stream.players.get(42).souls, 0);
  assert.equal(stream.players.get(42).kills, 5);
  assert.equal(stream.players.get(42).receivedAt, 1100);
  stream.apply({ kind: "player", tick: 98, entity_index: 2, account_id: 42, team: 2, souls: 500 }, 1300);
  assert.equal(stream.players.get(42).souls, 0);
});
test("spectators are excluded and deletion removes only the owning entity", () => {
  const stream = new S.StreamState();
  stream.apply({ kind: "player", tick: 1, entity_index: 1, account_id: 1, team: 1 });
  assert.equal(stream.players.size, 0);
  stream.apply({ kind: "player", tick: 2, entity_index: 2, account_id: 2, team: 2 });
  stream.apply({ kind: "player", tick: 3, entity_index: 3, account_id: 2, team: 2 });
  stream.apply({ kind: "player", tick: 4, entity_index: 2, delta_type: "delete" });
  assert.equal(stream.players.size, 1);
});
test("focus plan refuses unsupported edges and accepts an explicit manual choice", () => {
  const friends = [{ accountId: 1, heroId: 1 }], opponents = [{ accountId: 2, heroId: 2 }];
  const populations = new Map([[1, population], [2, population]]);
  assert.equal(S.focusPlan(friends, opponents, [], populations)[0].primary, null);
  assert.equal(S.focusPlan(friends, opponents, [{ hero_id: 1, enemy_hero_id: 2, wins: 51, matches_played: 100 }], populations)[0].primary, null);
  assert.equal(S.focusPlan(friends, opponents, [{ hero_id: 1, enemy_hero_id: 2, wins: 800, matches_played: 1000 }], populations)[0].primary.opponent.accountId, 2);
  assert.equal(S.focusPlan(friends, opponents, [], populations, new Map([[1, 2]]))[0].primary.manual, true);
});
test("item recommendations reject unavailable, owned, hero-restricted and low-sample items", () => {
  const catalog = new Map([1, 2, 3, 4, 5].map((id) => [id, { id, type: "upgrade", shopable: true, heroes: [] }]));
  catalog.get(3).shopable = false; catalog.get(4).heroes = [99]; catalog.get(5).disabled = true;
  const rows = [1, 2, 3, 4, 5, 6].map((id) => ({ item_id: id, matches: 100, players: 20, wins: 60, losses: 40, avg_buy_time_s: null }));
  const result = S.itemCandidates(rows, catalog, 1, new Set([2]));
  assert.deepEqual(result.map((r) => r.item_id), [1]);
  assert.equal(result[0].timing, null);
});
test("SSE parser handles named error events and multiline data", () => {
  assert.deepEqual(D.parseFrame('event: error\r\ndata: {"status":400,\r\ndata: "error":"bad query"}'), { event: "error", data: { status: 400, error: "bad query" } });
  assert.equal(D.parseFrame(": heartbeat"), null);
});
test("stream handles arbitrary frame boundaries and surfaces HTTP-200 error events", async (t) => {
  const encoder = new TextEncoder();
  t.mock.method(global, "fetch", async () => new Response(new ReadableStream({ start(controller) {
    ['data: {"kind":"player",', '"tick":1}\n', '\nevent: error\ndata: {"status":400,"error":"schema changed"}\n\n'].forEach((x) => controller.enqueue(encoder.encode(x))); controller.close();
  } }), { headers: { "content-type": "text/event-stream" } }));
  const rows = [];
  await assert.rejects(() => D.stream("https://example.invalid", new AbortController().signal, (row) => rows.push(row)), (error) => error.status === 400 && /not supported/.test(error.message) && !error.message.includes("schema changed"));
  assert.equal(rows.length, 1);
});
test("scope is before the current match, uses calendar-date proxy, and excludes current ID", () => {
  const start = Date.UTC(2026, 9, 15) / 1000;
  const scope = D.scopeFor({ start_time: start, match_mode: 4 }, [{ title: "09-29-2026", pub_date: "2026-10-15T03:12:00Z" }], start + 100);
  assert.equal(scope.end, start - 7200);
  assert.equal(scope.patch, Date.UTC(2026, 8, 29) / 1000);
  const params = D.paramsFor({ match_id: 100 }, scope);
  assert.equal(params.get("max_match_id"), "99");
});

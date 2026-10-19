// Read-only retrospective diagnostic. No credentials; run with explicit completed match IDs.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import S from "../live-stats.js";
import D from "../live-data.js";
import { API_BASE } from "../common.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(os.tmpdir(), "deadlock-scout-backtest");
let networkRequests = 0;
const diskRequest = async (endpoint, signal) => {
  const name = path.join(cacheDir, crypto.createHash("sha256").update(endpoint).digest("hex") + ".json");
  try { return JSON.parse(await fs.readFile(name, "utf8")); } catch {}
  networkRequests++;
  const response = await fetch(`${API_BASE}${endpoint}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  if (!response.ok) { const e = new Error(`HTTP ${response.status}: ${endpoint.split("?")[0]}`); e.status = response.status; e.retryAfter = Number(response.headers.get("retry-after")) || null; throw e; }
  const result = { data: await response.json(), fetchedAt: new Date().toISOString() };
  await fs.writeFile(name, JSON.stringify(result));
  return result;
};
D.useTransport(diskRequest);
const mean = S.average;
const dcg = (order, truths) => order.reduce((sum, p, i) => sum + (truths.get(p.accountId) || 0) / Math.log2(i + 2), 0);

async function main() {
  const ids = process.argv.slice(2).map(Number);
  if (!ids.length || ids.length > 10 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Usage: node scripts/backtest-live.mjs MATCH_ID [MATCH_ID ...] (1–10 completed normal games)");
  await fs.mkdir(cacheDir, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), model: "scouting-v0.1", weights: [.5, .3, .2],
    purpose: "Small retrospective smoke backtest, not model validation or causal evidence.",
    target: "Top three opponents by post-match log KDA residual against the same-hero, rank-band population. This is a performance proxy, not ground truth danger.",
    calibrationTarget: "Adjusted historical hero win-rate component versus the eventual match result. The combined scouting index is not a probability and has no probability calibration.",
    caveats: ["Small selected sample; players and outcomes within a match are correlated.", "Retrospective aggregates can contain late-ingested records that were not available at the time.", "Rank distribution and all aggregate features are bounded before the target match; current rank is rejected when it is from a later match.", "Patch calendar-date windows do not establish exact client-version coverage.", "No tuning or validation claim is justified by this diagnostic."], matches: [], rankings: [], calibration: [], failures: [] };
  for (const id of ids) {
    const signal = AbortSignal.timeout(240000);
    try {
      const raw = (await diskRequest(`/v1/matches/${id}/metadata`, signal)).data.match_info;
      if (!raw || raw.match_id !== id || ![0, 1].includes(raw.winning_team) || !raw.start_time || raw.players?.length !== 12) throw new Error("Missing completed 12-player metadata.");
      if (raw.game_mode !== 1 || ![1, 4].includes(raw.match_mode)) throw new Error("Backtest requires verified ranked/unranked normal mode.");
      const match = { match_id: id, start_time: raw.start_time, match_mode: raw.match_mode };
      const players = S.roster(raw.players.map((p) => ({ account_id: p.account_id, hero_id: p.hero_id, team: p.team })));
      const context = await D.scouting(match, players, signal);
      const populations = new Map();
      for (const p of players) {
        p.percentile = S.percentile(context.ranks.get(p.accountId)?.badge, context.distribution);
        populations.set(p.accountId, S.baseline(context.populationRows, p.heroId, context.ranks.get(p.accountId)?.badge));
      }
      for (const p of players) {
        const rank = context.ranks.get(p.accountId)?.badge;
        const games = S.recentGames(context.histories.get(p.accountId), raw.start_time, match.match_mode, id);
        p.scouting = S.scout({ hero: context.playerHeroes.get(`${p.accountId}:${p.heroId}`), population: populations.get(p.accountId), rankPercentile: p.percentile,
          friendlyPercentiles: players.filter((f) => f.team !== p.team).map((f) => f.percentile), games,
          formPopulations: games.map((g) => S.baseline(context.formRows.get(g.match_duration_s <= 7000 ? Math.floor(g.match_duration_s / 600) * 600 : null), g.hero_id, rank)) });
        if (p.scouting.estimate) report.calibration.push({ matchId: id, prediction: p.scouting.estimate.rate, outcome: p.team === raw.winning_team ? 1 : 0 });
      }
      for (const team of [0, 1]) {
        const opponents = players.filter((p) => p.team !== team);
        const performance = opponents.flatMap((p) => {
          const final = raw.players.find((r) => r.account_id === p.accountId), b = populations.get(p.accountId);
          if (!b || [final.kills, final.assists, final.deaths, b.kills, b.assists, b.deaths].some((v) => S.number(v) === null)) return [];
          return [{ accountId: p.accountId, residual: Math.log((final.kills + final.assists + 2) / (final.deaths + 1)) - Math.log((b.kills + b.assists + 2) / (b.deaths + 1)) }];
        }).sort((a, b) => b.residual - a.residual);
        const predicted = opponents.filter((p) => p.scouting.eligible).sort((a, b) => b.scouting.score - a.scouting.score).slice(0, 3);
        if (performance.length !== 6 || predicted.length !== 3) { report.failures.push({ matchId: id, team, reason: "Insufficient complete truth proxy or three eligible predictions." }); continue; }
        const truths = new Map(performance.map((p, i) => [p.accountId, 6 - i]));
        const realTop = new Set(performance.slice(0, 3).map((p) => p.accountId));
        report.rankings.push({ matchId: id, friendlyTeam: team,
          precisionAt3: predicted.filter((p) => realTop.has(p.accountId)).length / 3,
          ndcgAt3: dcg(predicted, truths) / dcg(performance.slice(0, 3), truths), eligibleOpponents: opponents.filter((p) => p.scouting.eligible).length });
      }
      report.matches.push({ id, startTime: raw.start_time, scoredPlayers: players.filter((p) => p.scouting.eligible).length, unavailableRequests: context.errors.length });
      console.log(`Checked ${id}: ${players.filter((p) => p.scouting.eligible).length}/12 eligible players; ${context.errors.length} unavailable sources.`);
    } catch (e) { report.failures.push({ matchId: id, reason: e.message }); }
  }
  const bins = [[0, .4], [.4, .5], [.5, .6], [.6, 1.01]];
  report.summary = { completedMatches: report.matches.length, rankingComparisons: report.rankings.length,
    meanPrecisionAt3: mean(report.rankings.map((r) => r.precisionAt3)), randomPrecisionAt3: .5,
    meanNdcgAt3: mean(report.rankings.map((r) => r.ndcgAt3)), calibrationObservations: report.calibration.length,
    heroWinRateBrier: mean(report.calibration.map((r) => (r.prediction - r.outcome) ** 2)), constantHalfBrier: .25,
    reliabilityBins: bins.map(([lo, hi]) => { const rows = report.calibration.filter((r) => r.prediction >= lo && r.prediction < hi); return { range: [lo, Math.min(hi, 1)], n: rows.length, predicted: mean(rows.map((r) => r.prediction)), observed: mean(rows.map((r) => r.outcome)) }; }), networkRequests };
  const target = path.join(here, "../docs/live-backtest-results.json");
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.summary, null, 2));
  if (!report.matches.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });

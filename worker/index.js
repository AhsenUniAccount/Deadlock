import DeadlockMatchStats from "../match-stats.js";
import MatchDigest from "../match-digest.js";
import { request } from "../common.js";
import { analyzeDigest, providerConfig, AnalysisError, PROMPT_VERSION } from "./analyze.js";

// Site Worker: static pages are served from assets; /api/* routes run here.
// The Worker fetches match data itself, so clients only choose a match and a
// player and can never supply text that reaches the model.
const CACHE_TTL_S = 180 * 24 * 3600; // Completed matches never change.
const CATALOG_TTL_MS = 3600000;
// New reviews per UTC day across all visitors. About 25 Workers AI reviews fit
// in Cloudflare's free daily allowance; raise it only if you accept charges.
const DEFAULT_DAILY_LIMIT = 25;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

// The asset catalogs are several megabytes; keep only the fields the digest needs.
let catalogs = null;
async function loadCatalogs(signal) {
  if (catalogs && catalogs.expires > Date.now()) return catalogs.value;
  const [heroes, items] = await Promise.all([
    request("/v1/assets/heroes", signal, CATALOG_TTL_MS),
    request("/v1/assets/items", signal, CATALOG_TTL_MS),
  ]);
  const value = {
    heroes: new Map(heroes.data.map((h) => [h.id, { name: h.name }])),
    items: new Map(
      items.data.map((i) => [
        i.id,
        { name: i.name, type: i.type, item_slot_type: i.item_slot_type, item_tier: i.item_tier, cost: i.cost },
      ]),
    ),
  };
  catalogs = { value, expires: Date.now() + CATALOG_TTL_MS };
  return value;
}

function parseTarget(matchId, slot) {
  const id = String(matchId ?? "");
  if (!/^\d{1,15}$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)
    throw new AnalysisError("A valid match ID is required.", 400);
  if (!Number.isInteger(slot) || slot < 0 || slot > 63)
    throw new AnalysisError("A valid player slot is required.", 400);
  return { matchId: Number(id), slot };
}

async function loadDigest({ matchId, slot }, signal) {
  let metadata;
  try {
    metadata = (await request(`/v1/matches/${matchId}/metadata`, signal, 1800000, false, true)).data;
  } catch (error) {
    if (error.status === 404) throw new AnalysisError("Detailed data for this match is not available yet.", 404);
    throw new AnalysisError("The Deadlock API could not provide this match. Try again later.");
  }
  const info = metadata?.match_info;
  if (info?.game_mode !== 1)
    throw new AnalysisError("AI review currently supports standard 6v6 matches only.", 422);
  let match;
  try {
    match = DeadlockMatchStats.summarizeMatch(metadata, matchId);
  } catch (error) {
    throw new AnalysisError(error.message);
  }
  if (![0, 1].includes(match.winningTeam) || !Number.isFinite(match.duration))
    throw new AnalysisError("This match has no final result yet, so it cannot be reviewed.", 422);
  let names;
  try {
    names = await loadCatalogs(signal);
  } catch {
    throw new AnalysisError("Hero and item names are unavailable right now. Try again later.");
  }
  try {
    return MatchDigest.build(match, names, slot);
  } catch (error) {
    throw new AnalysisError(error.message, 400);
  }
}

async function handleDigest(url, signal) {
  const slot = url.searchParams.get("slot") ?? "";
  const target = parseTarget(url.searchParams.get("match"), /^\d+$/.test(slot) ? Number(slot) : NaN);
  return json({ digest: await loadDigest(target, signal) });
}

async function handleAnalyze(req, env, signal) {
  const body = await req.json().catch(() => null);
  const target = parseTarget(body?.matchId, body?.slot);
  const { provider, model } = providerConfig(env);
  const key = `review:p${PROMPT_VERSION}:d${MatchDigest.VERSION}:${provider}:${model}:${target.matchId}:${target.slot}`;
  const cached = await env.ANALYSIS_CACHE?.get(key, "json");
  if (cached) return json({ ...cached, cached: true });

  // Only uncached reviews cost money, so only they count against the limit.
  if (env.ANALYSIS_LIMITER) {
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.ANALYSIS_LIMITER.limit({ key: ip });
    if (!success) throw new AnalysisError("Too many new reviews requested. Wait a minute and try again.", 429);
  }
  // A site-wide daily cap keeps total usage inside the free allowance (or a
  // chosen budget). The KV counter is approximate under concurrent requests.
  const limit = Number(env.DAILY_REVIEW_LIMIT ?? DEFAULT_DAILY_LIMIT);
  const usageKey = `usage:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((await env.ANALYSIS_CACHE?.get(usageKey)) ?? 0);
  if (used >= limit)
    throw new AnalysisError("Today's free AI reviews are used up. Try again after 00:00 UTC.", 429);

  const digest = await loadDigest(target, signal);
  const result = await analyzeDigest(digest, { env, signal });
  await env.ANALYSIS_CACHE?.put(usageKey, String(used + 1), { expirationTtl: 2 * 24 * 3600 });
  const record = {
    matchId: target.matchId,
    slot: target.slot,
    analysis: result.analysis,
    digest,
    model: result.model,
    promptVersion: PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
  };
  console.log("review generated", target.matchId, target.slot, result.model, JSON.stringify(result.usage));
  await env.ANALYSIS_CACHE?.put(key, JSON.stringify(record), { expirationTtl: CACHE_TTL_S });
  return json({ ...record, cached: false });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (url.pathname === "/api/digest" && req.method === "GET") return await handleDigest(url, req.signal);
      if (url.pathname === "/api/analyze" && req.method === "POST") return await handleAnalyze(req, env, req.signal);
      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof AnalysisError) return json({ error: error.message }, error.status);
      console.error("Unhandled API error", error);
      return json({ error: "Something went wrong. Try again later." }, 500);
    }
  },
};

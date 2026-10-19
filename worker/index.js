import DeadlockMatchStats from "../match-stats.js";
import MatchDigest from "../match-digest.js";
import MatchSummary from "../match-summary.js";
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

// Link-preview crawlers. Only these get per-match tags, so normal page views
// never trigger an extra metadata download.
const PREVIEW_BOTS =
  /discordbot|twitterbot|facebookexternalhit|slackbot|telegrambot|whatsapp|linkedinbot|redditbot|embedly|skypeuripreview|mastodon|iframely|bluesky|googlebot|bingbot/i;
const PREVIEW_VERSION = "2";
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const escapeAttr = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Title and description for a match link: the player's summary when the link
// names a player in the match, otherwise the result and MVPs.
async function previewTags(matchId, accountId, signal) {
  const metadata = (await request(`/v1/matches/${matchId}/metadata`, signal, 1800000, false, true)).data;
  const match = DeadlockMatchStats.summarizeMatch(metadata, matchId);
  const { heroes } = await loadCatalogs(signal);
  const player = match.players.find((p) => p.accountId === accountId && accountId > 0);
  if (player && metadata.match_info?.game_mode === 1 && [0, 1].includes(player.team)) {
    const summary = MatchSummary.build(MatchDigest.build(match, { heroes, items: new Map() }, player.slot));
    const description = summary.points
      .slice(0, 3)
      .map((p) => `${p.title}: ${p.detail}`)
      .join(" ");
    return { title: summary.headline, description: description.length > 280 ? `${description.slice(0, 277)}…` : description };
  }
  const winner = match.winningTeam === 0 ? "The Hidden King" : match.winningTeam === 1 ? "The ArchMother" : null;
  const mvps = DeadlockMatchStats.matchMvps(match.players).map((p) => heroes.get(p.heroId)?.name || `Hero ${p.heroId}`);
  return {
    title: `Match #${matchId}${winner && Number.isFinite(match.duration) ? `: ${winner} won in ${clock(match.duration)}` : ""}`,
    description: `${mvps.length ? `MVPs: ${mvps.join(", ")}. ` : ""}Open the breakdown for a plain-English summary of every player's game.`,
  };
}

export function applyPreviewTags(html, { title, description }, url) {
  const set = (pattern, value) => html.replace(pattern, (_, before, after) => `${before}${escapeAttr(value)}${after}`);
  html = set(/(<meta (?:property|name)="(?:og|twitter):title" content=")[^"]*(")/g, title);
  html = set(/(<meta (?:property|name)="(?:og|twitter):description" content=")[^"]*(")/g, description);
  html = set(/(<meta property="og:url" content=")[^"]*(")/, url);
  return html.replace(/<title>[^<]*<\/title>/, `<title>${escapeAttr(title)} | DeadStats</title>`);
}

async function matchPreview(req, env) {
  const page = await env.ASSETS.fetch(req);
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  if (!page.ok || !/^\d{1,15}$/.test(id)) return page;
  // Completed matches never change, so previews are cached at the edge for a day.
  const cache = globalThis.caches?.default;
  // Bump PREVIEW_VERSION when the preview text or page template changes, so
  // cached previews are replaced rather than served for another day.
  const keyUrl = new URL(url);
  keyUrl.searchParams.set("preview", PREVIEW_VERSION);
  const key = new Request(keyUrl.toString());
  const hit = await cache?.match(key);
  if (hit) return hit;
  const html = await page.text();
  let tags;
  try {
    tags = await previewTags(Number(id), Number(url.searchParams.get("player")), req.signal);
  } catch {
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  const response = new Response(applyPreviewTags(html, tags, url.toString()), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
  await cache?.put(key, response.clone());
  return response;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/match" && PREVIEW_BOTS.test(req.headers.get("User-Agent") || ""))
      return matchPreview(req, env);
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

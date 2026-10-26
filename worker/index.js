import DeadlockMatchStats from "../public/js/core/match-stats.js";
import MatchDigest from "../public/js/core/match-digest.js";
import MatchSummary from "../public/js/core/match-summary.js";
import { request } from "../public/js/core/common.js";
import { analyzeDigest, providerConfig, AnalysisError, PROMPT_VERSION } from "./analyze.js";

// Site Worker: static pages are served from assets; /api/* routes run here.
// The Worker fetches match data itself, so clients only choose a match and a
// player and can never supply text that reaches the model.
const CACHE_TTL_S = 180 * 24 * 3600; // Completed matches never change.
const CATALOG_TTL_MS = 3600000;
// New reviews per UTC day across all visitors. About 25 Workers AI reviews fit
// in Cloudflare's free daily allowance; raise it only if you accept charges.
const DEFAULT_DAILY_LIMIT = 25;
// New reviews per visitor (by hashed IP) per UTC day, so one person cannot use
// the whole site-wide allowance.
const DEFAULT_DAILY_IP_LIMIT = 5;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

// Applied to every response the Worker creates; static files get the same
// headers from _headers. Keep the two in sync.
export const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self'",
    "img-src 'self' data: https://assets-bucket.deadlock-api.com https://*.steamstatic.com https://steamcdn-a.akamaihd.net",
    "connect-src 'self' https://api.deadlock-api.com https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=31536000",
};
function secure(response) {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) copy.headers.set(name, value);
  return copy;
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

// Fields the pages read from the public catalogs, which are several megabytes
// in full. Served trimmed at /api/assets/{heroes,items} and used by the digest.
const pick = (source, keys) => Object.fromEntries(keys.filter((k) => source?.[k] !== undefined).map((k) => [k, source[k]]));
export const trimHero = (hero) => ({
  ...pick(hero, ["id", "name"]),
  images: pick(hero.images, ["icon_image_small", "icon_image_small_webp", "icon_hero_card", "icon_hero_card_webp"]),
});
export const trimItem = (item) =>
  pick(item, [
    "id", "name", "type", "item_slot_type", "item_tier", "cost", "shopable", "disabled", "heroes",
    "image", "image_webp", "shop_image", "shop_image_webp", "shop_image_small_webp",
  ]);

async function handleAsset(req, kind, signal) {
  // Edge-cached for an hour; the catalogs change only with game patches.
  const cache = globalThis.caches?.default;
  const key = new Request(new URL(`/api/assets/${kind}`, req.url).toString());
  const hit = await cache?.match(key);
  if (hit) return hit;
  let upstream;
  try {
    upstream = await request(`/v1/assets/${kind}`, signal, CATALOG_TTL_MS);
  } catch {
    throw new AnalysisError("The Deadlock API could not provide the catalog right now.");
  }
  const response = new Response(JSON.stringify(upstream.data.map(kind === "heroes" ? trimHero : trimItem)), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
  await cache?.put(key, response.clone());
  return response;
}

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

// Cloudflare Turnstile proves a real browser on this site made the request.
// Local development without a secret skips the check; production fails closed.
async function verifyTurnstile(token, req, env, url) {
  if (!env.TURNSTILE_SECRET) {
    if (LOCAL_HOSTS.has(url.hostname)) return;
    throw new AnalysisError("AI review is not configured on this server.", 503);
  }
  if (typeof token !== "string" || !token || token.length > 2048)
    throw new AnalysisError("The bot check did not complete. Reload the page and try again.", 403);
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  const ip = req.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);
  const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form })
    .then((r) => r.json())
    .catch(() => null);
  if (!result?.success) throw new AnalysisError("The bot check failed. Reload the page and try again.", 403);
}

async function hashedIp(req, day) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  // A one-way hash salted with the day: the stored key cannot be turned back into an IP.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day}:${ip}`));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleAnalyze(req, env, signal, url) {
  // Only this site's pages may request reviews: JSON from the same origin. This
  // stops other websites from spending the allowance through visitors' browsers.
  if (!(req.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json"))
    throw new AnalysisError("Requests must be JSON.", 415);
  if (req.headers.get("Origin") !== url.origin) throw new AnalysisError("Cross-site requests are not allowed.", 403);
  const body = await req.json().catch(() => null);
  const target = parseTarget(body?.matchId, body?.slot);
  const { provider, model } = providerConfig(env);
  const key = `review:p${PROMPT_VERSION}:d${MatchDigest.VERSION}:${provider}:${model}:${target.matchId}:${target.slot}`;
  const cached = await env.ANALYSIS_CACHE?.get(key, "json");
  if (cached) return json({ ...cached, cached: true });

  // Only uncached reviews cost anything, so only they need the bot check and limits.
  await verifyTurnstile(body?.turnstileToken, req, env, url);
  if (env.ANALYSIS_LIMITER) {
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.ANALYSIS_LIMITER.limit({ key: ip });
    if (!success) throw new AnalysisError("Too many new reviews requested. Wait a minute and try again.", 429);
  }
  // A site-wide daily cap keeps total usage inside the free allowance (or a
  // chosen budget). The KV counter is approximate under concurrent requests.
  const day = new Date().toISOString().slice(0, 10);
  const limit = Number(env.DAILY_REVIEW_LIMIT ?? DEFAULT_DAILY_LIMIT);
  const usageKey = `usage:${day}`;
  const used = Number((await env.ANALYSIS_CACHE?.get(usageKey)) ?? 0);
  if (used >= limit)
    throw new AnalysisError("Today's free AI reviews are used up. Try again after 00:00 UTC.", 429);
  const ipLimit = Number(env.DAILY_IP_LIMIT ?? DEFAULT_DAILY_IP_LIMIT);
  const ipKey = `ipday:${day}:${await hashedIp(req, day)}`;
  const ipUsed = Number((await env.ANALYSIS_CACHE?.get(ipKey)) ?? 0);
  if (ipUsed >= ipLimit)
    throw new AnalysisError(`You've reached today's limit of ${ipLimit} new AI reviews. Saved reviews still work.`, 429);

  const digest = await loadDigest(target, signal);
  const result = await analyzeDigest(digest, { env, signal });
  await env.ANALYSIS_CACHE?.put(usageKey, String(used + 1), { expirationTtl: 2 * 24 * 3600 });
  await env.ANALYSIS_CACHE?.put(ipKey, String(ipUsed + 1), { expirationTtl: 2 * 24 * 3600 });
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
const PREVIEW_VERSION = "3";
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
  // Anyone can claim to be a preview bot, so previews are rate-limited per IP;
  // over the limit, the normal page (with generic tags) is served instead.
  if (env.PREVIEW_LIMITER) {
    const { success } = await env.PREVIEW_LIMITER.limit({ key: req.headers.get("CF-Connecting-IP") || "unknown" });
    if (!success) return page;
  }
  const player = /^\d{1,10}$/.test(url.searchParams.get("player") ?? "") ? url.searchParams.get("player") : null;
  // Completed matches never change, so previews are cached at the edge for a day.
  const cache = globalThis.caches?.default;
  // Bump PREVIEW_VERSION when the preview text or page template changes, so
  // cached previews are replaced rather than served for another day.
  // The key holds only the match, player and version, so extra query
  // parameters cannot bypass the cache.
  const keyUrl = new URL(`${url.origin}/match`);
  keyUrl.searchParams.set("id", id);
  if (player) keyUrl.searchParams.set("player", player);
  keyUrl.searchParams.set("preview", PREVIEW_VERSION);
  const key = new Request(keyUrl.toString());
  const hit = await cache?.match(key);
  if (hit) return hit;
  const html = await page.text();
  let tags;
  try {
    tags = await previewTags(Number(id), Number(player), req.signal);
  } catch {
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  const response = new Response(applyPreviewTags(html, tags, url.toString()), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
  await cache?.put(key, response.clone());
  return response;
}

async function route(req, env) {
  const url = new URL(req.url);
  if (url.pathname === "/match" && PREVIEW_BOTS.test(req.headers.get("User-Agent") || ""))
    return matchPreview(req, env);
  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
  try {
    // The raw digest is a development aid; in production it would let anyone
    // make the Worker download match data on demand.
    if (url.pathname === "/api/digest" && req.method === "GET" && LOCAL_HOSTS.has(url.hostname))
      return await handleDigest(url, req.signal);
    const asset = /^\/api\/assets\/(heroes|items)$/.exec(url.pathname);
    if (asset && req.method === "GET") return await handleAsset(req, asset[1], req.signal);
    if (url.pathname === "/api/analyze" && req.method === "POST")
      return await handleAnalyze(req, env, req.signal, url);
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof AnalysisError) return json({ error: error.message }, error.status);
    console.error("Unhandled API error", error);
    return json({ error: "Something went wrong. Try again later." }, 500);
  }
}

export default {
  async fetch(req, env) {
    return secure(await route(req, env));
  },
};

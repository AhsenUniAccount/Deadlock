import test from "node:test";
import assert from "node:assert/strict";
import worker, { applyPreviewTags } from "../worker/index.js";

// The Worker is exercised end to end with fetch mocked for both the Deadlock
// API and the Anthropic API, so no network or API key is needed.
const metadata = {
  match_info: {
    match_id: 77,
    duration_s: 900,
    winning_team: 0,
    game_mode: 1,
    players: [0, 1].map((slot) => ({
      player_slot: slot,
      team: slot,
      account_id: 10 + slot,
      hero_id: slot + 1,
      assigned_lane: 1,
      kills: 0,
      deaths: 0,
      assists: 0,
      net_worth: 5000,
      stats: [{ time_stamp_s: 300, net_worth: 2000 }],
      death_details: [],
    })),
  },
};
const review = {
  headline: "Even lane, early lead.",
  summary: "You matched your lane opponent.",
  key_moments: [
    { time_s: 300, title: "Lane parity", detail: "Souls were equal.", impact: "neutral" },
    { time_s: 99999, title: "Invented", detail: "Outside the match.", impact: "negative" },
  ],
  strengths: [{ title: "Farm", detail: "Steady." }],
  improvements: [{ title: "Push", detail: "Take Guardians.", evidence: "No structures fell." }],
};

function setup({ modelText = JSON.stringify(review), stopReason = "end_turn", ai } = {}) {
  const calls = { anthropic: [], deadlock: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.anthropic.com")) {
      calls.anthropic.push({ url, init, headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: modelText }],
        stop_reason: stopReason,
        usage: { input_tokens: 100, output_tokens: 50 },
      });
    }
    calls.deadlock.push(url);
    if (url.includes("/metadata")) return Response.json(metadata);
    if (url.includes("/assets/heroes")) return Response.json([{ id: 1, name: "Haze" }, { id: 2, name: "Ivy" }]);
    if (url.includes("/assets/items")) return Response.json([]);
    return new Response("not found", { status: 404 });
  };
  const store = new Map();
  const env = {
    ANALYSIS_PROVIDER: ai ? "workers-ai" : "anthropic",
    ANALYSIS_MODEL: undefined,
    AI: ai,
    ANTHROPIC_API_KEY: "test-key",
    ANALYSIS_CACHE: {
      get: async (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
      put: async (key, value) => store.set(key, value),
    },
    ASSETS: { fetch: async () => new Response("asset") },
  };
  const post = (body) =>
    worker.fetch(
      new Request("https://example.test/api/analyze", { method: "POST", body: JSON.stringify(body) }),
      env,
    );
  return { calls, env, store, post };
}

test("analyze fetches the match itself, sends a digest and caches a sanitized review", async () => {
  const { calls, post } = setup();
  const response = await post({ matchId: "77", slot: 0 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.cached, false);
  assert.equal(body.digest.you.hero, "Haze");
  assert.deepEqual(body.digest.you.laneOpponents, ["Ivy"]);
  // The out-of-range timestamp is dropped rather than shown.
  assert.deepEqual(body.analysis.keyMoments.map((m) => m.timeS), [300]);

  const [call] = calls.anthropic;
  assert.equal(call.body.model, "claude-opus-5-5");
  assert.equal(call.body.fallbacks, "default");
  assert.equal(call.body.output_config.format.type, "json_schema");
  assert.match(call.headers.get("anthropic-beta"), /server-side-fallback-2026-07-01/);
  assert.match(call.body.messages[0].content, /"laneOpponents":\["Ivy"\]/);

  const again = await (await post({ matchId: 77, slot: 0 })).json();
  assert.equal(again.cached, true);
  assert.equal(calls.anthropic.length, 1);
});
test("invalid targets and unconfigured keys fail with clear errors and no model call", async () => {
  const { calls, env, post } = setup();
  assert.equal((await post({ matchId: "abc", slot: 0 })).status, 400);
  assert.equal((await post({ matchId: 77, slot: 9 })).status, 400);
  env.ANTHROPIC_API_KEY = "";
  const response = await post({ matchId: 77, slot: 1 });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/);
  assert.equal(calls.anthropic.length, 0);
});
test("Workers AI is the default provider and gets the digest with JSON mode", async () => {
  const runs = [];
  const ai = {
    run: async (model, input) => {
      runs.push({ model, input });
      return { response: review, usage: { prompt_tokens: 900, completion_tokens: 300 } };
    },
  };
  const { env, post, calls } = setup({ ai });
  delete env.ANALYSIS_PROVIDER;
  const body = await (await post({ matchId: 77, slot: 1 })).json();
  assert.equal(body.model, "@cf/openai/gpt-oss-120b");
  assert.equal(body.analysis.headline, review.headline);
  assert.equal(runs[0].input.response_format.type, "json_schema");
  assert.equal(runs[0].input.response_format.json_schema.strict, true);
  assert.ok(runs[0].input.max_tokens >= 8192);
  assert.match(runs[0].input.messages[1].content, /"hero":"Ivy"/);
  assert.equal(calls.anthropic.length, 0);
});
test("OpenAI-style models return chat choices; a length cut-off is reported", async () => {
  const choices = (content, finish_reason = "stop") => ({
    choices: [{ message: { content }, finish_reason }],
    usage: { prompt_tokens: 4000, completion_tokens: 1500, neurons: 260 },
  });
  const ok = setup({ ai: { run: async () => choices(JSON.stringify(review)) } });
  assert.equal((await (await ok.post({ matchId: 77, slot: 0 })).json()).analysis.headline, review.headline);
  const cut = setup({ ai: { run: async () => choices('{"headline":', "length") } });
  assert.match((await (await cut.post({ matchId: 77, slot: 0 })).json()).error, /cut off/);
});
test("Workers AI string output is parsed; the daily allowance error becomes a clear 429", async () => {
  const text = setup({ ai: { run: async () => ({ response: JSON.stringify(review) }) } });
  assert.equal((await text.post({ matchId: 77, slot: 0 })).status, 200);
  const exhausted = setup({
    ai: { run: async () => { throw new Error("3036: you have used up your daily free allocation of 10,000 neurons"); } },
  });
  const response = await exhausted.post({ matchId: 77, slot: 0 });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /free AI allowance/);
  const empty = setup({ ai: { run: async () => ({ response: { headline: "", summary: "" } }) } });
  assert.match((await (await empty.post({ matchId: 77, slot: 0 })).json()).error, /incomplete/);
});
test("the site-wide daily cap stops new reviews but still serves cached ones", async () => {
  let runs = 0;
  const { env, post } = setup({ ai: { run: async () => (runs++, { response: review }) } });
  env.DAILY_REVIEW_LIMIT = "1";
  assert.equal((await post({ matchId: 77, slot: 0 })).status, 200);
  const capped = await post({ matchId: 77, slot: 1 });
  assert.equal(capped.status, 429);
  assert.match((await capped.json()).error, /used up/);
  assert.equal((await (await post({ matchId: 77, slot: 0 })).json()).cached, true);
  assert.equal(runs, 1);
});
test("refusals and unreadable output are reported, not cached", async () => {
  const refused = setup({ stopReason: "refusal" });
  assert.equal((await refused.post({ matchId: 77, slot: 0 })).status, 502);
  assert.equal(refused.store.size, 0);
  const garbled = setup({ modelText: "not json" });
  assert.match((await (await garbled.post({ matchId: 77, slot: 0 })).json()).error, /unreadable/);
});
test("digest route returns facts without calling the model; other paths are static assets", async () => {
  const { calls, env } = setup();
  const digest = await worker.fetch(new Request("https://example.test/api/digest?match=77&slot=1"), env);
  assert.equal((await digest.json()).digest.match.result, "loss");
  assert.equal(await (await worker.fetch(new Request("https://example.test/match.html"), env)).text(), "asset");
  assert.equal(calls.anthropic.length, 0);
});

const PAGE = `<title>Match | DeadStats</title>
<meta property="og:title" content="Generic" />
<meta property="og:description" content="Generic" />
<meta property="og:url" content="https://example.test/match" />
<meta name="twitter:title" content="Generic" />
<meta name="twitter:description" content="Generic" />`;
const visit = (env, userAgent, query = "?id=77&player=10") =>
  worker.fetch(new Request(`https://example.test/match${query}`, { headers: { "User-Agent": userAgent } }), env);

test("link-preview bots get the player's summary in the page tags; browsers get the static page", async () => {
  const { env, calls } = setup();
  env.ASSETS = { fetch: async () => new Response(PAGE, { headers: { "Content-Type": "text/html" } }) };
  const bot = await (await visit(env, "Mozilla/5.0 (compatible; Discordbot/2.0)")).text();
  assert.match(bot, /<meta property="og:title" content="Win as Haze · 0\/0\/0 · 1st of 2 in souls" \/>/);
  assert.match(bot, /<meta name="twitter:description" content="[^"]*souls/);
  assert.match(bot, /<title>Win as Haze · 0\/0\/0 · 1st of 2 in souls \| DeadStats<\/title>/);
  assert.match(bot, /og:url" content="https:\/\/example.test\/match\?id=77&amp;player=10"/);
  const fetchesAfterBot = calls.deadlock.length;
  assert.equal(await (await visit(env, "Mozilla/5.0 Chrome/130")).text(), PAGE);
  assert.equal(calls.deadlock.length, fetchesAfterBot);
});
test("previews without a player describe the result; bad IDs and API failures keep generic tags", async () => {
  const { env } = setup();
  env.ASSETS = { fetch: async () => new Response(PAGE) };
  assert.match(await (await visit(env, "Twitterbot/1.0", "?id=77")).text(), /og:title" content="Match #77: The Hidden King won in 15:00"/);
  assert.equal(await (await visit(env, "Twitterbot/1.0", "?id=abc")).text(), PAGE);
  globalThis.fetch = async () => new Response("down", { status: 503 });
  assert.match(await (await visit(env, "Twitterbot/1.0", "?id=78")).text(), /og:title" content="Generic"/);
});
test("preview text is escaped before it goes into attributes", () => {
  const html = applyPreviewTags(PAGE, { title: 'A "quote" <b>', description: "x & y" }, "https://e.test/?a=1&b=2");
  assert.match(html, /og:title" content="A &quot;quote&quot; &lt;b&gt;"/);
  assert.match(html, /og:description" content="x &amp; y"/);
});

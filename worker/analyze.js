import Anthropic from "@anthropic-ai/sdk";

// Model call for one match digest. The digest already holds every number; the
// model's job is to select what mattered and explain it. Bump PROMPT_VERSION
// whenever the prompt or schema changes so cached reviews are regenerated.
export const PROMPT_VERSION = 3;

// Workers AI is the free default (a daily allowance on every Cloudflare account);
// Anthropic is a paid option for higher-quality reviews.
export const PROVIDERS = {
  // gpt-oss-120b followed the review rules far better than Llama 3.3 70B in
  // testing, at a similar ~260 neurons per review.
  "workers-ai": { defaultModel: "@cf/openai/gpt-oss-120b" },
  anthropic: { defaultModel: "claude-opus-5-5" },
};

export class AnalysisError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const SYSTEM_PROMPT = `You are an experienced Deadlock coach reviewing one completed match for one player. You receive structured match data for that player and write a review they can act on next game.

Deadlock basics, so you read the data correctly:
- Two teams of six: The Hidden King and The ArchMother. Players start in lanes (two or so per lane), then roam.
- Souls are the currency and the main measure of progress. "Souls" in the data is net worth, including souls already spent on items. Souls come from lane creeps, neutral camps, killing players and bosses; dying loses some and costs time while respawning.
- Structures, in rough order of a push: Guardians, Walkers, Base Guardians, Shrines, then the Patron. The Mid Boss drops the Rejuvenator, which the claiming team uses to push.
- Items are bought in weapon, vitality and spirit categories, in tiers 1 to 4.

How to read the data:
- Stat snapshots ("checkpoints") are cumulative totals at the listed times, typically three to five minutes apart. Differences between two checkpoints are valid; values between them are unknown.
- teamSoulsLead is from the player's side: positive means their team was ahead.
- null means the value was not recorded. Never treat null as zero.
- dataQuality.unavailable lists what the data cannot show. Do not make claims about those things, such as positioning, ability usage, who assisted a kill, or how this player compares with others of the same rank.

Writing rules:
- Every number you state must appear in the data or be a simple difference or sum of values in it. Do not estimate or invent figures.
- Every time_s must be a time that appears in the data.
- Refer to players by hero name and address the player as "you". Say "match data", not "digest" or "JSON".
- Every time in the data comes with a ready-made minutes:seconds version (for example "timeS": 1519 has "time": "25:19"). Copy those exactly. Never convert seconds yourself and never write raw seconds like "1519s".
- Use Deadlock terms: souls, not gold or experience.
- The data has no benchmarks for item choices, damage or healing. Do not call them good or bad; only describe what happened, such as when an item was bought relative to a fight.
- Be specific and honest. If the player played well and lost anyway, say so. If the data cannot explain an outcome, say that instead of guessing.
- Advice must be concrete and tied to moments in this match, not generic tips. Each improvement names the specific times it is based on.
- State findings directly. Avoid hedges such as "may have" unless the data is genuinely ambiguous.
- Return 3 to 6 key moments, 1 to 3 strengths and 2 to 4 improvements, ordered by importance.`;

const text = { type: "string" };
const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "key_moments", "strengths", "improvements"],
  properties: {
    headline: {
      type: "string",
      description: "A one-sentence verdict on how the player did, not a title. Example: \"You won your lane but died during the late-game pushes that decided the match.\"",
    },
    summary: {
      type: "string",
      description: "Two to four sentences on why the match went the way it did for this player.",
    },
    key_moments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["time_s", "title", "detail", "impact"],
        properties: {
          time_s: { type: "integer" },
          title: text,
          detail: text,
          impact: { type: "string", enum: ["positive", "negative", "neutral"] },
        },
      },
    },
    strengths: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail"],
        properties: { title: text, detail: text },
      },
    },
    improvements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "evidence"],
        properties: {
          title: text,
          detail: { type: "string", description: "What to do differently next game." },
          evidence: { type: "string", description: "The facts from this match that support it." },
        },
      },
    },
  },
};

// Schema-valid output can still exceed what the page should render, or cite a
// time outside the match. Trim, rather than trust, before caching.
function sanitize(raw, durationS) {
  const clip = (value, max) => String(value ?? "").trim().slice(0, max);
  const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
  const validTime = (t) =>
    Number.isInteger(t) && t >= 0 && (!Number.isFinite(durationS) || t <= durationS);
  return {
    headline: clip(raw.headline, 300),
    summary: clip(raw.summary, 1500),
    keyMoments: list(raw.key_moments, 6)
      .filter((m) => validTime(m?.time_s))
      .sort((a, b) => a.time_s - b.time_s)
      .map((m) => ({
        timeS: m.time_s,
        title: clip(m.title, 120),
        detail: clip(m.detail, 600),
        impact: ["positive", "negative", "neutral"].includes(m.impact) ? m.impact : "neutral",
      })),
    strengths: list(raw.strengths, 3).map((s) => ({
      title: clip(s?.title, 120),
      detail: clip(s?.detail, 600),
    })),
    improvements: list(raw.improvements, 4).map((s) => ({
      title: clip(s?.title, 120),
      detail: clip(s?.detail, 600),
      evidence: clip(s?.evidence, 600),
    })),
  };
}

// Models convert seconds to clock times unreliably, so every time field gets a
// pre-formatted sibling: timeS -> time, deadForS -> deadFor, and so on.
const CLOCK_FIELDS = ["timeS", "deadForS", "previousSnapshotS", "soldOrReplacedS", "durationS"];
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
function withClockTimes(value) {
  if (Array.isArray(value)) return value.map(withClockTimes);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = withClockTimes(inner);
    if (CLOCK_FIELDS.includes(key) && Number.isFinite(inner)) out[key.slice(0, -1)] = clock(inner);
  }
  return out;
}

const userMessage = (digest) =>
  `<match_data>\n${JSON.stringify(withClockTimes(digest))}\n</match_data>\n\nReview this match for the player marked "you" (playing ${digest.you.hero}). Write to them directly as "you", not by hero name.`;

// Resolve which provider and model the Worker is configured to use.
export function providerConfig(env) {
  const provider = env.ANALYSIS_PROVIDER || "workers-ai";
  if (!PROVIDERS[provider]) throw new AnalysisError("AI review is misconfigured on this server.", 503);
  return { provider, model: env.ANALYSIS_MODEL || PROVIDERS[provider].defaultModel };
}

export async function analyzeDigest(digest, { env, signal }) {
  const { provider, model } = providerConfig(env);
  const result =
    provider === "anthropic"
      ? await analyzeWithAnthropic(digest, { apiKey: env.ANTHROPIC_API_KEY, model, signal })
      : await analyzeWithWorkersAi(digest, { ai: env.AI, model });
  const analysis = sanitize(result.parsed, digest.match.durationS);
  if (!analysis.headline || !analysis.summary)
    throw new AnalysisError("The AI service returned an incomplete review. Try again.");
  return { analysis, model: result.model, usage: result.usage };
}

// Cloudflare Workers AI through the AI binding. On the Workers Free plan the
// daily allowance cannot be exceeded; the Worker's own daily cap keeps paid
// accounts inside it too.
async function analyzeWithWorkersAi(digest, { ai, model }) {
  if (!ai) throw new AnalysisError("AI review is not configured on this server.", 503);
  // OpenAI's open models on Workers AI use the OpenAI chat-completions shape and
  // reason before answering, so they need room for that thinking in max_tokens.
  const openAiStyle = model.startsWith("@cf/openai/");
  let result;
  try {
    result = await ai.run(model, {
      messages: [
        {
          role: "system",
          content: `${SYSTEM_PROMPT}\n\nRespond only with a JSON object that matches the required schema.`,
        },
        { role: "user", content: userMessage(digest) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: openAiStyle
          ? { name: "match_review", strict: true, schema: ANALYSIS_SCHEMA }
          : ANALYSIS_SCHEMA,
      },
      // The Workers AI default is a few hundred tokens, too short for a review.
      max_tokens: openAiStyle ? 8192 : 2048,
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/3036|daily free allocation/i.test(message))
      throw new AnalysisError("Today's free AI allowance is used up. Try again after 00:00 UTC.", 429);
    if (/3040|capacity/i.test(message))
      throw new AnalysisError("The AI service is busy. Try again in a minute.", 503);
    if (/JSON Mode couldn't be met/i.test(message))
      throw new AnalysisError("The AI service returned an unreadable review. Try again.");
    console.error("Workers AI error", message);
    throw new AnalysisError("The AI service could not complete the review. Try again later.");
  }
  const choice = result?.choices?.[0];
  if (choice?.finish_reason === "length")
    throw new AnalysisError("The review was cut off before it finished. Try again.");
  // JSON mode returns an object (or a JSON string); OpenAI-style models return message text.
  let parsed = choice ? choice.message?.content : result?.response;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object")
    throw new AnalysisError("The AI service returned an unreadable review. Try again.");
  return {
    parsed,
    model,
    usage: {
      inputTokens: result?.usage?.prompt_tokens ?? null,
      outputTokens: result?.usage?.completion_tokens ?? null,
      neurons: result?.usage?.neurons ?? null,
    },
  };
}

async function analyzeWithAnthropic(digest, { apiKey, model, signal }) {
  if (!apiKey) throw new AnalysisError("AI review is not configured on this server.", 503);
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 120000 });
  let response;
  try {
    response = await client.beta.messages.create(
      {
        model,
        max_tokens: 16000,
        // If a safety classifier declines, the API re-runs on its recommended fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: ANALYSIS_SCHEMA },
        },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage(digest) }],
      },
      { signal },
    );
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError)
      throw new AnalysisError("The AI service is busy. Try again in a minute.", 503);
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      console.error("Anthropic credentials rejected", error.status);
      throw new AnalysisError("AI review is misconfigured on this server.", 503);
    }
    if (error instanceof Anthropic.APIError) {
      console.error("Anthropic API error", error.status, error.message);
      throw new AnalysisError("The AI service could not complete the review. Try again later.");
    }
    throw error;
  }
  if (response.stop_reason === "refusal")
    throw new AnalysisError("The AI service declined to review this match.");
  if (response.stop_reason === "max_tokens")
    throw new AnalysisError("The review was cut off before it finished. Try again.");
  const body = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AnalysisError("The AI service returned an unreadable review. Try again.");
  }
  return {
    parsed,
    model: response.model,
    usage: {
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    },
  };
}

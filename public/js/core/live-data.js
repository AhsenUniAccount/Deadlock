import DeadlockLiveStats from "./live-stats.js";
import { API_BASE, request, errorMessage, assetCatalog } from "./common.js";

const DeadlockLiveData = (() => {
  const S = DeadlockLiveStats;
  const sources = new Map();
  // Swappable so the Node backtest can serve responses from its disk cache.
  let transport = request;
  const useTransport = (fn) => { transport = fn; };
  const LIVE_QUERY = `SELECT 'player' AS kind, tick, entity_index, delta_type,
    "m_unEconAccountID" AS account_id, "m_iTeamNum" AS team,
    "m_PlayerDataGlobal__m_nHeroID" AS hero_id,
    "m_PlayerDataGlobal__m_iGoldNetWorth" AS souls,
    "m_PlayerDataGlobal__m_iPlayerKills" AS kills,
    "m_PlayerDataGlobal__m_iPlayerAssists" AS assists,
    "m_PlayerDataGlobal__m_iDeaths" AS deaths,
    NULL AS game_time, NULL AS clock_tick, NULL AS paused
    FROM CCitadelPlayerController
    UNION ALL SELECT 'clock' AS kind, tick, entity_index, delta_type,
    NULL AS account_id, NULL AS team, NULL AS hero_id, NULL AS souls,
    NULL AS kills, NULL AS assists, NULL AS deaths,
    "m_pGameRules__m_flMatchClockAtLastUpdate" AS game_time,
    "m_pGameRules__m_nMatchClockUpdateTick" AS clock_tick,
    "m_pGameRules__m_bGamePaused" AS paused FROM CCitadelGameRulesProxy`;

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const done = () => { signal.removeEventListener("abort", abort); resolve(); };
      const id = setTimeout(done, ms);
      const abort = () => { clearTimeout(id); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  async function mapLimit(values, fn, signal, limit = 3) {
    const results = new Array(values.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        signal.throwIfAborted(); const i = next++;
        try { results[i] = { status: "fulfilled", value: await fn(values[i], i) }; }
        catch (reason) { results[i] = { status: "rejected", reason }; }
      }
    }));
    signal.throwIfAborted(); return results;
  }

  async function get(path, signal, ttl = 600000, object = false) {
    for (let attempt = 0; ; attempt++) {
      try {
        // Hero and item catalogs come trimmed from the site's Worker, unless a
        // custom transport (the Node backtest) is in use.
        const catalog = transport === request && { "/v1/assets/heroes": "heroes", "/v1/assets/items": "items" }[path];
        const result = catalog ? await assetCatalog(catalog, signal) : await transport(path, signal, ttl, false, object);
        signal.throwIfAborted(); sources.set(path, result.fetchedAt); return result.data;
      } catch (error) {
        if (signal.aborted || attempt || ![429, 503].includes(error.status) || (error.retryAfter || 0) > 10) throw error;
        await delay(Math.max(2000, (error.retryAfter || 2) * 1000), signal);
      }
    }
  }

  // SSE frames can be split across network chunks; preserve multiline data and errors.
  function parseFrame(frame) {
    const lines = frame.replace(/\r/g, "").split("\n");
    const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) return null;
    return { event: lines.find((l) => l.startsWith("event:"))?.slice(6).trim() || "message", data: JSON.parse(data) };
  }
  async function stream(broadcast, signal, receive) {
    const params = new URLSearchParams({ broadcast_url: broadcast, query: LIVE_QUERY });
    const response = await fetch(`${API_BASE}/v1/matches/demo/live/query?${params}`, { signal, headers: { Accept: "text/event-stream" } });
    if (!response.ok || !response.body) {
      const error = new Error(`Broadcast unavailable (${response.status}).`); error.status = response.status; throw error;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r/g, "");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = parseFrame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
          if (!frame) continue;
          if (frame.event === "error") {
            const e = new Error(frame.data.status === 400 ? "The broadcast data format is not supported for this match." : "The broadcast service could not provide this match. Try another lobby or reconnect later.");
            e.status = frame.data.status; throw e;
          }
          receive(frame.data);
        }
        if (buffer.length > 1024 * 1024) throw new Error("Unexpected broadcast frame size.");
        if (done) break;
      }
    } finally { await reader.cancel().catch(() => {}); }
  }

  function scopeFor(match, patches, now = Date.now() / 1000) {
    const cutoff = S.number(match.start_time) !== null ? Math.min(match.start_time, now) : now;
    const end = Math.floor(cutoff - 7200);
    // Titles are calendar dates only; pub_date has proved inconsistent. Never imply an exact version filter.
    const patchDates = (patches || []).flatMap((p) => {
      const m = /\b(\d{2})-(\d{2})-(\d{4})\b/.exec(p.title || "");
      if (!m) return [];
      const t = Date.UTC(+m[3], +m[1] - 1, +m[2]) / 1000;
      return t <= end && t > end - 90 * 86400 ? [t] : [];
    });
    const patch = patchDates.length ? Math.max(...patchDates) : null;
    return { cutoff, end, start: Math.max(end - 30 * 86400, patch || 0), patch,
      mode: match.match_mode === 4 ? "ranked" : match.match_mode === 1 ? "unranked" : "ranked,unranked" };
  }
  function paramsFor(match, scope, extra = {}) {
    return new URLSearchParams({ game_mode: "normal", match_mode: scope.mode,
      min_unix_timestamp: String(scope.start), max_unix_timestamp: String(scope.end),
      max_match_id: String(match.match_id - 1), ...extra });
  }

  async function scouting(match, players, signal, progress = () => {}) {
    const errors = [], result = { histories: new Map(), ranks: new Map(), playerHeroes: new Map(), formRows: new Map(), errors };
    const ids = players.map((p) => p.accountId).join(",");
    const basics = [
      ["heroes", "/v1/assets/heroes", 3600000], ["items", "/v1/assets/items", 3600000],
      ["rankCatalog", "/v1/assets/ranks", 3600000],
      ["profiles", `/v1/players/steam?account_ids=${ids}`],
      ["rankRows", `/v1/players/rank?account_ids=${ids}`],
      ["patches", "/v1/patches", 3600000],
      ...players.map((p) => [`history:${p.accountId}`, `/v1/players/${p.accountId}/match-history`]),
    ];
    await mapLimit(basics, async ([name, path, ttl]) => {
      try { const rows = await get(path, signal, ttl);
        if (name.startsWith("history:")) {
          const id = Number(name.slice(8));
          result.histories.set(id, rows.filter((r) => r.account_id === id));
          if (rows.some((r) => r.account_id !== id)) errors.push(`History for account ${id}: mismatched records discarded.`);
        } else result[name] = rows;
      } catch (e) { errors.push(`${name.startsWith("history:") ? `History for account ${name.slice(8)}` : name}: ${errorMessage(e)}`); }
      progress();
    }, signal);
    result.heroes = new Map((result.heroes || []).map((r) => [r.id, r]));
    result.items = new Map((result.items || []).map((r) => [r.id, r]));
    result.profiles = new Map((result.profiles || []).map((r) => [r.account_id, r]));
    result.scope = scopeFor(match, result.patches);
    for (const p of players) {
      const rank = result.rankRows?.find((r) => r.account_id === p.accountId && r.badge > 0 &&
        S.number(r.last_match?.start_time) !== null && r.last_match.start_time < result.scope.cutoff && r.last_match.match_id !== match.match_id);
      // Historical fallback is strictly before this lobby, never its result.
      const previous = (result.histories.get(p.accountId) || []).filter((r) =>
        r.match_mode === 4 && r.ranked_display_badge > 0 && r.start_time + r.match_duration_s < result.scope.cutoff && r.match_id !== match.match_id)
        .sort((a, b) => b.start_time - a.start_time)[0];
      if (rank || previous) result.ranks.set(p.accountId, rank || { badge: previous.ranked_display_badge, last_match: previous });
    }
    const tasks = [
      ["distribution", `/v1/players/rank/distribution?${new URLSearchParams({ min_unix_timestamp: String(result.scope.start), max_unix_timestamp: String(result.scope.end), max_match_id: String(match.match_id - 1) })}`],
      ["populationRows", `/v1/analytics/hero-stats?${paramsFor(match, result.scope, { bucket: "avg_badge" })}`],
      ["counters", `/v1/analytics/hero-counter-stats?${paramsFor(match, result.scope, { same_lane_filter: "false", min_matches: "100" })}`],
      ...players.map((p) => {
        const badge = result.ranks.get(p.accountId)?.badge;
        const tier = badge ? Math.floor(badge / 10) : 0;
        return [`heroes:${p.accountId}`, `/v1/analytics/hero-stats?${paramsFor(match, result.scope, {
          bucket: "no_bucket", account_ids: String(p.accountId),
          ...(tier ? { min_average_badge: String(tier * 10 + 1), max_average_badge: String(tier * 10 + 6) } : {}) })}`];
      }),
    ];
    const durationBands = new Set();
    for (const p of players) S.recentGames(result.histories.get(p.accountId), result.scope.cutoff, match.match_mode ?? null, match.match_id)
      .forEach((g) => { if (g.match_duration_s <= 7000) durationBands.add(Math.floor(g.match_duration_s / 600) * 600); });
    for (const band of durationBands) tasks.push([`form:${band}`, `/v1/analytics/hero-stats?${paramsFor(match, result.scope, { bucket: "avg_badge", min_duration_s: String(band), max_duration_s: String(Math.min(7000, band + 599)) })}`]);
    await mapLimit(tasks, async ([name, path]) => {
      try {
        const rows = await get(path, signal);
        if (name.startsWith("heroes:")) rows.forEach((r) => result.playerHeroes.set(`${name.slice(7)}:${r.hero_id}`, {
          ...r, matches_played: Number.isInteger(r.wins) && Number.isInteger(r.losses) ? r.wins + r.losses : null,
        }));
        else if (name.startsWith("form:")) result.formRows.set(Number(name.slice(5)), rows);
        else result[name] = rows;
      } catch (e) { errors.push(`${name}: ${errorMessage(e)}`); }
      progress();
    }, signal);
    result.fetchedAt = new Date(); return result;
  }

  async function builds(match, context, friends, targets, signal) {
    const output = new Map();
    await mapLimit(friends, async (p) => {
      if (!Number.isInteger(p.heroId) || p.heroId <= 0) {
        output.set(p.accountId, { core: [], situational: [], errors: ["Selected hero unavailable."] }); return;
      }
      const target = targets.find((t) => t.friend.accountId === p.accountId)?.primary?.opponent;
      const extra = { bucket: "no_bucket", hero_ids: String(p.heroId), min_matches: "100" };
      const rank = context.ranks.get(p.accountId)?.badge;
      if (rank) { const tier = Math.floor(rank / 10); extra.min_average_badge = String(tier * 10 + 1); extra.max_average_badge = String(tier * 10 + 6); }
      const data = { core: [], situational: [], target, build: null, errors: [] };
      try { data.core = await get(`/v1/analytics/item-stats?${paramsFor(match, context.scope, extra)}`, signal); }
      catch (e) { data.errors.push(errorMessage(e)); }
      if (target) {
        try { data.situational = await get(`/v1/analytics/item-stats?${paramsFor(match, context.scope, { ...extra, enemy_hero_ids: String(target.heroId), same_lane_filter: "false" })}`, signal); }
        catch (e) { data.errors.push(errorMessage(e)); }
      }
      try {
        const stats = await get(`/v1/analytics/hero-build-stats/${p.heroId}?${paramsFor(match, context.scope, { min_matches: "100", ...(extra.min_average_badge ? { min_average_badge: extra.min_average_badge, max_average_badge: extra.max_average_badge } : {}) })}`, signal);
        const selected = stats.filter((r) => r.matches >= 100 && r.players >= 20).sort((a, b) => b.matches - a.matches)[0];
        if (selected) data.build = { evidence: selected, detail: await get(`/v1/builds/${p.heroId}/${selected.hero_build_id}`, signal, 3600000, true) };
      } catch (e) { data.errors.push(errorMessage(e)); }
      output.set(p.accountId, data);
    }, signal, 2);
    return output;
  }
  return { get, useTransport, sources, mapLimit, parseFrame, stream, delay, scopeFor, paramsFor, scouting, builds, LIVE_QUERY };
})();
export default DeadlockLiveData;

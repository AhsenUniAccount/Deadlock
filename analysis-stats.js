"use strict";
// Pure comparison helpers: no DOM, requests, or storage dependencies.
const AnalysisStats = (() => {
  const matchStats =
    typeof module !== "undefined"
      ? require("./match-stats.js")
      : DeadlockMatchStats;
  // Use the last observed value, not interpolation. Callers display its timestamp.
  const at = (player, time) =>
    player.soulSamples.filter((point) => point.time <= time).at(-1) || null;
  // Retained calculation helper; the current UI does not show historical averages.
  const mean = (values) => {
    const valid = values.filter(Number.isFinite);
    return valid.length
      ? valid.reduce((a, b) => a + b, 0) / valid.length
      : null;
  };
  // Calculate team net-worth difference only at timestamps recorded for every roster member.
  function advantage(match) {
    // Sum only simultaneous snapshots for every member of both teams.
    if (
      !match.players.length ||
      match.players.some((p) => ![0, 1].includes(p.team)) ||
      ![0, 1].every((t) => match.players.some((p) => p.team === t))
    )
      return [];
    const maps = match.players.map(
      (p) => new Map(p.soulSamples.map((s) => [s.time, s.souls])),
    );
    return match.players[0].soulSamples
      .filter((s) => maps.every((m) => m.has(s.time)))
      .map((s) => ({
        time: s.time,
        souls: match.players.reduce(
          (sum, p, i) => sum + (p.team === 0 ? 1 : -1) * maps[i].get(s.time),
          0,
        ),
      }));
  }
  // Events on the closing boundary belong to this interval; untimed events
  // cannot be included in a time-specific comparison.
  function counts(match, player, start, end) {
    const events = matchStats
      .killTimeline(match)
      .filter(
        (e) =>
          e.time !== null &&
          e.time <= end &&
          (start === 0 ? e.time >= 0 : e.time > start),
      );
    return {
      kills: events.filter(
        (e) => e.killer?.slot === player.slot && e.victim.slot !== player.slot,
      ).length,
      deaths: events.filter((e) => e.victim.slot === player.slot).length,
    };
  }
  // Compare the first purchase only; repeat buys do not create extra samples.
  function firstBuys(player, catalog) {
    const result = new Map();
    for (const item of matchStats.purchases(player, catalog) || [])
      if (item.bought !== null && !result.has(item.id))
        result.set(item.id, item.bought);
    return result;
  }
  // Prevent look-ahead: exclude this match and games played after it.
  // Retained for tests/future comparisons; the current UI does not load historical comparisons.
  // Limit the candidate list to five unique games.
  function candidates(history, player, match) {
    return [
      ...new Map(
        history
          .filter(
            (h) =>
              h.account_id === player.accountId &&
              h.hero_id === player.heroId &&
              Number.isSafeInteger(h.match_id) &&
              h.match_id > 0 &&
              h.match_id !== Number(match.id) &&
              Number.isFinite(h.start_time) &&
              h.start_time < match.startTime,
          )
          .map((h) => [h.match_id, h]),
      ).values(),
    ]
      .sort((a, b) => b.start_time - a.start_time)
      .slice(0, 5);
  }
  return { at, mean, advantage, counts, firstBuys, candidates };
})();
if (typeof module !== "undefined") module.exports = AnalysisStats;

"use strict";

// Pure API-to-view-model transformations, shared by the UI and Node tests.
// null means unavailable; zero is a real measurement and must not be discarded.
const DeadlockMatchStats = (() => {
  const count = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : null;

  // Validate the requested match and normalize its roster, snapshots and objective events for the UI.
  function summarizeMatch(metadata, expectedId) {
    const info = metadata?.match_info;
    if (
      !info ||
      String(info.match_id) !== String(expectedId) ||
      !Array.isArray(info.players) ||
      !info.players.length
    ) {
      throw new Error(
        "The API returned incomplete or mismatched match metadata.",
      );
    }
    const slots = new Set();
    const players = info.players
      .map((raw) => {
        if (
          !Number.isInteger(raw?.player_slot) ||
          slots.has(raw.player_slot) ||
          !Number.isInteger(raw.account_id) ||
          !Number.isInteger(raw.hero_id)
        ) {
          throw new Error("The API returned an invalid match roster.");
        }
        slots.add(raw.player_slot);
        const events = Array.isArray(raw.death_details)
          ? raw.death_details
          : [];
        return {
          slot: raw.player_slot,
          accountId: raw.account_id,
          heroId: raw.hero_id,
          team: raw.team,
          kills: count(raw.kills),
          deaths: count(raw.deaths),
          assists: count(raw.assists),
          souls: count(raw.net_worth),
          mvpRank:
            Number.isInteger(raw.mvp_rank) &&
            raw.mvp_rank >= 1 &&
            raw.mvp_rank <= 3
              ? raw.mvp_rank
              : null,
          items: Array.isArray(raw.items) ? raw.items : null,
          soulSamples: soulSamples(raw.stats, info.duration_s),
          events,
          deathsComplete:
            Array.isArray(raw.death_details) &&
            count(raw.deaths) !== null &&
            events.length === raw.deaths &&
            events.every((event) => event && typeof event === "object"),
        };
      })
      .sort((a, b) => (a.team ?? 99) - (b.team ?? 99) || a.slot - b.slot);
    // Event attribution uses player slots, never roster indexes or account IDs.
    const bySlot = new Map(players.map((player) => [player.slot, player]));
    // Only total attributed kills are needed to check log completeness.
    const recordedKills = new Map(players.map((player) => [player.slot, 0]));
    for (const victim of players) {
      for (const event of victim.events) {
        const killer = bySlot.get(event?.killer_player_slot);
        if (killer && killer.slot !== victim.slot) {
          recordedKills.set(killer.slot, recordedKills.get(killer.slot) + 1);
        }
      }
    }
    const incomplete = players.some(
      (player) =>
        !player.deathsComplete ||
        recordedKills.get(player.slot) !== player.kills,
    );
    return {
      id: info.match_id,
      startTime: info.start_time,
      duration: info.duration_s,
      winningTeam: info.winning_team,
      players,
      incomplete,
      objectives: objectiveTimeline(info),
    };
  }

  // Structure teams identify their owner, not the team that destroyed them.
  // IDs follow ECitadelTeamObjective in Valve's match metadata protobuf.
  function objectiveTimeline(info) {
    const validTime = (value) =>
      count(value) !== null &&
      value > 0 &&
      (!Number.isFinite(info.duration_s) || value <= info.duration_s);
    const events = [];
    for (const objective of Array.isArray(info.objectives)
      ? info.objectives
      : []) {
      if (!objective || !validTime(objective.destroyed_time_s)) continue;
      let id = objective.team_objective_id;
      let team = objective.team;
      // Older matches encode the owning team in a single legacy objective ID.
      if (
        id == null &&
        Number.isInteger(objective.legacy_objective_id) &&
        objective.legacy_objective_id >= 0 &&
        objective.legacy_objective_id < 32
      ) {
        id = objective.legacy_objective_id % 16;
        team = Math.floor(objective.legacy_objective_id / 16);
      }
      if (!Number.isInteger(id) || ![0, 1].includes(team)) continue;
      const type =
        id >= 1 && id <= 4
          ? "Guardian"
          : id >= 5 && id <= 8
            ? "Walker"
            : id === 10 || id === 11
              ? "Shrine"
              : id >= 12 && id <= 15
                ? "Base Guardian"
                : null;
      if (type)
        events.push({
          time: objective.destroyed_time_s,
          kind: "objective",
          team,
          type,
        });
    }
    for (const boss of Array.isArray(info.mid_boss) ? info.mid_boss : []) {
      if (boss && validTime(boss.destroyed_time_s)) {
        events.push({
          time: boss.destroyed_time_s,
          kind: "midboss",
          type: "Mid Boss",
        });
      }
    }
    return events.sort((a, b) => a.time - b.time);
  }

  // Select catalog-confirmed shop purchases and retain buy/removal times, including repeat buys.
  function purchases(player, catalog) {
    if (!Array.isArray(player.items)) return null;
    return player.items
      .filter((item) => item && catalog.get(item.item_id)?.type === "upgrade")
      .map((item) => ({
        id: item.item_id,
        bought: count(item.game_time_s),
        removed: count(item.sold_time_s) > 0 ? count(item.sold_time_s) : null,
      }))
      .sort((a, b) => (a.bought ?? Infinity) - (b.bought ?? Infinity));
  }
  // Deduplicate timestamps without inventing an initial balance or smoothing
  // decreases: net worth snapshots are the source of truth for every graph.
  function soulSamples(stats, duration) {
    const samples = new Map();
    for (const point of Array.isArray(stats) ? stats : []) {
      if (
        !point ||
        count(point.time_stamp_s) === null ||
        count(point.net_worth) === null ||
        (Number.isFinite(duration) && point.time_stamp_s > duration)
      )
        continue;
      samples.set(point.time_stamp_s, {
        time: point.time_stamp_s,
        souls: point.net_worth,
      });
    }
    return [...samples.values()].sort((a, b) => a.time - b.time);
  }
  // Join each recorded death to its killer by player slot; preserve unknown sources and times.
  function killTimeline(match) {
    const bySlot = new Map(
      match.players.map((player) => [player.slot, player]),
    );
    const events = [];
    for (const victim of match.players) {
      for (const event of victim.events) {
        if (!event || typeof event !== "object") continue;
        const time = count(event.game_time_s);
        events.push({
          victim,
          killer: bySlot.get(event.killer_player_slot) || null,
          time:
            time !== null &&
            (!Number.isFinite(match.duration) || time <= match.duration)
              ? time
              : null,
        });
      }
    }
    return events.sort(
      (a, b) =>
        (a.time ?? Infinity) - (b.time ?? Infinity) ||
        a.victim.slot - b.victim.slot,
    );
  }
  // These ranks come from the API. Do not substitute a locally calculated KDA score.
  function matchMvps(players) {
    return players
      .filter(
        (player) =>
          player.mvpRank !== null &&
          Number.isInteger(player.mvpRank) &&
          player.mvpRank >= 1 &&
          player.mvpRank <= 3,
      )
      .sort((a, b) => a.mvpRank - b.mvpRank || a.slot - b.slot);
  }
  return {
    objectiveTimeline,
    summarizeMatch,
    purchases,
    soulSamples,
    matchMvps,
    killTimeline,
  };
})();
if (typeof module !== "undefined") module.exports = DeadlockMatchStats;

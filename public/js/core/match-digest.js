import DeadlockMatchStats from "./match-stats.js";
import AnalysisStats from "./analysis-stats.js";

// Compact, model-ready facts about one player's match. Every number is computed
// here from normalized metadata; the language model explains and prioritizes but
// never derives values itself. null means unavailable and must not become zero.
const MatchDigest = (() => {
  // Bump when the digest shape or meaning changes: cached analyses are keyed by it.
  const VERSION = 2;
  const TEAM_NAMES = ["The Hidden King", "The ArchMother"];
  const PHASES = [
    { name: "laning (0-10 min)", start: 0, end: 600 },
    { name: "mid game (10-20 min)", start: 600, end: 1200 },
    { name: "late game (20+ min)", start: 1200, end: Infinity },
  ];
  // Things the metadata cannot tell us; the model is told not to speculate about them.
  const UNAVAILABLE = [
    "Assist attribution per kill (only total assists are recorded)",
    "Player positions or movement between snapshots",
    "Ability usage, cooldowns and damage by source",
    "Exact souls gained or lost per individual kill or death",
    "Comparison with other players of the same hero or rank",
  ];

  const round = (value) => (Number.isFinite(value) ? Math.round(value) : null);

  function build(match, catalogs, focusSlot) {
    const focus = match.players.find((player) => player.slot === focusSlot);
    if (!focus) throw new Error("That player is not in this match.");
    if (![0, 1].includes(focus.team))
      throw new Error("This player's team is unknown, so the match cannot be analysed.");
    const heroes = catalogs?.heroes || new Map();
    const items = catalogs?.items || new Map();

    // Players are referred to by hero; slots disambiguate a repeated hero.
    const heroCounts = new Map();
    for (const player of match.players)
      heroCounts.set(player.heroId, (heroCounts.get(player.heroId) || 0) + 1);
    const side = (player) =>
      player.slot === focus.slot ? "you" : player.team === focus.team ? "ally" : "enemy";
    const name = (player) => {
      const hero = heroes.get(player.heroId)?.name || `Hero ${player.heroId}`;
      return heroCounts.get(player.heroId) > 1 ? `${hero} (slot ${player.slot})` : hero;
    };
    const label = (player) => (player ? `${name(player)} [${side(player)}]` : "unknown / non-player");

    const finalSoulsRank = (player, pool) => {
      if (player.souls === null) return null;
      const known = pool.filter((p) => p.souls !== null);
      return 1 + known.filter((p) => p.souls > player.souls).length;
    };
    const allies = match.players.filter((p) => p.team === focus.team);
    const enemies = match.players.filter((p) => [0, 1].includes(p.team) && p.team !== focus.team);
    const laneOpponents =
      focus.lane === null ? [] : enemies.filter((p) => p.lane === focus.lane);
    const lanePartners =
      focus.lane === null
        ? []
        : allies.filter((p) => p.lane === focus.lane && p.slot !== focus.slot);

    // The shared advantage series is Hidden King minus ArchMother; flip it so
    // positive always means the focus player's team is ahead.
    const sign = focus.team === 0 ? 1 : -1;
    const lead = new Map(AnalysisStats.advantage(match).map((p) => [p.time, sign * p.souls]));
    // Snapshots are minutes apart, so the measurement time travels with the value.
    const leadBefore = (time) => {
      let value = { souls: null, timeS: null };
      for (const [t, souls] of lead) if (t <= time) value = { souls, timeS: t };
      return value;
    };
    const sampleMaps = new Map(
      match.players.map((p) => [p.slot, new Map(p.statSamples.map((s) => [s.time, s]))]),
    );
    const sampleAt = (player, time) => sampleMaps.get(player.slot).get(time) || null;

    // Only exact shared snapshot times are compared; nothing is interpolated.
    const checkpoints = focus.statSamples.map((sample) => {
      const lobby = match.players
        .map((p) => sampleAt(p, sample.time)?.souls ?? null)
        .filter((souls) => souls !== null);
      const opponents = laneOpponents.map((p) => sampleAt(p, sample.time)?.souls ?? null);
      const ownLane = [focus, ...lanePartners].map((p) => sampleAt(p, sample.time)?.souls ?? null);
      const total = (values) =>
        values.length && values.every((s) => s !== null) ? values.reduce((a, b) => a + b, 0) : null;
      return {
        timeS: sample.time,
        souls: sample.souls,
        soulsRankInLobby:
          sample.souls === null ? null : 1 + lobby.filter((souls) => souls > sample.souls).length,
        playersWithSnapshot: lobby.length,
        teamSoulsLead: lead.has(sample.time) ? lead.get(sample.time) : null,
        soulsVsLaneOpponentsAverage:
          sample.souls !== null && opponents.length && opponents.every((s) => s !== null)
            ? round(sample.souls - opponents.reduce((a, b) => a + b, 0) / opponents.length)
            : null,
        // Your lane's combined souls minus the opposing lane's: symmetric between the two sides.
        laneSoulsLead:
          total(ownLane) !== null && total(opponents) !== null
            ? total(ownLane) - total(opponents)
            : null,
        playerDamage: sample.playerDamage,
        damageTaken: sample.damageTaken,
        healing: sample.healing,
        creepKills: sample.creepKills,
        neutralKills: sample.neutralKills,
        soulsFrom: {
          players: sample.soulsFromPlayers,
          laneCreeps: sample.soulsFromLaneCreeps,
          neutrals: sample.soulsFromNeutrals,
          bosses: sample.soulsFromBosses,
        },
        soulsLostToDeaths: sample.soulsLostToDeaths,
      };
    });

    const timeline = DeadlockMatchStats.killTimeline(match);
    const deathEvents = timeline.filter((e) => e.victim.slot === focus.slot);
    const killEvents = timeline.filter(
      (e) => e.killer?.slot === focus.slot && e.victim.slot !== focus.slot,
    );
    const deaths = deathEvents.map((e) => {
      const before = e.time === null ? { souls: null, timeS: null } : leadBefore(e.time);
      return {
        timeS: e.time,
        killedBy: e.killer?.slot === focus.slot ? "self-attributed" : label(e.killer),
        deadForS: e.deadFor === null ? null : round(e.deadFor),
        teamSoulsLeadAtPreviousSnapshot: before.souls,
        previousSnapshotS: before.timeS,
      };
    });
    const kills = killEvents.map((e) => ({ timeS: e.time, victim: label(e.victim) }));

    const inPhase = (phase, time) =>
      time !== null && time >= phase.start && (time < phase.end || phase.end === Infinity);
    const teamOf = (player) => player?.team;
    // Phases that start after the match ended are omitted rather than reported as zero.
    const reached = (phase) => !Number.isFinite(match.duration) || match.duration > phase.start;
    const phases = PHASES.filter(reached).map((phase) => {
      const events = timeline.filter((e) => inPhase(phase, e.time));
      return {
        phase: phase.name,
        yourKills: killEvents.filter((e) => inPhase(phase, e.time)).length,
        yourDeaths: deathEvents.filter((e) => inPhase(phase, e.time)).length,
        teamKills: events.filter(
          (e) => teamOf(e.killer) === focus.team && e.victim.team !== focus.team,
        ).length,
        teamDeaths: events.filter((e) => e.victim.team === focus.team).length,
      };
    });

    // "Dead at the time" is only reported when every death has a time and duration.
    const deathWindowsKnown = deathEvents.every((e) => e.time !== null && e.deadFor !== null);
    const wasDead = (time) =>
      deathWindowsKnown
        ? deathEvents.some((e) => time >= e.time && time < e.time + e.deadFor)
        : null;
    const objectives = match.objectives.map((event) =>
      event.kind === "midboss"
        ? {
            timeS: event.time,
            type: "Mid Boss",
            claimedBy:
              event.claimedBy === null
                ? "unknown"
                : event.claimedBy === focus.team
                  ? "your team"
                  : "enemy team",
            youWereDead: wasDead(event.time),
          }
        : {
            timeS: event.time,
            type: event.type,
            destroyed: event.team === focus.team ? "your team's structure" : "enemy structure",
            youWereDead: wasDead(event.time),
          },
    );

    const bought = DeadlockMatchStats.purchases(focus, items);
    const purchases =
      bought === null
        ? null
        : bought.map((purchase) => {
            const item = items.get(purchase.id);
            return {
              timeS: purchase.bought,
              item: item?.name || `Item ${purchase.id}`,
              category: item?.item_slot_type ?? null,
              tier: Number.isInteger(item?.item_tier) ? item.item_tier : null,
              cost: Number.isInteger(item?.cost) ? item.cost : null,
              soldOrReplacedS: purchase.removed,
            };
          });

    const roster = match.players.map((p) => ({
      hero: name(p),
      side: side(p),
      lane: p.lane,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      finalSouls: p.souls,
      lastHits: p.lastHits,
      denies: p.denies,
      mvpRank: p.mvpRank,
    }));
    const untimed = timeline.filter((e) => e.time === null).length;
    const notes = [];
    if (match.incomplete)
      notes.push("The kill/death event log is incomplete or disagrees with the final scoreboard.");
    if (untimed) notes.push(`${untimed} death events have no valid time and are excluded from timed facts.`);
    if (!focus.statSamples.length) notes.push("No stat snapshots were recorded for this player.");
    if (focus.lane === null) notes.push("This player's lane assignment is unavailable.");
    if (!lead.size) notes.push("Team souls lead is unavailable: not every player has shared snapshots.");
    if (!deathWindowsKnown) notes.push("Some deaths lack a time or respawn duration, so 'youWereDead' is unavailable.");

    return {
      digestVersion: VERSION,
      match: {
        id: match.id,
        durationS: Number.isFinite(match.duration) ? match.duration : null,
        yourTeam: TEAM_NAMES[focus.team],
        result:
          ![0, 1].includes(match.winningTeam)
            ? "unknown"
            : match.winningTeam === focus.team
              ? "win"
              : "loss",
      },
      you: {
        hero: name(focus),
        lane: focus.lane,
        lanePartners: lanePartners.map(name),
        laneOpponents: laneOpponents.map(name),
        kills: focus.kills,
        deaths: focus.deaths,
        assists: focus.assists,
        finalSouls: focus.souls,
        finalSoulsRankInLobby: finalSoulsRank(focus, match.players),
        finalSoulsRankOnTeam: finalSoulsRank(focus, allies),
        lastHits: focus.lastHits,
        denies: focus.denies,
        level: focus.level,
        mvpRank: focus.mvpRank,
      },
      roster,
      checkpoints,
      phases,
      deaths,
      kills,
      objectives,
      purchases,
      dataQuality: {
        eventLogComplete: !match.incomplete,
        notes,
        unavailable: UNAVAILABLE,
      },
    };
  }

  return { VERSION, build };
})();

export default MatchDigest;

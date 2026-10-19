// Rule-based match summary: turns a match digest into short, factual points.
// No model is involved, so it is free, instant and cannot invent numbers. A
// point is only produced when every value it mentions is available.
const MatchSummary = (() => {
  // Thresholds for calling something notable. Below them a point is neutral or omitted.
  const LANE_SOULS_MARGIN = 500;
  const TEAM_LEAD_SWING = 2000;
  const DEAD_SHARE_HIGH = 0.1;
  const PHASE_DEATHS_HIGH = 3;

  const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const num = (n) => Math.abs(n).toLocaleString("en-US");
  const ordinal = (n) => {
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
    return `${n}${suffix}`;
  };
  const list = (names) =>
    names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const known = (value) => value !== null && value !== undefined;

  function build(digest) {
    const { you, match } = digest;
    const points = [];
    const add = (tone, title, detail, timeS = null) => points.push({ tone, title, detail, timeS });

    // Laning: the last snapshot within the first ten minutes.
    const lane = digest.checkpoints.filter((c) => c.timeS <= 600).at(-1);
    // The verdict uses lane totals so both sides of a lane get consistent results;
    // the player's own comparison is added as detail.
    if (lane && known(lane.laneSoulsLead) && you.laneOpponents.length) {
      const diff = lane.laneSoulsLead;
      const tone = diff >= LANE_SOULS_MARGIN ? "positive" : diff <= -LANE_SOULS_MARGIN ? "negative" : "neutral";
      const side = you.lanePartners.length ? `your lane (you and ${list(you.lanePartners)})` : "you";
      const own = lane.soulsVsLaneOpponentsAverage;
      const versus = you.laneOpponents.length > 1 ? `the average of ${list(you.laneOpponents)}` : you.laneOpponents[0];
      const personal =
        known(own) && you.lanePartners.length
          ? ` You personally had ${num(own)} ${own >= 0 ? "more" : "fewer"} than ${versus}.`
          : "";
      const rank = known(lane.soulsRankInLobby)
        ? ` You were ${ordinal(lane.soulsRankInLobby)} of ${lane.playersWithSnapshot} in the lobby for souls.`
        : "";
      add(
        tone,
        tone === "positive" ? "Won your lane" : tone === "negative" ? "Lost your lane" : "Even lane",
        `At ${clock(lane.timeS)}, ${side} had ${num(diff)} souls ${diff >= 0 ? "more" : "fewer"} than ${list(you.laneOpponents)}.${personal}${rank}`,
        lane.timeS,
      );
    }

    // Team lead swings, from the player's side.
    const leads = digest.checkpoints.filter((c) => known(c.teamSoulsLead));
    if (leads.length >= 2) {
      const peak = leads.reduce((a, b) => (b.teamSoulsLead > a.teamSoulsLead ? b : a));
      const low = leads.reduce((a, b) => (b.teamSoulsLead < a.teamSoulsLead ? b : a));
      const last = leads.at(-1);
      if (match.result === "loss" && peak.teamSoulsLead >= TEAM_LEAD_SWING && peak !== last) {
        add(
          "negative",
          "Lead slipped away",
          `Your team led by ${num(peak.teamSoulsLead)} souls at ${clock(peak.timeS)}, but ${last.teamSoulsLead < 0 ? `trailed by ${num(last.teamSoulsLead)}` : `led by only ${num(last.teamSoulsLead)}`} at ${clock(last.timeS)}.`,
          peak.timeS,
        );
      } else if (match.result === "win" && low.teamSoulsLead <= -TEAM_LEAD_SWING && low !== last) {
        add(
          "positive",
          "Came back from behind",
          `Your team trailed by ${num(low.teamSoulsLead)} souls at ${clock(low.timeS)} and still won.`,
          low.timeS,
        );
      }
    }

    // Kills compared with souls, within the player's own team.
    const team = digest.roster.filter((p) => p.side !== "enemy");
    if (known(you.kills) && you.kills > 0 && team.every((p) => known(p.kills))) {
      const killRank = 1 + team.filter((p) => p.kills > you.kills).length;
      const soulsRank = you.finalSoulsRankOnTeam;
      if (killRank === 1 && known(soulsRank)) {
        const converted = soulsRank <= 2;
        add(
          converted ? "positive" : "neutral",
          converted ? "Top fragger with the souls to match" : "Kills did not turn into souls",
          `You had the most kills on your team (${you.kills}) and finished ${ordinal(soulsRank)} of ${team.length} on your team in souls.`,
        );
      }
    }

    // Deaths and time spent respawning.
    const deaths = digest.deaths;
    if (known(you.deaths) && you.deaths === 0) {
      add("positive", "No deaths", "You did not die this match.");
    } else if (deaths.length && deaths.every((d) => known(d.deadForS)) && known(match.durationS)) {
      const dead = deaths.reduce((sum, d) => sum + d.deadForS, 0);
      const share = dead / match.durationS;
      add(
        share >= DEAD_SHARE_HIGH ? "negative" : "neutral",
        "Time spent dead",
        `You were dead for ${clock(dead)} across ${deaths.length} death${deaths.length === 1 ? "" : "s"}, ${Math.round(share * 100)}% of the match.`,
      );
    }
    const worst = digest.phases.reduce((a, b) => (b.yourDeaths > a.yourDeaths ? b : a), digest.phases[0]);
    if (worst && worst.yourDeaths >= PHASE_DEATHS_HIGH && known(you.deaths)) {
      add(
        "negative",
        "Deaths clustered in one phase",
        `${worst.yourDeaths} of your ${you.deaths} deaths came in the ${worst.phase}.`,
      );
    }
    const lostWhileDead = digest.objectives.filter(
      (o) => o.destroyed === "your team's structure" && o.youWereDead === true,
    );
    if (lostWhileDead.length) {
      const shown = lostWhileDead.slice(0, 3).map((o) => `${o.type} at ${clock(o.timeS)}`);
      const more = lostWhileDead.length > 3 ? ` and ${lostWhileDead.length - 3} more` : "";
      add(
        "negative",
        "Structures fell while you were dead",
        `Your team lost ${list(shown)}${more} while you were respawning.`,
        lostWhileDead[0].timeS,
      );
    }

    if (known(you.mvpRank))
      add("positive", `Match MVP #${you.mvpRank}`, `The game ranked you #${you.mvpRank} MVP across both teams.`);

    // Where the player's souls came from, at the last snapshot with full sources.
    const sourced = digest.checkpoints
      .filter((c) => Object.values(c.soulsFrom).every(known))
      .at(-1);
    if (sourced) {
      const parts = [
        ["lane creeps", sourced.soulsFrom.laneCreeps],
        ["neutral camps", sourced.soulsFrom.neutrals],
        ["kills on players", sourced.soulsFrom.players],
        ["bosses", sourced.soulsFrom.bosses],
      ];
      const total = parts.reduce((sum, [, value]) => sum + value, 0);
      if (total > 0)
        add(
          "neutral",
          "Where your souls came from",
          `By ${clock(sourced.timeS)}: ${parts
            .filter(([, value]) => value > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([name, value]) => `${name} ${Math.round((value / total) * 100)}%`)
            .join(", ")}.`,
        );
    }

    const result = match.result === "win" ? "Win" : match.result === "loss" ? "Loss" : "Result unknown";
    const kda = [you.kills, you.deaths, you.assists].every(known)
      ? ` · ${you.kills}/${you.deaths}/${you.assists}`
      : "";
    const souls = known(you.finalSoulsRankInLobby)
      ? ` · ${ordinal(you.finalSoulsRankInLobby)} of ${digest.roster.length} in souls`
      : "";
    return { headline: `${result} as ${you.hero}${kda}${souls}`, points };
  }

  return { build };
})();

export default MatchSummary;

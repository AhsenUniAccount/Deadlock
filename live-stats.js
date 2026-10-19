// Pure scouting calculations. Null means unknown; scores are indices, not probabilities.
const DeadlockLiveStats = (() => {
  const number = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
  const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
  const positive = (v) => count(v) !== null && v > 0;
  const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
  const average = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

  function roster(raw) {
    const seen = new Set();
    return (Array.isArray(raw) ? raw : []).flatMap((p) => {
      if (!positive(p?.account_id) || seen.has(p.account_id) || ![0, 1].includes(p.team)) return [];
      seen.add(p.account_id);
      return [{ accountId: p.account_id, heroId: positive(p.hero_id) ? p.hero_id : null, team: p.team }];
    });
  }

  // Empirical tied mid-rank, not arithmetic on rank labels or tier gaps.
  function percentile(badge, distribution) {
    if (!positive(badge)) return null;
    const rows = (distribution || []).filter((r) => positive(r.badge) && positive(r.players));
    const total = rows.reduce((s, r) => s + r.players, 0);
    if (!total || !rows.some((r) => r.badge === badge)) return null;
    return 100 * rows.reduce((s, r) => s + (r.badge < badge ? r.players : r.badge === badge ? r.players / 2 : 0), 0) / total;
  }

  // Aggregate same-hero populations within one rank tier (match-average badge proxy).
  function baseline(rows, heroId, badge = null) {
    const tier = positive(badge) ? Math.floor(badge / 10) : null;
    const selected = (rows || []).filter((r) => r.hero_id === heroId &&
      (tier === null || (r.bucket >= tier * 10 + 1 && r.bucket <= tier * 10 + 6)) &&
      count(r.wins) !== null && count(r.losses) !== null && count(r.matches) !== null &&
      r.wins + r.losses > 0 && r.wins + r.losses <= r.matches);
    const sum = (key) => selected.every((r) => number(r[key]) !== null && r[key] >= 0)
      ? selected.reduce((s, r) => s + r[key], 0) : null;
    const wins = sum("wins"), losses = sum("losses"), matches = sum("matches");
    if (wins === null || losses === null || matches === null || !matches) return null;
    const n = wins + losses;
    return { rate: wins / n, n, matches, rankAdjusted: tier !== null,
      kills: sum("total_kills") === null ? null : sum("total_kills") / matches,
      assists: sum("total_assists") === null ? null : sum("total_assists") / matches,
      deaths: sum("total_deaths") === null ? null : sum("total_deaths") / matches };
  }

  // Accept only completed, scored games known to have ended before the lobby began.
  function recentGames(rows, start, mode, currentId) {
    const seen = new Set();
    return (Array.isArray(rows) ? rows : []).filter((r) => {
      if (!positive(r?.match_id) || seen.has(r.match_id) || r.match_id === currentId ||
          !positive(r.start_time) || !positive(r.match_duration_s) ||
          r.start_time + r.match_duration_s > start || r.game_mode !== 1 ||
          (mode === null ? ![1, 4].includes(r.match_mode) : r.match_mode !== mode) || ![1, 2].includes(r.player_match_outcome)) return false;
      seen.add(r.match_id);
      return true;
    }).sort((a, b) => b.start_time - a.start_time || b.match_id - a.match_id).slice(0, 3);
  }

  function shrink(wins, n, prior, strength = 20) {
    if (count(wins) === null || !positive(n) || wins > n || number(prior) === null || prior < 0 || prior > 1) return null;
    const a = wins + prior * strength, b = n - wins + (1 - prior) * strength;
    const rate = a / (a + b);
    const se = Math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)));
    return { rate, lower: clamp(rate - 1.96 * se, 0, 1), upper: clamp(rate + 1.96 * se, 0, 1) };
  }

  function scout({ hero, population, rankPercentile, friendlyPercentiles = [], games = [], formPopulations = [] }) {
    const components = [], evidence = [];
    let estimate = null, heroMatches = 0;
    if (hero && positive(hero.matches_played) && count(hero.wins) !== null && hero.wins <= hero.matches_played && population?.n >= 100) {
      heroMatches = hero.matches_played;
      estimate = shrink(hero.wins, heroMatches, population.rate);
      components.push({ name: "Hero strength", weight: .5, score: clamp(50 + 200 * (estimate.rate - population.rate)) });
      evidence.push(`Hero win rate adjusted toward its ${population.rankAdjusted ? "rank-band" : "all-rank"} baseline using 20 prior matches.`);
    }
    const friendly = friendlyPercentiles.filter((p) => number(p) !== null);
    if (number(rankPercentile) !== null && friendly.length >= 3) {
      components.push({ name: "Rank context", weight: .3, score: clamp(50 + .5 * (rankPercentile - average(friendly))) });
      evidence.push(`Rank percentile ${rankPercentile.toFixed(0)} vs friendly average ${average(friendly).toFixed(0)} (${friendly.length} known ranks).`);
    }
    const form = games.flatMap((g, i) => {
      const p = formPopulations[i];
      if (!p || p.n < 100 || [g.player_kills, g.player_deaths, g.player_assists, p.kills, p.deaths, p.assists].some((v) => number(v) === null || v < 0)) return [];
      const ratio = (g.player_kills + g.player_assists + 2) / (g.player_deaths + 1);
      const expected = (p.kills + p.assists + 2) / (p.deaths + 1);
      const residual = .5 * Math.tanh(Math.log(ratio / expected)) + .5 * ((g.player_match_outcome === 1 ? 1 : 0) - p.rate);
      return [{ residual, ratio, expected, n: p.n }];
    });
    if (form.length) {
      components.push({ name: "Recent form", weight: .2,
        score: clamp(50 + 50 * average(form.map((f) => f.residual)) * form.length / (form.length + 10)) });
      evidence.push(`${form.length} recent games compared with same-hero, duration-band populations; shrunk with 10 baseline games. Noisy short window.`);
    }
    const coverage = components.reduce((s, c) => s + c.weight, 0);
    const score = coverage ? components.reduce((s, c) => s + c.score * c.weight, 0) / coverage : null;
    return { score, components: components.map((c) => ({ ...c, effectiveWeight: c.weight / coverage })),
      coverage, estimate, rawRate: estimate ? hero.wins / heroMatches : null, heroMatches, form, games, evidence,
      eligible: heroMatches >= 10 && population?.n >= 100 && coverage >= .5,
      quality: heroMatches >= 30 && coverage >= .99 && form.length === 3 ? "Moderate evidence" : "Limited evidence",
      missing: [!estimate && "hero comparison", !components.some((c) => c.name === "Rank context") && "rank comparison", form.length < 3 && "complete recent form"].filter(Boolean) };
  }

  // Whole-match co-occurrence supports strategic priorities, never duel or lane claims.
  function focusPlan(friends, opponents, counters, populations, overrides = new Map()) {
    const pairs = friends.map((f) => ({ friend: f, options: opponents.flatMap((o) => {
      const r = (counters || []).find((x) => x.hero_id === f.heroId && x.enemy_hero_id === o.heroId);
      const a = populations.get(f.accountId), b = populations.get(o.accountId);
      if (!r || !a || !b || !positive(r.matches_played) || r.matches_played < 100 || count(r.wins) === null || r.wins > r.matches_played) return [];
      const logit = (p) => Math.log(clamp(p, .01, .99) / (1 - clamp(p, .01, .99)));
      const expected = 1 / (1 + Math.exp(-(logit(a.rate) - logit(b.rate))));
      const posterior = shrink(r.wins, r.matches_played, expected, 100);
      if (!posterior || posterior.lower < expected + .02) return [];
      const edge = posterior.rate - expected;
      return [{ opponent: o, n: r.matches_played, edge, rate: posterior.rate,
        value: edge * (1 + (o.scouting?.eligible ? Math.max(0, o.scouting.score - 50) / 100 : 0)) }];
    }).sort((a, b) => b.value - a.value) }));
    const totals = new Map();
    pairs.forEach((p) => p.options.forEach((o) => totals.set(o.opponent.accountId, (totals.get(o.opponent.accountId) || 0) + o.value)));
    const priorities = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
    return pairs.map((p) => {
      const options = p.options.filter((o) => priorities.includes(o.opponent.accountId));
      const id = overrides.get(p.friend.accountId);
      return { ...p, primary: id ? { opponent: opponents.find((o) => o.accountId === id), manual: true } : options[0] || null,
        secondary: id ? null : options[1] || null };
    });
  }

  // Popularity chooses candidate core items; win rate is supporting observational evidence.
  function itemCandidates(rows, catalog, heroId, owned = new Set()) {
    const seen = new Set();
    return (rows || []).flatMap((r) => {
      const item = catalog.get(r.item_id);
      if (!item || seen.has(r.item_id) || owned.has(r.item_id) || item.shopable !== true || item.type !== "upgrade" ||
          item.disabled === true || (Array.isArray(item.heroes) && item.heroes.length && !item.heroes.includes(heroId)) ||
          !positive(r.matches) || r.matches < 100 || !positive(r.players) || r.players < 20 ||
          count(r.wins) === null || count(r.losses) === null || r.wins + r.losses === 0 || r.wins + r.losses > r.matches) return [];
      seen.add(r.item_id);
      return [{ ...r, item, rate: r.wins / (r.wins + r.losses), timing: number(r.avg_buy_time_s) !== null && r.avg_buy_time_s >= 0 ? r.avg_buy_time_s : null }];
    }).sort((a, b) => b.matches - a.matches || a.item_id - b.item_id);
  }

  class StreamState {
    constructor() { this.entities = new Map(); this.players = new Map(); this.clock = null; this.receivedAt = null; }
    apply(row, receivedAt = Date.now()) {
      if (!row || count(row.tick) === null || count(row.entity_index) === null) return false;
      const key = `${row.kind}:${row.entity_index}`, old = this.entities.get(key);
      if (old && row.tick < old.tick) return false;
      if (row.delta_type === "delete") {
        if (old?.account_id && this.players.get(old.account_id)?.entity_index === row.entity_index) this.players.delete(old.account_id);
        if (row.kind === "clock" && this.clock?.entity_index === row.entity_index) this.clock = null;
        this.entities.delete(key); return true;
      }
      const merged = { ...old };
      for (const [k, v] of Object.entries(row)) if (v !== null && v !== undefined) merged[k] = v;
      merged.receivedAt = receivedAt;
      this.entities.set(key, merged);
      if (merged.kind === "clock" && number(merged.game_time) !== null && merged.game_time >= 0) {
        if (!this.clock || merged.tick >= this.clock.tick) this.clock = merged;
      } else if (merged.kind === "player" && positive(merged.account_id) && [2, 3].includes(merged.team)) {
        if (old?.account_id && old.account_id !== merged.account_id && this.players.get(old.account_id)?.entity_index === row.entity_index) this.players.delete(old.account_id);
        const previous = this.players.get(merged.account_id);
        if (!previous || merged.tick >= previous.tick) this.players.set(merged.account_id, merged);
      }
      this.receivedAt = receivedAt; return true;
    }
  }
  return { number, count, average, roster, percentile, baseline, recentGames, shrink, scout, focusPlan, itemCandidates, StreamState };
})();
export default DeadlockLiveStats;

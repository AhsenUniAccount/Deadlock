// Where a player's average game sits among all games at their rank. The API
// returns per-game quantiles (1st..99th) for each metric; the player's average
// is placed on that curve by linear interpolation between quantiles.
const PlayerPercentiles = (() => {
  const QUANTILES = [1, 5, 10, 25, 50, 75, 90, 95, 99];

  const fixed = (digits) => (n) => n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const whole = (n) => Math.round(n).toLocaleString("en-US");
  const percent = (n) => `${(n * 100).toFixed(1)}%`;

  // lowerIsBetter flips the percentile so it always reads "better than X%".
  const METRICS = [
    { key: "net_worth_per_min", label: "Souls per minute", format: whole },
    { key: "player_damage_per_min", label: "Damage per minute", format: whole },
    { key: "kda", label: "KDA", format: fixed(2) },
    { key: "kills", label: "Kills", format: fixed(1) },
    { key: "deaths", label: "Deaths", format: fixed(1), lowerIsBetter: true },
    { key: "assists", label: "Assists", format: fixed(1) },
    { key: "last_hits", label: "Last hits", format: whole },
    { key: "denies", label: "Denies", format: fixed(1) },
    { key: "boss_damage_per_min", label: "Objective damage per minute", format: whole },
    { key: "accuracy", label: "Accuracy", format: percent },
    { key: "crit_shot_rate", label: "Headshot rate", format: percent },
  ];

  // Percent of games with a lower value. Outside the 1st..99th range the result
  // is clamped and flagged, since the tails are not measured.
  function percentileOf(value, stats) {
    if (!Number.isFinite(value) || !stats) return null;
    const points = QUANTILES.map((q) => [q, stats[`percentile${q}`]]);
    if (points.some(([, v]) => !Number.isFinite(v))) return null;
    if (value <= points[0][1]) return { value: 1, clamped: "low" };
    if (value >= points.at(-1)[1]) return { value: 99, clamped: "high" };
    for (let i = 1; i < points.length; i++) {
      const [q0, v0] = points[i - 1];
      const [q1, v1] = points[i];
      if (value <= v1) {
        // Equal quantile values (flat curve) sit at the upper quantile.
        const share = v1 === v0 ? 1 : (value - v0) / (v1 - v0);
        return { value: q0 + share * (q1 - q0), clamped: null };
      }
    }
    return null;
  }

  // mine: the API's metrics filtered to the player; population: the same
  // metrics for all players at their rank.
  function build(mine, population) {
    return METRICS.flatMap((metric) => {
      const yours = mine?.[metric.key]?.avg;
      const placed = percentileOf(yours, population?.[metric.key]);
      if (!placed) return [];
      const better = metric.lowerIsBetter ? 100 - placed.value : placed.value;
      const clamped = metric.lowerIsBetter
        ? { low: "high", high: "low" }[placed.clamped] || null
        : placed.clamped;
      const rounded = Math.round(better);
      return [
        {
          key: metric.key,
          label: metric.label,
          value: metric.format(yours),
          typical: metric.format(population[metric.key].percentile50),
          percentile: better,
          display:
            clamped === "high" ? "Top 1%" : clamped === "low" ? "Bottom 1%" : rounded >= 50 ? `Top ${Math.max(1, 100 - rounded)}%` : `Bottom ${Math.max(1, rounded)}%`,
          tone: better >= 75 ? "positive" : better < 25 ? "negative" : "neutral",
        },
      ];
    });
  }

  return { METRICS, percentileOf, build };
})();

export default PlayerPercentiles;

# Live match scouting v0.1

Implemented at `public/live.html`, linked from Overview, Hero Meta, and match breakdowns. It reuses the existing masthead, match sections, typography, portraits, and colors. No login, API key, backend, or new runtime dependency is required. Public API calls follow `public/js/core/common.js` directly from the browser. The site Worker (used for AI match review) is not involved; any private key must stay in Worker secrets, never in these scripts.

The site is hosted on Cloudflare Workers. A read-only check of `/tier-lists.html` returned a 307 redirect to `/tier-lists`, so sitemap and canonical URLs use the extensionless hosted paths. Local development links retain `.html` to work with the simple Python server. The sitemap now covers `/`, `/tier-lists`, and `/live`.

## Verified contract — 15 October 2026

Sources: [API specification](https://api.deadlock-api.com/openapi.json), [API reference](https://api.deadlock-api.com/docs). Read-only probes used an existing publicly listed broadcast; no Steam account credentials were involved.

| Source | Observed contract | Limits and interpretation |
| --- | --- | --- |
| `/v1/matches/active` | 150 matches in the sampled response. Normal and Street Brawl modes appeared. Normal match 117220040 had 12 player account/hero/team records, start time, team souls, queue, region, and compatibility version. | Documented Watch-list cap 200. `duration_s` was null in the sampled lobby. This is not discovery of every account’s current match. Page discovery shows normal mode only. |
| `/v1/matches/live/urls` | Existing public URL for the sampled match; 320 listed broadcasts in the sample. | Listed URLs can become stale. Use these before requesting another spectate URL. Never fetch the raw HTTP broadcast in the browser; send it to the HTTPS query service. |
| `/v1/matches/demo/schema` | Controller fields include account ID, hero, team, gold net worth, K/D/A. Game-rules fields include match-clock anchor and anchor tick. | SQL identifiers are case sensitive and require double quotes. Schema is taken from a recent completed demo, so a future live version can differ. Runtime schema errors remain visible. |
| `/v1/matches/demo/live/query` | Combined controller/game-rules `UNION ALL` query successfully streamed SSE. Engine teams 2/3 matched REST teams 0/1. A 12-second probe received 29,589 rows including a large initial burst and 12 playing accounts. | HTTP 200 can carry `event: error`. Spectator/bot rows with account 0 and team 1 were excluded. Receipt cadence is not simulation cadence. No source wall-clock timestamp was present; true broadcast delay could not be verified. |
| Clock | Sample anchor 848.625 seconds and anchor tick 60628 appeared in a row at tick 86647. | The anchor is not necessarily current match time. No tick-rate assumption or wall-clock extrapolation is made. Watch duration, if present, is labeled as a snapshot; otherwise the anchor is labeled explicitly. |
| Rank | One batched request returned 12 account records and latest ranked-match metadata. Distribution has badge/player counts. | Use supported rank endpoints. Protected accounts may be omitted; zero badge means unknown. Current ranks from after the target lobby are rejected; earlier completed history can provide a fallback. |
| Histories | Sample account returned 1,849 entries with outcomes, KDA, duration, hero, mode, and ranked badge. | Only that account’s records are retained. Non-bot-friend histories are stored records, not guaranteed complete coverage. Last-three view is same-mode, completed, scored history before the lobby. |
| Hero analytics | `bucket=avg_badge` returned hero/badge aggregates with wins/losses and performance totals. Per-account queries returned explicit wins and losses. | Per-account analytics are cached and fetched with concurrency 3, rather than interpreting unscored games as losses in the convenience hero endpoint. Rank cohorts use a match-average-badge proxy. |
| Items/builds | Item analytics returned purchase counts, unique players, outcomes and average buy time. Published builds expose category/mod `ability_id` paths. | Purchase timing and win associations are observational. Build popularity lacks an explicit game-mode filter; normal-mode item evidence and current-catalog checks still apply. Inventory IDs use an unverified binary encoding, so inventory is unavailable. |
| Patch notes | Latest note title was `09-29-2026`, while its `pub_date` was `2026-10-15T03:12:00Z`. | Publication date is not a trustworthy patch-start timestamp. Windows use a labeled calendar-date proxy parsed from titles, or a rolling 30-day fallback. Exact client-version cohorts cannot be certified by the inspected analytics filters. |

The query is inspectable in `public/js/core/live-data.js` as `LIVE_QUERY`. An existing listed broadcast allows 20 query connections/min/IP; a query/spectate acquisition by match ID is documented at 6/hour/IP. Rank batch: 20/min/IP. Rank distribution: 5/min/IP. Analytics share 200/min/IP. The page does not make a separate spectate request on each retry.

## Scoring and population

`public/js/core/live-stats.js` is pure and independently testable. Scouting v0.1 is an unvalidated index, not a probability or a causal measure of player impact.

- Hero strength: 50% starting weight. Scored wins/losses on the selected hero are compared with the same-hero, same-mode population in the account’s rank tier, using the match’s average badge as a cohort proxy. The adjusted rate is `(wins + 20 * baselineRate) / (scoredMatches + 20)`. The displayed interval is a normal approximation to the conditional Beta posterior; baseline uncertainty and missing-match bias are not fully represented. Prior strength 20 is provisional.
- Rank context: 30%. Compute the account badge’s empirical tied midpoint percentile from ranked-player counts. Compare it with the mean of at least three known friendly percentiles. No equal numeric spacing between named ranks is assumed.
- Recent form: 20%. Display the last three completed, scored games in this mode on any hero. Compare smoothed KDA and outcomes with each game’s hero/rank/10-minute-duration-band population. Shrink with 10 baseline games. Missing baselines stay missing; games over the analytics endpoint’s 7,000-second maximum receive no duration comparison.
- Missing components are removed from the weight denominator and disclosed. At least 10 matching hero games and 100 scored population observations are required to rank a top threat. Rank-only evidence never qualifies. Fewer than three eligible opponents leaves explicit insufficient-evidence slots. Close scores are flagged as uncertain.

Historical windows exclude this match ID and all later IDs. Aggregate analytics stop two hours before the lobby start, leaving a safety margin beyond the API’s 7,000-second duration filter. Recent histories must have ended before the lobby. Unknown start time uses a labeled current retrieval cutoff; it cannot support an exact pregame reconstruction. Ranked and unranked data remain separate when queue is known; otherwise the scope explicitly says both.

## Focus and build evidence

Focus pairs need at least 100 whole-match pair observations. Shrink pair wins with 100 prior observations toward the expectation calculated from the two heroes’ baseline win rates. Only recommend pairs whose approximate lower interval exceeds that expectation by 2 percentage points. Coordinate automated assignments around at most two supported opponents. These are pooled-rank observational associations, with no lane, role, reach, or positional confirmation. A player without a supported edge gets no forced assignment. Manual choices are labeled as overrides.

Core candidates follow the most-used qualifying published build when resolvable. Every displayed item must also have at least 100 matching purchase observations, 20 players, current shop availability, applicable hero restrictions, and no manual owned flag. Unsupported core paths fall back to clearly labeled frequently observed item candidates. Situational candidates are observed in matches against the priority hero; they are not claimed to be mechanical counters. If no pairing or item evidence exists, the UI says so. Current inventory is never inferred from final-match metadata.

## Runtime and failure behavior

- Only Watch snapshots poll every 30 seconds. Histories/scouting cache for 10 minutes, catalogs for one hour; build detail caches one hour. History and scouting endpoints are not refetched on each SSE event. Requests are bounded to three concurrent operations, build jobs to two.
- Shared HTTP requests time out after 20 seconds. The live wrapper retries 429/503 at most once, honors `Retry-After`, and skips an automatic retry if it asks for more than 10 seconds. A broadcast tries at most two reconnects, and stalls after 45 seconds without rows. Terminal authorization/schema/rate-limit errors require a manual retry.
- Stream frames are parsed incrementally, including multiline/chunk-split data and error events. Sparse fields merge without converting unknown to zero. Older entity/player ticks cannot overwrite newer state. Rendering of frequent observations is throttled to once per second. A new match or hero roster aborts obsolete enrichment. Team changes recompute friendly-relative comparisons and request the newly relevant builds.
- Current pressure is intentionally **unavailable** because source delay is unverified. Received KDA/souls are labeled broadcast observations with receipt age. “Connected” means the transport delivered rows, not that the game state is current. No end-of-game metadata is used as live telemetry.
- API-provided text is rendered through `textContent`; profiles and portraits retain the shared HTTPS URL policy. Broadcast URLs are accepted only for the requested match under Steam/Valve broadcast hosts. No supplied text/annotations become HTML or executable SQL.

## Backtest and verification

Run a bounded retrospective diagnostic with explicit completed normal-game IDs:

```sh
node scripts/backtest-live.mjs 117202274 117181625
```

It makes read-only public API calls and caches responses in the OS temporary directory. It writes `docs/live-backtest-results.json`. Rankings are evaluated against an explicit post-match log-KDA residual proxy; that is not ground-truth threat or causal contribution. Calibration is only diagnostic for the historical adjusted win-rate component. The scouting index itself has no probability calibration. Current rank is rejected for past matches, and population/distribution features are bounded before each target. Retrospective late ingestion is still a limitation.

Initial pilot: two selected matches; 7/12 and 6/12 eligible players; three eligible team-ranking comparisons. Mean precision@3 was 0.556 against a 0.500 random reference. Mean NDCG@3 was 0.778. For 23 correlated player outcomes, adjusted hero-rate Brier was 0.294, worse than the 0.250 constant-half reference. This is insufficient to validate or tune the model. Keep the preview labeling; a larger chronological held-out dataset and prospective archived pregame snapshots are needed before claiming predictive performance. No weights were tuned to this pilot.

Automated checks cover source filtering, shrinkage, missing components, percentile ranks, safe recommendations, split SSE frames/error events, stale updates, partial lobbies, team changes, and cancellation. Run `npm test`.

Browser-render verification could not run in the authoring session: native computer-use service startup failed and no in-app browser was available. Local HTTP and controller checks are recorded separately; desktop/mobile visual checks remain necessary before deployment.

## Acceptance scope

Implemented: manual/discovered match flow, transport state and receipt times, partial roster, last-three histories, transparent prototype top threats, percentile ranks, separate broadcast observations, guarded focus plan/overrides, current-catalog build candidates/manual owned filters, source details, caching/cancellation and failure states, existing visual components, and a recorded retrospective diagnostic.

Unavailable or unvalidated: complete own/private-match discovery, measured end-to-end latency, current-pressure scoring, verified live inventory, verified lane/position/hero-tool access, exact current-client-version analytics, established mechanical item counters, and validated predictive weights. The UI exposes these limits rather than manufacturing those signals.

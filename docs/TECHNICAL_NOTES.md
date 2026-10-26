# DeadStats technical notes

Detailed reference for contributors: what each statistic means, API details, and design constraints. For an overview, see the [README](../README.md).

A standalone browser tracker with a dark dashboard in warm charcoal, cream, and muted brass. Search a Steam player name, choose the matching account, and retrieve recent statistics from the community-run [Deadlock API](https://api.deadlock-api.com/docs). Statistics need no API key or account. Match pages open with a **Match summary** of the selected player's game, built from the statistics in the browser, plus an optional **AI coach** explanation from a free Cloudflare Workers AI model. Internet access is required for searches and match data.

## Use it

1. Run the site locally (see [Run locally](#run-locally)) or open the hosted site.
2. Start typing a Steam display name. After at least two characters and a 300 ms pause, matching accounts appear below the input with Steam avatars. **Search** or Enter also runs an immediate search.
3. Click a matching player, or use Up/Down and Enter. Escape closes the suggestions. Account IDs distinguish players with identical names.
4. Review their latest 20 recorded matches, per-hero win rates, and individual match K/D/A and durations. Hero portraits appear beside names in both tables.
5. Click **View match** on any row, or enter a match ID beside the history table. A separate match tab opens and shows every player’s kills, deaths, assists, and final souls. All players’ purchased items appear below the team scoreboards. Select a player’s name to highlight their build and souls timeline. Your player-search tab stays open. The match URL can be bookmarked or shared; reopening it loads the same match.

You can also enter a numeric Steam account ID (SteamID3's account number) or a SteamID64 to load that account directly. Steam profile URLs and vanity URLs are not supported. Name search covers profiles indexed by the API, so an account ID may work when a name does not.

## What the statistics mean

The app downloads the available match history, removes duplicate match IDs, sorts by match start time, and takes the latest 20 records. This includes all game and match modes returned by the API; it is not a ranked-only or lifetime summary. The displayed date range uses your local timezone.

Win rates use `player_match_outcome`: 1 is a win and 2 is a loss. Invalid, penalized, penalized-party, unscored, or unknown outcomes appear as **Other** and do not enter the win-rate denominator. The recent overall rate is total wins divided by total wins plus losses, not an average of hero rates. A player or hero with no scored matches shows `—`.

The API is unofficial and is not endorsed by Valve. Its recorded history may be incomplete or delayed. According to its match-history documentation, accounts that are not friends with one of its bots receive stored history only. This tracker does not request bot access or force a refresh. If the API responds with rate-limited stored history, the page labels that fallback.

## Hero meta chart

Open **Hero meta** beside Overview to compare hero pick rate with win rate. The default is the last 30 days, normal game mode, ranked matches at Oracle and above, and at least 1,000 scored matches per hero. Choose 7/30/90 days, Ranked or Unranked, a ranked threshold, and minimum sample size, then select **Apply filters**. The rank selector is hidden for Unranked.

The page calls `/v1/analytics/hero-stats` with `bucket=no_bucket` and explicit time/mode filters. Ranked thresholds use `min_average_badge`, which filters on the average badge level of both teams in a match. Pick rate is a hero's matches divided by the sum of matches across all heroes in the filtered API response; heroes excluded by the minimum-sample display filter still count in this denominator. Win rate is wins divided by wins plus losses. Unscored matches do not affect win rate, and heroes without scored results are omitted. No individual account filter is applied.

These stats cover the API's recorded matches and are not guaranteed full-playerbase coverage. Windows can span patches. Missing hero metadata falls back to initials, while API failures and empty results are explicitly labelled. Requests use the shared timeout/cancellation and five-minute local cache.

## Individual match breakdowns

The page starts with the match-wide MVPs in the API’s `mvp_rank` order (1–3), with their K/D/A and team. No MVP score is calculated locally; missing rankings show an unavailable message. Contents links below the MVPs jump to and open the corresponding section. The current order is:

1. **Player analysis** — open by default, with player perspective, large final K/D/A, and the individual souls timelines.
2. **KDA table** — collapsed by default, with one scoreboard per team.
3. **Items** — collapsible purchase histories for every player.
4. **Lane comparison** — collapsible comparison of any two opposing players.
5. **Match analysis** — collapsible team souls advantage graph with objective markers.
6. **Kill timeline** — collapsible chronological kill/death log.

Match scoreboards are split into **The Hidden King** (Amber) and **The ArchMother** (Sapphire), with a separate K/D/A and souls table for each team. Player selection works across both tables.

Match scoreboards use the final `kills`, `deaths`, `assists`, and `net_worth` fields from `match_info.players`. Souls means final net worth (including souls already spent), not an unspent wallet balance.

The kill timeline orders recorded deaths by `death_details[].game_time_s`, resolving killers by player slot and displaying player names and heroes. Unknown/non-player killers and self-attributed deaths are labelled. Events with missing or invalid times appear last; incomplete logs are flagged.

Timed kill and death counts in opponent comparisons use each victim's `death_details[].killer_player_slot`, joined to the roster by `player_slot`, not array position or account ID. Untimed events are excluded from time-specific counts. Incomplete logs are flagged, while the final scoreboard remains independent of event-log completeness.

**Limitation: per-player assist attribution is unavailable.** The verified metadata and its protobuf definition provide total assists but no assister identifiers in death events. The analysis shows assists as unavailable at a particular game time; it does not infer attribution from damage or proximity.

Player names are retrieved in a single batch. Missing Steam profiles fall back to account IDs, and missing hero metadata falls back to hero IDs. Match metadata loads on demand and is cached in memory for 30 minutes. Unavailable matches show a retry option. Leaving or replacing a match cancels pending requests.

Purchases are shown chronologically with current item names and icons. Ability unlocks and upgrades are excluded using the catalog's `type: upgrade` classification for shop items. Repeat purchases remain separate. Removal timestamps are labelled “sold / replaced” because they may represent sales or components replaced by upgrades; the list is purchase history, not a claimed final inventory. Missing catalogs or purchase logs are explicitly labelled. Unidentified entries are counted in a notice.

The match tab includes a **Player analysis** line chart for all players. The X axis is elapsed game time and the Y axis is souls (net worth). Lines connect validated `stats[].time_stamp_s` / `net_worth` snapshots; no start-of-game or missing values are invented. A hero-portrait dropdown selects the player perspective while keeping all available lines visible. The highlighted player has a solid green line; other players have dotted lines. Teammates are green and opponents red, relative to the player selected in the scoreboard. Selecting another player updates the chart, final K/D/A, event markers, and friendly-objective perspective in Match analysis. Hovering a player line shows their username and hero portrait. Missing timelines are labelled. The chart scrolls horizontally on narrow screens.

## API integration

The browser calls these endpoints directly; the service currently permits cross-origin requests:

- `GET /v1/players/steam-search?search_query=NAME&limit=20&min_matches_played_last_30d=0`
- `GET /v1/players/{account_id}/match-history`
- `GET /v1/assets/heroes`
- `GET /v1/assets/items`
- `GET /v1/analytics/hero-stats?bucket=no_bucket&game_mode=normal&match_mode=...&min_unix_timestamp=...&max_unix_timestamp=...`
- `GET /v1/matches/{match_id}/metadata`
- `GET /v1/players/steam?account_ids=ID1,ID2,...`

Base URL: `https://api.deadlock-api.com`. See the [OpenAPI specification](https://api.deadlock-api.com/openapi.json) for the source contract.

Typing immediately cancels obsolete requests, even before the debounce delay expires. Clearing the field closes the dropdown and clears the selection. IME composition waits until input is committed. Missing or failed avatar and hero images fall back to initials.

Requests have a 20-second timeout. New searches and player selections cancel obsolete requests so old results cannot replace the current selection. Successful results are cached in memory: searches for one minute, match history for five minutes, and hero names for the page session. Reloading clears these local caches; the service may still return its own cached data. Searches and selected account IDs are sent to the API. API results are kept in memory only. No credentials are stored.

The Worker uses the same `public/js/core/common.js` request helper for the AI coach. Any private credentials (such as an optional Anthropic key) live only in the Worker's secrets, never in browser code.

## Files

- `public/live.html`, `public/css/live.css`, `public/js/ui/live.js`: live scouting page, match discovery, broadcast observations, roster, focus overrides, and build evidence.
- `public/js/core/live-data.js`: public API batching/caching, cohort queries and bounded SSE transport.
- `public/js/core/live-stats.js`: pure scouting, rank percentile, recommendation guards and stream state normalization.
- `docs/LIVE_MATCH_ANALYSIS.md`: verified API contract, provisional model, failure behavior, backtest and implementation limits.
- `scripts/backtest-live.mjs`, `docs/live-backtest-results.json`: reproducible retrospective diagnostic and initial pilot results.
- `public/sitemap.xml`, `public/robots.txt`: crawl discovery for the canonical Overview, Hero Meta and Live Scouting pages on `deadstats.ahsenjauhar.workers.dev`.

- `public/css/deadlock-theme.css`: shared visual theme (period-style headings, squared panels, team accents and report stamps), loaded after the base styles.
- `public/images/tracker-seal.svg`: the original emblem, used for the favicon and 404 page.

- `public/index.html`: search form and results structure.
- `public/404.html`, `public/images/404-character.png`: custom Cloudflare Pages not-found page and its character artwork.
- `public/tier-lists.html`, `public/js/ui/tier-lists.js`: aggregate hero scatter plot, filters, and rendering.
- `public/js/core/tier-stats.js`: validated hero counts, pick-rate, and win-rate calculations.
- `tests/tier-stats.test.js`: ranking, ties, unscored results, and validation checks.
- `public/css/styles.css`: responsive dashboard styling using system fonts; profile avatars and hero portraits load from image URLs supplied by the API.
- `public/js/core/stats.js`: ID conversion and match aggregation.
- `public/js/ui/app.js`: API requests, state, and rendering.
- `public/js/ui/match.js`: standalone match page, scoreboard, Steam profile enrichment, and player highlighting.
- `public/match.html`: match page opened in a new tab using `?id=MATCH_ID&player=ACCOUNT_ID`.
- `public/js/core/common.js`: shared API requests and rendering helpers.
- `public/js/ui/souls-chart.js`: individual SVG souls timelines, player perspective dropdown, and player/item event tooltips.
- `public/js/core/match-stats.js`: roster validation, event-log completeness, purchases, player/objective timelines, and API MVP ranks.
- `public/js/core/analysis-stats.js`: pure team-advantage and opponent calculations; retained historical helpers are not exposed in the UI.
- `public/js/core/match-digest.js`: per-player match facts used by the summary and sent to the AI model.
- `public/js/core/match-summary.js`: rule-based match summary points built from a digest.
- `public/js/ui/review-panel.js`: Match summary (with **Copy summary**) and AI coach panel on the match page.
- `public/js/core/player-trends.js`: per-match takeaways, recent-game patterns and same-rank hero comparisons, from match history and hero-stats aggregates.
- `public/js/core/player-percentiles.js`: places a player's average game on the per-game quantile curve of all games at their rank.
- `public/js/ui/profile-view.js`: renders the profile's percentile cards, patterns and hero comparison.
- `public/privacy.html`: privacy policy (what the site shows, who processes requests, what is stored, Valve disclaimer), linked from every footer. Update it when data handling changes, such as adding analytics or switching the AI provider.
- `public/css/site.css`: shared look on every page (DeadStats brand, centred headings with a brass highlight, pill controls, rounded cards).
- `public/css/home.css`: front-page layout: centred hero search, feature previews before a search (`landing-only`), and the profile header after one (`player-only`, toggled by the `has-player` body class; `compact` shrinks the hero after the first search).
- `public/history.html`, `public/js/ui/history.js`: match history tab (latest 50 matches with takeaways), opened from the profile.
- `tests/player-percentiles.test.js`: interpolation, clamping and lower-is-better metrics.
- `tests/player-trends.test.js`: takeaway rules and scored-game filtering.
- `public/images/favicon.svg`, `public/images/apple-touch-icon.png`, `public/images/og-card.png`: site icon and the 1200×630 link-preview image.
- `tests/match-summary.test.js`: summary rules, thresholds and missing data.
- `worker/index.js`, `worker/analyze.js`: Cloudflare Worker routes (`/api/analyze`, `/api/digest`), caching, rate limiting and the Claude request.
- `wrangler.jsonc`, `package.json`: Worker configuration, unpublished files, and dependencies/scripts.
- `tests/match-digest.test.js`: digest perspective, shared snapshots, death windows and missing data.
- `public/js/ui/match-analysis.js`: lane comparison UI, team souls advantage graph, and objective hover markers.
- `public/images/rejuvenator.svg`: local Rejuvenator-inspired symbol for Mid Boss deaths.
- `tests/analysis-stats.test.js`: synchronized snapshots, event boundaries, historical selection, and purchase timings.
- `tests/match-stats.test.js`: sparse slots, incomplete logs, unknown killers, souls, objective IDs/times, and metadata validation.
- `tests/stats.test.js`: calculation and input-validation checks.
- `tests/app.test.js`: search debounce, keyboard navigation, avatars, IME input, API errors, stored-history fallback, and request cancellation checks.

## Run locally

The pages are ES modules, which browsers do not load from `file://` URLs, so serve the folder over HTTP. Install dependencies once with `npm install`, then:

```sh
npm run dev:offline  # pages + Worker at http://127.0.0.1:8787, no Cloudflare login needed
npm run dev          # same, with the AI coach (needs `npx wrangler login` once)
npm test          # calculation, digest and page-controller tests (Node 22+)
```

Workers AI has no local emulator, so `npm run dev` connects to your Cloudflare account and its requests count toward the free daily allowance. In `dev:offline`, the summary works and the AI button reports that AI is not configured. A plain static server (`python3 -m http.server 8000 --bind 127.0.0.1`) still serves the statistics pages, but not `/api/*`.

## Match analysis and review

The match page keeps its existing dark styling and adds an **Analysis** contents link. Team souls analysis covers both teams; lane comparison has independent player selectors:

- **Team souls advantage:** The Hidden King’s total minus The ArchMother’s total, using only snapshot times available for every player. Missing team data is never treated as zero.
- **Kills, deaths and purchases on the souls graph:** hollow green kill circles, red death Xs, brass shopping-cart purchase icons for the highlighted player. A key below the graph explains the markers; a portrait dropdown changes the player perspective. Kill and death tooltips identify the other player and hero; purchase tooltips show the item. Exact souls gained or lost per kill/death are unavailable in the current metadata integration and are labelled accordingly; snapshot changes are not attributed to individual events. Selecting a marker opens the section and displays its timestamp below the graph; it does not seek a replay.
- **Objective markers in Match analysis:** red Xs along the upper row identify destroyed friendly Guardians, Base Guardians, Walkers and Shrines. “Friendly” follows the player selected in Player analysis or the scoreboard. Hover or keyboard-focus a marker to see its objective type, team and destruction time. Rejuvenator-style symbols along the bottom mark Mid Boss deaths for either team. The checkbox toggles these markers independently of player events. These markers are **not** on the Player analysis graph.
- **Lane comparison:** a separate collapsible section lets you select any first player, a second player restricted to the opposing team, and a game time to compare souls, recorded kills/deaths, and first item purchase timings. Snapshot times are shown; a souls difference is calculated only for matching times. Timed assists are unavailable.

Objective events come from `match_info.objectives[].destroyed_time_s` and `match_info.mid_boss[].destroyed_time_s`. Structure IDs are translated from `team_objective_id`; older matches can use `legacy_objective_id`. Structure team IDs identify the owning team. Zero, invalid, out-of-duration and unknown structure events are omitted. Missing objective arrays yield no markers; this does not establish that no objectives fell. Mid Boss markers indicate death time, not Rejuvenator pickup time or the identity of the player who claimed it.

The team advantage remains Hidden King minus ArchMother regardless of the selected player; only the friendly-objective filter changes with selection. Lines between snapshots are visual connections, not measured values between those timestamps. No interpolation is used to claim exact income or losses.

Detailed player encounters, five-minute performance panels, recent-game/item comparisons, replay bookmarks, and the separate clickable event list below Player analysis are not part of the current UI. The kill timeline remains a separate section.

Contents links automatically open their collapsible target section.

## Player profile and match history

Searching a player opens their profile at `index.html?player=ACCOUNT_ID`, which can be bookmarked or shared. **Match history ↗** opens `history.html?player=ACCOUNT_ID` in a new tab with the latest 50 matches, each with a takeaway and a link to its breakdown.

The profile is two columns. On the left: the player card (avatar, rank, win rate and record over the last 20 matches, Match history and Copy profile link), their three most-played heroes over the last 30 days with win rate and average K/D/A (`PlayerTrends.topHeroes`), and their most recent standard match with its top summary point and a link to the breakdown. On the right: stats and percentiles as a list with a median tick on each bar. The full last-game summary, patterns, hero comparison and hero performance follow below.

The profile uses the player's standard matches from the last 30 days:

- **Your stats and percentiles**: for 11 metrics (souls and damage per minute, KDA, kills, deaths, assists, last hits, denies, objective damage per minute, accuracy, headshot rate), the player's average from `/v1/analytics/player-stats/metrics?account_ids=…` is placed on the per-game quantile curve (1st to 99th percentile) of all games at their rank tier (by match average badge), by linear interpolation. Deaths are flipped so every percentile means "better than". The API's quantiles are approximate (DDSketch, about 1% relative error), and values beyond the 1st/99th percentile are shown as Top/Bottom 1%.
- **Your patterns**: deaths and souls per minute in wins against losses, win rate in short against long games, and best and worst hero (each needs at least 3 games per side), plus the last five results.
- **Your heroes against other players**: for up to two heroes with at least 3 games in the player's main mode, per-game averages against the same hero at the same rank tier from `/v1/analytics/hero-stats`, needing at least 100 matches by others. Totals are not adjusted for game length.

## Overview summary and sharing

After a player is chosen, the overview loads their most recent standard match (one metadata request) and shows its Match summary in **Your last game**, with a link to the full breakdown. Each match-history row gets a one-line **Takeaway** from `public/js/core/player-trends.js`, relative to the player's own recent games (deathless game, best or lowest souls/min, deaths or kills well above average). Takeaways use match-history fields only, so they cost no extra requests.

Every page has Open Graph and Twitter tags with `public/images/og-card.png`. When a link-preview crawler (Discord, Reddit, X, Slack, Telegram, WhatsApp and similar) requests `/match?id=…&player=…`, the Worker replaces the match page's title and description with that player's summary, or with the result and MVPs when no player is given. Normal visitors get the static page, so previews never add API traffic for them. Previews are cached at the edge for a day. **Copy summary** on the match page copies the summary as text with a link back to that player's view.

## Match summary and AI coach

The **Match summary** section opens first on a match page and describes the selected player's game. Select another player in the KDA table to see theirs.

**Summary (free, no AI).** `public/js/core/match-digest.js` turns the normalized match into facts relative to that player: lane partners and opponents from `assigned_lane`, souls/damage/healing checkpoints at the recorded snapshot times, the team and lane souls leads from their side, kills and deaths with time spent dead, objectives (and whether they were dead at the time), Mid Boss claims, phase totals and the purchase order. `public/js/core/match-summary.js` applies fixed rules to those facts (lane result, lead swings, kills versus souls, time dead, clustered deaths, structures lost while dead, MVP, souls sources). Everything runs in the browser, and a point is only shown when every value it mentions was recorded. Thresholds are constants at the top of `public/js/core/match-summary.js`.

**AI coach (optional).** **Explain with AI** posts only `{ matchId, slot }` to `/api/analyze`. The Worker fetches the match itself (so no client-supplied text reaches the model; Steam names are never sent), builds the same digest, and asks a model for a headline, summary, key moments, strengths and improvements with evidence, using a JSON schema. Timestamps outside the match are dropped. The page shows the review with clickable times and **Match data the AI was given**. `GET /api/digest?match=ID&slot=N` returns the digest without calling a model.

Providers, set in `wrangler.jsonc`:

- `ANALYSIS_PROVIDER: "workers-ai"` (default, free): Cloudflare Workers AI through the `AI` binding, model `@cf/openai/gpt-oss-120b` (it followed the review rules much better than Llama 3.3 70B in testing). Every account gets 10,000 neurons a day free; one review uses roughly 260. Its reviews are specific but can still misstate a number, which the page warns about. On the Workers Free plan, usage beyond the allowance fails instead of being billed. On Workers Paid it is billed, so the Worker also stops at `DAILY_REVIEW_LIMIT` new reviews per UTC day (25 by default, about the free allowance).
- `ANALYSIS_PROVIDER: "anthropic"` (paid, higher quality): Claude through the Anthropic API. Requires the `ANTHROPIC_API_KEY` secret and costs money per new review; set a spend limit on the Anthropic workspace.

Reviews are cached in Workers KV for 180 days (completed matches never change), keyed by match, slot, provider, model, prompt version and digest version. Cached reviews are free and do not count toward either limit. New reviews are also limited to 3 per minute per IP. Bump `PROMPT_VERSION` (`worker/analyze.js`) or `MatchDigest.VERSION` when the prompt or digest changes. Only standard 6v6 matches with a final result can be reviewed.

### Catalogs

The pages need only a few fields from the public hero and item catalogs (about 1.9 MB and 6.2 MB). The Worker serves trimmed copies at `/api/assets/heroes` and `/api/assets/items` (about 1 KB and 24 KB gzipped), edge-cached for an hour; `trimHero`/`trimItem` in `worker/index.js` list the kept fields. `assetCatalog()` in `public/js/core/common.js` falls back to the full public catalog when the Worker is not available. If a page starts reading a new catalog field, add it to the trim list.

### Security

- `/api/analyze` accepts only `application/json` POSTs whose `Origin` is the site itself, so other websites cannot trigger reviews through visitors' browsers.
- New (uncached) reviews need a Cloudflare Turnstile token (invisible widget, site key in `public/js/ui/review-panel.js`, secret in the `TURNSTILE_SECRET` Worker secret). Without the secret the Worker refuses reviews, except on localhost. Saved reviews need no token.
- Limits on new reviews: 3 per minute per IP (`ANALYSIS_LIMITER`), `DAILY_IP_LIMIT` per visitor per day (keyed by a salted SHA-256 of IP and date, never the raw IP), and `DAILY_REVIEW_LIMIT` site-wide.
- Link previews are rate-limited per IP (`PREVIEW_LIMITER`, 60/min) and cached by match, player and version only; over the limit, the static page is served.
- `/api/digest` only answers on localhost.
- Security headers (CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS) come from `public/_headers` for static files and `SECURITY_HEADERS` in `worker/index.js` for Worker responses; keep the two in sync. The CSP allows scripts only from the site and Turnstile, images from the site, `assets-bucket.deadlock-api.com` and Steam's avatar CDN, and requests to the site, `api.deadlock-api.com` and Turnstile, so avoid inline `style=` attributes and inline scripts.

### Deploying

```sh
npx wrangler login
npm run deploy
```

`wrangler.jsonc` deploys the Worker named `deadstats`, serves the repository root as static assets (only the `public/` folder is published), connects Workers AI, and provisions the `ANALYSIS_CACHE` KV namespace on the first deploy. No API key is needed for the default provider. For Claude instead, run `npx wrangler secret put ANTHROPIC_API_KEY` and set `ANALYSIS_PROVIDER` to `"anthropic"` and `ANALYSIS_MODEL` to a Claude model.

## Editing guide

No build step or framework is needed. Each HTML page loads one controller as an ES module (`<script type="module">`), which imports what it needs. Calculation modules have no DOM dependencies, so the Worker and Node tests import the same files.

- **Change player search:** edit `public/js/ui/app.js` for interaction and `public/js/core/stats.js` for calculations.
- **Change the match layout:** edit `public/match.html` and `public/css/styles.css`. The shared `.match-details` class styles collapsible sections; preserve IDs used by JavaScript.
- **Change match data handling:** edit `public/js/core/match-stats.js`. Keep API field names at this boundary and use the normalized player model in rendering code.
- **Change objective markers:** edit `public/js/core/match-stats.js` for event normalization and `public/js/ui/match-analysis.js` for marker layout/tooltips. Keep objective markers separate from the individual player graph.
- **Change comparisons:** edit `public/js/core/analysis-stats.js` for calculations and `public/js/ui/match-analysis.js` for UI and loading.
- **Change chart behavior:** edit `public/js/ui/souls-chart.js`. Highlighted-player selection comes from `public/js/ui/match.js`; event markers and tooltips belong to the chart.
- **Change the summary or AI coach:** edit `public/js/core/match-digest.js` for the facts (test in `tests/match-digest.test.js`), `public/js/core/match-summary.js` for the rule-based points (test in `tests/match-summary.test.js`), `worker/analyze.js` for the prompt, schema and providers, and `public/js/ui/review-panel.js` for rendering.
- **Change API behavior:** edit `public/js/core/common.js`. Cancellation, timeout, cache lifetime, and stored-history fallback are shared here.

Missing values must remain distinct from zero. Do not join events by roster array index: use `player_slot`. Keep API strings in `textContent`, and retain cancellation checks after asynchronous requests so stale responses cannot overwrite the current selection. Comments explain these constraints where they matter.

Run `npm test` after changing calculations or request behavior. For a browser smoke check, open a match, switch players, expand Items/KDA table/Match analysis, compare two opposing players, and hover or keyboard-focus graph events. Switch between teams and check that friendly-objective markers change while the team-advantage sign stays fixed. Check a narrow viewport as well as desktop. Formatting is conventional two-space indentation; the site has no runtime formatter dependency.

## Data flow for contributors

`public/js/core/common.js` provides requests, caching and safe DOM/image helpers. `public/js/core/stats.js`, `public/js/core/match-stats.js`, `public/js/core/analysis-stats.js`, `public/js/core/match-digest.js`, `public/js/core/match-summary.js` and `public/js/core/tier-stats.js` are calculation modules that can run under Node without a browser. Page controllers connect those calculations to the DOM:

- Overview: `public/js/ui/app.js` searches profiles, loads history and renders `public/js/core/stats.js` summaries.
- Match: `public/js/ui/match.js` validates the URL match ID, loads metadata through `public/js/core/match-stats.js`, then enriches names, heroes and items independently. Its shared view contains the normalized match, identity/catalog maps and `selectedSlot`.
- Player selection: the scoreboard and `public/js/ui/souls-chart.js` dropdown both use `selectMatchPlayer()` in `public/js/ui/match.js`. This refreshes selection and the two chart modules without another metadata request. Lane selectors keep their own opposing pair.
- Summary and AI coach: `public/js/ui/review-panel.js` builds the digest and summary for the same `selectedSlot` in the browser; AI responses are stored per match and slot, so a late response never replaces another player's review.
- Hero meta: `public/js/ui/tier-lists.js` fetches aggregates and assets, then delegates count validation and rate calculations to `public/js/core/tier-stats.js`.

Function comments describe purpose and non-obvious constraints rather than each statement. When changing a calculation, preserve the distinction between unavailable (`null`) and a measured zero, and add a focused test for the changed rule. The current tests cover calculations and overview interactions; they do not replace the browser checks above for SVG layout and tooltips.


## Design system and loading states

- `public/css/theme.css` holds the design tokens (`--hero`, `--bg`, `--panel`, `--line`, `--win`, `--loss`, `--display`/`--ui` fonts, `--skew`, easing curves), the sticky header, panels, angled buttons, tables and every animation. Older stylesheets are retinted to the same palette; `theme.css` loads after them and wins on equal specificity. On the front page `home.css` loads last and styles the landing hero, banner, main hero card, chips, hero cards, last-match card and stat rows.
- **Hero accent:** `--hero` is registered with `@property`, so changes animate. `public/js/ui/hero-theme.js` sets it from the catalog's `colors.style_hex` for the player's main hero (profile and history) or the selected player's hero (match page), after nudging the colour into a readable saturation and lightness band. Use `var(--hero)` or `color-mix(in srgb, var(--hero) N%, transparent)` for anything that should follow the hero; charts draw with `currentColor`.
- **Angles:** parallelograms come from `clip-path` (cards, buttons) or `transform: skewX(var(--skew))` with the content skewed back (chips, stamps, the search bar backdrop). Use the skewed backdrop for anything with overflowing children, such as the search suggestions, because `clip-path` would cut them off.
- **Skeletons:** `ProfileView.showSkeleton()` and `showIdentitySkeleton()` (`public/js/ui/profile-view.js`) fill each profile section with `.skel` placeholders when a player starts loading (or immediately for a shared `?player=` link). Renderers replace them with real content, adding `.reveal` and a `--i` stagger index so items rise in one after another. Bars grow in with delays derived from the same index, and headline numbers count up (`public/js/ui/count-up.js`).
- **Motion:** `public/js/ui/motion.js` runs on every page: sections slide in as they scroll into view (`.sr` → `.sr-in`, including content rendered later), the header compacts once the page scrolls, `[data-parallax]` layers drift, and cards listed in its `TILT` selector tilt towards a fine pointer. Every animation is disabled under `prefers-reduced-motion: reduce`. When adding motion, define it in `theme.css` and include it in that media query.
- **Images:** hero portraits use the catalog's `icon_hero_card_webp` (the Worker's trimmed catalog keeps it), and rank crests use `images.large_webp` from `/v1/assets/ranks`. Both load from `assets-bucket.deadlock-api.com`, which the content security policy allows.

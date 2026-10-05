# Deadlock player tracker

A standalone browser tracker with a dark dashboard in warm charcoal, cream, and muted brass. Search a Steam player name, choose the matching account, and retrieve recent statistics from the community-run [Deadlock API](https://api.deadlock-api.com/docs). No API key, account, installation, or backend is needed. Internet access is required for searches and match data.

## Use it

1. Open `index.html` in Safari or Chrome, or refresh your existing tab.
2. Start typing a Steam display name. After at least two characters and a 300 ms pause, matching accounts appear below the input with Steam avatars. **Search** or Enter also runs an immediate search.
3. Click a matching player, or use Up/Down and Enter. Escape closes the suggestions. Account IDs distinguish players with identical names.
4. Review their latest 20 recorded matches, per-hero win rates, and individual match K/D/A and durations. Hero portraits appear beside names in both tables.
5. Click **View match** on any row, or enter a match ID beside the history table. A separate match tab opens and shows every player’s kills, deaths, assists, and final souls. All players’ purchased items appear below the team scoreboards. Select a player’s name to highlight their build and souls timeline. Your player-search tab stays open. The match URL can be bookmarked or shared; reopening it loads the same match.

You can also enter a numeric Steam account ID (SteamID3's account number) or a SteamID64 to load that account directly. Steam profile URLs and vanity URLs are not supported. Name search covers profiles indexed by the API, so an account ID may work when a name does not.

## What the statistics mean

The app downloads the available match history, removes duplicate match IDs, sorts by match start time, and takes the latest 20 records. This includes all game and match modes returned by the API; it is not a ranked-only or lifetime summary. The displayed date range uses your local timezone.

Win rates use `player_match_outcome`: 1 is a win and 2 is a loss. Invalid, penalized, penalized-party, unscored, or unknown outcomes appear as **Other** and do not enter the win-rate denominator. The recent overall rate is total wins divided by total wins plus losses, not an average of hero rates. A player or hero with no scored matches shows `—`.

The API is unofficial and is not endorsed by Valve. Its recorded history may be incomplete or delayed. According to its match-history documentation, accounts that are not friends with one of its bots receive stored history only. This tracker does not request bot access or force a refresh. If the API responds with rate-limited stored history, the page labels that fallback.

## Tier lists

Open **Tier lists** beside Overview to rank heroes by aggregate win rate. The default is the last 30 days, normal game mode, ranked and unranked matches, all ranks, and at least 1,000 scored matches per hero. Choose 7/30/90 days, match mode, and minimum sample size, then select **Apply filters**.

The page calls `/v1/analytics/hero-stats` with `bucket=no_bucket` and explicit time/mode filters. Time windows end at the current hour for cache reuse. It sorts by wins divided by wins plus losses before rounding to two decimal places; equal rates use scored-match count and then hero ID as tie-breakers. The minimum-sample filter applies to scored matches, not all returned matches. No individual account filter is applied. Unscored matches do not affect the denominator, and heroes without scored results are omitted.

These are rankings across the API's recorded matches, not guaranteed full-playerbase coverage or a subjective S–F tier assessment. Windows can span patches. Missing hero metadata falls back to IDs, while API failures and empty results are explicitly labelled. Requests use the shared timeout/cancellation and five-minute local cache.

## Individual match breakdowns

The page starts with the match-wide MVPs in the API’s `mvp_rank` order (1–3), with their K/D/A and team. No MVP score is calculated locally; missing rankings show an unavailable message. The team scoreboards follow, then every player’s items, the souls graph, and a kill timeline. Contents links below the MVPs jump to each section.

Match scoreboards are split into **The Hidden King** (Amber) and **The ArchMother** (Sapphire), with a separate K/D/A and souls table for each team. Player selection works across both tables.

Match scoreboards use the final `kills`, `deaths`, `assists`, and `net_worth` fields from `match_info.players`. Souls means final net worth (including souls already spent), not an unspent wallet balance.

The kill timeline orders recorded deaths by `death_details[].game_time_s`, resolving killers by player slot and displaying player names and heroes. Unknown/non-player killers and self-attributed deaths are labelled. Events with missing or invalid times appear last; incomplete logs are flagged.

Timed kill and death counts in opponent comparisons use each victim's `death_details[].killer_player_slot`, joined to the roster by `player_slot`, not array position or account ID. Untimed events are excluded from time-specific counts. Incomplete logs are flagged, while the final scoreboard remains independent of event-log completeness.

**Limitation: per-player assist attribution is unavailable.** The verified metadata and its protobuf definition provide total assists but no assister identifiers in death events. Both the selected-match and default replay-schema endpoints returned 404 during development. The analysis shows assists as unavailable at a particular game time; it does not infer attribution from damage or proximity.

Player names are retrieved in a single batch. Missing Steam profiles fall back to account IDs, and missing hero metadata falls back to hero IDs. Match metadata loads on demand and is cached in memory for 30 minutes. Unavailable matches show a retry option. Leaving or replacing a match cancels pending requests.

Purchases are shown chronologically with current item names and icons. Ability unlocks and upgrades are excluded using the catalog's `type: upgrade` classification for shop items. Repeat purchases remain separate. Removal timestamps are labelled “sold / replaced” because they may represent sales or components replaced by upgrades; the list is purchase history, not a claimed final inventory. Missing catalogs or purchase logs are explicitly labelled. Unidentified entries are counted in a notice.

The match tab includes a **Souls over time** line chart for all players. The X axis is elapsed game time and the Y axis is souls (net worth). Lines connect validated `stats[].time_stamp_s` / `net_worth` snapshots; no start-of-game or missing values are invented. A hero-portrait dropdown selects the player perspective while keeping all available lines visible. The highlighted player has a solid green line; other players have dotted lines. Teammates are green and opponents red, relative to the player selected in the scoreboard. Selecting another player updates the chart and legend. Missing timelines are labelled. The chart scrolls horizontally on narrow screens.

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

If this becomes a hosted product, a small backend proxy would allow shared caching and centralized rate-limit handling. Any future private API credentials should stay on that server, never in the browser code.

## Files

- `index.html`: search form and results structure.
- `tier-lists.html`, `tier-lists.js`: aggregate hero ranking page and filters.
- `tier-stats.js`: validated win-rate ranking and sample-size filtering.
- `tests/tier-stats.test.cjs`: ranking, ties, unscored results, and validation checks.
- `styles.css`: responsive dashboard styling using system fonts; profile avatars and hero portraits load from image URLs supplied by the API.
- `stats.js`: ID conversion and match aggregation.
- `app.js`: API requests, state, and rendering.
- `match.js`: standalone match page, scoreboard, Steam profile enrichment, and player highlighting.
- `match.html`: match page opened in a new tab using `?id=MATCH_ID&player=ACCOUNT_ID`.
- `common.js`: shared API requests and rendering helpers.
- `souls-chart.js`: interactive SVG souls timeline, player visibility controls and event tooltips.
- `match-stats.js`: roster validation, event-log completeness, purchases, timelines, and API MVP ranks.
- `analysis-stats.js`: pure team-advantage, opponent, and historical-comparison calculations.
- `match-analysis.js`: lane comparison UI and the team souls advantage graph.
- `tests/analysis-stats.test.cjs`: synchronized snapshots, event boundaries, historical selection, and purchase timings.
- `tests/match-stats.test.cjs`: sparse slots, incomplete logs, unknown killers, souls, and metadata validation.
- `tests/stats.test.cjs`: calculation and input-validation checks.
- `tests/app.test.cjs`: search debounce, keyboard navigation, avatars, IME input, API errors, stored-history fallback, and request cancellation checks.

Run the calculation tests with Node.js:

```sh
node --test tests/*.test.cjs
```

Opening the HTML file directly is sufficient. For an optional local web server:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Then visit `http://127.0.0.1:8000`. Stop the server with Control+C.

## Match analysis and review

The match page keeps its existing dark styling and adds an **Analysis** contents link. Team souls analysis covers both teams; lane comparison has independent player selectors:

- **Team souls advantage:** The Hidden King’s total minus The ArchMother’s total, using only snapshot times available for every player. Missing team data is never treated as zero.
- **Kills, deaths and purchases on the souls graph:** hollow green kill circles, red death Xs, brass shopping-cart purchase icons for the highlighted player. A key below the graph explains the markers; a portrait dropdown changes the player perspective. Kill and death tooltips identify the other player and hero; purchase tooltips show the item. Exact souls gained or lost per kill/death are unavailable in the current metadata integration and are labelled accordingly; snapshot changes are not attributed to individual events. Selecting one opens the graph at that game time.
- **Lane comparison:** a separate collapsible section lets you select any first player, a second player restricted to the opposing team, and a game time to compare souls, recorded kills/deaths, and first item purchase timings. Snapshot times are shown; a souls difference is calculated only for matching times. Timed assists are unavailable.

Contents links automatically open their collapsible target section. No additional API key or backend is needed.


## Editing guide

This is a static site: no build step or framework is needed. Each HTML page loads its scripts with `defer`; keep shared utilities and calculation modules before the page controllers that use them.

- **Change player search:** edit `app.js` for interaction and `stats.js` for calculations.
- **Change the match layout:** edit `match.html` and `styles.css`. The shared `.match-details` class styles collapsible sections; preserve IDs used by JavaScript.
- **Change match data handling:** edit `match-stats.js`. Keep API field names at this boundary and use the normalized player model in rendering code.
- **Change comparisons:** edit `analysis-stats.js` for calculations and `match-analysis.js` for UI and loading.
- **Change chart behavior:** edit `souls-chart.js`. Highlighted-player selection comes from `match.js`; event markers and tooltips belong to the chart.
- **Change API behavior:** edit `common.js`. Cancellation, timeout, cache lifetime, and stored-history fallback are shared here.

Missing values must remain distinct from zero. Do not join events by roster array index: use `player_slot`. Keep API strings in `textContent`, and retain cancellation checks after asynchronous requests so stale responses cannot overwrite the current selection. Comments explain these constraints where they matter.

Run `node --test tests/*.test.cjs` after changing calculations or request behavior. For a browser smoke check, open a match, switch players, expand Items/Souls/Analysis, compare two opposing players, and select a graph event. Check a narrow viewport as well as desktop. Formatting is conventional two-space indentation; the site has no runtime formatter dependency.

import DeadlockLiveStats from "../core/live-stats.js";
import DeadlockLiveData from "../core/live-data.js";
import { API_BASE, errorMessage, portrait } from "../core/common.js";

(() => {
  const S = DeadlockLiveStats, D = DeadlockLiveData;
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
  const pct = (v) => S.number(v) === null ? "Unavailable" : `${(v * 100).toFixed(1)}%`;
  const clock = (v) => S.number(v) === null ? "Unavailable" : `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
  const teamName = (t) => t === 0 ? "The Hidden King" : "The ArchMother";
  let match = null, players = [], context = null, plans = [], buildData = new Map();
  let active = [], session = null, scoutingController = null, buildController = null, feedController = null;
  let feedGeneration = 0, scoutGeneration = 0, buildGeneration = 0;
  let telemetry = new S.StreamState(), feedStatus = "Unavailable", feedMessage = "", lastSuccess = null;
  let renderTimer = null, rosterTimer = null, pollTimer = null, retryUntil = 0;
  const overrides = new Map(), owned = new Map();
  const currentTeam = () => Number($("live-team").value);
  const displayName = (p) => context?.profiles.get(p.accountId)?.personaname || `Account ${p.accountId}`;
  const heroName = (id) => context?.heroes.get(id)?.name || (id ? `Hero ${id}` : "Hero unavailable");
  const friends = () => players.filter((p) => p.team === currentTeam());
  const opponents = () => players.filter((p) => p.team !== currentTeam());
  const rosterSignature = (ps) => ps.map((p) => `${p.accountId}:${p.heroId}:${p.team}`).sort().join(",");

  function identity(p) {
    const row = el("div", undefined, "live-identity");
    const h = context?.heroes.get(p.heroId), name = heroName(p.heroId);
    row.append(portrait(h?.images?.icon_image_small_webp || h?.images?.icon_image_small, name, "hero-portrait"));
    const text = el("span"); text.append(el("strong", displayName(p)), el("small", name)); row.append(text); return row;
  }
  function rankLabel(p) {
    const badge = context?.ranks.get(p.accountId)?.badge;
    if (!badge) return "Rank unavailable";
    const tier = Math.floor(badge / 10);
    const name = context.rankCatalog?.find((r) => r.tier === tier)?.name || `Rank tier ${tier}`;
    return `${name} ${badge % 10} · ${S.number(p.rankPercentile) === null ? "percentile unavailable" : `${p.rankPercentile.toFixed(0)}th percentile`}`;
  }
  function liveLine(p) {
    const node = el("p", "Broadcast state unavailable", "live-pressure"); node.dataset.liveAccount = String(p.accountId); return node;
  }
  function updateObservations() {
    renderTimer = null;
    $("live-feed-state").textContent = feedStatus;
    $("live-updated").textContent = lastSuccess ? lastSuccess.toLocaleTimeString() : "Unavailable";
    const anchor = telemetry.clock;
    $("live-clock").textContent = S.number(match?.duration_s) !== null ? `${clock(match.duration_s)} · Watch snapshot` : anchor ? `${clock(anchor.game_time)} · clock anchor` : "Unavailable";
    $("live-feed-note").textContent = feedMessage || "Broadcast delay is unknown. Received state is observational; current pressure and inventory are unavailable.";
    for (const node of document.querySelectorAll("[data-live-account]")) {
      const p = telemetry.players.get(Number(node.dataset.liveAccount));
      if (!p || !p.receivedAt) { node.textContent = "Broadcast state unavailable · Current pressure unavailable"; continue; }
      const age = Math.floor((Date.now() - p.receivedAt) / 1000);
      const values = [p.kills, p.deaths, p.assists].every((v) => S.count(v) !== null) ? `${p.kills}/${p.deaths}/${p.assists}` : "KDA unavailable";
      node.textContent = `${values} · ${S.count(p.souls) !== null ? `${p.souls.toLocaleString()} souls` : "souls unavailable"} · received ${age}s ago${age > 45 ? " (stale receipt)" : ""}. Source delay unknown; pressure unavailable.`;
    }
  }
  function scheduleObservations() { if (renderTimer === null) renderTimer = setTimeout(updateObservations, 1000); }
  function renderSources() {
    $("live-source-list").replaceChildren(...[...D.sources].map(([path, date]) => {
      const li = el("li"), link = el("a", path);
      link.href = `${API_BASE}${path}`; link.target = "_blank"; link.rel = "noreferrer";
      li.append(link, document.createTextNode(` — retrieved ${date.toLocaleString()}`)); return li;
    }));
    (context?.errors || []).forEach((message) => $("live-source-list").append(el("li", `Unavailable: ${message}`, "live-muted")));
  }
  function recentList(p) {
    const list = el("ol", undefined, "live-games");
    for (const g of p.scouting?.games || []) {
      const value = (v) => S.count(v) === null ? "—" : String(v);
      const li = el("li"), a = el("a", `${g.player_match_outcome === 1 ? "Win" : "Loss"} · ${heroName(g.hero_id)} · ${value(g.player_kills)}/${value(g.player_deaths)}/${value(g.player_assists)}`);
      a.href = `match.html?id=${g.match_id}&player=${p.accountId}`;
      li.append(a, el("div", `${clock(g.match_duration_s)} · ${new Date(g.start_time * 1000).toLocaleDateString()}`));
      const band = g.match_duration_s <= 7000 ? Math.floor(g.match_duration_s / 600) * 600 : null;
      const b = S.baseline(context?.formRows.get(band), g.hero_id, context?.ranks.get(p.accountId)?.badge);
      const usable = b && b.n >= 100 && [b.kills, b.deaths, b.assists].every((v) => S.number(v) !== null);
      li.append(el("div", usable ? `Hero/duration baseline KDA ${((b.kills + b.assists + 2) / (b.deaths + 1)).toFixed(2)} (smoothed) · ${b.n.toLocaleString()} observations` : "Comparable form baseline unavailable"));
      list.append(li);
    }
    if (!list.children.length) list.append(el("li", "No completed, scored recent games available for this mode."));
    return list;
  }
  function factors(p) {
    const detail = el("details"), list = el("ul"), s = p.scouting;
    detail.append(el("summary", "Why this score?"));
    s.components.forEach((c) => list.append(el("li", `${c.name}: ${c.score.toFixed(1)} / 100 · ${(c.effectiveWeight * 100).toFixed(0)}% of available score`)));
    s.evidence.forEach((reason) => list.append(el("li", reason)));
    if (s.missing.length) list.append(el("li", `Unavailable: ${s.missing.join(", ")}. Supported weights were renormalized.`));
    detail.append(list); return detail;
  }
  function renderScouting() {
    if (!context) return;
    const friendlyPercentiles = friends().map((p) => S.percentile(context.ranks.get(p.accountId)?.badge, context.distribution));
    const allRankPopulations = new Map();
    for (const p of players) {
      const badge = context.ranks.get(p.accountId)?.badge;
      p.rankPercentile = S.percentile(badge, context.distribution);
      const games = S.recentGames(context.histories.get(p.accountId), context.scope.cutoff, match.match_mode ?? null, match.match_id);
      const population = S.baseline(context.populationRows, p.heroId, badge);
      allRankPopulations.set(p.accountId, S.baseline(context.populationRows, p.heroId));
      p.scouting = S.scout({ hero: context.playerHeroes.get(`${p.accountId}:${p.heroId}`), population,
        rankPercentile: p.rankPercentile, friendlyPercentiles, games,
        formPopulations: games.map((g) => S.baseline(context.formRows.get(g.match_duration_s <= 7000 ? Math.floor(g.match_duration_s / 600) * 600 : null), g.hero_id, badge)) });
    }
    plans = S.focusPlan(friends(), opponents(), context.counters, allRankPopulations, overrides);
    const top = opponents().filter((p) => p.scouting.eligible).sort((a, b) => b.scouting.score - a.scouting.score).slice(0, 3);
    $("live-threat-cards").replaceChildren(...Array.from({ length: 3 }, (_, i) => {
      const card = el("article", undefined, "live-card"), p = top[i];
      if (!p) { card.append(el("span", `Slot ${i + 1}`, "live-badge"), el("h3", "Insufficient evidence"), el("p", "No additional opponent has the minimum supported hero history.")); return card; }
      const s = p.scouting;
      card.append(el("span", `Watch priority ${i + 1}`, "live-badge"), identity(p), el("div", `${s.score.toFixed(1)} / 100`, "live-score"), el("p", `${s.quality} · ${s.heroMatches} matching hero games`), el("p", rankLabel(p)));
      if (s.estimate) card.append(el("p", `Recorded hero win rate ${pct(s.rawRate)}; adjusted ${pct(s.estimate.rate)} · approximate 95% interval ${pct(s.estimate.lower)}–${pct(s.estimate.upper)}`));
      card.append(el("p", `Scouting assembled ${context.fetchedAt.toLocaleTimeString()} · source retrieval times below`), factors(p), liveLine(p)); return card;
    }));
    const tied = top.length > 1 && top[0].scouting.score - top[1].scouting.score < 3;
    $("live-evidence-status").textContent = `${players.length} known players. ${top.length} supported watch priorities.${tied ? " The leading scores are close; treat their order as uncertain." : ""}${context.errors.length ? ` ${context.errors.length} source requests unavailable; partial evidence shown.` : ""}`;
    renderRoster(); renderFocus(); renderSources(); updateObservations();
  }
  function renderRoster() {
    const filter = $("live-team-filter").value, threatSort = $("live-sort").value === "threat";
    const selected = players.filter((p) => filter === "all" || (filter === "friendly") === (p.team === currentTeam()));
    selected.sort((a, b) => (threatSort ? (b.scouting?.score ?? -1) - (a.scouting?.score ?? -1) : a.team - b.team) || (a.heroId ?? 999) - (b.heroId ?? 999));
    $("live-roster-list").replaceChildren(...selected.map((p) => {
      const card = el("article", undefined, "live-card"), s = p.scouting;
      card.append(el("span", `${p.team === currentTeam() ? "Friendly" : "Opponent"} · ${teamName(p.team)}`, "live-badge"), identity(p));
      if (!s) { card.append(el("p", "Historical scouting loading…"), liveLine(p)); return card; }
      card.append(el("p", rankLabel(p)), el("p", s.estimate ? `Hero win rate ${pct(s.rawRate)} recorded / ${pct(s.estimate.rate)} adjusted · ${s.heroMatches} scored games` : "Hero comparison unavailable"));
      const rank = context.ranks.get(p.accountId);
      if (rank?.last_match?.start_time) card.append(el("p", `Rank from recorded match ${new Date(rank.last_match.start_time * 1000).toLocaleString()}`, "live-muted"));
      card.append(el("p", s.score !== null ? `Scouting ${s.score.toFixed(1)} / 100 · ${s.quality}${s.eligible ? "" : " · insufficient hero evidence for ranking"}` : "Scouting unavailable"), el("h3", "Last three games"), el("p", "Small sample · noisy form", "live-muted"), recentList(p), factors(p), liveLine(p)); return card;
    })); updateObservations();
  }
  function renderFocus() {
    const targets = [...new Set(plans.map((p) => p.primary?.opponent?.accountId).filter(Boolean))];
    $("live-focus-summary").textContent = targets.length ? `Team priorities: ${targets.map((id) => displayName(players.find((p) => p.accountId === id))).join("; ")}. Coordinate before committing. Statistical suggestions use all-rank matchup populations.` : "No clear target advantage is supported by this lobby’s matchup evidence. You can set a manual priority below.";
    $("live-focus-list").replaceChildren(...plans.map((plan) => {
      const card = el("article", undefined, "live-card"); card.append(identity(plan.friend));
      if (plan.primary?.opponent) {
        card.append(el("h3", `Priority: ${displayName(plan.primary.opponent)}`), el("p", plan.primary.manual ? "Your manual priority. No statistical matchup advantage is implied." : `Hero-pair win share is ${(plan.primary.edge * 100).toFixed(1)} percentage points above the hero-adjusted expectation after shrinkage · ${plan.primary.n.toLocaleString()} recorded pairings. This is an observational focus candidate.`));
        if (plan.secondary) card.append(el("p", `Secondary: ${displayName(plan.secondary.opponent)} · ${plan.secondary.n.toLocaleString()} pairings`));
      } else card.append(el("h3", "No clear target advantage"));
      const label = el("label", "Override focus priority"), select = el("select"); select.id = `focus-${plan.friend.accountId}`; label.htmlFor = select.id;
      const auto = el("option", "Use supported suggestion"); auto.value = ""; select.append(auto);
      opponents().forEach((p) => { const o = el("option", `${displayName(p)} · ${heroName(p.heroId)}`); o.value = String(p.accountId); select.append(o); });
      select.value = String(overrides.get(plan.friend.accountId) || "");
      select.addEventListener("change", () => { if (select.value) overrides.set(plan.friend.accountId, Number(select.value)); else overrides.delete(plan.friend.accountId); renderScouting(); loadBuilds(); });
      card.append(label, select); return card;
    }));
  }
  function itemNode(candidate, player, reason) {
    const row = el("div", undefined, "live-item");
    row.append(portrait(candidate.item.shop_image_small_webp || candidate.item.shop_image_webp || candidate.item.image_webp, candidate.item.name, "item-portrait"));
    const body = el("div"); body.append(el("strong", candidate.item.name), el("p", `${reason} ${candidate.matches.toLocaleString()} recorded purchases from ${candidate.players.toLocaleString()} players; win rate ${pct(candidate.rate)}.${candidate.timing !== null ? ` Average purchase ${clock(candidate.timing)}.` : " Purchase timing unavailable."}`));
    const button = el("button", "Mark owned", "secondary-button"); button.type = "button";
    button.setAttribute("aria-label", `Mark ${candidate.item.name} as owned by ${displayName(player)}`);
    button.addEventListener("click", () => { if (!owned.has(player.accountId)) owned.set(player.accountId, new Set()); owned.get(player.accountId).add(candidate.item_id); renderBuilds(); });
    body.append(button); row.append(body); return row;
  }
  function renderBuilds() {
    if (!context) return;
    $("live-build-scope").textContent = `${context.scope.mode} · evidence ${new Date(context.scope.start * 1000).toLocaleDateString()}–${new Date(context.scope.end * 1000).toLocaleString()}. ${context.scope.patch ? "Patch window uses a date parsed from the published update title; exact client-version coverage is unverified." : "Reliable patch boundary unavailable; this window can span balance updates."} Candidate confidence is limited by these patch and observational constraints.`;
    $("live-build-list").replaceChildren(...friends().map((p) => {
      const card = el("article", undefined, "live-card"); card.append(identity(p));
      const data = buildData.get(p.accountId);
      if (!data) { card.append(el("p", "Loading build evidence…")); return card; }
      const excluded = owned.get(p.accountId) || new Set();
      const core = S.itemCandidates(data.core, context.items, p.heroId, excluded);
      const build = data.build?.detail?.hero_build;
      const qualifying = new Map(core.map((r) => [r.item_id, r]));
      const path = build?.hero_id === p.heroId && build.hero_build_id === data.build.evidence.hero_build_id
        ? (build.details?.mod_categories || []).filter((c) => c.optional !== true).flatMap((c) => (c.mods || []).map((m) => qualifying.get(m.ability_id)).filter(Boolean)) : [];
      card.append(el("h3", "Core build evidence"));
      const used = new Set();
      if (path.length) {
        card.append(el("p", `${build.name} · most-used qualifying recorded build · ${data.build.evidence.matches.toLocaleString()} matches. Category order is the author’s path, not a validated purchase sequence.`));
        path.filter((r) => { if (used.has(r.item_id)) return false; used.add(r.item_id); return true; }).slice(0, 6).forEach((r) => card.append(itemNode(r, p, "Listed in this published build.")));
      } else {
        card.append(el("p", "A verified core build path is unavailable. Frequently recorded item candidates are shown where supported."));
        core.slice(0, 3).sort((a, b) => (a.timing ?? Infinity) - (b.timing ?? Infinity)).forEach((r) => { used.add(r.item_id); card.append(itemNode(r, p, "Popular on this hero; listed by average observed purchase time.")); });
        if (!core.length) card.append(el("p", "Insufficient current-catalog item evidence (minimum 100 purchases and 20 players)."));
      }
      card.append(el("h3", "Situational candidates"));
      const flex = S.itemCandidates(data.situational, context.items, p.heroId, excluded).filter((r) => !used.has(r.item_id)).slice(0, 2);
      if (data.target && flex.length) flex.forEach((r) => card.append(itemNode(r, p, `Recorded against ${heroName(data.target.heroId)}. This association does not establish a mechanical counter.`)));
      else card.append(el("p", data.target ? "No additional supported item candidate for this priority opponent." : "No supported focus target; situational counter evidence unavailable."));
      if (data.errors.length) card.append(el("p", `Partial item evidence: ${data.errors.join(" ")}`, "live-muted"));
      if (excluded.size) { const reset = el("button", "Clear manually owned items", "secondary-button"); reset.type = "button"; reset.addEventListener("click", () => { owned.delete(p.accountId); renderBuilds(); }); card.append(reset); }
      return card;
    })); renderSources();
  }
  async function loadBuilds() {
    buildController?.abort(); if (!context || !session) return;
    const controller = new AbortController(), generation = ++buildGeneration; buildController = controller;
    const signal = AbortSignal.any([controller.signal, session.signal]); buildData = new Map(); renderBuilds();
    try { const result = await D.builds(match, context, friends(), plans, signal); if (!signal.aborted && generation === buildGeneration) { buildData = result; renderBuilds(); } }
    catch (e) { if (!signal.aborted) $("live-build-scope").textContent = errorMessage(e); }
  }
  async function loadScouting() {
    if (!players.length || !session) return;
    scoutingController?.abort(); buildController?.abort();
    const controller = new AbortController(), generation = ++scoutGeneration; scoutingController = controller;
    const signal = AbortSignal.any([controller.signal, session.signal]); context = null;
    players.forEach((p) => { delete p.scouting; });
    $("live-content").hidden = false; $("live-evidence-status").textContent = "Loading cached or recorded historical evidence…";
    $("live-threat-cards").replaceChildren(); $("live-focus-list").replaceChildren(); $("live-build-list").replaceChildren();
    renderRoster();
    try {
      const result = await D.scouting(match, players, signal);
      if (signal.aborted || generation !== scoutGeneration) return;
      context = result;
      const retrievals = [...D.sources.values()].map((date) => date.getTime()).filter(Number.isFinite);
      if (retrievals.length && (!lastSuccess || Math.max(...retrievals) > lastSuccess.getTime())) lastSuccess = new Date(Math.max(...retrievals));
      renderScouting(); loadBuilds();
    } catch (e) { if (!signal.aborted) $("live-evidence-status").textContent = `Scouting could not load: ${errorMessage(e)}`; }
  }
  function mergeStreamRoster() {
    rosterTimer = null;
    const merged = new Map(players.map((p) => [p.accountId, p]));
    for (const raw of telemetry.players.values()) {
      if (raw.hero_id > 0) merged.set(raw.account_id, { accountId: raw.account_id, heroId: raw.hero_id, team: raw.team - 2 });
    }
    const next = [...merged.values()];
    if (rosterSignature(next) !== rosterSignature(players)) { players = next; updateRosterCount(); loadScouting(); }
  }
  function updateRosterCount() { $("live-roster-count").textContent = `${players.length} known / 12 expected${players.length === 12 ? "" : " · partial roster"}`; }
  async function connectFeed(broadcast) {
    feedController?.abort(); const generation = ++feedGeneration;
    const controller = new AbortController(); feedController = controller;
    const signal = AbortSignal.any([controller.signal, session.signal]);
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
      feedStatus = attempt ? "Reconnecting" : "Connecting"; updateObservations();
      const connection = new AbortController(), combined = AbortSignal.any([signal, connection.signal]);
      let received = Date.now();
      const watchdog = setInterval(() => { if (Date.now() - received > 45000) connection.abort(new DOMException("Broadcast stalled", "TimeoutError")); }, 5000);
      try {
        await D.stream(broadcast, combined, (row) => {
          if (signal.aborted || generation !== feedGeneration) return;
          if (!telemetry.apply(row)) return;
          received = Date.now();
          lastSuccess = new Date(); feedStatus = "Connected · delay unknown";
          feedMessage = "Broadcast observations received. End-to-end delay is unverified; current pressure remains unavailable. The clock is an unextrapolated anchor when Watch duration is absent.";
          scheduleObservations(); if (rosterTimer === null) rosterTimer = setTimeout(mergeStreamRoster, 1500);
        });
        if (!signal.aborted) throw new Error("Broadcast ended or disconnected.");
      } catch (e) {
        if (signal.aborted || generation !== feedGeneration) return;
        feedStatus = "Disconnected"; feedMessage = `${errorMessage(e)} Historical scouting is retained. ${attempt < 2 ? "A bounded reconnect will be attempted." : "Automatic retries stopped; reconnect manually if needed."}`;
        updateObservations();
        if (attempt < 2 && ![400, 403, 404, 429].includes(e.status)) await D.delay(attempt ? 10000 : 3000, signal).catch(() => {});
        else break;
      } finally { clearInterval(watchdog); }
    }
  }
  async function resolveBroadcast(id, signal, allowSpectate = true) {
    const urls = await D.get("/v1/matches/live/urls", signal, 30000).catch(() => []);
    let url = urls.find((u) => u.match_id === id)?.broadcast_url;
    if (!url && allowSpectate && Date.now() >= retryUntil) {
      retryUntil = Date.now() + 60000;
      url = (await D.get(`/v1/matches/${id}/live/url`, signal, 3600000, true)).broadcast_url;
    }
    if (!url) throw new Error("No public broadcast is available. Wait before trying again.");
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || !/(^|\.)(steamcontent\.com|valve\.net)$/.test(parsed.hostname) || !parsed.pathname.includes(`/tv/${id}_`)) throw new Error("Unexpected broadcast address; connection refused.");
    return url;
  }
  async function discover(signal) {
    const rows = await D.get("/v1/matches/active", signal, 30000);
    active = rows.filter((m) => m.game_mode === 1 && S.count(m.match_id) !== null && m.match_id > 0);
    const input = $("live-account").value.trim();
    if (input && (!/^\d+$/.test(input) || !Number.isSafeInteger(Number(input)) || +input <= 0 || +input > 4294967295)) throw new Error("Enter a valid SteamID3 account number.");
    const visible = input ? active.filter((m) => m.players?.some((p) => p.account_id === Number(input))) : active;
    const placeholder = el("option", visible.length ? "Select a public match" : "No matching public normal-game lobby"); placeholder.value = "";
    $("live-available").replaceChildren(placeholder, ...visible.map((m) => { const o = el("option", `#${m.match_id} · ${m.match_mode_parsed || "Unknown queue"} · ${m.region_mode_parsed || "Unknown region"} · ${m.players?.length || 0} players`); o.value = String(m.match_id); return o; }));
    $("live-discovery-status").textContent = `${visible.length} normal-game lobbies found${input ? " for this account" : ""}. Watch-list coverage is limited; absence does not mean a player is offline.`;
    return visible;
  }
  async function openMatch(id) {
    if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) { $("live-status").textContent = "Enter a valid numeric match ID."; return; }
    session?.abort(); feedController?.abort(); scoutingController?.abort(); buildController?.abort();
    clearTimeout(pollTimer); clearTimeout(rosterTimer); rosterTimer = null;
    const controller = new AbortController(); session = controller; const signal = controller.signal;
    D.sources.clear();
    telemetry = new S.StreamState(); players = []; context = null; buildData = new Map(); overrides.clear(); owned.clear();
    lastSuccess = null; feedStatus = "Connecting";
    $("live-content").hidden = true; $("live-status").textContent = "Resolving the lobby and its public broadcast…";
    $("live-match-id").value = String(id); $("live-title").textContent = `Match #${id}`;
    $("live-reconnect").disabled = false;
    const params = new URLSearchParams({ id: String(id), team: String(currentTeam()) }); history.replaceState(null, "", `${location.pathname || "live.html"}?${params}`);
    document.title = `Live Match #${id} | DeadStats`;
    try {
      await discover(signal).catch((e) => {
        $("live-discovery-status").textContent = `Watch list unavailable: ${errorMessage(e)} Trying the entered match directly.`;
      });
      if (signal.aborted) return;
      match = active.find((m) => m.match_id === Number(id)) || { match_id: Number(id), players: [], start_time: null, match_mode: null };
      players = S.roster(match.players);
      const self = players.find((p) => p.accountId === Number($("live-account").value)); if (self) $("live-team").value = String(self.team);
      updateRosterCount();
      $("live-title").textContent = `Match #${id} · ${match.match_mode_parsed || "Queue unavailable"}`;
      $("live-status").textContent = players.length ? `Lobby resolved. Friendly team: ${teamName(currentTeam())}. Loading historical scouting…` : "Match is outside the available Watch list. Trying to resolve a roster from its broadcast.";
      if (players.length) loadScouting();
      try { const url = await resolveBroadcast(Number(id), signal); if (!signal.aborted) connectFeed(url); }
      catch (e) { if (!signal.aborted) { feedStatus = "Unavailable"; feedMessage = `${errorMessage(e)}${players.length ? " Historical scouting remains available." : " No roster can be resolved; this match may be private, finished, or not spectatable."}`; updateObservations(); } }
      if (!signal.aborted) pollTimer = setTimeout(pollRoster, 30000);
    } catch (e) { if (!signal.aborted) { feedStatus = "Unavailable"; $("live-status").textContent = errorMessage(e); updateObservations(); } }
  }
  async function pollRoster() {
    if (!session || session.signal.aborted || !match) return;
    const signal = session.signal;
    try {
      const rows = await D.get("/v1/matches/active", signal, 30000);
      if (signal.aborted) return;
      const update = rows.find((m) => m.match_id === match.match_id);
      if (update) {
        // Watch responses carry no observation timestamp; they must not replace streamed player state.
        const previousMode = match.match_mode, previousStart = match.start_time;
        const merged = new Map(players.map((p) => [p.accountId, p]));
        S.roster(update.players).forEach((p) => { if (!telemetry.players.has(p.accountId)) merged.set(p.accountId, p); });
        const next = [...merged.values()], changed = rosterSignature(next) !== rosterSignature(players);
        match = { ...match, ...update }; lastSuccess = new Date();
        if (changed || previousMode !== match.match_mode || previousStart !== match.start_time) { players = next; updateRosterCount(); loadScouting(); }
        $("live-status").textContent = `Watch snapshot retrieved. Friendly team: ${teamName(currentTeam())}. Scouting remains historical.`;
      } else $("live-status").textContent = "This match is no longer in the available Watch list. It may have ended or moved out of coverage; retained observations are not proof it is still live.";
      updateObservations();
    } catch (e) { if (!signal.aborted) $("live-status").textContent = `Watch refresh failed: ${errorMessage(e)} Retaining the last known roster.`; }
    if (!signal.aborted) pollTimer = setTimeout(pollRoster, 30000);
  }
  $("live-discover-form").addEventListener("submit", async (event) => { event.preventDefault(); const c = new AbortController(); try { const rows = await discover(c.signal); if ($("live-account").value && rows.length === 1) openMatch(rows[0].match_id); } catch (e) { $("live-discovery-status").textContent = errorMessage(e); } });
  $("live-match-form").addEventListener("submit", (event) => { event.preventDefault(); openMatch($("live-match-id").value); });
  $("live-open-available").addEventListener("click", () => { if ($("live-available").value) openMatch($("live-available").value); });
  $("live-team").addEventListener("change", () => { overrides.clear(); if (context) { renderScouting(); loadBuilds(); } });
  $("live-team-filter").addEventListener("change", renderRoster); $("live-sort").addEventListener("change", renderRoster);
  $("live-reconnect").addEventListener("click", async () => {
    if (!match || !session) return;
    const selectedSession = session, id = match.match_id;
    try { const url = await resolveBroadcast(id, selectedSession.signal); if (session === selectedSession && !selectedSession.signal.aborted) connectFeed(url); }
    catch (e) { if (session === selectedSession && !selectedSession.signal.aborted) { feedStatus = "Unavailable"; feedMessage = errorMessage(e); updateObservations(); } }
  });
  document.querySelectorAll('.match-contents a[href^="#"]').forEach((a) => a.addEventListener("click", () => { const target = document.querySelector(a.getAttribute("href")); if (target?.tagName === "DETAILS") target.open = true; }));
  const aging = setInterval(updateObservations, 5000);
  window.addEventListener("pagehide", () => { session?.abort(); clearInterval(aging); clearTimeout(pollTimer); clearTimeout(renderTimer); clearTimeout(rosterTimer); });
  const initial = new URLSearchParams(location.search); if (["0", "1"].includes(initial.get("team"))) $("live-team").value = initial.get("team");
  if (initial.get("id")) openMatch(initial.get("id"));
})();

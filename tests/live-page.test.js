import { test } from "node:test";
import assert from "node:assert/strict";
import D from "../live-data.js";

// live.js is a page module: install stub DOM globals and mock the shared data
// object, then import a fresh copy (the query string forces a new instance).
let instance = 0;

async function setup(scouting) {
  class Element {
    constructor(tag = "div") { this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.dataset = {}; this.style = {}; this.value = ""; this.textContent = ""; }
    append(...xs) { this.children.push(...xs); }
    replaceChildren(...xs) { this.children = xs; }
    addEventListener(k, cb) { this.events[k] = cb; }
    setAttribute() {}
  }
  const elements = new Map(), all = [];
  const get = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  get("live-team").value = "0"; get("live-team-filter").value = "all"; get("live-sort").value = "team";
  const now = Math.floor(Date.now() / 1000);
  const matches = [10, 20].map((id) => ({ match_id: id, game_mode: 1, match_mode: 4, start_time: now, players: Array.from({ length: 12 }, (_, i) => ({ account_id: i + id * 100, hero_id: i + 1, team: i < 6 ? 0 : 1 })) }));
  const document = {
    getElementById: get,
    createElement(tag) { const n = new Element(tag); all.push(n); return n; },
    createTextNode(text) { const n = new Element(); n.textContent = text; return n; },
    querySelectorAll(selector) { return selector === "[data-live-account]" ? all.filter((n) => n.dataset.liveAccount) : []; },
  };
  const timers = new Map(); let timer = 0;
  const data = {
    sources: new Map(), get: async (p) => p.includes("/active") ? matches : [],
    scouting: (m, ps, signal) => scouting(m, ps, signal, now),
    builds: async (m, c, ps) => new Map(ps.map((p) => [p.accountId, { core: [], situational: [], errors: [] }])),
  };
  Object.assign(D, data);
  Object.assign(globalThis, { document, window: { addEventListener() {} }, history: { replaceState() {} }, location: { search: "" },
    setTimeout(fn) { timers.set(++timer, fn); return timer; }, clearTimeout(id) { timers.delete(id); }, setInterval() { return 0; }, clearInterval() {},
  });
  await import(`../live.js?test=${++instance}`);
  return { get, timers, async open(id) { get("live-match-id").value = String(id); get("live-match-form").events.submit({ preventDefault() {} }); await flush(); } };
}
async function flush() { for (let i = 0; i < 12; i++) await new Promise(setImmediate); }
function fixture(match, players, signal, now) {
  return { heroes: new Map(players.map((p) => [p.heroId, { name: `Hero ${p.heroId}` }])), profiles: new Map(), ranks: new Map(), rankCatalog: [], distribution: [],
    histories: new Map(), playerHeroes: new Map(), formRows: new Map(), populationRows: [], counters: [], errors: [], items: new Map(),
    scope: { cutoff: now, start: now - 86400, end: now - 7200, mode: "ranked", patch: null }, fetchedAt: new Date() };
}
function text(node) { return node.textContent + node.children.map(text).join(" "); }

test("page resolves a full lobby with explicit missing-data states and no fabricated top threats", async () => {
  const page = await setup(async (...args) => fixture(...args));
  await page.open(10);
  assert.equal(page.get("live-content").hidden, false);
  assert.equal(page.get("live-threat-cards").children.length, 3);
  assert.match(text(page.get("live-threat-cards")), /Insufficient evidence/);
  assert.equal(page.get("live-roster-list").children.length, 12);
  assert.match(text(page.get("live-roster-list")), /Rank unavailable/);
  assert.match(text(page.get("live-focus-summary")), /No clear target advantage/);
  assert.match(text(page.get("live-build-list")), /Insufficient current-catalog item evidence/);
});
test("a late scouting result cannot replace a newly selected match", async () => {
  let finish;
  const page = await setup((m, ...args) => m.match_id === 10 ? new Promise((resolve) => { finish = () => resolve(fixture(m, ...args)); }) : Promise.resolve(fixture(m, ...args)));
  await page.open(10); await page.open(20); finish(); await flush();
  assert.match(text(page.get("live-title")), /#20/);
  assert.match(text(page.get("live-roster-list")), /Account 2000/);
  assert.doesNotMatch(text(page.get("live-roster-list")), /Account 1000/);
});
test("changing team and reopening a match leaves the page usable during a new load", async () => {
  const page = await setup(async (...args) => fixture(...args)); await page.open(10);
  page.get("live-team").value = "1"; page.get("live-team").events.change(); await flush();
  assert.equal(page.get("live-focus-list").children.length, 6);
  await page.open(20);
  assert.equal(page.get("live-roster-list").children.length, 12);
});

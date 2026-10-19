const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function setup(fetch) {
  class Element {
    constructor() {
      this.children = [];
      this.style = {};
      this.events = {};
      this.attributes = {};
      this.value = "";
      this.textContent = "";
    }
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = children;
      this.value = "";
    }
    setAttribute(key, value) {
      this.attributes[key] = value;
    }
    addEventListener(name, callback) {
      this.events[name] = callback;
    }
    removeAttribute(key) {
      delete this.attributes[key];
    }
    scrollIntoView() {}
    contains(target) {
      return (
        this === target || this.children.some((child) => child.contains(target))
      );
    }
  }
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    fetch,
    AbortSignal,
    AbortController,
    URLSearchParams,
    console,
    setTimeout: (callback) => {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    document: {
      querySelector: get,
      createElement: () => new Element(),
      addEventListener() {},
    },
  });
  for (const file of ["stats.js", "common.js", "app.js"])
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
      context,
    );
  return {
    get,
    search: async (query) => {
      get("#search-query").value = query;
      await get("#search-form").events.submit({ preventDefault() {} });
    },
    choose: async (id) =>
      vm.runInContext(
        `choosePlayer(profiles.find(p => p.account_id === ${id}))`,
        context,
      ),
    type: (query) => {
      get("#search-query").value = query;
      get("#search-query").events.input();
    },
    flush: async () => {
      const callbacks = [...timers.values()];
      timers.clear();
      await Promise.all(callbacks.map((callback) => callback()));
    },
    key: (key) =>
      get("#search-query").events.keydown({ key, preventDefault() {} }),
  };
}
const response = (data, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => data,
});
const history = (id) => [
  {
    account_id: id,
    match_id: 1,
    hero_id: 1,
    start_time: 1000,
    player_match_outcome: 1,
    player_kills: 5,
    player_deaths: 2,
    player_assists: 7,
    match_duration_s: 600,
  },
];

test("empty name searches leave no previous statistics", async () => {
  const app = setup(async (url) =>
    response(
      url.includes("steam-search")
        ? []
        : url.includes("assets")
          ? [{ id: 1, name: "Infernus" }]
          : history(42),
    ),
  );
  await app.search("42");
  assert.equal(app.get("#overall-rate").textContent, "100.0%");
  await app.search("missing");
  assert.equal(app.get("#overall-rate").textContent, "—");
  assert.equal(app.get("#hero-results").children.length, 0);
  assert.equal(app.get("#player-suggestions").hidden, true);
});
test("rate limit without stored history shows a useful error", async () => {
  const app = setup(async () => response({ error: "limited" }, 429));
  await app.search("a player");
  assert.match(app.get("#search-status").textContent, /request limit/);
  assert.equal(app.get("#search-form").attributes["aria-busy"], "false");
});
test("429 stored history is rendered and labelled, with hero-ID fallback", async () => {
  const app = setup(async (url) =>
    url.includes("assets") ? response({}, 500) : response(history(42), 429),
  );
  await app.search("42");
  assert.equal(app.get("#recent-results").children.length, 1);
  assert.match(app.get("#summary").textContent, /stored history/);
  assert.match(app.get("#summary").textContent, /Hero names are unavailable/);
  assert.equal(
    app.get("#hero-results").children[0].children[0].children[0].children[1]
      .textContent,
    "Hero 1",
  );
});
test("late results from a cancelled player cannot overwrite the next account", async () => {
  let finishFirst;
  const app = setup(async (url) => {
    if (url.includes("/42/"))
      return new Promise((resolve) => {
        finishFirst = () => resolve(response(history(42)));
      });
    return response(
      url.includes("assets") ? [{ id: 1, name: "Infernus" }] : history(43),
    );
  });
  const first = app.search("42");
  await app.search("43");
  finishFirst();
  await first;
  assert.match(app.get("#summary").textContent, /^Account 43/);
  assert.equal(app.get("#recent-results").children.length, 1);
});

test("incremental typing is debounced and short or cleared queries make no requests", async () => {
  const calls = [];
  const app = setup(async (url) => {
    calls.push(url);
    return response([]);
  });
  app.type("s");
  await app.flush();
  assert.equal(calls.length, 0);
  app.type("sh");
  app.type("shr");
  app.type("shroud");
  assert.equal(calls.length, 0);
  await app.flush();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /search_query=shroud/);
  app.type("shro");
  app.type("");
  await app.flush();
  assert.equal(calls.length, 1);
  assert.equal(app.get("#player-suggestions").hidden, true);
});
test("editing aborts old suggestions immediately, before the next debounce completes", async () => {
  let resolveOld;
  const app = setup(
    async () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const pending = app.search("old");
  app.type("new");
  resolveOld(response([{ account_id: 42, personaname: "Old" }]));
  await pending;
  assert.equal(app.get("#player-suggestions").children.length, 0);
  assert.equal(app.get("#player-suggestions").hidden, true);
});
test("suggestions include avatars, keyboard focus and a selected-player identity", async () => {
  const app = setup(async (url) =>
    response(
      url.includes("steam-search")
        ? [
            {
              account_id: 42,
              personaname: "Example",
              avatarmedium: "https://example.com/avatar.jpg",
            },
          ]
        : url.includes("assets")
          ? [
              {
                id: 1,
                name: "Infernus",
                images: {
                  icon_image_small_webp: "https://example.com/hero.webp",
                },
              },
            ]
          : history(42),
    ),
  );
  await app.search("Example");
  const options = app.get("#player-suggestions");
  const avatar = options.children[0].children[0].children[0];
  assert.equal(avatar.src, "https://example.com/avatar.jpg");
  avatar.events.error();
  assert.equal(avatar.hidden, true);
  app.key("ArrowDown");
  assert.equal(
    app.get("#search-query").attributes["aria-activedescendant"],
    "player-option-0",
  );
  app.key("Escape");
  assert.equal(options.hidden, true);
  app.key("ArrowUp");
  assert.equal(options.hidden, false);
  await app.choose(42);
  assert.equal(options.hidden, true);
  assert.equal(
    app.get("#selected-player").children[1].children[0].textContent,
    "Example",
  );
  const portrait =
    app.get("#hero-results").children[0].children[0].children[0].children[0]
      .children[0];
  assert.equal(portrait.src, "https://example.com/hero.webp");
});
test("IME composition does not search until composition finishes", async () => {
  let count = 0;
  const app = setup(async () => {
    count++;
    return response([]);
  });
  app.get("#search-query").events.compositionstart();
  app.type("player");
  await app.flush();
  assert.equal(count, 0);
  app.get("#search-query").events.compositionend();
  await app.flush();
  assert.equal(count, 1);
});

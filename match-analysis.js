"use strict";
// Match analysis owns opponent selection and the team souls advantage graph.
// render() receives the shared view; calculations stay in analysis-stats.js.
const MatchAnalysis = (() => {
  let laneMatchId;
  let view;
  const byId = (id) => document.getElementById(id);
  const playerLabel = (p) =>
    `${view.profiles.get(p.accountId)?.personaname || `Account ${p.accountId}`} · ${view.heroes.get(p.heroId)?.name || `Hero ${p.heroId}`}`;
  const formatTime = (t) =>
    Number.isFinite(t)
      ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`
      : "—";
  const formatNumber = (n) =>
    Number.isFinite(n) ? Math.round(n).toLocaleString() : "—";
  // Replace a comparison table using accessible headings and text-only cells.
  function renderTable(target, headers, rows) {
    const wrap = document.createElement("div");
    wrap.className = "table-scroll";
    wrap.tabIndex = 0;
    const t = document.createElement("table"),
      head = document.createElement("thead"),
      tr = document.createElement("tr"),
      body = document.createElement("tbody");
    headers.forEach((h) => {
      const th = cell("th", h);
      th.scope = "col";
      tr.append(th);
    });
    head.append(tr);
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      row.forEach((v) => tr.append(cell("td", String(v))));
      body.append(tr);
    });
    t.append(head, body);
    wrap.append(t);
    byId(target).replaceChildren(wrap);
  }
  // Refresh team data and identities without resetting the chosen lane pair.
  function render(next) {
    view = next;
    renderLaneSelectors();
    drawAdvantage();
    renderOpponentComparison();
  }
  // Lane selectors retain their own state when the scoreboard highlight changes.
  // Rebuild labels after profile enrichment while keeping a valid opposing pair.
  function fillPlayerOptions(id, players, preferredSlot) {
    const select = byId(id);
    select.replaceChildren();
    for (const player of players) {
      const team = player.team === 0 ? "The Hidden King" : "The ArchMother";
      const option = cell("option", `${playerLabel(player)} · ${team}`);
      option.value = String(player.slot);
      select.append(option);
    }
    if (
      players.some((player) => String(player.slot) === String(preferredSlot))
    ) {
      select.value = String(preferredSlot);
    }
    select.disabled = !players.length;
    renderHeroPicker(select, players);
  }

  // Use real buttons inside a disclosure for image choices: native <option>
  // rendering drops images in many browsers. Keep names for identifying players,
  // and expose the hero name to screen readers and in the image tooltip.
  function renderHeroPicker(select, players) {
    select.hidden = true;
    let picker = byId(`${select.id}-picker`);
    if (!picker) {
      picker = document.createElement("details");
      picker.id = `${select.id}-picker`;
      picker.className = "hero-picker";
      select.after(picker);
      picker.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          picker.open = false;
          picker.querySelector("summary").focus();
        }
      });
      const label = document.querySelector(`label[for="${select.id}"]`);
      if (label) {
        label.removeAttribute("for");
        label.addEventListener("click", () =>
          picker.querySelector("summary").focus(),
        );
      }
    }
    const identity = (player) => {
      const hero = view.heroes.get(player.heroId);
      const heroName = hero?.name || `Hero ${player.heroId}`;
      const icon = portrait(
        hero?.images?.icon_image_small_webp || hero?.images?.icon_image_small,
        heroName,
        "hero-portrait",
      );
      icon.title = heroName;
      const text = cell(
        "span",
        view.profiles.get(player.accountId)?.personaname ||
          `Account ${player.accountId}`,
      );
      text.append(
        cell("small", player.team === 0 ? "The Hidden King" : "The ArchMother"),
      );
      return [icon, text];
    };
    const current = players.find(
      (player) => String(player.slot) === select.value,
    );
    const summary = document.createElement("summary");
    summary.id = `${select.id}-trigger`;
    summary.setAttribute(
      "aria-label",
      `${select.id === "lane-player" ? "First player" : "Opposing player"}: ${current ? playerLabel(current) : "Unavailable"}`,
    );
    if (current) summary.append(...identity(current));
    else summary.textContent = "No eligible players";
    const choices = document.createElement("div");
    choices.className = "hero-picker-options";
    for (const player of players) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-label", playerLabel(player));
      button.setAttribute("aria-pressed", String(player === current));
      button.append(...identity(player));
      button.addEventListener("click", () => {
        select.value = String(player.slot);
        picker.open = false;
        select.dispatchEvent(new Event("change"));
        renderHeroPicker(select, players);
        picker.querySelector("summary").focus();
      });
      choices.append(button);
    }
    picker.replaceChildren(summary, choices);
  }

  // Keep the first player selected while restricting the second choice to the opposing team.
  function renderLaneSelectors() {
    const newMatch = laneMatchId !== view.match.id;
    const firstSlot = newMatch ? view.selectedSlot : byId("lane-player").value;
    const opponentSlot = newMatch ? null : byId("analysis-opponent").value;
    const players = view.match.players.filter((player) =>
      [0, 1].includes(player.team),
    );
    fillPlayerOptions("lane-player", players, firstSlot);
    const first = players.find(
      (player) => String(player.slot) === byId("lane-player").value,
    );
    fillPlayerOptions(
      "analysis-opponent",
      players.filter((player) => first && player.team !== first.team),
      opponentSlot,
    );
    byId("lane-time").max = String(
      view.match.duration ||
        Math.max(
          1,
          ...view.match.players.flatMap((player) =>
            player.soulSamples.map((sample) => sample.time),
          ),
        ),
    );
    if (newMatch)
      byId("lane-time").value = String(
        Math.min(600, Number(byId("lane-time").max)),
      );
    laneMatchId = view.match.id;
  }

  // Match-wide objective markers share the player graph's tooltip styling.
  const objectiveTooltip = document.createElement("div");
  objectiveTooltip.id = "objective-tooltip";
  objectiveTooltip.className = "souls-player-tooltip";
  objectiveTooltip.setAttribute("role", "tooltip");
  objectiveTooltip.hidden = true;
  document.body.append(objectiveTooltip);
  const hideObjectiveTooltip = () => {
    objectiveTooltip.hidden = true;
  };
  window.addEventListener("scroll", hideObjectiveTooltip, true);
  window.addEventListener("resize", hideObjectiveTooltip);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideObjectiveTooltip();
  });
  byId("advantage-chart")
    .closest("details")
    .addEventListener("toggle", hideObjectiveTooltip);
  byId("show-objective-events").addEventListener("change", () => {
    if (view) drawAdvantage();
  });
  // Overlay friendly structure losses and neutral Mid Boss deaths on the team advantage chart.
  function drawObjectives(svg, el, x) {
    if (!byId("show-objective-events").checked) return;
    const team = view.match.players.find(
      (p) => p.slot === view.selectedSlot,
    )?.team;
    for (const event of view.match.objectives || []) {
      if (event.kind !== "midboss" && event.team !== team) continue;
      const boss = event.kind === "midboss";
      const label = `${formatTime(event.time)} · ${boss ? "Mid Boss killed" : `Friendly ${event.type} destroyed · ${team === 0 ? "The Hidden King" : "The ArchMother"}`}`;
      const cx = x(event.time),
        cy = boss ? 250 : 18;
      const marker = el("g", {
        tabindex: 0,
        "aria-label": label,
        "aria-describedby": objectiveTooltip.id,
        "data-event-kind": event.kind,
      });
      marker.append(el("circle", { cx, cy, r: 12, fill: "transparent" }));
      marker.append(
        boss
          ? el("image", {
              href: "rejuvenator.svg",
              x: cx - 11,
              y: cy - 11,
              width: 22,
              height: 22,
            })
          : el("path", {
              d: `M ${cx - 5} ${cy - 5} L ${cx + 5} ${cy + 5} M ${cx + 5} ${cy - 5} L ${cx - 5} ${cy + 5}`,
              stroke: "#f08a8a",
              "stroke-width": 2.5,
              "stroke-linecap": "round",
            }),
      );
      marker.append(el("title", {}, label));
      const show = (e) => {
        objectiveTooltip.replaceChildren(cell("strong", label));
        objectiveTooltip.hidden = false;
        const bounds = marker.getBoundingClientRect();
        const px = Number.isFinite(e.clientX) ? e.clientX : bounds.left;
        const py = Number.isFinite(e.clientY) ? e.clientY : bounds.top;
        objectiveTooltip.style.left = `${Math.max(8, Math.min(px + 14, window.innerWidth - objectiveTooltip.offsetWidth - 8))}px`;
        objectiveTooltip.style.top = `${Math.max(8, Math.min(py + 14, window.innerHeight - objectiveTooltip.offsetHeight - 8))}px`;
      };
      marker.addEventListener("pointermove", show);
      marker.addEventListener("focus", show);
      marker.addEventListener("pointerleave", hideObjectiveTooltip);
      marker.addEventListener("blur", hideObjectiveTooltip);
      svg.append(marker);
    }
  }

  // Plot Hidden King minus ArchMother souls; objective events can still render without snapshots.
  function drawAdvantage() {
    hideObjectiveTooltip();
    const points = AnalysisStats.advantage(view.match),
      svg = byId("advantage-chart"),
      ns = "http://www.w3.org/2000/svg";
    const el = (tag, attrs, text) => {
      const n = document.createElementNS(ns, tag);
      Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
      if (text) n.textContent = text;
      return n;
    };
    svg.replaceChildren(el("title", {}, "Team souls advantage over game time"));
    byId("advantage-note").textContent = points.length
      ? `${points.length} simultaneous team snapshots. Lines between snapshots are not measured values.`
      : "No complete simultaneous team snapshots are available.";
    const max = Math.max(1000, ...points.map((p) => Math.abs(p.souls))),
      end = Math.max(
        1,
        view.match.duration ||
          points.at(-1)?.time ||
          Math.max(
            1,
            ...(view.match.objectives || []).map((event) => event.time),
          ),
      );
    const x = (t) => 85 + (t / end) * 870,
      y = (n) => 140 - (n / max) * 105;
    [-1, -0.5, 0, 0.5, 1].forEach((f) => {
      svg.append(
        el("line", {
          x1: 85,
          x2: 955,
          y1: y(f * max),
          y2: y(f * max),
          stroke: f === 0 ? "#d7bf83" : "#394132",
        }),
        el(
          "text",
          {
            x: 75,
            y: y(f * max) + 4,
            "text-anchor": "end",
            class: "chart-label",
          },
          formatNumber(f * max),
        ),
      );
    });
    for (let i = 0; i <= 5; i++)
      svg.append(
        el(
          "text",
          {
            x: x((end * i) / 5),
            y: 275,
            "text-anchor": "middle",
            class: "chart-label",
          },
          formatTime((end * i) / 5),
        ),
      );
    svg.append(
      el("polyline", {
        points: points.map((p) => `${x(p.time)},${y(p.souls)}`).join(" "),
        fill: "none",
        stroke: "#d7bf83",
        "stroke-width": 3,
      }),
    );
    points.forEach((p) => {
      const dot = el("circle", {
        cx: x(p.time),
        cy: y(p.souls),
        r: 4,
        fill: p.souls >= 0 ? "#86d99b" : "#f08a8a",
      });
      dot.append(
        el(
          "title",
          {},
          `${formatTime(p.time)} · ${formatNumber(p.souls)} souls advantage for The Hidden King`,
        ),
      );
      svg.append(dot);
    });
    drawObjectives(svg, el, x);
  }
  // Compare the chosen opposing players at a time using observed souls, kills/deaths and first buys.
  function renderOpponentComparison() {
    const time = Number(byId("lane-time").value),
      player = view.match.players.find(
        (p) => String(p.slot) === byId("lane-player").value,
      ),
      opponent = view.match.players.find(
        (p) => String(p.slot) === byId("analysis-opponent").value,
      );
    byId("lane-time-label").textContent = formatTime(time);
    if (!player || !opponent || player.team === opponent.team) {
      byId("opponent-comparison").textContent =
        "Two players on opposing teams are required for a lane comparison.";
      return;
    }
    const players = [player, opponent];
    renderTable(
      "opponent-comparison",
      ["Player", "Souls (snapshot time)", "Recorded K / D", "Assists"],
      players.map((p) => {
        const s = AnalysisStats.at(p, time),
          c = AnalysisStats.counts(view.match, p, 0, time);
        return [
          playerLabel(p),
          s
            ? `${formatNumber(s.souls)} (${formatTime(s.time)})`
            : "Unavailable",
          `${c.kills} / ${c.deaths}${view.match.incomplete ? " (partial)" : ""}`,
          "Unavailable at this time",
        ];
      }),
    );
    const a = AnalysisStats.at(player, time),
      b = opponent && AnalysisStats.at(opponent, time);
    byId("opponent-comparison").append(
      cell(
        "p",
        a && b && a.time === b.time
          ? `Souls difference: ${formatNumber(a.souls - b.souls)} at ${formatTime(a.time)}.`
          : "No souls difference calculated unless both snapshot times match.",
      ),
    );
    if (view.items) {
      const buys = players.map((p) => AnalysisStats.firstBuys(p, view.items));
      const rows = [...new Set(buys.flatMap((m) => [...m.keys()]))]
        .filter((id) => buys.some((m) => m.has(id) && m.get(id) <= time))
        .map((id) => [
          view.items.get(id)?.name || `Item ${id}`,
          ...buys.map((m) =>
            m.has(id) && m.get(id) <= time
              ? formatTime(m.get(id))
              : "Not recorded by this time",
          ),
        ]);
      const holder = document.createElement("div");
      holder.id = "lane-item-times";
      byId("opponent-comparison").append(holder);
      renderTable(
        "lane-item-times",
        ["First purchase", ...players.map(playerLabel)],
        rows,
      );
    }
  }
  // Register handlers once; render() only refreshes the current view.
  byId("lane-player").addEventListener("change", () => {
    if (!view) return;
    renderLaneSelectors();
    renderOpponentComparison();
  });
  byId("lane-time").addEventListener(
    "input",
    () => view && renderOpponentComparison(),
  );
  byId("analysis-opponent").addEventListener(
    "change",
    () => view && renderOpponentComparison(),
  );
  document.querySelectorAll(".match-contents a").forEach((link) =>
    link.addEventListener("click", () => {
      const target = document.querySelector(link.getAttribute("href"));
      if (target?.tagName === "DETAILS") target.open = true;
    }),
  );
  return { render };
})();

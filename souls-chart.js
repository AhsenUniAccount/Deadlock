"use strict";

// SVG chart controller. All available timelines remain visible; the selected
// perspective controls team colors, the solid line, and event markers.
const SoulsChart = (() => {
  // Team colors are relative to the highlighted player, not to the winning team.
  function playerColor(player) {
    const selected = view.match.players.find(
      (person) => person.slot === view.selectedSlot,
    );
    if (player.slot === view.selectedSlot) return "#86d99b";
    if (selected?.team == null || player.team == null) return "#acb9a4";
    return player.team === selected.team ? "#86d99b" : "#f08a8a";
  }
  let view;
  let visible = new Set();
  let endTime = 1;
  const svgNS = "http://www.w3.org/2000/svg";
  function node(tag, attributes = {}, text) {
    const element = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attributes))
      element.setAttribute(key, value);
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function time(seconds) {
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  }
  function name(player) {
    return `${view.profiles.get(player.accountId)?.personaname || `Account ${player.accountId}`} · ${view.heroes.get(player.heroId)?.name || `Hero ${player.heroId}`}`;
  }
  // HTML tooltips can show hero images, unlike the browser's SVG title tooltip.
  // Attach to the body to avoid clipping inside the horizontally scrolling chart.
  const tooltip = document.createElement("div");
  tooltip.id = "souls-player-tooltip";
  tooltip.className = "souls-player-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  document.body.append(tooltip);

  function hideTooltip() {
    tooltip.hidden = true;
  }
  function showPlayerTooltip(player, event) {
    const hero = view.heroes.get(player.heroId);
    const heroName = hero?.name || `Hero ${player.heroId}`;
    const username =
      view.profiles.get(player.accountId)?.personaname ||
      `Account ${player.accountId}`;
    const text = cell("span", username);
    text.append(cell("small", heroName));
    tooltip.replaceChildren(
      portrait(
        hero?.images?.icon_image_small_webp || hero?.images?.icon_image_small,
        heroName,
        "hero-portrait",
      ),
      text,
    );
    positionTooltip(event);
  }
  function positionTooltip(event) {
    tooltip.hidden = false;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Number.isFinite(event.clientX)
      ? event.clientX
      : bounds.left + bounds.width / 2;
    const y = Number.isFinite(event.clientY) ? event.clientY : bounds.top;
    tooltip.style.left = `${Math.max(8, Math.min(x + 14, window.innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(y + 14, window.innerHeight - tooltip.offsetHeight - 8))}px`;
  }
  function attachPlayerTooltip(element, player) {
    element.addEventListener("pointermove", (event) =>
      showPlayerTooltip(player, event),
    );
    element.addEventListener("pointerleave", hideTooltip);
    element.addEventListener("focus", (event) =>
      showPlayerTooltip(player, event),
    );
    element.addEventListener("blur", hideTooltip);
  }
  window.addEventListener("scroll", hideTooltip, true);
  window.addEventListener("resize", hideTooltip);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideTooltip();
  });
  document
    .querySelector("#souls-graph")
    .addEventListener("toggle", hideTooltip);

  function playerIdentity(player) {
    const hero = view.heroes.get(player.heroId);
    const heroName = hero?.name || `Hero ${player.heroId}`;
    const text = cell(
      "span",
      view.profiles.get(player.accountId)?.personaname ||
        `Account ${player.accountId}`,
    );
    text.append(cell("small", heroName));
    return [
      portrait(
        hero?.images?.icon_image_small_webp || hero?.images?.icon_image_small,
        heroName,
        "hero-portrait",
      ),
      text,
    ];
  }
  function renderPerspective() {
    const current = document.querySelector("#souls-perspective-current");
    const options = document.querySelector("#souls-perspective-options");
    const selected = view.match.players.find(
      (player) => player.slot === view.selectedSlot,
    );
    current.replaceChildren(...playerIdentity(selected));
    const kda = document.querySelector("#souls-player-kda");
    const count = (value) =>
      Number.isFinite(value) ? value.toLocaleString() : "—";
    kda.textContent = [selected.kills, selected.deaths, selected.assists]
      .map(count)
      .join(" / ");
    kda.setAttribute(
      "aria-label",
      `${count(selected.kills)} kills, ${count(selected.deaths)} deaths, ${count(selected.assists)} assists`,
    );
    options.replaceChildren();
    for (const player of view.match.players) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.playerSlot = player.slot;
      button.setAttribute(
        "aria-pressed",
        String(player.slot === view.selectedSlot),
      );
      button.append(...playerIdentity(player));
      button.addEventListener("click", () => {
        document.querySelector("#souls-perspective").open = false;
        // Match controller owns selection, keeping the scoreboard and analysis in sync.
        document.dispatchEvent(
          new CustomEvent("match-player-select", {
            detail: { slot: player.slot },
          }),
        );
        current.focus();
      });
      options.append(button);
    }
  }
  function showEventTooltip(eventData, pointerEvent) {
    const text = document.createElement("span");
    text.append(
      cell(
        "strong",
        `${time(eventData.time)} · ${eventData.kind === "kill" ? "Killed" : eventData.kind === "death" ? "Killed by" : "Purchased"}`,
      ),
    );
    if (eventData.kind === "purchase") {
      const item = eventData.item;
      const itemName = item?.name || "Unknown item";
      text.append(cell("small", itemName));
      tooltip.replaceChildren(
        portrait(
          item?.shop_image_webp ||
            item?.shop_image ||
            item?.image_webp ||
            item?.image,
          itemName,
          "item-portrait",
        ),
        text,
      );
    } else {
      const person = eventData.other;
      const hero = person && view.heroes.get(person.heroId);
      const heroName =
        hero?.name || (person ? `Hero ${person.heroId}` : "Unknown source");
      text.append(
        cell("small", person ? name(person) : "Unknown / non-player source"),
      );
      // Net-worth snapshots also include farming and other income: never attribute
      // their difference to one kill/death without a verified currency-event source.
      text.append(
        cell(
          "small",
          `Souls ${eventData.kind === "kill" ? "gained" : "lost"}: unavailable in match metadata`,
        ),
      );
      tooltip.replaceChildren(
        portrait(
          hero?.images?.icon_image_small_webp || hero?.images?.icon_image_small,
          heroName,
          "hero-portrait",
        ),
        text,
      );
    }
    positionTooltip(pointerEvent);
  }
  function attachEventTooltip(element, eventData) {
    element.setAttribute("aria-describedby", tooltip.id);
    element.addEventListener("pointermove", (event) =>
      showEventTooltip(eventData, event),
    );
    element.addEventListener("focus", (event) =>
      showEventTooltip(eventData, event),
    );
    element.addEventListener("pointerleave", hideTooltip);
    element.addEventListener("blur", hideTooltip);
  }
  document
    .querySelector("#souls-perspective")
    .addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.currentTarget.open = false;
        document.querySelector("#souls-perspective-current").focus();
      }
    });

  function render(nextView) {
    view = nextView;
    document.querySelector("#souls-event-detail").textContent = "";
    const players = view.match.players;
    const available = players.filter((player) => player.soulSamples.length);
    visible = new Set(available.map((player) => player.slot));
    endTime = Math.max(
      1,
      view.match.duration || 0,
      ...players.flatMap((player) =>
        player.soulSamples.map((point) => point.time),
      ),
    );
    document.querySelector("#souls-note").textContent = available.length
      ? "Lines connect recorded net-worth snapshots, including spent souls; values between snapshots are not measured. The highlighted player has a solid line; all other players have dotted lines. Green: highlighted player and teammates. Red: opponents. Choose a player from the perspective dropdown to change the highlight and event markers." +
        (available.length < players.length
          ? ` Timeline data is missing for ${players.length - available.length} player(s).`
          : "")
      : "No souls-over-time snapshots are available for this match. Final souls are still shown in the scoreboard.";
    renderPerspective();
    draw();
  }
  function draw() {
    hideTooltip();
    const svg = document.querySelector("#souls-chart");
    svg.replaceChildren(
      node(
        "title",
        { id: "souls-chart-title" },
        "Souls per player over game time",
      ),
      node(
        "desc",
        { id: "souls-chart-description" },
        "X axis: game time. Y axis: souls. The player dropdown selects the perspective. Hover over snapshots and events for details.",
      ),
    );
    const left = 78,
      right = 970,
      top = 26,
      bottom = 338;
    const maxSouls = Math.max(
      5000,
      Math.ceil(
        Math.max(
          0,
          ...view.match.players.flatMap((player) =>
            player.soulSamples.map((point) => point.souls),
          ),
        ) / 5000,
      ) * 5000,
    );
    const x = (time) => left + (time / endTime) * (right - left);
    const y = (souls) => bottom - (souls / maxSouls) * (bottom - top);
    for (let tick = 0; tick <= 5; tick++) {
      const souls = (tick * maxSouls) / 5;
      svg.append(
        node("line", {
          x1: left,
          y1: y(souls),
          x2: right,
          y2: y(souls),
          stroke: "#394132",
        }),
      );
      svg.append(
        node(
          "text",
          {
            x: left - 12,
            y: y(souls) + 4,
            "text-anchor": "end",
            class: "chart-label",
          },
          Math.round(souls).toLocaleString(),
        ),
      );
      const seconds = (tick * endTime) / 5;
      svg.append(
        node(
          "text",
          {
            x: x(seconds),
            y: bottom + 25,
            "text-anchor": "middle",
            class: "chart-label",
          },
          time(seconds),
        ),
      );
    }
    svg.append(
      node("text", { x: left, y: 15, class: "chart-label" }, "Souls"),
      node(
        "text",
        {
          x: (left + right) / 2,
          y: 390,
          "text-anchor": "middle",
          class: "chart-label",
        },
        "Game time (minutes:seconds)",
      ),
    );
    [...view.match.players]
      .sort(
        (a, b) =>
          Number(a.slot === view.selectedSlot) -
          Number(b.slot === view.selectedSlot),
      )
      .forEach((player) => {
        if (!visible.has(player.slot) || !player.soulSamples.length) return;
        const color = playerColor(player);
        // Keep context visible without competing with the highlighted player.
        const opacity = player.slot === view.selectedSlot ? 1 : 0.4;
        const line = node("polyline", {
          points: player.soulSamples
            .map((point) => `${x(point.time)},${y(point.souls)}`)
            .join(" "),
          fill: "none",
          stroke: color,
          opacity,
          "stroke-width": player.slot === view.selectedSlot ? 3.5 : 2,
          "stroke-dasharray":
            player.slot === view.selectedSlot ? "none" : "1 6",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          class: "souls-line",
          "data-player-slot": player.slot,
        });
        svg.append(line);
        // A transparent, solid hit area makes even faint dotted lines easy to hover.
        // It changes pointer targeting only, preserving the visible line styling.
        const hitArea = node("polyline", {
          points: line.getAttribute("points"),
          fill: "none",
          stroke: "transparent",
          "stroke-width": 12,
          "pointer-events": "stroke",
          tabindex: 0,
          "aria-label": name(player),
          "aria-describedby": tooltip.id,
          class: "souls-line-hit",
          "data-player-slot": player.slot,
        });
        attachPlayerTooltip(hitArea, player);
        svg.append(hitArea);
        for (const point of player.soulSamples) {
          const dot = node("circle", {
            cx: x(point.time),
            cy: y(point.souls),
            r: player.slot === view.selectedSlot ? 3 : 2,
            fill: color,
            opacity,
          });
          dot.append(
            node(
              "title",
              {},
              `${name(player)} · ${time(point.time)} · ${point.souls.toLocaleString()} souls`,
            ),
          );
          attachPlayerTooltip(dot, player);
          svg.append(dot);
        }
      });
    if (document.querySelector("#show-souls-events").checked) {
      events().forEach((event) => {
        // Separate event rows keep a kill and a purchase at the same time distinct.
        // Group each symbol with its hit area for one accessible click target.
        const marker = node("g", { "data-event-kind": event.kind });
        const centerX = x(event.time);
        const centerY =
          event.kind === "kill" ? 24 : event.kind === "death" ? 42 : 60;
        if (event.kind === "purchase") {
          // Vector cart stays crisp at chart scale; the invisible box keeps it easy to click.
          marker.append(
            node("rect", {
              x: centerX - 9,
              y: centerY - 9,
              width: 18,
              height: 18,
              fill: "transparent",
            }),
          );
          marker.append(
            node("path", {
              d: "M2 3h2l2 10h9l3-7H5 M7 16h.01 M14 16h.01",
              transform: `translate(${centerX - 10} ${centerY - 10})`,
              fill: "none",
              stroke: "#d7bf83",
              "stroke-width": 2,
              "stroke-linecap": "round",
              "stroke-linejoin": "round",
            }),
          );
        } else {
          // Invisible interiors preserve a generous hit target for hollow symbols.
          marker.append(
            node("circle", {
              cx: centerX,
              cy: centerY,
              r: 7,
              fill: "transparent",
              stroke: event.kind === "kill" ? "#86d99b" : "none",
              "stroke-width": 2,
            }),
          );
          if (event.kind === "death") {
            marker.append(
              node("path", {
                d: `M ${centerX - 5} ${centerY - 5} L ${centerX + 5} ${centerY + 5} M ${centerX + 5} ${centerY - 5} L ${centerX - 5} ${centerY + 5}`,
                stroke: "#f08a8a",
                "stroke-width": 2.5,
                "stroke-linecap": "round",
                "pointer-events": "none",
              }),
            );
          }
        }
        marker.setAttribute("role", "button");
        marker.setAttribute("tabindex", "0");
        marker.setAttribute(
          "aria-label",
          `${time(event.time)} · ${event.label}`,
        );
        marker.append(
          node("title", {}, `${time(event.time)} · ${event.label}`),
        );
        attachEventTooltip(marker, event);
        const activate = () => jump(event.time, event.label);
        marker.addEventListener("click", activate);
        marker.addEventListener("keydown", (e) => {
          if (["Enter", " "].includes(e.key)) {
            e.preventDefault();
            activate();
          }
        });
        svg.append(marker);
      });
    }
    if (!visible.size)
      svg.append(
        node(
          "text",
          { x: 520, y: 185, "text-anchor": "middle", class: "chart-label" },
          "No player timeline data is available.",
        ),
      );
  }
  // Markers describe recorded events only; purchases need a loaded item catalog.
  function events() {
    const player = view.match.players.find((p) => p.slot === view.selectedSlot);
    if (!player) return [];
    const timeline = DeadlockMatchStats.killTimeline(view.match);
    const kills = timeline
      .filter(
        (e) =>
          e.killer?.slot === player.slot &&
          e.victim.slot !== player.slot &&
          e.time !== null,
      )
      .map((e) => ({
        time: e.time,
        kind: "kill",
        other: e.victim,
        label: `${name(player)} killed ${name(e.victim)}`,
      }));
    const deaths = timeline
      .filter((e) => e.victim.slot === player.slot && e.time !== null)
      .map((e) => ({
        time: e.time,
        kind: "death",
        other: e.killer,
        label: e.killer
          ? `${name(player)} died to ${name(e.killer)}`
          : `${name(player)} died to an unknown / non-player source`,
      }));
    const buys = view.items
      ? (DeadlockMatchStats.purchases(player, view.items) || [])
          .filter((p) => p.bought !== null && p.bought <= endTime)
          .map((p) => ({
            time: p.bought,
            kind: "purchase",
            item: view.items.get(p.id),
            label: `Bought ${view.items.get(p.id)?.name || `Item ${p.id}`}`,
          }))
      : [];
    return [...kills, ...deaths, ...buys].sort((a, b) => a.time - b.time);
  }

  function jump(seconds, label = "Selected event") {
    if (!view) return;
    document.querySelector("#souls-graph").open = true;
    document.querySelector("#souls-event-detail").textContent =
      `${time(seconds)} · ${label}`;
    draw();
    document.querySelector("#souls-chart").scrollIntoView({ block: "center" });
  }
  document
    .querySelector("#show-souls-events")
    .addEventListener("change", () => {
      if (view) {
        draw();
      }
    });
  return { render, jump };
})();

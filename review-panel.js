import SoulsChart from "./souls-chart.js";
import MatchDigest from "./match-digest.js";
import MatchSummary from "./match-summary.js";
import { cell } from "./common.js";

// Match summary panel for the selected player. The rule-based summary is built
// here in the browser from the loaded match. The optional AI explanation is
// requested from the Worker, which builds the same digest and calls the model.
const ReviewPanel = (() => {
  const byId = (id) => document.getElementById(id);
  const summaryHeadline = byId("summary-headline");
  const summaryPoints = byId("summary-points");
  const button = byId("ai-review-button");
  const status = byId("ai-review-status");
  const result = byId("ai-review-result");
  // Reviews and in-flight requests are per match and player slot, so switching
  // players never shows another player's review or a late response.
  const reviews = new Map();
  const pending = new Map();
  let view;

  const keyFor = () => `${view.match.id}:${view.selectedSlot}`;
  const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const heroLabel = () => {
    const player = view.match.players.find((p) => p.slot === view.selectedSlot);
    return view.heroes.get(player?.heroId)?.name || "this player";
  };

  // A key-moment or summary time opens the souls chart at that point.
  function timeButton(seconds, label) {
    const time = document.createElement("button");
    time.type = "button";
    time.className = "ai-moment-time";
    time.textContent = clock(seconds);
    time.setAttribute("aria-label", `Show ${clock(seconds)} on the souls chart`);
    time.addEventListener("click", () => SoulsChart.jump(seconds, label));
    return time;
  }

  function renderSummary() {
    summaryPoints.replaceChildren();
    let summary;
    try {
      summary = MatchSummary.build(
        MatchDigest.build(view.match, { heroes: view.heroes, items: view.items }, view.selectedSlot),
      );
    } catch (error) {
      summaryHeadline.textContent = error.message;
      return;
    }
    summaryHeadline.textContent = summary.headline;
    if (!summary.points.length)
      summaryPoints.append(cell("li", "Not enough recorded data for a summary of this player."));
    for (const point of summary.points) {
      const item = document.createElement("li");
      item.dataset.impact = point.tone;
      const text = document.createElement("div");
      text.append(cell("strong", point.title), cell("p", point.detail));
      item.append(point.timeS === null ? cell("span", "") : timeButton(point.timeS, point.title), text);
      summaryPoints.append(item);
    }
  }

  function render(nextView) {
    view = nextView;
    renderSummary();
    const key = keyFor();
    button.textContent = `Explain ${heroLabel()}'s match with AI`;
    button.disabled = pending.has(key);
    const review = reviews.get(key);
    if (review?.error) {
      result.hidden = true;
      status.textContent = review.error;
    } else if (review) {
      status.textContent = "";
      showReview(review);
    } else {
      result.hidden = true;
      result.replaceChildren();
      status.textContent = pending.has(key)
        ? "The AI coach is reviewing the match. This can take up to a minute…"
        : "";
    }
  }

  async function requestReview() {
    const key = keyFor();
    if (pending.has(key)) return;
    const controller = new AbortController();
    pending.set(key, controller);
    reviews.delete(key);
    render(view);
    const [matchId, slot] = key.split(":").map(Number);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ matchId, slot }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!body)
        throw new Error(
          "AI review needs the site's Worker. Run `npm run dev` locally, or use the hosted site.",
        );
      if (!response.ok) throw new Error(body.error || `AI review failed (${response.status}).`);
      reviews.set(key, body);
    } catch (error) {
      if (controller.signal.aborted) return;
      reviews.set(key, {
        error:
          error instanceof TypeError
            ? "Could not reach the AI review service. Check your connection and try again."
            : error.message,
      });
    } finally {
      pending.delete(key);
    }
    // Only repaint if the response belongs to the player currently selected.
    if (view && keyFor() === key) render(view);
  }

  function section(title, list) {
    const wrapper = document.createElement("section");
    wrapper.className = "ai-review-section";
    wrapper.append(cell("h4", title), list);
    return wrapper;
  }

  function showReview(review) {
    const { analysis } = review;
    const moments = document.createElement("ol");
    moments.className = "ai-moments";
    for (const moment of analysis.keyMoments) {
      const item = document.createElement("li");
      item.dataset.impact = moment.impact;
      const time = timeButton(moment.timeS, moment.title);
      const text = document.createElement("div");
      text.append(cell("strong", moment.title), cell("p", moment.detail));
      item.append(time, text);
      moments.append(item);
    }
    const strengths = document.createElement("ul");
    strengths.className = "ai-points";
    for (const point of analysis.strengths) {
      const item = document.createElement("li");
      item.append(cell("strong", point.title), cell("p", point.detail));
      strengths.append(item);
    }
    const improvements = document.createElement("ol");
    improvements.className = "ai-points";
    for (const point of analysis.improvements) {
      const item = document.createElement("li");
      const evidence = cell("small", `Evidence: ${point.evidence}`);
      item.append(cell("strong", point.title), cell("p", point.detail), evidence);
      improvements.append(item);
    }
    // The exact data sent to the model, so readers can check the review's claims.
    const source = document.createElement("details");
    source.className = "ai-source";
    const sourceSummary = cell("summary", "Match data the AI was given");
    const sourceBody = cell("pre", JSON.stringify(review.digest, null, 2));
    source.append(sourceSummary, sourceBody);
    const generated = new Date(review.generatedAt);
    const footer = cell(
      "p",
      `Generated by ${review.model}${Number.isNaN(generated.getTime()) ? "" : ` on ${generated.toLocaleString()}`}${review.cached ? " (saved review)" : ""}. AI reviews can be wrong. Check claims against the charts and tables below.`,
    );
    footer.className = "match-help";

    const headline = cell("h4", analysis.headline);
    headline.className = "ai-headline";
    result.replaceChildren(
      headline,
      cell("p", analysis.summary),
      ...(analysis.keyMoments.length ? [section("Key moments", moments)] : []),
      ...(analysis.strengths.length ? [section("What went well", strengths)] : []),
      ...(analysis.improvements.length ? [section("What to work on", improvements)] : []),
      footer,
      source,
    );
    result.hidden = false;
  }

  button.addEventListener("click", requestReview);
  window.addEventListener("pagehide", () => {
    for (const controller of pending.values()) controller.abort();
  });
  return { render };
})();

export default ReviewPanel;

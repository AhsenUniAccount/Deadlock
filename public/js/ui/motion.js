// Site-wide motion, loaded on every page: the header shrinks once the page
// scrolls, sections slide in as they enter the viewport (including content that
// loads later), cards tilt towards the pointer, and [data-parallax] layers drift.
// Nothing is hidden or moved for people who prefer reduced motion.

const reduceMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
const finePointer = globalThis.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? false;

// Sections that slide in. Items rendered with .reveal already animate on arrival.
const REVEAL = [
  ".panel",
  ".search-panel",
  ".match-details",
  ".mvp-team",
  ".team-scoreboard",
  ".feature-card",
  ".compare-hero",
  ".sec-h",
  ".split > *",
  ".pgrid",
  ".data-note",
  ".policy section",
  ".live-section",
  ".page-heading",
].join(", ");
// Cards that tilt slightly towards the pointer.
const TILT = ".hero-card, .feature-card, .mvp-team, .last-card";

const header = document.querySelector(".masthead");
const parallaxLayers = () => document.querySelectorAll("[data-parallax]");

let frame = 0;
function onScroll() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    header?.classList.toggle("is-scrolled", window.scrollY > 8);
    if (reduceMotion) return;
    for (const layer of parallaxLayers()) {
      const speed = Number(layer.dataset.parallax) || 0.2;
      layer.style.transform = `translate3d(0, ${(window.scrollY * speed).toFixed(1)}px, 0)`;
    }
  });
}
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

if (!reduceMotion && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target;
        element.classList.add("sr-in");
        observer.unobserve(element);
        // Once in place, drop the reveal classes so hover and tilt transitions
        // run at their own speed instead of the slower, delayed reveal timing.
        setTimeout(() => {
          element.classList.remove("sr", "sr-in");
          element.style.removeProperty("--sr-i");
        }, 1200);
      }
    },
    { rootMargin: "0px 0px -6% 0px", threshold: 0.06 },
  );
  const seen = new WeakSet();
  const scan = (root) => {
    const found = [];
    if (root.matches?.(REVEAL)) found.push(root);
    found.push(...(root.querySelectorAll?.(REVEAL) ?? []));
    let index = 0;
    for (const element of found) {
      if (seen.has(element)) continue;
      seen.add(element);
      element.classList.add("sr");
      element.style.setProperty("--sr-i", String(index++ % 5));
      observer.observe(element);
    }
  };
  scan(document.body);
  // Profiles, matches and tables render after data arrives.
  new MutationObserver((mutations) => {
    for (const mutation of mutations)
      for (const node of mutation.addedNodes) if (node.nodeType === 1) scan(node);
  }).observe(document.body, { childList: true, subtree: true });
}

if (!reduceMotion && finePointer) {
  let tilted = null;
  const reset = (card) => {
    card.style.removeProperty("--rx");
    card.style.removeProperty("--ry");
    card.classList.remove("is-tilting");
  };
  document.addEventListener(
    "pointermove",
    (event) => {
      const card = event.target.closest?.(TILT);
      if (tilted && tilted !== card) reset(tilted);
      tilted = card;
      if (!card) return;
      const box = card.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      card.classList.add("is-tilting");
      card.style.setProperty("--rx", `${(-y * 6).toFixed(2)}deg`);
      card.style.setProperty("--ry", `${(x * 8).toFixed(2)}deg`);
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", () => tilted && reset(tilted));
}

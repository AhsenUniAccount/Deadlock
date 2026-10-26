// Sets an element's text, counting each number in it up from zero, for example
// "47.4%" or "9W – 10L" or "1,161". Formatting (decimals, thousands separators,
// surrounding text) is preserved. Without animation support, or for people who
// prefer reduced motion, the final text is set immediately.

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

export function countUp(element, text, duration = 700) {
  const target = String(text);
  const raf = globalThis.requestAnimationFrame;
  const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const parts = [...target.matchAll(NUMBER)];
  if (!raf || reduce || !parts.length) {
    element.textContent = target;
    return;
  }
  const values = parts.map((m) => ({
    value: Number(m[0].replace(/,/g, "")),
    decimals: (m[0].split(".")[1] || "").length,
    grouped: m[0].includes(","),
  }));
  const format = (n, { decimals, grouped }) =>
    grouped
      ? n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : n.toFixed(decimals);
  const start = performance.now();
  const token = Symbol("count");
  element.countToken = token;
  const step = (now) => {
    if (element.countToken !== token) return; // a newer value replaced this one
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    let i = 0;
    element.textContent = target.replace(NUMBER, () => {
      const part = values[i++];
      return format(part.value * eased, part);
    });
    if (t < 1) raf(step);
    else element.textContent = target;
  };
  raf(step);
}

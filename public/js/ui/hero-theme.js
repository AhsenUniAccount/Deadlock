// The site's accent colour follows a hero: the player's main hero on a profile,
// the selected player's hero on a match page. Catalog colours range from near
// grey to very dark, so they are nudged into a band that reads on the dark UI.

const DEFAULT_ACCENT = "#e6b450";

function hexToHsl(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!match) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
}

// A readable accent: saturation at least 0.38, lightness between 0.55 and 0.72.
// Pure greys keep their neutrality rather than gaining a random hue.
export function accentColor(hex) {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;
  const [h, s, l] = hsl;
  const saturation = s < 0.04 ? 0 : Math.max(s, 0.38);
  return hslToHex(h, saturation, Math.min(0.72, Math.max(0.55, l)));
}

// Dark text on light accents, light text on darker ones.
export function inkFor(hex) {
  const hsl = hexToHsl(hex);
  return hsl && hsl[2] < 0.6 && (hsl[0] < 40 || hsl[0] > 200) ? "#ffffff" : "#0a0c0f";
}

export function applyHeroTheme(hero) {
  const root = globalThis.document?.documentElement;
  if (!root?.style) return;
  const accent = accentColor(hero?.colors?.style_hex);
  if (!accent) return resetHeroTheme();
  root.style.setProperty("--hero", accent);
  root.style.setProperty("--hero-ink", inkFor(accent));
}

export function resetHeroTheme() {
  const root = globalThis.document?.documentElement;
  root?.style?.removeProperty("--hero");
  root?.style?.removeProperty("--hero-ink");
}

export { DEFAULT_ACCENT };

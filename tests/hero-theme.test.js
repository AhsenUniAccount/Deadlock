import test from "node:test";
import assert from "node:assert/strict";
import { accentColor, inkFor } from "../public/js/ui/hero-theme.js";

const lightness = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
};

test("hero accents are pulled into a readable lightness band and keep their hue", () => {
  const dark = accentColor("#2a0a0a");
  const pale = accentColor("#f6eef8");
  assert.ok(lightness(dark) >= 0.54 && lightness(dark) <= 0.73, dark);
  assert.ok(lightness(pale) >= 0.54 && lightness(pale) <= 0.73, pale);
  // Apollo's red stays red.
  const red = accentColor("#FF3333");
  assert.ok(parseInt(red.slice(1, 3), 16) > parseInt(red.slice(3, 5), 16) * 2, red);
  // Greys stay grey instead of picking up a hue.
  const grey = accentColor("#808080");
  assert.equal(grey.slice(1, 3), grey.slice(3, 5));
});
test("missing or malformed colours give no accent", () => {
  assert.equal(accentColor(undefined), null);
  assert.equal(accentColor("red"), null);
  assert.equal(accentColor("#abc"), null);
});
test("text on the accent is dark for light accents", () => {
  assert.equal(inkFor("#e6b450"), "#0a0c0f");
});

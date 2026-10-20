// Fails if any relative import, page asset (CSS, JS, image) or CSS url() points
// at a file that does not exist. Catches broken paths after files are moved.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const broken = [];
const check = (from, target, resolved) => {
  if (!fs.existsSync(resolved)) broken.push(`${path.relative(root, from)} → ${target}`);
};

const tracked = execSync("git ls-files", { cwd: root }).toString().trim().split("\n");

for (const file of tracked.filter((f) => /\.(m?js)$/.test(f))) {
  const full = path.join(root, file);
  const source = fs.readFileSync(full, "utf8");
  // Static imports and dynamic import() of relative paths, ignoring query strings.
  for (const match of source.matchAll(/(?:from |import\()["`](\.{1,2}\/[^"`?]+)/g))
    check(full, match[1], path.join(path.dirname(full), match[1]));
}

for (const file of tracked.filter((f) => f.startsWith("public/") && f.endsWith(".html"))) {
  const full = path.join(root, file);
  const source = fs.readFileSync(full, "utf8");
  for (const match of source.matchAll(/(?:href|src)="(\/?[^"#:?]+\.(?:css|js|svg|png|webp))"/g)) {
    const target = match[1];
    const resolved = target.startsWith("/")
      ? path.join(root, "public", target)
      : path.join(path.dirname(full), target);
    check(full, target, resolved);
  }
}

for (const file of tracked.filter((f) => f.startsWith("public/css/") && f.endsWith(".css"))) {
  const full = path.join(root, file);
  const source = fs.readFileSync(full, "utf8");
  for (const match of source.matchAll(/url\("?(?!data:|https?:)([^")]+)"?\)/g))
    check(full, match[1], path.join(path.dirname(full), match[1]));
}

if (broken.length) {
  console.error(`Broken references (${broken.length}):\n  ${broken.join("\n  ")}`);
  process.exit(1);
}
console.log("All imports, page assets and CSS url() references resolve.");

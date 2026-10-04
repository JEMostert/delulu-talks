// Verifies WCAG text contrast for the Deep Sea tokens in both themes.
// Usage: bun scripts/check-contrast.mjs   (exits 1 when a required pair fails)
import { readFileSync } from "node:fs";

const css = readFileSync(
  new URL("../src/styles/tokens.css", import.meta.url),
  "utf8",
);

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing ${selector}`);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] === "}" && --depth === 0) return css.slice(start, index);
  }
  throw new Error(`Unclosed ${selector}`);
}

function tokens(text) {
  const values = {};
  for (const [, name, value] of text.matchAll(/--([\w-]+):\s*([^;]+);/g))
    values[name] = value.trim();
  return values;
}

function parse(color) {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = color.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(",").map(Number);
    return [r, g, b, a];
  }
  throw new Error(`Unsupported color ${color}`);
}

function over([r, g, b, a], [br, bg, bb]) {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
}

function luminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const light = tokens(block(":root"));
const themes = {
  light,
  dark: { ...light, ...tokens(block(':root[data-theme="dark"]')) },
};

const text = [
  "ink",
  "muted",
  "subtle",
  "accent-ink",
  "success",
  "warning",
  "danger",
];
const surfaces = [
  "surface",
  "surface-soft",
  "surface-hover",
  "input",
  "panel-heading",
  "surface-sheet",
];
let failed = 0;
for (const [theme, values] of Object.entries(themes)) {
  const canvas = parse(values.canvas);
  const solid = (name) => {
    const color = parse(values[name]);
    return color[3] < 1 ? over(color, canvas) : color;
  };
  console.log(`\n${theme}`);
  for (const surface of surfaces) {
    const background = solid(surface);
    const row = text.map((name) => {
      const value = ratio(solid(name), background);
      const pass = value >= 4.5;
      if (!pass) failed++;
      return `${name} ${value.toFixed(2)}${pass ? "" : " ✗"}`;
    });
    console.log(`  on ${surface.padEnd(14)} ${row.join(" · ")}`);
  }
  const stops = [...values["accent-grad"].matchAll(/#[0-9a-f]{6}/gi)].map(
    ([hex]) => parse(hex),
  );
  const onAccent = parse(values["on-accent"]);
  const gradient = stops.map((stop) => ratio(onAccent, stop).toFixed(2));
  const middle = ratio(onAccent, stops[Math.floor(stops.length / 2)]);
  if (middle < 4.5) failed++;
  console.log(
    `  on-accent over accent gradient stops: ${gradient.join(" / ")}${middle < 4.5 ? " ✗" : ""}`,
  );
}
if (failed) {
  console.error(`\n${failed} text pair(s) below 4.5:1`);
  process.exit(1);
}
console.log("\nAll text pairs meet 4.5:1");

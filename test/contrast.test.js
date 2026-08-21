/* WCAG contrast verification for both palettes, parsed from the live
   stylesheet in docs/index.html — not from a copy that could drift.
   Thresholds: body ink 7:1 (AAA), secondary ink 4.5:1, tertiary
   ink/labels 3:1, and the two accent inks 4.5:1 (they carry
   normal-size figures). Run: node --test test/contrast.test.js */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "docs", "index.html"), "utf8");

function tokensFrom(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) out[m[1]] = m[2];
  return out;
}
const rootBlock = html.match(/:root\s*{([\s\S]*?)}/)[1];
const darkBlock = html.match(/body\[data-mode="dark"\]\s*{([\s\S]*?)}/)[1];
const light = tokensFrom(rootBlock);
const dark = Object.assign({}, light, tokensFrom(darkBlock));

function lum(hex) {
  const h = hex.length === 4 ? "#" + [...hex.slice(1)].map(c => c + c).join("") : hex;
  const chan = i => {
    const v = parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(0) + 0.7152 * chan(1) + 0.0722 * chan(2);
}
function ratio(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const REQUIREMENTS = [
  ["text", 7],
  ["text-2", 4.5],
  ["text-3", 3],
  ["up", 4.5],
  ["down", 4.5],
];

for (const [name, palette] of [["light", light], ["dark", dark]]) {
  test(`contrast (${name} palette)`, () => {
    assert.ok(palette.bg, "bg token parsed");
    for (const [token, min] of REQUIREMENTS) {
      assert.ok(palette[token], token + " token parsed");
      const r = ratio(palette[token], palette.bg);
      assert.ok(r >= min,
        `${name}: --${token} ${palette[token]} on --bg ${palette.bg} is ${r.toFixed(2)}:1, needs ${min}:1`);
    }
  });
}

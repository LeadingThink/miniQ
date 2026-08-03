// One-off generator for src/assets/fonts/MiSansVF-subset.woff2.
//
// Subsets the MiSans VF variable font (weight axis 150–700 preserved) down to
// the General Standard Chinese Characters table level 1+2 (常用字 6500) plus
// ASCII and CJK punctuation. Rare characters outside the subset fall back to
// Microsoft YaHei / PingFang via the font stack in styles/base.css.
//
// Inputs (not committed; download before running):
//   MiSansVF.ttf     https://raw.githubusercontent.com/luyanci/Misansvf/main/MiSansVF.ttf
//   characters.json  https://raw.githubusercontent.com/jaywcjlove/table-of-general-standard-chinese-characters/main/data/characters.json
//     (flat array of 8105 chars ordered by level: 0-3499 level 1, 3500-6499 level 2)
//
// Usage: node scripts/subset-misans.mjs <MiSansVF.ttf> <characters.json>

import fs from "node:fs";
import path from "node:path";
import subsetFont from "subset-font";

const [ttfPath, charsPath] = process.argv.slice(2);
if (!ttfPath || !charsPath) {
  console.error("usage: node scripts/subset-misans.mjs <MiSansVF.ttf> <characters.json>");
  process.exit(1);
}

const LEVEL_1_2 = 6500; // 一级 3500 + 二级 3000

const hanzi = JSON.parse(fs.readFileSync(charsPath, "utf8")).slice(0, LEVEL_1_2);

// ASCII printable
let ascii = "";
for (let c = 0x20; c <= 0x7e; c++) ascii += String.fromCharCode(c);

// CJK punctuation, fullwidth forms, common typographic marks
const ranges = [
  [0x3000, 0x303f], // CJK symbols & punctuation 、。〈〉《》「」【】
  [0xff01, 0xff5e], // fullwidth ASCII ！？（）：；
  [0xffe0, 0xffe5], // ￠￡￢￣￤￥
  [0x2010, 0x2027], // dashes, quotes ‘’“”…‧
  [0x2030, 0x203b], // ‰ ′ ″ ※
  [0x00a0, 0x00ff], // Latin-1 supplement (°±×÷ é ü etc.)
  [0x2190, 0x2193], // arrows ←↑→↓
  [0x25a0, 0x25cf], // geometric shapes ■□▲△●
  [0x2605, 0x2606], // ★☆
];
let punct = "";
for (const [lo, hi] of ranges) {
  for (let c = lo; c <= hi; c++) punct += String.fromCharCode(c);
}

const text = ascii + punct + hanzi.join("");
console.log(`subsetting to ${[...new Set(text)].length} unique chars…`);

const ttf = fs.readFileSync(ttfPath);
const woff2 = await subsetFont(ttf, text, { targetFormat: "woff2" });

const outDir = path.join(import.meta.dirname, "..", "src", "assets", "fonts");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "MiSansVF-subset.woff2");
fs.writeFileSync(outPath, woff2);
console.log(`wrote ${outPath} (${(woff2.length / 1024 / 1024).toFixed(2)} MB)`);

import { readFile, writeFile } from "fs/promises";
import cloud from "d3-cloud";
import { createCanvas } from "@napi-rs/canvas";

// Packs the /tags/ flex list into a spiral word cloud rendered as SVG anchors: real, crawlable,
// keyboard-focusable links, laid out deterministically at build time (no runtime JS, no layout shift).
const FILE = "public/tags/index.html";
const FONT = "sans-serif"; // measured and rendered with the same family so packing matches the glyphs
const MIN_PX = 16;
const MAX_PX = 68;
const PAD = 3;

const CONTAINER = /<div class=["']?tag-cloud["']? data-wordcloud>([\s\S]*?)<\/div>/;
const ANCHOR = /<a href=["']?([^"'\s>]+)["']?[^>]*?\sdata-w=["']?(\d+)["']?[^>]*>([\s\S]*?)<\/a>/g;

// small deterministic PRNG so the layout is byte-stable across builds
const makeRng = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const html = await readFile(FILE, "utf-8");
const block = html.match(CONTAINER);
if (!block) {
  console.log("wordcloud: no tag-cloud container found, leaving flex fallback in place");
  process.exit(0);
}

const words = [];
for (const [, href, w, text] of block[1].matchAll(ANCHOR)) {
  words.push({ href, text: text.trim(), freq: Number(w) });
}
if (!words.length) {
  console.log("wordcloud: no tags parsed, leaving flex fallback in place");
  process.exit(0);
}

const weights = words.map((d) => Math.sqrt(d.freq + 1));
const wMin = Math.min(...weights);
const wSpan = Math.max(...weights) - wMin || 1;
words.forEach((d, i) => {
  d.t = (weights[i] - wMin) / wSpan;
  d.size = Math.round(MIN_PX + d.t * (MAX_PX - MIN_PX));
});

const glyphArea = words.reduce((a, d) => a + d.size * d.size * (d.text.length * 0.7 + 1), 0);

const layout = (width, height, seed) => {
  const rng = makeRng(seed);
  return new Promise((resolve) => {
    cloud()
      .size([width, height])
      .canvas(() => createCanvas(1, 1))
      .words(words.map((d) => ({ ...d })))
      .padding(PAD)
      .font(FONT)
      .fontSize((d) => d.size)
      .rotate(() => (rng() < 0.18 ? 90 : 0))
      .random(rng)
      .on("end", resolve)
      .start();
  });
};

// grow the canvas until every tag is placed (d3-cloud silently drops words that do not fit)
const aspect = 1.55;
let scale = 1.9;
let placed = [];
let width = 0;
let height = 0;
for (let attempt = 0; attempt < 7; attempt++) {
  const area = glyphArea * scale;
  width = Math.round(Math.sqrt(area * aspect));
  height = Math.round(width / aspect);
  placed = await layout(width, height, 0x9e3779b1);
  if (placed.length === words.length) break;
  scale *= 1.2;
}
if (placed.length < words.length) {
  console.log(`wordcloud: only ${placed.length}/${words.length} tags fit, keeping flex fallback`);
  process.exit(0);
}

// crop to the words' true extent so the cloud fills its width instead of floating in empty canvas
const mctx = createCanvas(10, 10).getContext("2d");
let x0 = Infinity;
let y0 = Infinity;
let x1 = -Infinity;
let y1 = -Infinity;
for (const d of placed) {
  mctx.font = `600 ${d.size}px ${FONT}`;
  const halfW = mctx.measureText(d.text).width / 2;
  const halfH = d.size * 0.62;
  const [ex, ey] = d.rotate ? [halfH, halfW] : [halfW, halfH];
  x0 = Math.min(x0, d.x - ex);
  y0 = Math.min(y0, d.y - ey);
  x1 = Math.max(x1, d.x + ex);
  y1 = Math.max(y1, d.y + ey);
}
const M = 6;
const vbX = (x0 - M).toFixed(1);
const vbY = (y0 - M).toFixed(1);
const vbW = (x1 - x0 + 2 * M).toFixed(1);
const vbH = (y1 - y0 + 2 * M).toFixed(1);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// screen-reader and tab order follow frequency, independent of the visual spiral placement
placed.sort((a, b) => b.freq - a.freq);

const anchors = placed
  .map((d) => {
    const cx = d.x.toFixed(1);
    const cy = d.y.toFixed(1);
    const rot = d.rotate ? ` transform="rotate(${d.rotate} ${cx} ${cy})"` : "";
    return (
      `<a href="${d.href}" aria-label="${esc(d.text)}">` +
      `<text x="${cx}" y="${cy}"${rot} font-size="${d.size}" style="--t:${d.t.toFixed(3)}">${esc(d.text)}</text>` +
      `</a>`
    );
  })
  .join("");

const svg =
  `<svg class="wordcloud" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" role="group" ` +
  `aria-label="Blog topics, sized by how often each word appears" ` +
  `xmlns="http://www.w3.org/2000/svg" text-anchor="middle" dominant-baseline="central" font-family="${FONT}">` +
  `<title>Blog topics word cloud</title>${anchors}</svg>`;

// keep the flex list for narrow screens (readable), show the packed SVG where it has room; CSS swaps them
const replacement =
  `<div class="tag-cloud tag-cloud--flex">${block[1]}</div>` + `<div class="tag-cloud--svg">${svg}</div>`;
await writeFile(FILE, html.replace(CONTAINER, replacement));
console.log(`wordcloud: packed ${placed.length} tags into ${width}x${height} SVG`);
process.exit(0);

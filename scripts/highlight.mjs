import { createHighlighter } from "shiki";
import { readFile, writeFile } from "fs/promises";
import { glob } from "glob";

// github-light/github-dark clear WCAG 4.5:1 for their tokens; catppuccin-latte did not
const THEMES = { light: "github-light", dark: "github-dark" };
const LANGS = [
  "python",
  "bash",
  "shell",
  "toml",
  "yaml",
  "json",
  "rust",
  "go",
  "kotlin",
  "javascript",
  "typescript",
  "html",
  "css",
];
const CODE_BLOCK_RE = /<pre><code class=["']?language-(\w+)["']?>([\s\S]*?)<\/code><\/pre>/g;
const INLINE_CODE_RE = /<code>([^<]*?[.()\[\]=:][^<]*?)<\/code>/g;

// WCAG 4.5:1 minimum for token text, enforced per theme after highlighting: syntax themes
// de-emphasize comments (and github-light's orange) below the threshold, so nudge any failing
// token toward the background's opposite, preserving hue, until it clears 4.5:1.
const BG = { light: "e0e0e0", dark: "4f4f4f" }; // the coder theme's actual code backgrounds ($alt-bg-color[-dark])
const relLum = (r, g, b) => {
  const f = (c) => ((c /= 255), c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) =>
  c
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
const contrast = (a, b) => {
  const [la, lb] = [relLum(...a), relLum(...b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
function ensureContrast(fgHex, bgHex, min = 4.6) {
  // aim a touch above 4.5 so rounding the RGB back to 8-bit does not drop below the threshold
  const fg = rgb(fgHex);
  const bg = rgb(bgHex);
  if (contrast(fg, bg) >= min) return fgHex;
  const target = relLum(...bg) > 0.18 ? [0, 0, 0] : [255, 255, 255]; // darken on light bg, lighten on dark bg
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    if (
      contrast(
        fg.map((c, j) => c + (target[j] - c) * t),
        bg,
      ) >= min
    )
      hi = t;
    else lo = t;
  }
  return hex(fg.map((c, j) => c + (target[j] - c) * hi));
}
const enforceContrast = (html) =>
  html
    .replace(/--shiki-light:#([0-9A-Fa-f]{6})/g, (_m, c) => "--shiki-light:#" + ensureContrast(c, BG.light))
    .replace(/--shiki-dark:#([0-9A-Fa-f]{6})/g, (_m, c) => "--shiki-dark:#" + ensureContrast(c, BG.dark));

const highlighter = await createHighlighter({ themes: Object.values(THEMES), langs: LANGS });

const files = await glob("public/**/*.html");
let totalBlocks = 0;

for (const file of files) {
  let html = await readFile(file, "utf-8");
  let changed = false;

  html = html.replace(CODE_BLOCK_RE, (_match, lang, code) => {
    const decoded = code
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&#34;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&amp;", "&");

    const highlighted = highlighter.codeToHtml(decoded, {
      lang: LANGS.includes(lang) ? lang : "text",
      themes: THEMES,
      defaultColor: false,
    });
    changed = true;
    totalBlocks++;
    return highlighted;
  });

  html = html.replace(INLINE_CODE_RE, (_match, code) => {
    const decoded = code
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&#34;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&amp;", "&");

    const highlighted = highlighter.codeToHtml(decoded, {
      lang: "python",
      themes: THEMES,
      defaultColor: false,
    });
    const inner = highlighted.match(/<code>([\s\S]*?)<\/code>/)?.[1];
    if (inner) {
      changed = true;
      totalBlocks++;
      return `<code class="shiki-inline">${inner}</code>`;
    }
    return _match;
  });

  if (changed) {
    await writeFile(file, enforceContrast(html));
  }
}

console.log(`Highlighted ${totalBlocks} code blocks across ${files.length} HTML files`);
highlighter.dispose();

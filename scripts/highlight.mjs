import { createHighlighter } from "shiki";
import { readFile, writeFile } from "fs/promises";
import { glob } from "glob";

const THEMES = { light: "catppuccin-latte", dark: "catppuccin-mocha" };
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
    await writeFile(file, html);
  }
}

console.log(`Highlighted ${totalBlocks} code blocks across ${files.length} HTML files`);
highlighter.dispose();

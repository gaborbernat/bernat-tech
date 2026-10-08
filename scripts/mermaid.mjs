import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { glob } from "glob";
import { chromium } from "playwright";

// Render every <pre class="mermaid"> block to static SVG at build time, in both a light and a dark
// variant, so no page ships the ~3.5 MB mermaid runtime or renders a diagram in the browser. CSS shows
// the variant that matches the active theme. Each raw render is cached by a hash of its source, so an
// unchanged build reuses the cache and never launches the browser; only new or edited diagrams render.
const MERMAID = "node_modules/mermaid/dist/mermaid.min.js";
const CACHE_DIR = ".cache/mermaid";
const CACHE_VERSION = "1"; // bump when the render config below changes so stale renders are dropped
const BLOCK = /<pre class=["']?mermaid["']?>([\s\S]*?)<\/pre>/g;
// mermaid.min.js inlines its own KaTeX 0.16 (GHSA-238p-pmpm-9mq7), which npm overrides cannot replace, and
// calls it only for label text matching this pattern; refusing math keeps that copy from ever running
const KATEX_MATH = /\$\$(.*?)\$\$/;

const decode = (s) =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#34;", '"')
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

// mermaid mints non-deterministic ids per render; remap every id (and its references) to a stable
// per-diagram sequence so a rebuild produces byte-identical output. The remap depends only on the
// order ids appear, not their values, so canonicalizing a cached render is identical to a fresh one.
const canonicalize = (svg, prefix) => {
  const ids = [...new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))];
  let out = svg;
  ids.forEach((id, i) => {
    const to = `${prefix}-${i}`;
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out
      .replace(new RegExp(`id="${esc}"`, "g"), `id="${to}"`)
      .replace(new RegExp(`#${esc}\\b`, "g"), `#${to}`)
      .replace(new RegExp(`(aria-(?:labelledby|describedby)=")${esc}"`, "g"), `$1${to}"`);
  });
  // mermaid sets role="graphics-document document" (two tokens), which is not a valid role value,
  // and emits zero-size edge-label rects with no width/height (invalid, but already invisible); give
  // those explicit 0 dimensions so the SVG validates without changing what renders.
  return out
    .replace(/ role="graphics-document document"/g, ' role="img"')
    .replace(/<rect(?![^>]*\bwidth=)([^>]*)>/g, '<rect width="0" height="0"$1>')
    .replace(/ name="[^"]*"/g, ""); // mermaid emits name= on rect/line, not a valid SVG attribute
};

const DIAGRAM_KINDS = {
  flowchart: "Flowchart",
  graph: "Flowchart",
  sequenceDiagram: "Sequence diagram",
  timeline: "Timeline",
  "xychart-beta": "Chart",
};

// name the diagram for screen readers: an accTitle in the source wins (mermaid wires it to <title> itself),
// otherwise the diagram kind and the heading it sits under
const label = (svg, code, heading) => {
  if (svg.includes("aria-labelledby=")) return svg;
  const kind = DIAGRAM_KINDS[code.split(/\s/)[0]] ?? "Diagram";
  // the heading comes straight from the page, already HTML-escaped; only the attribute quote needs escaping
  const text = heading ? `${kind}: ${heading}` : kind;
  return svg.replace(/<svg\b/, `<svg aria-label="${text.replaceAll('"', "&quot;")}"`);
};

// the narrowest width at which the 16px labels still render at 12px; on a phone column the diagrams otherwise
// shrink to fit and labels drop to 4-6px, so the stylesheet holds them at this width and lets the figure scroll
const readable = (svg) => {
  const width = Number(svg.match(/<svg\b[^>]*\bviewBox="[-\d.]+ [-\d.]+ ([\d.]+)/)?.[1]);
  return width ? svg.replace(/(<svg\b[^>]*\bstyle=")/, `$1--mmd-min: ${Math.round(width * 0.75)}px; `) : svg;
};

// the nearest heading above a diagram, as escaped HTML text without its tags or anchor link
const headingBefore = (html, offset) => {
  const headings = [...html.slice(0, offset).matchAll(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/g)];
  const last = headings.at(-1)?.[1] ?? "";
  return last
    .replace(/<a\b[^>]*class=["']?heading-link[\s\S]*?<\/a>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

const files = await glob("public/**/*.html");
const targets = [];
const codesByFile = new Map();
for (const file of files) {
  const html = await readFile(file, "utf-8");
  if (!html.includes("<pre class=mermaid>") && !html.includes('<pre class="mermaid">')) continue;
  const codes = [];
  html.replace(BLOCK, (_m, body) => codes.push(decode(body.trim())));
  const math = codes.find((code) => KATEX_MATH.test(code));
  if (math) {
    console.error(`mermaid: ${file} has $$ math, which would run mermaid's bundled KaTeX 0.16:\n${math}`);
    process.exit(1);
  }
  targets.push(file);
  codesByFile.set(file, codes);
}
if (!targets.length) {
  console.log(process.argv.includes("--check") ? "0" : "mermaid: no diagrams to render");
  process.exit(0);
}

// salt the cache key with the mermaid bundle so an upgrade or a config change invalidates every render
const salt = createHash("sha256")
  .update(await readFile(MERMAID))
  .update(CACHE_VERSION)
  .digest("hex")
  .slice(0, 16);
const rawPath = (code, theme) =>
  `${CACHE_DIR}/${createHash("sha256").update(code).update(theme).update(salt).digest("hex")}.svg`;

await mkdir(CACHE_DIR, { recursive: true });
const misses = [];
for (const codes of codesByFile.values()) {
  for (const code of codes) {
    for (const theme of ["default", "dark"]) {
      const path = rawPath(code, theme);
      if (!existsSync(path)) misses.push({ code, theme, path });
    }
  }
}

// --check reports how many diagrams need rendering so CI can skip the browser install when it is zero
if (process.argv.includes("--check")) {
  console.log(misses.length);
  process.exit(0);
}

if (misses.length) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addScriptTag({ path: MERMAID });
  for (const [index, { code, theme, path }] of misses.entries()) {
    const svg = await page.evaluate(
      async ({ code, theme, id }) => {
        // htmlLabels:false keeps labels as SVG <text>/<tspan> rather than foreignObject <p> inside
        // <span>, which the HTML validator rejects (and which drops a bare <rect>).
        const cfg = {
          startOnLoad: false,
          theme,
          htmlLabels: false,
          flowchart: { htmlLabels: false },
        };
        if (theme === "dark") cfg.themeVariables = { edgeLabelBackground: "#212121" };
        mermaid.initialize(cfg);
        const { svg } = await mermaid.render(id, code);
        return svg;
      },
      { code, theme, id: `r${index}` },
    );
    await writeFile(path, svg);
  }
  await browser.close();
}

let placed = 0;
let diagram = 0;
for (const file of targets) {
  const html = await readFile(file, "utf-8");
  const codes = codesByFile.get(file);
  const figs = [];
  for (const match of html.matchAll(BLOCK)) {
    const code = codes[figs.length];
    const heading = headingBefore(html, match.index);
    diagram++;
    // both variants carry the name; CSS display:none on the inactive one already keeps it out of the
    // accessibility tree, so a fixed aria-hidden would hide the diagram from dark-mode screen readers
    const light = readable(label(canonicalize(await readFile(rawPath(code, "default"), "utf-8"), `ml${diagram}`), code, heading));
    const dark = readable(label(canonicalize(await readFile(rawPath(code, "dark"), "utf-8"), `md${diagram}`), code, heading));
    figs.push(
      `<figure class="mermaid"><span class="mermaid-light">${light}</span>` +
        `<span class="mermaid-dark">${dark}</span></figure>`,
    );
    placed++;
  }
  let index = 0;
  await writeFile(file, html.replace(BLOCK, () => figs[index++]));
}
console.log(`mermaid: ${placed} diagrams across ${targets.length} files (${misses.length} rendered, rest cached)`);
process.exit(0);

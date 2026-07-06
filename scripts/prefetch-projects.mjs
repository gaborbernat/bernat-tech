import { readFile, writeFile } from "fs/promises";
import { parse } from "yaml";

// Fetches the live GitHub/PyPI/JetBrains stats the project tables show and writes them to
// data/project_stats.json, so the content build reads a static file instead of making ~150 API
// calls per build. A scheduled workflow refreshes this file; project-row.html consumes it by key.
const SRC = "data/projects.yaml";
const OUT = "data/project_stats.json";
const GROUPS = ["primary", "maintenance"]; // presentations render only static columns, no live stats
const TOKEN = process.env.HUGO_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";

// project-row.html builds the same key from org|repo|name|type|pypi; keep the two in lockstep
const keyOf = (p) => {
  const repo = p.repo || p.name;
  return [p.org, repo, p.name, p.type || "", p.pypi || ""].join("|");
};

const ghHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
async function json(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}
const gh = (path) => json(`https://api.github.com/${path}`, ghHeaders);

async function statsFor(p) {
  const org = p.org;
  const repo = p.repo || p.name;
  const name = p.name;
  const showPypi = (p.pypi ?? "") !== "false";
  const jetbrainsId = p["jetbrains-id"];
  const types = (p.type || "").split(",").map((s) => s.trim());
  const errors = [];
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      return undefined;
    }
  };

  const d = {
    default_branch: "main",
    stars: 0,
    open_total: 0,
    open_prs: 0,
    last_commit_date: "",
    release_tag: "",
    release_published_at: "",
    pypi_version: "",
    pypi_release_date: "",
    pypi_downloads: 0,
    gha_usage_count: 0,
    gh_downloads: 0,
    gh_download_label: "total",
    jb_downloads: 0,
    jb_version: "",
    jb_release_unix: 0,
  };

  const repoData = await attempt("repo-info", () => gh(`repos/${org}/${repo}`));
  if (repoData) {
    d.default_branch = repoData.default_branch || "main";
    d.stars = repoData.stargazers_count || 0;
    d.open_total = repoData.open_issues_count || 0;
  }

  const commits = await attempt("commits", () =>
    gh(`repos/${org}/${repo}/commits?sha=${d.default_branch}&per_page=1`),
  );
  if (commits?.[0]) d.last_commit_date = commits[0].commit.committer.date;

  const release = await attempt("release", () =>
    gh(`repos/${org}/${repo}/releases/latest`),
  );
  if (release?.tag_name) {
    d.release_tag = release.tag_name;
    d.release_published_at = release.published_at || "";
  }

  if (showPypi) {
    const pypi = await attempt("pypi-version", () =>
      json(`https://pypi.org/pypi/${name}/json`),
    );
    if (pypi) {
      d.pypi_version = pypi.info?.version || "";
      d.pypi_release_date = pypi.urls?.[0]?.upload_time_iso_8601 || "";
    }
    const recent = await attempt("pypi-downloads", () =>
      json(`https://pypistats.org/api/packages/${name}/recent`),
    );
    if (recent) d.pypi_downloads = recent.data?.last_month || 0;
  } else if (!jetbrainsId) {
    if (types.includes("github-action")) {
      const search = await attempt("gha-usage", () =>
        gh(`search/code?q=${encodeURIComponent(`"uses: ${org}/${repo}"`)}`),
      );
      if (search) d.gha_usage_count = search.total_count || 0;
    } else if (types.includes("pre-commit")) {
      const clones = await attempt("gh-clones", () =>
        gh(`repos/${org}/${repo}/traffic/clones`),
      );
      if (clones) {
        d.gh_downloads = clones.count || 0;
        d.gh_download_label = "clones/14d";
      }
    } else {
      const releases = await attempt("gh-releases", () =>
        gh(`repos/${org}/${repo}/releases?per_page=100`),
      );
      if (releases) {
        for (const r of releases)
          for (const a of r.assets || [])
            d.gh_downloads += a.download_count || 0;
      }
      if (d.gh_downloads === 0) {
        const clones = await attempt("gh-clones", () =>
          gh(`repos/${org}/${repo}/traffic/clones`),
        );
        if (clones) {
          d.gh_downloads = clones.count || 0;
          d.gh_download_label = "clones/14d";
        }
      }
    }
  }

  if (jetbrainsId) {
    const plugin = await attempt("jb-downloads", () =>
      json(`https://plugins.jetbrains.com/api/plugins/${jetbrainsId}`),
    );
    if (plugin) d.jb_downloads = plugin.downloads || 0;
    const updates = await attempt("jb-version", () =>
      json(
        `https://plugins.jetbrains.com/api/plugins/${jetbrainsId}/updates?channel=&size=1`,
      ),
    );
    if (updates?.[0]) {
      d.jb_version = updates[0].version || "";
      d.jb_release_unix = Math.floor((updates[0].cdate || 0) / 1000);
    }
  }

  const pulls = await attempt("gh-pulls", () =>
    gh(`repos/${org}/${repo}/pulls?state=open&per_page=100`),
  );
  if (pulls) d.open_prs = pulls.length;

  return { d, errors };
}

// bounded concurrency so a full refresh stays polite and well under the API rate limit
async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const projects = parse(await readFile(SRC, "utf-8"));
const list = GROUPS.flatMap((g) => projects[g] || []);
const results = await mapPool(list, 8, statsFor);

const stats = {};
list.forEach((p, i) => {
  stats[keyOf(p)] = results[i].d;
  const errs = results[i].errors;
  const openIssues = results[i].d.open_total - results[i].d.open_prs;
  console.log(
    `${p.org}/${p.repo || p.name} stars=${results[i].d.stars} issues=${openIssues} prs=${results[i].d.open_prs}` +
      (errs.length ? ` | errors: ${errs.join("; ")}` : ""),
  );
});

// sort keys so the committed file has stable, reviewable diffs
const sorted = Object.fromEntries(
  Object.keys(stats)
    .sort()
    .map((k) => [k, stats[k]]),
);
await writeFile(OUT, JSON.stringify(sorted, null, 2) + "\n");
console.log(
  `prefetch: wrote ${Object.keys(sorted).length} project records to ${OUT}${TOKEN ? "" : " (no token: GitHub calls rate-limited)"}`,
);

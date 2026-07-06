# /// script
# requires-python = ">=3.13"
# dependencies = ["pyyaml>=6"]
# ///
"""Fetch the GitHub/PyPI/JetBrains stats the project tables show into data/project_stats.json, so Hugo
reads a static file instead of making ~150 fragile API calls inside its render timeout. CI runs this
once before the build; project-row.html consumes it by the key keyed() builds here. The committed file
is the fallback used for local `hugo serve` and when the refresh step is skipped or fails."""

# print is this CLI build script's progress output; stdout is intended
# ruff: noqa: T201

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final

import yaml

if TYPE_CHECKING:
    from collections.abc import Callable

type Json = dict[str, Json] | list[Json] | str | int | float | bool | None
type Attempt = Callable[[str, Callable[[], Json]], Json]

_SRC: Final = Path("data/projects.yaml")
_OUT: Final = Path("data/project_stats.json")
_GROUPS: Final = ("primary", "maintenance")  # presentations render only static columns, no live stats
_TOKEN: Final = os.environ.get("HUGO_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
_GH_HEADERS: Final = {"Authorization": f"Bearer {_TOKEN}"} if _TOKEN else {}


@dataclass
class Stats:
    default_branch: str = "main"
    stars: int = 0
    open_total: int = 0
    open_prs: int = 0
    last_commit_date: str = ""
    release_tag: str = ""
    release_published_at: str = ""
    pypi_version: str = ""
    pypi_release_date: str = ""
    pypi_downloads: int = 0
    gha_usage_count: int = 0
    gh_downloads: int = 0
    gh_download_label: str = "total"
    jb_downloads: int = 0
    jb_version: str = ""
    jb_release_unix: int = 0


def main() -> None:
    projects: dict[str, list[dict[str, str]]] = yaml.safe_load(_SRC.read_text())
    listing = [project for group in _GROUPS for project in (projects.get(group) or [])]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(stats_for, listing))
    stats = {keyed(project): asdict(record) for project, (record, _) in zip(listing, results, strict=True)}
    for project, (record, errors) in zip(listing, results, strict=True):
        note = f" | errors: {'; '.join(errors)}" if errors else ""
        print(
            f"{project['org']}/{project.get('repo') or project['name']} "
            f"stars={record.stars} issues={record.open_total - record.open_prs} prs={record.open_prs}{note}"
        )
    _OUT.write_text(json.dumps(stats, indent=2, sort_keys=True) + "\n")
    hint = "" if _TOKEN else " (no token: GitHub calls rate-limited)"
    print(f"prefetch: wrote {len(stats)} project records to {_OUT}{hint}")


def keyed(project: dict[str, str]) -> str:
    # the composite key project-row.html rebuilds; keep the two in lockstep
    parts = (project["org"], project.get("repo") or project["name"], project["name"])
    return "|".join((*parts, project.get("type") or "", project.get("pypi") or ""))


def stats_for(project: dict[str, str]) -> tuple[Stats, list[str]]:
    org, name = project["org"], project["name"]
    repo = project.get("repo") or name
    show_pypi = (project.get("pypi") or "") != "false"
    jetbrains_id = project.get("jetbrains-id")
    types = [entry.strip() for entry in (project.get("type") or "").split(",")]
    errors: list[str] = []
    record = Stats()

    def attempt(label: str, fetch: Callable[[], Json]) -> Json:
        try:
            return fetch()
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            errors.append(f"{label}: {exc}")
            return None

    repo_data = attempt("repo-info", lambda: gh(f"repos/{org}/{repo}"))
    record.default_branch = as_text(dig(repo_data, "default_branch")) or "main"
    record.stars = as_int(dig(repo_data, "stargazers_count"))
    record.open_total = as_int(dig(repo_data, "open_issues_count"))

    commits_url = f"repos/{org}/{repo}/commits?sha={record.default_branch}&per_page=1"
    if commits := as_list(attempt("commits", lambda: gh(commits_url))):
        record.last_commit_date = as_text(dig(commits[0], "commit", "committer", "date"))

    release = attempt("release", lambda: gh(f"repos/{org}/{repo}/releases/latest"))
    if tag := as_text(dig(release, "tag_name")):
        record.release_tag = tag
        record.release_published_at = as_text(dig(release, "published_at"))

    if show_pypi:
        collect_pypi(record, name, attempt)
    elif not jetbrains_id:
        collect_downloads(record, org, repo, types, attempt)

    if jetbrains_id:
        collect_jetbrains(record, jetbrains_id, attempt)

    record.open_prs = len(as_list(attempt("gh-pulls", lambda: gh(f"repos/{org}/{repo}/pulls?state=open&per_page=100"))))
    return record, errors


def collect_pypi(record: Stats, name: str, attempt: Attempt) -> None:
    pypi = attempt("pypi-version", lambda: get(f"https://pypi.org/pypi/{name}/json"))
    record.pypi_version = as_text(dig(pypi, "info", "version"))
    if urls := as_list(dig(pypi, "urls")):
        record.pypi_release_date = as_text(dig(urls[0], "upload_time_iso_8601"))
    recent = attempt("pypi-downloads", lambda: get(f"https://pypistats.org/api/packages/{name}/recent"))
    record.pypi_downloads = as_int(dig(recent, "data", "last_month"))


def collect_downloads(record: Stats, org: str, repo: str, types: list[str], attempt: Attempt) -> None:
    if "github-action" in types:
        query = urllib.parse.quote(f'"uses: {org}/{repo}"')
        record.gha_usage_count = as_int(dig(attempt("gha-usage", lambda: gh(f"search/code?q={query}")), "total_count"))
        return
    if "pre-commit" not in types:
        releases = as_list(attempt("gh-releases", lambda: gh(f"repos/{org}/{repo}/releases?per_page=100")))
        record.gh_downloads = sum(
            as_int(dig(asset, "download_count")) for release in releases for asset in as_list(dig(release, "assets"))
        )
        if record.gh_downloads:
            return
    if clones := attempt("gh-clones", lambda: gh(f"repos/{org}/{repo}/traffic/clones")):
        record.gh_downloads = as_int(dig(clones, "count"))
        record.gh_download_label = "clones/14d"


def collect_jetbrains(record: Stats, plugin_id: str, attempt: Attempt) -> None:
    plugin = attempt("jb-downloads", lambda: get(f"https://plugins.jetbrains.com/api/plugins/{plugin_id}"))
    record.jb_downloads = as_int(dig(plugin, "downloads"))
    endpoint = f"https://plugins.jetbrains.com/api/plugins/{plugin_id}/updates?channel=&size=1"
    if updates := as_list(attempt("jb-version", lambda: get(endpoint))):
        record.jb_version = as_text(dig(updates[0], "version"))
        record.jb_release_unix = int(as_text(dig(updates[0], "cdate")) or 0) // 1000


def gh(path: str) -> Json:
    return get(f"https://api.github.com/{path}", _GH_HEADERS)


def get(url: str, headers: dict[str, str] | None = None) -> Json:
    request = urllib.request.Request(url, headers={"User-Agent": "bernat-tech-prefetch", **(headers or {})})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def dig(value: Json, *keys: str) -> Json:
    for key in keys:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def as_list(value: Json) -> list[Json]:
    return value if isinstance(value, list) else []


def as_text(value: Json) -> str:
    return value if isinstance(value, str) else ""


def as_int(value: Json) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


if __name__ == "__main__":
    main()

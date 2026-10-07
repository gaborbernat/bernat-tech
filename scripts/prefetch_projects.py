# /// script
# requires-python = ">=3.13"
# dependencies = ["pyyaml>=6", "rich>=13", "tenacity>=9"]
# ///
"""Refresh the GitHub/PyPI/JetBrains/Homebrew stats the project tables show into data/project_stats.json, so Hugo
reads a static file instead of making ~150 fragile API calls inside its render timeout. An hourly workflow
runs this off the build's hot path and stores the result in the Actions cache, the file's only home: it is not
committed, so the build restores it and a cache miss renders the tables without stats. project-row.html consumes it
by the key keyed() builds here.

The refresh is best effort: it starts from the previous values and overwrites a number only when its fetch
succeeds, so a rate-limited call keeps the last known value instead of zeroing it. Each record carries the
time it was last fetched cleanly (no transient failure); the stalest go first, and the run exits non-zero
when any record has gone unrefreshed for more than three days so the workflow surfaces it.

Popularity ranks ride along: PyPI and Homebrew publish a ranked list each, loaded once per run, while JetBrains has
none, so its rank comes from a binary search over the marketplace's download-sorted listing, at most once a day. A
failed rank fetch keeps the prior rank and does not hold back fetched_at."""

# print is this CLI build script's progress output; stdout is intended
# ruff: file-ignore[print]

from __future__ import annotations

import contextlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from functools import partial
from http import HTTPStatus
from pathlib import Path
from typing import TYPE_CHECKING, Final

import tenacity
import yaml
from rich.console import Console
from rich.table import Table

if TYPE_CHECKING:
    from collections.abc import Callable

type Json = dict[str, Json] | list[Json] | str | int | float | bool | None
type Attempt = Callable[[str, Callable[[], Json]], Json]

_SRC: Final = Path("data/projects.yaml")
_OUT: Final = Path("data/project_stats.json")
_GROUPS: Final = ("primary", "maintenance")  # every group data/projects.yaml defines
_TOKEN: Final = os.environ.get("HUGO_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
_GH_HEADERS: Final = {"Authorization": f"Bearer {_TOKEN}"} if _TOKEN else {}
_PEPY_KEY: Final = os.environ.get("PEPY") or ""
_PEPY_HEADERS: Final = {"X-API-Key": _PEPY_KEY} if _PEPY_KEY else {}
_RETRYABLE: Final = frozenset({
    HTTPStatus.TOO_MANY_REQUESTS,
    HTTPStatus.INTERNAL_SERVER_ERROR,
    HTTPStatus.BAD_GATEWAY,
    HTTPStatus.SERVICE_UNAVAILABLE,
    HTTPStatus.GATEWAY_TIMEOUT,
})
_MAX_ATTEMPTS: Final = 5  # tenacity retries a retryable response this many times before giving up
_BACKOFF_CAP: Final = 60  # seconds; ceiling for both the blind backoff and a server's Retry-After
_NOW: Final = datetime.now(tz=UTC)
_STAMP: Final = _NOW.isoformat(timespec="seconds")  # written to fetched_at when a record refreshes cleanly
_STALE_AFTER: Final = timedelta(days=3)  # a record unrefreshed this long fails the job so it gets noticed
_RANK_EVERY: Final = timedelta(days=1)  # JetBrains costs ~14 requests per rank; neighbours sit days of downloads apart
_PYPI_TOP: Final = "https://hugovk.dev/top-pypi-packages/top-pypi-packages.min.json"
_BREW_TOP: Final = "https://formulae.brew.sh/api/analytics/install-on-request/30d.json"
_JB_RANKED: Final = 10_000  # the marketplace listing refuses offset + max past this
_FETCH_ERRORS: Final = (urllib.error.URLError, TimeoutError, json.JSONDecodeError)
# the previous run's records, keyed as below; the baseline every best-effort fetch merges onto
_BASELINE: Final[dict[str, Json]] = json.loads(_OUT.read_text()) if _OUT.exists() else {}


@dataclass
class Rank:
    position: int
    of: int  # how many the source ranks; 0 when it does not say
    as_of: str  # the upstream data date, or the fetch time when the source has none


@dataclass(frozen=True)
class Board:
    positions: dict[str, int]
    of: int
    as_of: str


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
    ranks: dict[str, Rank] = field(default_factory=dict)  # keyed by source: pypi, homebrew, jetbrains
    fetched_at: str = ""  # day this record last fetched with no transient failure; drives staleness


def main() -> None:
    projects: dict[str, list[dict[str, str]]] = yaml.safe_load(_SRC.read_text())
    listing = [project for group in _GROUPS for project in (projects.get(group) or [])]
    listing.sort(key=baseline_fetched_at)  # stalest (and never-fetched) first, so they win the rate-limit budget
    boards = load_boards()
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(partial(stats_for, boards=boards), listing))
    stats = {keyed(project): asdict(record) for project, (record, _) in zip(listing, results, strict=True)}
    render_summary(listing, results)
    _OUT.write_text(json.dumps(stats, indent=2, sort_keys=True) + "\n")
    hint = "" if _TOKEN else " (no token: GitHub calls rate-limited)"
    print(f"prefetch: wrote {len(stats)} project records to {_OUT}{hint}")
    if stale := sorted(key for key, record in stats.items() if is_stale(record["fetched_at"])):
        print(f"::error::{len(stale)} record(s) unrefreshed for over {_STALE_AFTER.days} days: {', '.join(stale)}")
        raise SystemExit(1)


def load_boards() -> dict[str, Board]:
    boards: dict[str, Board] = {}
    for source, load in (("pypi", pypi_board), ("homebrew", homebrew_board)):
        try:
            board = load()
        except _FETCH_ERRORS as exc:
            print(f"prefetch: {source} ranking unavailable, keeping prior ranks: {exc}")
            continue
        if board.positions:  # an empty list means the format changed; dropping every rank would be wrong
            boards[source] = board
    return boards


def pypi_board() -> Board:
    data = get(_PYPI_TOP)
    rows = as_list(dig(data, "rows"))  # sorted by 30-day downloads, so the position is the rank
    return Board(
        positions={normalize(as_text(dig(row, "project"))): index for index, row in enumerate(rows, 1)},
        of=len(rows),
        as_of=as_text(dig(data, "last_update"))[:10],
    )


def homebrew_board() -> Board:
    data = get(_BREW_TOP)
    items = as_list(dig(data, "items"))
    return Board(
        positions={as_text(dig(item, "formula")): as_int(dig(item, "number")) for item in items},
        of=len(items),  # total_items overstates what the list holds
        as_of=as_text(dig(data, "end_date")),
    )


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()  # PEP 503, so pytest_env and pytest-env meet


def baseline_fetched_at(project: dict[str, str]) -> str:
    return as_text(dig(_BASELINE.get(keyed(project)), "fetched_at"))


def is_stale(fetched_at: object) -> bool:
    if not isinstance(fetched_at, str) or not fetched_at:
        return True
    moment = datetime.fromisoformat(fetched_at)
    if moment.tzinfo is None:  # a date-only value from an older file parses naive; read it as UTC
        moment = moment.replace(tzinfo=UTC)
    return moment < _NOW - _STALE_AFTER


def keyed(project: dict[str, str]) -> str:
    # the composite key project-row.html rebuilds; keep the two in lockstep. `lang` is deliberately absent:
    # it never changes which endpoints get hit, so reclassifying one must not throw away its numbers.
    parts = (project["org"], project.get("repo") or project["name"], project["name"])
    return "|".join((*parts, project.get("kind") or "", project.get("pypi") or ""))


def render_summary(listing: list[dict[str, str]], results: list[tuple[Stats, list[str]]]) -> None:
    # colour the log in CI (no tty there); when a value could not be refreshed the row shows the kept value
    console = Console(force_terminal=True, width=120) if os.environ.get("GITHUB_ACTIONS") else Console()
    table = Table(title="Download stats refresh")
    table.add_column("Project", no_wrap=True)
    table.add_column("Previous update", justify="center")
    table.add_column("Updated", justify="center")
    table.add_column("Previous", justify="right")
    table.add_column("New", justify="right")
    notes: list[str] = []
    for project, (record, errors) in sorted(
        zip(listing, results, strict=True), key=lambda pair: pair[0]["name"].lower()
    ):
        prior = _BASELINE.get(keyed(project))
        previous_at = as_text(dig(prior, "fetched_at"))
        previous = as_int(dig(prior, tracked_field(project)))
        current = as_int(dig(asdict(record), tracked_field(project)))
        table.add_row(
            f"{project['org']}/{project['name']}",
            short_time(previous_at) or "[dim]never[/dim]",
            update_cell(record.fetched_at, previous_at),
            count_cell(previous),
            delta_cell(previous, current),
        )
        if errors:
            notes.append(f"[yellow]{project['name']}[/yellow] kept prior value: {'; '.join(errors)}")
    console.print(table)
    for note in notes:
        console.print(note)


def kinds_of(project: dict[str, str]) -> list[str]:
    return [entry.strip() for entry in (project.get("kind") or "").split(",")]


def tracked_field(project: dict[str, str]) -> str:
    if (project.get("pypi") or "") != "false":
        return "pypi_downloads"
    if project.get("jetbrains-id"):
        return "jb_downloads"
    if "action" in kinds_of(project):
        return "gha_usage_count"
    return "gh_downloads"


def update_cell(fetched_at: str, previous_at: str) -> str:
    shown = short_time(fetched_at) or "never"
    if is_stale(fetched_at):
        return f"[red]{shown}[/red]"  # over the threshold: the job fails on this
    if fetched_at != previous_at:
        return f"[green]{shown}[/green]"  # advanced this run
    return f"[yellow]{shown}[/yellow]"  # unchanged: kept the prior value, likely rate-limited


def short_time(fetched_at: str) -> str:
    return fetched_at[:16].replace("T", " ")  # trim the ISO stamp to "YYYY-MM-DD HH:MM"


def count_cell(value: int) -> str:
    return f"{value:,}" if value else "[dim]—[/dim]"


def delta_cell(previous: int, current: int) -> str:
    text = f"{current:,}" if current else "—"
    if current > previous:
        return f"[green]{text}[/green]"
    if current < previous:
        return f"[red]{text}[/red]"
    return f"[dim]{text}[/dim]"


def stats_for(project: dict[str, str], boards: dict[str, Board]) -> tuple[Stats, list[str]]:
    org, name = project["org"], project["name"]
    repo = project.get("repo") or name
    show_pypi = (project.get("pypi") or "") != "false"
    no_release = (project.get("no-release") or "") == "true"  # never cuts releases: skip the always-404 lookup
    jetbrains_id = project.get("jetbrains-id")
    kinds = kinds_of(project)
    errors: list[str] = []
    transient: list[str] = []
    record = from_baseline(_BASELINE.get(keyed(project)))  # keep prior values for any fetch that fails

    def attempt(label: str, fetch: Callable[[], Json]) -> Json:
        try:
            return fetch()
        except urllib.error.HTTPError as exc:
            if _is_transient_http(exc):
                transient.append(label)  # rate-limited/5xx: a real refresh failure, not a missing resource
            errors.append(f"{label}: {exc}")
            return None
        except _FETCH_ERRORS as exc:
            transient.append(label)
            errors.append(f"{label}: {exc}")
            return None

    collect_github(record, org, repo, attempt, no_release=no_release)
    if show_pypi:
        collect_pypi(record, name, attempt)
    elif not jetbrains_id:
        collect_downloads(record, org, repo, kinds, attempt)
    if jetbrains_id:
        collect_jetbrains(record, jetbrains_id, attempt)

    collect_ranks(record, project, boards, errors)

    if not transient:
        record.fetched_at = _STAMP
    return record, errors


def from_baseline(data: Json) -> Stats:
    return Stats(
        default_branch=as_text(dig(data, "default_branch")) or "main",
        stars=as_int(dig(data, "stars")),
        open_total=as_int(dig(data, "open_total")),
        open_prs=as_int(dig(data, "open_prs")),
        last_commit_date=as_text(dig(data, "last_commit_date")),
        release_tag=as_text(dig(data, "release_tag")),
        release_published_at=as_text(dig(data, "release_published_at")),
        pypi_version=as_text(dig(data, "pypi_version")),
        pypi_release_date=as_text(dig(data, "pypi_release_date")),
        pypi_downloads=as_int(dig(data, "pypi_downloads")),
        gha_usage_count=as_int(dig(data, "gha_usage_count")),
        gh_downloads=as_int(dig(data, "gh_downloads")),
        gh_download_label=as_text(dig(data, "gh_download_label")) or "total",
        jb_downloads=as_int(dig(data, "jb_downloads")),
        jb_version=as_text(dig(data, "jb_version")),
        jb_release_unix=as_int(dig(data, "jb_release_unix")),
        ranks={
            source: Rank(
                position=as_int(dig(entry, "position")),
                of=as_int(dig(entry, "of")),
                as_of=as_text(dig(entry, "as_of")),
            )
            for source, entry in as_dict(dig(data, "ranks")).items()
        },
        fetched_at=as_text(dig(data, "fetched_at")),
    )


def collect_github(record: Stats, org: str, repo: str, attempt: Attempt, *, no_release: bool) -> None:
    if (repo_data := attempt("repo-info", lambda: gh(f"repos/{org}/{repo}"))) is not None:
        record.default_branch = as_text(dig(repo_data, "default_branch")) or "main"
        record.stars = as_int(dig(repo_data, "stargazers_count"))
        record.open_total = as_int(dig(repo_data, "open_issues_count"))

    commits_url = f"repos/{org}/{repo}/commits?sha={record.default_branch}&per_page=1"
    if commits := as_list(attempt("commits", lambda: gh(commits_url))):
        record.last_commit_date = as_text(dig(commits[0], "commit", "committer", "date"))

    if not no_release and (
        tag := as_text(
            dig(release := attempt("release", lambda: gh(f"repos/{org}/{repo}/releases/latest")), "tag_name")
        )
    ):
        record.release_tag = tag
        record.release_published_at = as_text(dig(release, "published_at"))

    if (pulls := attempt("gh-pulls", lambda: gh(f"repos/{org}/{repo}/pulls?state=open&per_page=100"))) is not None:
        record.open_prs = len(as_list(pulls))


def collect_pypi(record: Stats, name: str, attempt: Attempt) -> None:
    pypi = attempt("pypi-version", lambda: get(f"https://pypi.org/pypi/{name}/json"))
    if pypi is not None:
        record.pypi_version = as_text(dig(pypi, "info", "version"))
        if urls := as_list(dig(pypi, "urls")):
            record.pypi_release_date = as_text(dig(urls[0], "upload_time_iso_8601"))
    stats = attempt("pypi-downloads", lambda: get(f"https://api.pepy.tech/api/v2/projects/{name}", _PEPY_HEADERS))
    if month := last_month_downloads(stats):
        record.pypi_downloads = month


def last_month_downloads(stats: Json) -> int:
    # pepy returns a per-day, per-version breakdown; sum the trailing 30 days to match the "/mo" the table
    # shows (ISO dates sort lexically, so a string compare bounds the window)
    daily = dig(stats, "downloads")
    if not isinstance(daily, dict):
        return 0
    cutoff = (_NOW - timedelta(days=30)).date().isoformat()
    return sum(
        as_int(count)
        for day, versions in daily.items()
        if day >= cutoff and isinstance(versions, dict)
        for count in versions.values()
    )


def collect_downloads(record: Stats, org: str, repo: str, kinds: list[str], attempt: Attempt) -> None:
    if "action" in kinds:
        query = urllib.parse.quote(f'"uses: {org}/{repo}"')
        if (usage := attempt("gha-usage", lambda: gh(f"search/code?q={query}"))) is not None:
            record.gha_usage_count = as_int(dig(usage, "total_count"))
        return
    if "pre-commit" not in kinds:
        releases = as_list(attempt("gh-releases", lambda: gh(f"repos/{org}/{repo}/releases?per_page=100")))
        if downloads := sum(
            as_int(dig(asset, "download_count")) for release in releases for asset in as_list(dig(release, "assets"))
        ):
            record.gh_downloads = downloads
            return
    if clones := attempt("gh-clones", lambda: gh(f"repos/{org}/{repo}/traffic/clones")):
        record.gh_downloads = as_int(dig(clones, "count"))
        record.gh_download_label = "clones/14d"


def collect_jetbrains(record: Stats, plugin_id: str, attempt: Attempt) -> None:
    plugin = attempt("jb-downloads", lambda: get(f"https://plugins.jetbrains.com/api/plugins/{plugin_id}"))
    if plugin is not None:
        record.jb_downloads = as_int(dig(plugin, "downloads"))
    endpoint = f"https://plugins.jetbrains.com/api/plugins/{plugin_id}/updates?channel=&size=1"
    if updates := as_list(attempt("jb-version", lambda: get(endpoint))):
        record.jb_version = as_text(dig(updates[0], "version"))
        record.jb_release_unix = int(as_text(dig(updates[0], "cdate")) or 0) // 1000


def collect_ranks(record: Stats, project: dict[str, str], boards: dict[str, Board], errors: list[str]) -> None:
    if (project.get("pypi") or "") != "false" and (board := boards.get("pypi")):
        place(record, "pypi", board, normalize(project["name"]))
    if (formula := project.get("homebrew")) and (board := boards.get("homebrew")):
        place(record, "homebrew", board, formula)
    if project.get("jetbrains-id") and record.jb_downloads and rank_due(record.ranks.get("jetbrains")):
        try:
            jetbrains = jetbrains_rank(record.jb_downloads)
        except _FETCH_ERRORS as exc:  # outside attempt(): a missed rank must not hold back fetched_at
            errors.append(f"jb-rank: {exc}")
            return
        record.ranks.pop("jetbrains", None)
        if jetbrains.position:
            record.ranks["jetbrains"] = jetbrains


def place(record: Stats, source: str, board: Board, key: str) -> None:
    if position := board.positions.get(key):
        record.ranks[source] = Rank(position=position, of=board.of, as_of=board.as_of)
    else:  # fell off the list, so the old rank no longer holds
        record.ranks.pop(source, None)


def rank_due(rank: Rank | None) -> bool:
    return rank is None or datetime.fromisoformat(rank.as_of) < _NOW - _RANK_EVERY


def jetbrains_rank(downloads: int) -> Rank:
    # the listing sorts by all-time downloads but cannot filter by them, so binary-search the first offset whose
    # plugin has no more downloads than ours; everything before it outranks us
    low, high = 0, _JB_RANKED
    while low < high:
        middle = (low + high) // 2
        page = get(f"https://plugins.jetbrains.com/api/searchPlugins?orderBy=downloads&max=1&offset={middle}")
        if (plugins := as_list(dig(page, "plugins"))) and as_int(dig(plugins[0], "downloads")) > downloads:
            low = middle + 1
        else:
            high = middle
    return Rank(position=0 if low == _JB_RANKED else low + 1, of=0, as_of=_STAMP)


def gh(path: str) -> Json:
    return get(f"https://api.github.com/{path}", _GH_HEADERS)


def _is_transient_http(exc: urllib.error.HTTPError) -> bool:
    # GitHub answers an exhausted rate limit with 403 as often as 429; only the headers tell it apart from a 403
    # for a resource the token may not read (traffic/clones without push access), which no retry fixes
    rate_limited = exc.code == HTTPStatus.FORBIDDEN and (
        exc.headers.get("x-ratelimit-remaining") == "0" or exc.headers.get("Retry-After") is not None
    )
    return exc.code in _RETRYABLE or rate_limited


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, urllib.error.HTTPError):
        return _is_transient_http(exc)
    return isinstance(exc, (urllib.error.URLError, TimeoutError))  # connection reset, DNS, timeout


# deterministic doubling (1s, 2s, 4s, 8s) with a little jitter so 8 threads do not retry in lockstep
_BLIND_BACKOFF: Final = tenacity.wait_exponential_jitter(initial=1, max=_BACKOFF_CAP, jitter=0.5)


def retry_after(exc: BaseException | None) -> float | None:
    # honour how long the server told us to wait: RFC 7231 Retry-After, then pepy's and GitHub's own headers
    if not isinstance(exc, urllib.error.HTTPError):
        return None
    if raw := exc.headers.get("Retry-After"):
        if (raw := raw.strip()).isdigit():
            return float(raw)
        with contextlib.suppress(TypeError, ValueError):
            return (parsedate_to_datetime(raw) - datetime.now(tz=UTC)).total_seconds()
    if secs := exc.headers.get("X-Rate-Limit-Retry-After-Seconds"):  # pepy.tech
        with contextlib.suppress(ValueError):
            return float(secs)
    if exc.headers.get("x-ratelimit-remaining") == "0" and (reset := exc.headers.get("x-ratelimit-reset")):
        with contextlib.suppress(ValueError):
            return int(reset) - datetime.now(tz=UTC).timestamp()
    return None


def retry_wait(state: tenacity.RetryCallState) -> float:
    exc = state.outcome.exception() if state.outcome else None
    if (told := retry_after(exc)) is not None:
        return max(0.0, min(told, _BACKOFF_CAP))  # the server named a delay; obey it within the cap
    return _BLIND_BACKOFF(state)  # nothing to go on: jittered exponential


def _log_retry(state: tenacity.RetryCallState) -> None:
    url = state.args[0] if state.args else ""
    exc = state.outcome.exception() if state.outcome else None
    wait = state.next_action.sleep if state.next_action else 0.0
    print(f"  retry {state.attempt_number}/{_MAX_ATTEMPTS} in {wait:.1f}s after {exc}: {url}")


@tenacity.retry(
    retry=tenacity.retry_if_exception(_is_retryable),
    wait=retry_wait,
    stop=tenacity.stop_after_attempt(_MAX_ATTEMPTS),
    before_sleep=_log_retry,
    reraise=True,
)
def get(url: str, headers: dict[str, str] | None = None) -> Json:
    request = urllib.request.Request(url, headers={"User-Agent": "bernat-tech-prefetch", **(headers or {})})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def dig(value: Json, *keys: str) -> Json:
    for key in keys:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def as_dict(value: Json) -> dict[str, Json]:
    return value if isinstance(value, dict) else {}


def as_list(value: Json) -> list[Json]:
    return value if isinstance(value, list) else []


def as_text(value: Json) -> str:
    return value if isinstance(value, str) else ""


def as_int(value: Json) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


if __name__ == "__main__":
    main()

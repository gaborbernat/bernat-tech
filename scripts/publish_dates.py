# /// script
# requires-python = ">=3.13"
# ///
"""Record when each post went from draft to live so the posts index shows the real publish date rather
than the frontmatter start date (which is set when writing begins). The go-live commit is the newest one
that touched `draft = true`: a published post is no longer a draft, so that commit is the one that removed
it. Writes data/publish_dates.json keyed by the content-relative path; posts/li.html reads it and falls
back to the frontmatter date for posts that were never drafts."""

# print is this CLI build script's progress output; stdout is intended
# ruff: noqa: T201

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Final

_CONTENT: Final = Path("content")
_OUT: Final = Path("data/publish_dates.json")


def main() -> None:
    dates = {}
    for post in sorted(_CONTENT.glob("posts/*/index.md")):
        if live := went_live(post):
            dates[str(post.relative_to(_CONTENT))] = live
    _OUT.write_text(json.dumps(dates, indent=2, sort_keys=True) + "\n")
    print(f"publish-dates: recorded {len(dates)} go-live dates")


def went_live(post: Path) -> str:
    result = subprocess.run(
        ["git", "log", "--format=%aI", "-S", "draft = true", "--", str(post)],
        capture_output=True,
        text=True,
        check=True,
    )
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    return lines[0][:10] if lines else ""


if __name__ == "__main__":
    main()

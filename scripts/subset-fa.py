# /// script
# requires-python = ">=3.13"
# dependencies = ["fonttools>=4.55", "brotli>=1.1"]
# ///
"""Subset the FontAwesome webfonts in public/fonts/ to only the glyphs the built site actually uses,
then verify every used codepoint survived. Runs after Hugo, against the rendered output. FA6 defines
each icon's codepoint as a CSS variable (`.fa-name { --fa: "\\fXXXX" }`), so we map used `fa-name`
classes to codepoints via the built CSS and drop everything else from the fonts.

Some icon names get more than one `--fa` rule: FA6 keeps a legacy codepoint under the bare `.fa-name`
selector and overrides it to the current one only under a more specific selector like `.fa.fa-name`.
Our markup (`class="fas fa-name"`) never matches that override, so the plain, less-specific rule is the
one that actually applies — but it isn't always the one that appears last in the CSS. Keep every
codepoint ever associated with a used name rather than guessing which rule wins the cascade.

Fail-safe: if the extraction finds nothing, or a used codepoint is missing from every font after
subsetting, exit non-zero so the build fails instead of shipping broken icons."""

# print is this CLI build script's progress output; stdout is intended
# ruff: file-ignore[print]

from __future__ import annotations

import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Final

from fontTools.ttLib import TTFont

_FA_DEF: Final = re.compile(r'\.fa-([a-z0-9-]+)\s*\{\s*--fa:\s*"\\([0-9a-fA-F]+)"')
_FA_USE: Final = re.compile(r"fa-([a-z0-9-]+)")
_FONTS: Final = Path("public/fonts")


def main() -> None:
    name_to_cps: defaultdict[str, set[int]] = defaultdict(set)
    for css in Path("public").rglob("*.css"):
        for name, codepoint in _FA_DEF.findall(css.read_text(encoding="utf-8", errors="ignore")):
            name_to_cps[name].add(int(codepoint, 16))
    used_names = {
        name
        # scan JS too: the copy button and other scripts inject fa- icons that never appear in the HTML
        for pattern in ("*.html", "*.js")
        for path in Path("public").rglob(pattern)
        for name in _FA_USE.findall(path.read_text(encoding="utf-8", errors="ignore"))
    }
    used = sorted({cp for name in used_names for cp in name_to_cps.get(name, ())})
    if not used:
        sys.exit("subset-fa: found no FontAwesome codepoints; refusing to empty the fonts")

    unicodes = ",".join(f"U+{codepoint:04X}" for codepoint in used)
    for font in sorted(_FONTS.glob("fa-*.woff2")):
        before = font.stat().st_size
        subprocess.run(
            [
                sys.executable,
                "-m",
                "fontTools.subset",
                str(font),
                f"--unicodes={unicodes}",
                "--flavor=woff2",
                f"--output-file={font}",
            ],
            check=True,
        )
        print(f"  {font.name}: {before // 1024} kB -> {font.stat().st_size // 1024} kB")

    if missing := [codepoint for codepoint in used if codepoint not in surviving_codepoints()]:
        sys.exit("subset-fa: used codepoints missing after subset: " + ",".join(f"U+{cp:04X}" for cp in missing))
    print(f"subset-fa: OK, kept {len(used)} glyphs used across {len(used_names)} classes")


def surviving_codepoints() -> set[int]:
    codepoints: set[int] = set()
    for font in _FONTS.glob("fa-*.woff2"):
        tables = TTFont(font)
        for table in tables["cmap"].tables:
            codepoints |= set(table.cmap.keys())
        tables.close()
    return codepoints


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Subset the FontAwesome webfonts in public/fonts/ to only the glyphs the built
site actually uses, then verify every used codepoint survived. Runs after Hugo,
against the rendered output. FA6 defines each icon's codepoint as a CSS variable
(`.fa-name { --fa: "\\fXXXX" }`), so we map used `fa-name` classes to codepoints
via the built CSS and drop everything else from the fonts.

Fail-safe: if the extraction finds nothing, or a used codepoint is missing from
every font after subsetting, exit non-zero so the build fails instead of shipping
broken icons."""

from __future__ import annotations

import glob
import os
import re
import subprocess
import sys

from fontTools.ttLib import TTFont

FA_DEF = re.compile(r'\.fa-([a-z0-9-]+)\s*\{\s*--fa:\s*"\\([0-9a-fA-F]+)"')
FA_USE = re.compile(r"fa-([a-z0-9-]+)")


def read(path: str) -> str:
    return open(path, encoding="utf-8", errors="ignore").read()


def codepoints_in_fonts() -> set[int]:
    cps: set[int] = set()
    for font in glob.glob("public/fonts/fa-*.woff2"):
        tt = TTFont(font)
        for table in tt["cmap"].tables:
            cps |= set(table.cmap.keys())
        tt.close()
    return cps


def main() -> None:
    name_to_cp = {
        name: int(hexcp, 16)
        for css in glob.glob("public/**/*.css", recursive=True)
        for name, hexcp in FA_DEF.findall(read(css))
    }
    used_names = {
        name for html in glob.glob("public/**/*.html", recursive=True) for name in FA_USE.findall(read(html))
    }
    used_cps = sorted({name_to_cp[name] for name in used_names if name in name_to_cp})
    if not used_cps:
        sys.exit("subset-fa: found no FontAwesome codepoints; refusing to empty the fonts")

    unicodes = ",".join(f"U+{cp:04X}" for cp in used_cps)
    for font in sorted(glob.glob("public/fonts/fa-*.woff2")):
        before = os.path.getsize(font)
        subprocess.run(
            [sys.executable, "-m", "fontTools.subset", font, f"--unicodes={unicodes}", "--flavor=woff2",
             f"--output-file={font}"],
            check=True,
        )
        print(f"  {os.path.basename(font)}: {before // 1024} kB -> {os.path.getsize(font) // 1024} kB")

    missing = [cp for cp in used_cps if cp not in codepoints_in_fonts()]
    if missing:
        sys.exit("subset-fa: used codepoints missing after subset: " + ",".join(f"U+{cp:04X}" for cp in missing))
    print(f"subset-fa: OK, kept {len(used_cps)} glyphs used across {len(used_names)} classes")


if __name__ == "__main__":
    main()

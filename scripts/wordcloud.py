# /// script
# requires-python = ">=3.13"
# dependencies = ["pillow>=12.3", "numpy>=2.5.1", "fonttools[woff]>=4.63"]
# ///
"""Pack the /topics/ flex list into a horizontal spiral word cloud, emitted as SVG anchors
(crawlable, focusable links) at build time: no runtime JS, no layout shift.

Glyphs are measured with the exact font the page ships (static/fonts/tag-cloud.woff2), so the
browser paints the same widths the packer reserved and no two words overlap."""

# print is this CLI build script's progress output; stdout is intended
# ruff: noqa: T201

from __future__ import annotations

import io
import math
import re
from pathlib import Path
from typing import Final, NamedTuple

import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

_FILE: Final = Path("public/posts/index.html")
_WOFF2: Final = Path("static/fonts/tag-cloud.woff2")
_MIN_PX: Final = 16
_MAX_PX: Final = 68
_PAD: Final = 6  # clear pixels kept between neighbouring words
_MARGIN: Final = 6  # viewBox breathing room
_ASPECT: Final = 1.55
_CONTAINER: Final = re.compile(r'<div class=["\']?tag-cloud["\']? data-wordcloud>(.*?)</div>', re.DOTALL)
_ANCHOR: Final = re.compile(
    r'<a href=["\']?([^"\'\s>]+)["\']?[^>]*?\sdata-w=["\']?(\d+)["\']?[^>]*>(.*?)</a>', re.DOTALL
)


class Word(NamedTuple):
    href: str
    topic: str  # slug carried onto the SVG anchor so the filter JS can toggle it
    text: str
    freq: int
    size: int
    heat: float  # 0..1 position on the colour gradient


class Glyph(NamedTuple):
    tight: np.ndarray  # ink mask, for collision queries
    grown: np.ndarray  # ink dilated by _PAD, written into the occupancy grid
    left: int  # ink offset from the SVG anchor (horizontal centre, alphabetic baseline)
    top: int


class Placed(NamedTuple):
    word: Word
    x: float
    y: float
    left: float
    top: float
    right: float
    bottom: float


def main() -> None:
    html = _FILE.read_text()
    if not (block := _CONTAINER.search(html)):
        print("wordcloud: no tag-cloud container found, leaving flex fallback in place")
        return
    if not (words := parse_words(block.group(1))):
        print("wordcloud: no tags parsed, leaving flex fallback in place")
        return
    glyphs = build_glyphs(words)
    if not (placed := pack(words, glyphs)):
        print(f"wordcloud: could not fit {len(words)} tags, keeping flex fallback")
        return
    svg = render_svg(placed)
    replacement = (
        f'<div class="tag-cloud tag-cloud--flex">{block.group(1)}</div><div class="tag-cloud--svg">{svg}</div>'
    )
    _FILE.write_text(html[: block.start()] + replacement + html[block.end() :])
    print(f"wordcloud: packed {len(placed)} tags")


def parse_words(inner: str) -> list[Word]:
    raw = [(match[1], re.sub(r"\s+", " ", match[3]).strip(), int(match[2])) for match in _ANCHOR.finditer(inner)]
    if not raw:
        return []
    weights = [math.sqrt(freq + 1) for *_, freq in raw]
    lo = min(weights)
    span = (max(weights) - lo) or 1
    words = []
    for (href, text, freq), weight in zip(raw, weights, strict=True):
        heat = (weight - lo) / span
        topic = href.rsplit("topics=", 1)[-1]
        words.append(Word(href, topic, text, freq, round(_MIN_PX + heat * (_MAX_PX - _MIN_PX)), heat))
    return words


def build_glyphs(words: list[Word]) -> dict[Word, Glyph]:
    font = TTFont(str(_WOFF2))
    font.flavor = None
    buffer = io.BytesIO()
    font.save(buffer)
    ttf = buffer.getvalue()
    faces: dict[int, ImageFont.FreeTypeFont] = {}
    glyphs = {}
    for word in words:
        face = faces.setdefault(word.size, ImageFont.truetype(io.BytesIO(ttf), word.size))
        left, top, right, bottom = (round(edge) for edge in face.getbbox(word.text, anchor="ms"))
        image = Image.new("L", (right - left + 2 * _PAD, bottom - top + 2 * _PAD), 0)
        ImageDraw.Draw(image).text((_PAD - left, _PAD - top), word.text, font=face, fill=255, anchor="ms")
        tight = np.asarray(image) > 40
        grown = np.asarray(image.filter(ImageFilter.MaxFilter(2 * _PAD + 1))) > 40
        glyphs[word] = Glyph(tight, grown, left, top)
    return glyphs


def pack(words: list[Word], glyphs: dict[Word, Glyph]) -> list[Placed] | None:
    order = sorted(words, key=lambda word: (-word.size, word.text))
    ink = sum(int(glyph.tight.sum()) for glyph in glyphs.values())
    scale = 2.6
    for _ in range(7):
        width = round(math.sqrt(ink * scale * _ASPECT))
        if (placed := try_place(order, glyphs, width, round(width / _ASPECT))) is not None:
            return placed
        scale *= 1.3
    return None


def try_place(order: list[Word], glyphs: dict[Word, Glyph], width: int, height: int) -> list[Placed] | None:
    occ = np.zeros((height, width), dtype=bool)
    cx, cy = width // 2, height // 2
    placed = []
    for word in order:
        if (spot := spiral_place(occ, glyphs[word], cx, cy)) is None:
            return None
        dx, dy = spot
        glyph = glyphs[word]
        left, top = dx + glyph.left, dy + glyph.top
        placed.append(Placed(word, dx, dy, left, top, left + glyph.tight.shape[1], top + glyph.tight.shape[0]))
    return placed


def spiral_place(occ: np.ndarray, glyph: Glyph, cx: int, cy: int) -> tuple[float, float] | None:
    height, width = occ.shape
    th, tw = glyph.tight.shape
    limit = math.hypot(width, height)
    theta = 0.0
    while (radius := 4.0 * theta) < limit:
        dx = radius * math.cos(theta)
        dy = radius * math.sin(theta)
        gx = round(dx + glyph.left) + cx
        gy = round(dy + glyph.top) + cy
        in_bounds = gx - _PAD >= 0 and gy - _PAD >= 0 and gx + tw + _PAD <= width and gy + th + _PAD <= height
        if in_bounds and not occ[gy : gy + th, gx : gx + tw][glyph.tight].any():
            occ[gy - _PAD : gy - _PAD + glyph.grown.shape[0], gx - _PAD : gx - _PAD + glyph.grown.shape[1]] |= (
                glyph.grown
            )
            return dx, dy
        theta += 0.35 / (1.0 + 0.02 * theta)
    return None


def render_svg(placed: list[Placed]) -> str:
    x0 = min(word.left for word in placed) - _MARGIN
    y0 = min(word.top for word in placed) - _MARGIN
    x1 = max(word.right for word in placed) + _MARGIN
    y1 = max(word.bottom for word in placed) + _MARGIN
    body = "".join(
        f'<a href="{word.word.href}" data-topic="{esc(word.word.topic)}" aria-label="{esc(word.word.text)}">'
        f'<text x="{word.x:.1f}" y="{word.y:.1f}" font-size="{word.word.size}" '
        f'style="--t:{word.word.heat:.3f}">{esc(word.word.text)}</text>'
        f"</a>"
        # screen-reader and tab order follow frequency, independent of the visual spiral placement
        for word in sorted(placed, key=lambda word: -word.word.freq)
    )
    return (
        f'<svg class="wordcloud" viewBox="{x0:.1f} {y0:.1f} {x1 - x0:.1f} {y1 - y0:.1f}" role="group" '
        f'aria-label="Blog topics, sized by how often each word appears" '
        f'xmlns="http://www.w3.org/2000/svg" text-anchor="middle" font-family="TagCloud">'
        f"<title>Blog topics word cloud</title>{body}</svg>"
    )


def esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


if __name__ == "__main__":
    main()

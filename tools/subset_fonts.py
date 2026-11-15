#!/usr/bin/env python3
"""
Subset the self-hosted web fonts to what the site uses.

- Characters: Google Fonts' "latin" range plus the arrows and symbols the site
  uses (→ ↓ ≈ ▾ ×). Text outside it falls back to the system font.
- Weights: variable fonts are limited to the range their @font-face rule
  declares in css/base.css (DM Sans 400-700, JetBrains Mono 400-500), so
  nothing the browser can request is lost.
- All OpenType layout features are kept.

Usage:
    uv run --with 'fonttools[woff]' python tools/subset_fonts.py

Rewrites assets/fonts/*.woff2 in place. Running it again gives the same files.
"""

from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FONTS_DIR = Path(__file__).resolve().parent.parent / "assets" / "fonts"

# Google Fonts "latin" subset, plus arrows, ≈ and ▾.
UNICODES = (
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,"
    "U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2190-21FF,U+2212,"
    "U+2215,U+2248,U+25BE,U+FEFF,U+FFFD"
)

# File -> wght axis limits matching the @font-face weight range (None: static font).
FONTS = {
    "DMSans.woff2": (400, 700),
    "JetBrainsMono.woff2": (400, 500),
    "InstrumentSerif.woff2": None,
}


def parse_unicodes(spec: str) -> list[int]:
    codepoints = []
    for part in spec.split(","):
        part = part.removeprefix("U+")
        lo, _, hi = part.partition("-")
        codepoints.extend(range(int(lo, 16), int(hi or lo, 16) + 1))
    return codepoints


def main() -> None:
    unicodes = parse_unicodes(UNICODES)
    for name, wght in FONTS.items():
        path = FONTS_DIR / name
        before = path.stat().st_size
        font = TTFont(path, lazy=False)
        options = subset.Options()
        options.flavor = "woff2"
        options.layout_features = ["*"]
        options.name_IDs = ["*"]
        options.notdef_outline = True
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=unicodes)
        subsetter.subset(font)
        if wght and "fvar" in font:
            font = instancer.instantiateVariableFont(font, {"wght": wght})
        font.flavor = "woff2"
        font.save(path)
        print(f"{name}: {before // 1024} KB -> {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()

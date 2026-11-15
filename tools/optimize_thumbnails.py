#!/usr/bin/env python3
"""
Self-host card images as WebP at twice their displayed size.

Homepage cards display thumbnails about 270 px wide and training posters about
318 px wide. Sources are often far larger (YouTube maxresdefault is 1280 px,
press photos 800 px, Hot Stove's OG image 3600 px), so this script writes a
resized WebP copy of every `thumbnail` and `poster` in data/*.json and points
the JSON at the copy.

Usage:
    uv run python tools/optimize_thumbnails.py

Where copies go:
- YouTube URLs     -> assets/images/youtube/<videoId>.webp
- Local images     -> same folder and name, .webp extension
- Other remote URLs -> assets/images/thumbs/<host>-<name>.webp

Original files are left in place (the Evolution page's video facades look up
assets/images/youtube/<videoId>.jpg). Entries that already point at a .webp
under /assets/images/ are skipped, so re-running only handles new entries,
such as remote thumbnails the Substack fetcher appends.
"""

import io
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent / "fetch"))
from common import PROJECT_ROOT, load_json  # noqa: E402

DATA_DIR = PROJECT_ROOT / "data"
IMAGES_DIR = PROJECT_ROOT / "assets" / "images"

# JSON key -> (output width in px, WebP quality). Widths are 2x the displayed
# card width; posters are photo stills with fine grain, so they get a lower
# quality to stay near 100 KB.
TARGETS = {
    "thumbnail": (540, 80),
    "poster": (640, 75),
}

YOUTUBE_RE = re.compile(r"(?:img\.youtube\.com|i\.ytimg\.com)/vi/([\w-]{11})/")


def output_path(src: str) -> Path:
    """Return where the WebP copy of `src` is written."""
    if m := YOUTUBE_RE.search(src):
        return IMAGES_DIR / "youtube" / f"{m.group(1)}.webp"
    parsed = urlparse(src)
    if parsed.scheme in ("http", "https"):
        host = parsed.netloc.removeprefix("www.").split(".")[0]
        stem = Path(parsed.path).stem or "image"
        return IMAGES_DIR / "thumbs" / f"{host}-{stem}.webp"
    return (PROJECT_ROOT / parsed.path.lstrip("/")).with_suffix(".webp")


def read_source(src: str) -> bytes:
    """Fetch a remote image or read a local one (query string ignored)."""
    parsed = urlparse(src)
    if parsed.scheme in ("http", "https"):
        resp = requests.get(src, timeout=30)
        resp.raise_for_status()
        return resp.content
    return (PROJECT_ROOT / parsed.path.lstrip("/")).read_bytes()


def write_webp(data: bytes, dest: Path, width: int, quality: int) -> tuple[int, int]:
    """Resize to `width` (never upscale) and save as WebP. Returns (w, h)."""
    im = Image.open(io.BytesIO(data))
    im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, "WEBP", quality=quality, method=6)
    return im.size


def is_optimized(src: str) -> bool:
    return src.startswith("/assets/images/") and urlparse(src).path.endswith(".webp")


def process(node, stats: dict, replacements: dict) -> None:
    """Walk JSON, recording a WebP copy for each thumbnail/poster.

    Fills `replacements` with (key, old value) -> new value.
    """
    if isinstance(node, list):
        for item in node:
            process(item, stats, replacements)
        return
    if not isinstance(node, dict):
        return
    for key, value in node.items():
        if key in TARGETS and isinstance(value, str) and value and not is_optimized(value):
            width, quality = TARGETS[key]
            dest = output_path(value)
            try:
                data = read_source(value)
                size = write_webp(data, dest, width, quality)
            except (requests.RequestException, OSError) as e:
                print(f"  SKIP {value}: {e}", file=sys.stderr)
                stats["skipped"] += 1
                continue
            rel = "/" + dest.relative_to(PROJECT_ROOT).as_posix()
            new_bytes = dest.stat().st_size
            print(f"  {len(data) // 1024:>4} KB -> {new_bytes // 1024:>3} KB {size[0]}x{size[1]} {rel}")
            stats["before"] += len(data)
            stats["after"] += new_bytes
            stats["count"] += 1
            replacements[(key, value)] = rel
        else:
            process(value, stats, replacements)


def rewrite(path: Path, replacements: dict) -> None:
    """Swap each `"key": "old"` for `"key": "new"` in the file's text.

    Editing the text, rather than re-serializing, keeps the files' hand-written
    formatting (such as one-line author arrays) intact.
    """
    text = path.read_text()
    for (key, old), new in replacements.items():
        needle = f"{json.dumps(key)}: {json.dumps(old, ensure_ascii=False)}"
        if needle not in text:
            raise SystemExit(f"{path.name}: could not find {needle}")
        text = text.replace(needle, f"{json.dumps(key)}: {json.dumps(new)}")
    path.write_text(text)


def main() -> None:
    stats = {"before": 0, "after": 0, "count": 0, "skipped": 0}
    for path in sorted(DATA_DIR.glob("*.json")):
        replacements: dict = {}
        process(load_json(path), stats, replacements)
        if replacements:
            rewrite(path, replacements)
            print(f"updated {path.relative_to(PROJECT_ROOT)}")
    print(
        f"{stats['count']} images: {stats['before'] // 1024} KB -> {stats['after'] // 1024} KB"
        f" ({stats['skipped']} skipped)"
    )


if __name__ == "__main__":
    main()

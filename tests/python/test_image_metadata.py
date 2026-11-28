"""Every image under assets/ ships to the public site, so none may carry EXIF GPS tags.

Strip them before committing, for example with `exiftool -gps:all= <file>`,
which leaves the image data untouched.
"""

from pathlib import Path

import pytest
from PIL import ExifTags, Image, UnidentifiedImageError

ASSETS = Path(__file__).parent.parent.parent / "assets"
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic"}
IMAGES = sorted(p for p in ASSETS.rglob("*") if p.is_file() and p.suffix.lower() in EXTENSIONS)


def test_assets_contain_images():
    assert IMAGES, f"no images found under {ASSETS}"


@pytest.mark.parametrize("path", IMAGES, ids=lambda p: str(p.relative_to(ASSETS)))
def test_image_has_no_gps_metadata(path):
    try:
        with Image.open(path) as im:
            gps = im.getexif().get_ifd(ExifTags.IFD.GPSInfo)
    except UnidentifiedImageError:
        # Pillow reads HEIC only with a plugin; an unreadable file is not a pass.
        pytest.fail(f"{path.name}: Pillow cannot read it, so its metadata is unchecked")
    assert not gps, f"{path.name} carries EXIF GPS tags: {sorted(ExifTags.GPSTAGS.get(k, k) for k in gps)}"

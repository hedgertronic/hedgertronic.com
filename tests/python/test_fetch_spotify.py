"""Tests for the https-only URL check in fetch_spotify.py."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "tools" / "fetch"))

import fetch_spotify

EXISTING = {
    "listening": {
        "album": {
            "title": "Old Album",
            "artist": "Old Artist",
            "cover": "https://i.scdn.co/image/old",
            "url": "https://open.spotify.com/album/old",
        }
    }
}


def album(cover: str, url: str) -> dict:
    return {
        "id": "a1",
        "name": "New Album",
        "album_type": "album",
        "artists": [{"name": "New Artist"}],
        "images": [{"url": cover, "width": 300}],
        "external_urls": {"spotify": url},
    }


class FakeResponse:
    def __init__(self, items):
        self._items = items

    def raise_for_status(self):
        pass

    def json(self):
        return {"items": self._items}


@pytest.fixture
def run_with_album(monkeypatch, tmp_path):
    personal = tmp_path / "personal.json"
    personal.write_text(json.dumps(EXISTING))
    monkeypatch.setattr(fetch_spotify, "PERSONAL_FILE", personal)
    monkeypatch.setattr(fetch_spotify, "get_secret", lambda name: "x")
    monkeypatch.setattr(fetch_spotify, "get_access_token", lambda *a: "token")

    def run(top_album: dict) -> dict:
        monkeypatch.setattr(
            fetch_spotify.requests, "get", lambda *a, **kw: FakeResponse([{"album": top_album}])
        )
        fetch_spotify.main()
        return json.loads(personal.read_text())["listening"]["album"]

    return run


@pytest.mark.parametrize(
    "cover, url",
    [
        ("http://i.scdn.co/image/new", "https://open.spotify.com/album/new"),
        ("https://i.scdn.co/image/new", "javascript:alert(1)"),
    ],
)
def test_keeps_existing_album_when_a_url_is_not_https(run_with_album, capsys, cover, url):
    assert run_with_album(album(cover, url)) == EXISTING["listening"]["album"]
    assert "non-https URL" in capsys.readouterr().err


def test_writes_album_with_https_urls(run_with_album):
    updated = run_with_album(album("https://i.scdn.co/image/new", "https://open.spotify.com/album/new"))
    assert updated["title"] == "New Album"
    assert updated["cover"] == "https://i.scdn.co/image/new"
    assert updated["url"] == "https://open.spotify.com/album/new"

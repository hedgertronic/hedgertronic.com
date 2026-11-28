"""Tests for the https-only URL check in fetch_substack.py."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "tools" / "fetch"))

import fetch_substack

FEED = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <item>
      <title>Good post</title>
      <link>https://example.substack.com/p/good</link>
      <pubDate>Mon, 02 Nov 2026 12:00:00 GMT</pubDate>
      <enclosure url="https://substackcdn.com/image/good.jpg" type="image/jpeg"/>
    </item>
    <item>
      <title>Script link</title>
      <link>javascript:alert(1)</link>
      <pubDate>Mon, 02 Nov 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Plain http link</title>
      <link>http://example.substack.com/p/http</link>
      <pubDate>Mon, 02 Nov 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Data image</title>
      <link>https://example.substack.com/p/data-image</link>
      <pubDate>Mon, 02 Nov 2026 12:00:00 GMT</pubDate>
      <media:content url="data:image/svg+xml,&lt;svg/&gt;"/>
    </item>
  </channel>
</rss>
"""


class FakeResponse:
    status_code = 200
    content = FEED

    def raise_for_status(self):
        pass


def test_drops_entries_with_non_https_link_or_image(monkeypatch, capsys):
    monkeypatch.setattr(fetch_substack.requests, "get", lambda *a, **kw: FakeResponse())

    entries = fetch_substack.fetch_feed("https://example.substack.com/feed")

    assert [e["url"] for e in entries] == ["https://example.substack.com/p/good"]
    assert entries[0]["thumbnail"] == "https://substackcdn.com/image/good.jpg"
    warnings = capsys.readouterr().err
    assert "Script link" in warnings
    assert "Plain http link" in warnings
    assert "Data image" in warnings

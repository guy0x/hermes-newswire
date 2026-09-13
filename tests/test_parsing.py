"""Parser tests: RSS2 / RDF / Atom / JSON Feed / malformed, sanitization, discovery."""

from __future__ import annotations

import pytest

from conftest import ATOM, HTML_PAGE, JSONFEED, MALFORMED_XML, RDF, RSS2


def test_parse_rss2(plugin):
    feed = plugin.parse_feed(RSS2)
    assert feed["format"] == "rss"
    assert feed["title"] == "Example RSS2"
    assert len(feed["entries"]) == 2
    e = feed["entries"][0]
    assert e["title"] == "First post"                     # HTML stripped
    assert e["link"] == "https://example.com/first?utm_source=rss"
    assert e["guid"] == "guid-1"
    assert e["author"] == "Alice"
    assert e["summary"] == "Hello world with spaces"      # tags stripped, entities unescaped, ws collapsed
    assert e["published"] == "2026-09-13T10:00:00+00:00"


def test_parse_rdf(plugin):
    feed = plugin.parse_feed(RDF)
    assert feed["format"] == "rss"
    assert feed["title"] == "Example RDF"
    e = feed["entries"][0]
    assert e["title"] == "RDF item one"
    assert e["link"] == "https://example.com/one"
    assert e["author"] == "Bob"
    assert e["published"] == "2026-09-12T08:00:00+00:00"


def test_parse_atom(plugin):
    feed = plugin.parse_feed(ATOM)
    assert feed["format"] == "atom"
    e = feed["entries"][0]
    assert e["title"] == "Atom &entry"
    assert e["link"] == "https://example.com/atom-1"       # rel=alternate wins over rel=self
    assert e["guid"] == "urn:uuid:abcd-1"
    assert e["author"] == "Carol"
    assert e["summary"] == "Atom summary markup"
    assert e["published"] == "2026-09-13T08:00:00+00:00"


def test_parse_jsonfeed(plugin):
    feed = plugin.parse_feed(JSONFEED)
    assert feed["format"] == "jsonfeed"
    e = feed["entries"][0]
    assert e["title"] == "JSON feed item"
    assert e["link"] == "https://example.com/jf-1"
    assert e["guid"] == "jf-1"
    assert e["author"] == "Dan"
    assert e["summary"] == "plain text body"
    assert e["published"] == "2026-09-13T07:00:00+00:00"


def test_json_detected_by_sniffing(plugin):
    """JSON Feed without a JSON content-type still parses as JSON (leading '{')."""
    feed = plugin.parse_feed(JSONFEED, "text/plain")
    assert feed["format"] == "jsonfeed"


def test_malformed_xml_raises(plugin):
    with pytest.raises(Exception):
        plugin.parse_feed(MALFORMED_XML)


def test_malformed_json_raises(plugin):
    with pytest.raises(Exception):
        plugin.parse_feed(b'{"broken', "application/json")


def test_parse_bad_dates_become_none(plugin):
    feed = plugin.parse_feed(RSS2)
    # overwrite: craft directly
    assert plugin.parse_date("not a date at all") is None
    assert plugin.parse_date(None) is None
    assert plugin.parse_date("") is None
    assert plugin.parse_date("Sun, 13 Sep 2026 10:00:00 GMT") == "2026-09-13T10:00:00+00:00"
    assert plugin.parse_date("2026-09-13T10:00:00Z") == "2026-09-13T10:00:00+00:00"


def test_strip_html_entities_and_collapse(plugin):
    assert plugin.strip_html(None) == ""
    assert plugin.strip_html("") == ""
    assert plugin.strip_html("<p>a &amp; b</p>\n<span>c</span>") == "a & b c"
    assert plugin.strip_html("&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;") == "alert(1)"
    assert plugin.strip_html("  keep   inner   spacing  ") == "keep inner spacing"


def test_looks_like_feed(plugin):
    assert plugin.looks_like_feed(RSS2)
    assert plugin.looks_like_feed(ATOM, "application/atom+xml")
    assert plugin.looks_like_feed(RDF)
    assert plugin.looks_like_feed(JSONFEED, "application/feed+json")
    assert not plugin.looks_like_feed(b"<html><body>page</body></html>", "text/html")
    assert not plugin.looks_like_feed(b"just text")


def test_discover_link_tags(plugin):
    found = plugin.discover_in_html("https://example.com/", HTML_PAGE)
    assert found == ["https://example.com/feed.xml"]


def test_discover_relative_and_absolute(plugin):
    html = (
        b'<html><head>'
        b'<link rel="alternate" type="application/atom+xml" href="https://cdn.example.org/a.xml">'
        b'<link rel="alternate" type="application/rss+xml" href="../blog/feed">'
        b'</head><body></body></html>'
    )
    found = plugin.discover_in_html("https://example.com/news/", html)
    assert found[0] == "https://cdn.example.org/a.xml"
    assert found[1] == "https://example.com/blog/feed"


def test_discover_falls_back_to_common_paths(plugin):
    found = plugin.discover_in_html("https://example.com/", b"<html><body>no links</body></html>")
    assert found[0] == "https://example.com/feed"
    assert "/feed.xml" in " ".join(found)
    assert len(found) == len(plugin.COMMON_FEED_PATHS)


def test_discover_rejects_stylesheet(plugin):
    html = b'<link rel="stylesheet" type="application/rss+xml" href="/style-feed.xml">'
    found = plugin.discover_in_html("https://example.com/", html)
    # The stylesheet link contributed nothing; only the common-path fallback remains.
    assert found == [f"https://example.com{p}" for p in plugin.COMMON_FEED_PATHS]


def test_url_helpers(plugin):
    assert plugin.canonical_url("https://s.example/feed", "https://s.example/a?x=1#frag") == "https://s.example/a?x=1"
    assert plugin.canonical_url("https://s.example/feed", " /rel ") == "https://s.example/rel"
    assert plugin.canonical_url("https://s.example/feed", None) is None
    assert plugin.canonical_url("https://s.example/feed", "   ") is None

    n = plugin.normalize_url("HTTPS://Example.COM:443/p?utm_source=x&keep=1")
    assert n == "https://example.com/p?keep=1"
    assert plugin.normalize_url("http://example.com:80/a") == "http://example.com/a"
    assert plugin.normalize_url(None) is None


def test_dedup_keys_deterministic(plugin):
    h1 = plugin.content_hash("Title", "Body", "fallback")
    h2 = plugin.content_hash("title ", "Body", "fallback")
    assert h1 == h2  # case-insensitive, whitespace-normalised title+summary
    assert h1 != plugin.content_hash("Title", "Other", "fallback")

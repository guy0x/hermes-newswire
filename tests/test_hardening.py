"""M5 hardening tests: insert cap, consecutive-error counters, JSON export twin,
offline/DNS refresh isolation, and 200-with-identical-content hash dedup."""

from __future__ import annotations

import httpx
import pytest

from conftest import RSS2, outcome

PREFIX = "/api/plugins/hermes-newswire"


def ok(plugin, body=RSS2, **kw):
    return outcome(plugin, body, **kw)


# --- Per-refresh insert cap ------------------------------------------------------

def _feed_with_n_items(n: int, base: int = 0) -> bytes:
    items = b"".join(
        b"<item><title>Cap %d</title><link>https://example.com/cap-%d</link></item>" % (i, i)
        for i in range(base, base + n)
    )
    return b"<rss version='2.0'><channel><title>Cap</title>" + items + b"</channel></rss>"


def test_refresh_insert_cap(plugin, client, fake_fetch, monkeypatch):
    monkeypatch.setattr(plugin, "MAX_ARTICLES_PER_REFRESH", 5)
    fake_fetch({"https://example.com/feed.xml": lambda h: ok(plugin, _feed_with_n_items(20))})
    r = client.post(f"{PREFIX}/sources", json={"url": "https://example.com/feed.xml"})
    assert r.status_code == 201
    assert r.json()["articles_added"] == 5          # capped at 5, not 20
    assert client.get(f"{PREFIX}/articles?limit=500").json()["total"] == 5


def test_refresh_cap_continues_next_refresh(plugin, client, fake_fetch, monkeypatch):
    """The cap throttles per refresh, not forever: the next refresh inserts more."""
    monkeypatch.setattr(plugin, "MAX_ARTICLES_PER_REFRESH", 5)
    fake_fetch({"https://example.com/feed.xml": lambda h: ok(plugin, _feed_with_n_items(20))})
    sid = client.post(f"{PREFIX}/sources", json={"url": "https://example.com/feed.xml"}).json()["source"]["id"]
    # Same 20-item document again: 5 more new rows pass the dedup ladder.
    r = client.post(f"{PREFIX}/sources/{sid}/refresh").json()
    assert r["result"]["ok"] is True
    assert r["result"]["added"] == 5
    assert client.get(f"{PREFIX}/articles?limit=500").json()["total"] == 10


def test_refresh_cap_does_not_break_dedup(plugin, client, fake_fetch, monkeypatch):
    """Capped items reappearing next refresh still dedup against stored rows."""
    monkeypatch.setattr(plugin, "MAX_ARTICLES_PER_REFRESH", 3)
    fake_fetch({"https://example.com/feed.xml": lambda h: ok(plugin, _feed_with_n_items(10))})
    sid = client.post(f"{PREFIX}/sources", json={"url": "https://example.com/feed.xml"}).json()["source"]["id"]
    for _ in range(4):
        client.post(f"{PREFIX}/sources/{sid}/refresh")
    # 10 unique items, 3 per pass, 5 passes -> exactly 10 stored, none duplicated
    total = client.get(f"{PREFIX}/articles?limit=500").json()
    assert total["total"] == 10


# --- error_count semantics: consecutive, reset on recovery ------------------------

def test_error_count_consecutive_and_reset(plugin, client, fake_fetch):
    fake_fetch({"https://example.com/feed.xml": lambda h: ok(plugin)})
    sid = client.post(f"{PREFIX}/sources", json={"url": "https://example.com/feed.xml"}).json()["source"]["id"]

    def src():
        return next(s for s in client.get(f"{PREFIX}/sources").json()["sources"] if s["id"] == sid)

    # Three consecutive failures
    fake_fetch({"https://example.com/feed.xml": lambda h: ok(plugin, b"x", status=503, ctype="text/plain")})
    client.post(f"{PREFIX}/sources/{sid}/refresh")
    client.post(f"{PREFIX}/sources/{sid}/refresh")
    fake_fetch({"https://example.com/feed.xml": RuntimeError("network error fetching feed: DNS went away")})
    client.post(f"{PREFIX}/sources/{sid}/refresh")
    assert src()["error_count"] == 3
    assert "DNS went away" in src()["last_error"]
    # Cached articles survive the failures
    assert client.get(f"{PREFIX}/articles").json()["total"] == 2

    # Recovery resets the counter (and the 304 path does too)
    fake_fetch({"https://example.com/feed.xml": lambda h: ok(plugin, b"", status=304)})
    client.post(f"{PREFIX}/sources/{sid}/refresh")
    assert src()["error_count"] == 0
    assert src()["last_error"] is None
    assert src()["last_success_at"] is not None


def test_error_count_reset_on_200_too(plugin, client, fake_fetch):
    fake_fetch({"https://example.com/feed.xml": lambda h: ok(plugin)})
    sid = client.post(f"{PREFIX}/sources", json={"url": "https://example.com/feed.xml"}).json()["source"]["id"]
    fake_fetch({"https://example.com/feed.xml": lambda h: ok(plugin, b"err", status=500, ctype="text/plain")})
    client.post(f"{PREFIX}/sources/{sid}/refresh")
    fake_fetch({"https://example.com/feed.xml": lambda h: ok(plugin, RSS2.replace(b"Second", b"Second-v3"))})
    client.post(f"{PREFIX}/sources/{sid}/refresh")
    src = next(s for s in client.get(f"{PREFIX}/sources").json()["sources"] if s["id"] == sid)
    assert src["error_count"] == 0 and src["last_error"] is None


# --- Offline / DNS failure isolation (real _http_fetch, MockTransport) ------------

def test_offline_refresh_isolated_to_failing_source(plugin, client, fake_fetch):
    """DNS failure on one source does not affect the other; cached articles stay."""
    fake_fetch({
        "https://good.example/feed.xml": lambda h: ok(plugin),
        "https://gone.example/feed.xml": lambda h: ok(plugin, b"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Gone</title><entry>
<title>gone entry</title><id>g1</id><link rel="alternate" href="https://gone.example/e1"/></entry></feed>""", ctype="application/atom+xml"),
    })
    client.post(f"{PREFIX}/sources", json={"url": "https://good.example/feed.xml"})
    client.post(f"{PREFIX}/sources", json={"url": "https://gone.example/feed.xml"})

    # Simulate offline: every fetch raises a transport-level DNS failure.
    fake_fetch({
        "https://good.example/feed.xml": httpx.ConnectError("[Errno -2] Name or service not known"),
        "https://gone.example/feed.xml": httpx.ConnectError("[Errno -2] Name or service not known"),
    })
    r = client.post(f"{PREFIX}/refresh-all").json()
    assert all(x["ok"] is False for x in r["results"])
    assert all("network error" in x["error"] or "Name or service" in x["error"] for x in r["results"])

    sources = {s["id"]: s for s in client.get(f"{PREFIX}/sources").json()["sources"]}
    assert all(s["error_count"] == 1 for s in sources.values())
    assert all(s["enabled"] for s in sources.values())     # never auto-disabled
    # Cached articles remain readable while offline (2 RSS + 1 Atom)
    assert client.get(f"{PREFIX}/articles").json()["total"] == 3

    # Reconnect: next scheduled refresh resumes and recovers
    fake_fetch({
        "https://good.example/feed.xml": lambda h: ok(plugin, RSS2.replace(b"First", b"First-v9")),
        "https://gone.example/feed.xml": lambda h: ok(plugin),
    })
    r = client.post(f"{PREFIX}/refresh-all").json()
    assert all(x["ok"] is True for x in r["results"])
    sources = {s["id"]: s for s in client.get(f"{PREFIX}/sources").json()["sources"]}
    assert all(s["error_count"] == 0 and s["last_error"] is None for s in sources.values())


def test_timeout_failure_recorded_not_raised(plugin, client, fake_fetch):
    fake_fetch({"https://slow.example/feed": lambda h: ok(plugin)})
    client.post(f"{PREFIX}/sources", json={"url": "https://slow.example/feed"})
    fake_fetch({"https://slow.example/feed": httpx.ReadTimeout("timed out")})
    r = client.post(f"{PREFIX}/refresh-all").json()      # must not raise
    assert r["results"][0]["ok"] is False


# --- HTTP caching polish -----------------------------------------------------------

def test_200_identical_content_dedups_by_hash(plugin, client, fake_fetch):
    """No validators (no ETag/Last-Modified): a 200 returning byte-identical
    content must not duplicate rows — the global content-hash index dedups."""
    fake_fetch({"https://example.com/feed.xml": lambda h: ok(plugin)})  # no etag
    sid = client.post(f"{PREFIX}/sources", json={"url": "https://example.com/feed.xml"}).json()["source"]["id"]
    for _ in range(3):
        r = client.post(f"{PREFIX}/sources/{sid}/refresh").json()
        assert r["result"]["ok"] is True
        assert r["result"]["added"] == 0
    assert client.get(f"{PREFIX}/articles").json()["total"] == 2


def test_etag_last_modified_persisted_and_replayed(plugin, client, fake_fetch):
    calls: list[dict] = []

    def first(h):
        assert "If-None-Match" not in h and "If-Modified-Since" not in h
        return ok(plugin, headers={"etag": '"W/abc"', "last-modified": "Sun, 13 Sep 2026 12:00:00 GMT"})

    fake_fetch({"https://example.com/feed.xml": first})
    sid = client.post(f"{PREFIX}/sources", json={"url": "https://example.com/feed.xml"}).json()["source"]["id"]
    src = client.get(f"{PREFIX}/sources").json()["sources"][0]
    assert src["etag"] == '"W/abc"'
    assert src["last_modified"] == "Sun, 13 Sep 2026 12:00:00 GMT"

    def second(h):
        calls.append(dict(h))
        return ok(plugin, b"", status=304)

    fake_fetch({"https://example.com/feed.xml": second})
    r = client.post(f"{PREFIX}/sources/{sid}/refresh").json()
    assert r["result"]["not_modified"] is True
    assert calls[0]["If-None-Match"] == '"W/abc"'
    assert calls[0]["If-Modified-Since"] == "Sun, 13 Sep 2026 12:00:00 GMT"
    # 304 updated timestamps but touched no articles
    assert client.get(f"{PREFIX}/articles").json()["total"] == 2


# --- OPML JSON export twin ----------------------------------------------------------

def test_opml_export_json_matches_xml_route(plugin, client, fake_fetch):
    fake_fetch({"https://example.com/feed.xml": lambda h: ok(plugin)})
    client.post(f"{PREFIX}/sources", json={"url": "https://example.com/feed.xml", "name": "Evil \" & <name>"})
    raw = client.get(f"{PREFIX}/opml/export")
    js = client.get(f"{PREFIX}/opml/export.json")
    assert js.status_code == 200
    body = js.json()
    assert isinstance(body.get("xml"), str)
    assert body["xml"] == raw.text                  # identical document
    import xml.etree.ElementTree as ET
    ET.fromstring(body["xml"])                      # still valid OPML
    assert "&quot;" in body["xml"]                  # escaping preserved

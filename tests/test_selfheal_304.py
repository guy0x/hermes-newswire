"""304-on-empty self-heal: validators captured by an aborted first fetch
must not freeze a source at 0 articles forever.

Contract: refresh returning 304 for a source with no stored articles drops
etag/last_modified so the next refresh does a full fetch; a 304 for a source
WITH articles keeps the fast path (validators intact, no extra writes).
"""

from __future__ import annotations

from conftest import RSS2, outcome


PREFIX = "/api/plugins/hermes-newswire"


def test_304_on_empty_drops_validators(plugin, client, fake_fetch):
    url = "https://example.com/feed.xml"
    # First fetch: 200 with validators, but simulate the insert race by
    # having the feed parse fail AFTER etag capture is impossible here —
    # instead: add source where first fetch 200 (articles stored), then
    # delete articles directly to simulate the raced state, then 304.
    fake_fetch({url: lambda h: outcome(plugin, RSS2, headers={"etag": '"v1"', "last-modified": "Sat, 12 Sep 2026 00:00:00 GMT"})})
    r = client.post(f"{PREFIX}/sources", json={"url": url})
    assert r.status_code == 201
    sid = r.json()["source"]["id"]
    assert r.json()["articles_added"] > 0

    import sqlite3
    from pathlib import Path
    import os
    db = Path(os.environ["HERMES_HOME"]) / "state" / "newswire" / "newswire.db"
    conn = sqlite3.connect(db)
    conn.execute("DELETE FROM articles WHERE source_id=?", (sid,))
    # The raced state is NEVER-parsed: articles_ever must also be 0 (a
    # retention-pruned source keeps its validators — see test_o1_retention).
    conn.execute("UPDATE sources SET articles_ever=0 WHERE id=?", (sid,))
    conn.commit(); conn.close()

    # Now a 304 arrives for an article-less source → self-heal must fire.
    fake_fetch({url: lambda h: outcome(plugin, b"", status=304)})
    r2 = client.post(f"{PREFIX}/sources/{sid}/refresh").json()
    assert r2["result"].get("self_heal") or "self_heal" in r2["result"], r2

    src = client.get(f"{PREFIX}/sources").json()["sources"]
    me = [s for s in src if s["id"] == sid][0]
    assert me["etag"] is None and me["last_modified"] is None

    # Next refresh does a full fetch and stores articles again.
    fake_fetch({url: lambda h: outcome(plugin, RSS2)})
    r3 = client.post(f"{PREFIX}/sources/{sid}/refresh").json()
    assert r3["result"]["added"] > 0
    assert client.get(f"{PREFIX}/articles").json()["total"] > 0


def test_304_with_articles_keeps_fast_path(plugin, client, fake_fetch):
    url = "https://example.org/feed.xml"
    fake_fetch({url: lambda h: outcome(plugin, RSS2, headers={"etag": '"v9"'})})
    sid = client.post(f"{PREFIX}/sources", json={"url": url}).json()["source"]["id"]
    assert client.get(f"{PREFIX}/articles").json()["total"] > 0

    fake_fetch({url: lambda h: outcome(plugin, b"", status=304)})
    r2 = client.post(f"{PREFIX}/sources/{sid}/refresh").json()
    assert r2["result"]["not_modified"] is True
    assert "self_heal" not in r2["result"]
    me = [s for s in client.get(f"{PREFIX}/sources").json()["sources"] if s["id"] == sid][0]
    assert me["etag"] == '"v9"'

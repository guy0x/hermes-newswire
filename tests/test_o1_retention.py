"""O1 (QA re-gate): retention-pruned feeds must not self-heal-churn.

Contract: a source whose articles were parsed but ALL pruned by retention
(articles_ever > 0, current count 0) keeps the 304 fast path — no full
re-fetch loop. The heal only fires for genuinely-never-parsed sources.
"""

from __future__ import annotations

from conftest import RSS2, outcome


PREFIX = "/api/plugins/hermes-newswire"


def test_retention_pruned_feed_keeps_304_fast_path(plugin, client, fake_fetch):
    url = "https://example.com/feed.xml"
    fake_fetch({url: lambda h: outcome(plugin, RSS2, headers={"etag": '"v1"'})})
    r = client.post(f"{PREFIX}/sources", json={"url": url})
    assert r.status_code == 201
    sid = r.json()["source"]["id"]
    assert r.json()["articles_added"] > 0

    # All articles pruned by retention (simulate: max_article_age_hours tiny)
    client.patch(f"{PREFIX}/settings", json={"max_article_age_hours": 0})
    # age 0 = keep forever per docstring; force prune via direct retention call
    import os, sqlite3
    from pathlib import Path
    db = Path(os.environ["HERMES_HOME"]) / "state" / "newswire" / "newswire.db"
    conn = sqlite3.connect(db)
    conn.execute("DELETE FROM articles WHERE source_id=?", (sid,))
    conn.commit()
    ever = conn.execute("SELECT articles_ever FROM sources WHERE id=?", (sid,)).fetchone()[0]
    conn.close()
    assert ever > 0  # migration backfilled from live rows

    # 304 arrives → fast path, NO self-heal (articles_ever > 0), explanatory note
    fake_fetch({url: lambda h: outcome(plugin, b"", status=304)})
    r2 = client.post(f"{PREFIX}/sources/{sid}/refresh").json()
    assert r2["result"]["not_modified"] is True
    assert "self_heal" not in r2["result"]
    assert "retention" in r2["result"].get("note", "")
    me = [s for s in client.get(f"{PREFIX}/sources").json()["sources"] if s["id"] == sid][0]
    assert me["etag"] == '"v1"'  # validators intact — no churn
    assert "retention" in (me["last_error"] or "")  # explained in the UI


def test_never_parsed_source_still_heals(plugin, client, fake_fetch):
    url = "https://example.org/feed.xml"
    fake_fetch({url: lambda h: outcome(plugin, RSS2, headers={"etag": '"v2"'})})
    r = client.post(f"{PREFIX}/sources", json={"url": url})
    sid = r.json()["source"]["id"]

    # Simulate the raced state: articles wiped AND articles_ever reset
    import os, sqlite3
    from pathlib import Path
    db = Path(os.environ["HERMES_HOME"]) / "state" / "newswire" / "newswire.db"
    conn = sqlite3.connect(db)
    conn.execute("DELETE FROM articles WHERE source_id=?", (sid,))
    conn.execute("UPDATE sources SET articles_ever=0 WHERE id=?", (sid,))
    conn.commit(); conn.close()

    fake_fetch({url: lambda h: outcome(plugin, b"", status=304)})
    r2 = client.post(f"{PREFIX}/sources/{sid}/refresh").json()
    assert "self_heal" in r2["result"]

    fake_fetch({url: lambda h: outcome(plugin, RSS2)})
    r3 = client.post(f"{PREFIX}/sources/{sid}/refresh").json()
    assert r3["result"]["added"] > 0

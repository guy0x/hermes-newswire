"""F1 (QA HOLD): disabled sources must vanish from /articles.

Contract: PATCH enabled=false → its articles excluded from /articles until
re-enabled (cached rows stay in the DB — offline value). include_disabled_sources
opts in (Sources tab). Also F5: SSRF policy rejection is 400, not 502.
"""

from __future__ import annotations

from conftest import RSS2, outcome


PREFIX = "/api/plugins/hermes-newswire"


def _add(plugin, client, fake_fetch, feed_url="https://example.com/feed.xml", name="S"):
    fake_fetch({feed_url: lambda h: outcome(plugin, RSS2)})
    r = client.post(f"{PREFIX}/sources", json={"url": feed_url, "name": name})
    assert r.status_code == 201, r.text
    return r.json()["source"]["id"]


def test_disabled_source_hidden_from_articles(plugin, client, fake_fetch):
    sid = _add(plugin, client, fake_fetch)
    before = client.get(f"{PREFIX}/articles").json()
    assert before["total"] > 0

    r = client.patch(f"{PREFIX}/sources/{sid}", json={"enabled": False})
    assert r.status_code == 200

    after = client.get(f"{PREFIX}/articles").json()
    assert after["total"] == 0
    assert after["items"] == []

    # Opt-in restores visibility (Sources tab manages a disabled source's rows).
    opted = client.get(f"{PREFIX}/articles?include_disabled_sources=true").json()
    assert opted["total"] == before["total"]

    # Re-enable → articles return.
    client.patch(f"{PREFIX}/sources/{sid}", json={"enabled": True})
    restored = client.get(f"{PREFIX}/articles").json()
    assert restored["total"] == before["total"]


def test_disabled_source_hidden_with_filters(plugin, client, fake_fetch):
    sid = _add(plugin, client, fake_fetch)
    client.patch(f"{PREFIX}/sources/{sid}", json={"enabled": False})
    # the filter composes with unread/limit/source_id paths
    assert client.get(f"{PREFIX}/articles?unread=true").json()["total"] == 0
    assert client.get(f"{PREFIX}/articles?source_id={sid}").json()["total"] == 0


def test_unsafe_url_rejected_400_not_502(plugin, client):
    for url in ("http://127.0.0.1:9/x.xml", "http://169.254.169.254/meta"):
        r = client.post(f"{PREFIX}/sources", json={"url": url})
        assert r.status_code == 400, f"{url} → {r.status_code}"
        assert r.json()["detail"]["code"] == "unsafe_url"
        d = client.post(f"{PREFIX}/discover", json={"url": url})
        assert d.status_code == 400, f"{url} → {d.status_code}"
        assert d.json()["detail"]["code"] == "unsafe_url"

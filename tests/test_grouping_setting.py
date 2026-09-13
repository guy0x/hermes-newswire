"""ticker_grouping setting: newest | source | unread_first ordering modes."""

from __future__ import annotations


PREFIX = "/api/plugins/hermes-newswire"


def test_grouping_default_and_patch(plugin, client):
    s = client.get(f"{PREFIX}/settings").json()["settings"]
    assert s["ticker_grouping"] == "newest"
    r = client.patch(f"{PREFIX}/settings", json={"ticker_grouping": "source"})
    assert r.status_code == 200
    assert r.json()["settings"]["ticker_grouping"] == "source"
    r2 = client.patch(f"{PREFIX}/settings", json={"ticker_grouping": "unread_first"})
    assert r2.status_code == 200
    r3 = client.patch(f"{PREFIX}/settings", json={"ticker_grouping": "shuffle"})
    assert r3.status_code == 400
    assert client.patch(f"{PREFIX}/settings", json={"ticker_grouping": "newest"}).status_code == 200

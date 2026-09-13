"""open_article_behavior setting — internal preview vs external browser."""

from __future__ import annotations


PREFIX = "/api/plugins/hermes-newswire"


def test_open_behavior_default(plugin, client):
    s = client.get(f"{PREFIX}/settings").json()["settings"]
    assert s["open_article_behavior"] == "internal"


def test_open_behavior_patch_and_validate(plugin, client):
    r = client.patch(f"{PREFIX}/settings", json={"open_article_behavior": "external"})
    assert r.status_code == 200
    assert r.json()["settings"]["open_article_behavior"] == "external"
    r2 = client.patch(f"{PREFIX}/settings", json={"open_article_behavior": "incognito"})
    assert r2.status_code == 400
    # round-trip back
    assert client.patch(f"{PREFIX}/settings", json={"open_article_behavior": "internal"}).status_code == 200

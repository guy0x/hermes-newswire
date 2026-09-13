"""ticker_font_size setting — readability knob.

Contract: 9–20px integer, default 11; out-of-range/bad-type rejected with 400.
"""

from __future__ import annotations

PREFIX = "/api/plugins/hermes-newswire"


def test_font_size_default(plugin, client):
    s = client.get(f"{PREFIX}/settings").json()["settings"]
    assert s["ticker_font_size"] == 11


def test_font_size_patch_and_roundtrip(plugin, client):
    r = client.patch(f"{PREFIX}/settings", json={"ticker_font_size": 14})
    assert r.status_code == 200
    s = r.json()["settings"]
    assert s["ticker_font_size"] == 14
    s2 = client.get(f"{PREFIX}/settings").json()["settings"]
    assert s2["ticker_font_size"] == 14


def test_font_size_bounds(plugin, client):
    for ok_v in (9, 13, 20):
        assert client.patch(f"{PREFIX}/settings", json={"ticker_font_size": ok_v}).status_code == 200
    for bad in (8, 21, "big", None, 11.5):
        assert client.patch(f"{PREFIX}/settings", json={"ticker_font_size": bad}).status_code == 400

"""Favicon proxy (GET /icon.json) — issue #6 regression tests.

Renderer ``<img>`` favicon fetches bypass the pinned transport entirely (the
desktop SDK's ``rest`` door is JSON-only), so the backend now proxies icons
through the same SSRF gate + validated-IP pinning as feeds and returns a
``data:`` URL. These tests pin the policy: URL validation, content-type
allowlist, body cap, failure → null (never a raw pass-through), and caching.
"""

from __future__ import annotations

import base64

import pytest

from conftest import outcome

PREFIX = "/api/plugins/hermes-newswire"

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"0" * 32
EXPECTED_DATA_URL = "data:image/png;base64," + base64.b64encode(PNG_BYTES).decode("ascii")


@pytest.fixture
def no_dns_gate(plugin, monkeypatch):
    """Bypass the URL gate's DNS step for hostname URLs.

    The route re-validates through ``_assert_public_http_url_sync`` before the
    (already faked) fetch; with real DNS, offline test hostnames fail. The
    gate's own behavior is covered by test_http.py and by the two scheme /
    loopback tests below, which keep the REAL gate (those checks precede any
    DNS lookup, so they pass offline).
    """

    async def _allow(_url: str) -> None:
        return None

    monkeypatch.setattr(plugin, "_assert_public_http_url_sync", _allow)


def _png_outcome(plugin, ctype="image/png", body=PNG_BYTES, status=200):
    return outcome(plugin, body=body, status=status, ctype=ctype)


def test_icon_proxy_returns_data_url(plugin, client, fake_fetch, no_dns_gate):
    fake_fetch({"https://icons.example/a.png": lambda h: _png_outcome(plugin)})
    r = client.get(f"{PREFIX}/icon.json", params={"url": "https://icons.example/a.png"})
    assert r.status_code == 200
    assert r.json()["data_url"] == EXPECTED_DATA_URL


def test_icon_proxy_rejects_non_http_scheme(plugin, client, fake_fetch):
    r = client.get(f"{PREFIX}/icon.json", params={"url": "file:///etc/passwd"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "unsafe_url"


def test_icon_proxy_rejects_loopback(plugin, client, fake_fetch):
    # Literal loopback IP: blocked by the gate without any DNS lookup.
    ff = fake_fetch({})
    r = client.get(f"{PREFIX}/icon.json", params={"url": "http://127.0.0.1:9/icon.png"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "unsafe_url"
    assert ff.calls == []  # never reached the fetch layer


def test_icon_proxy_blocked_by_gate_during_fetch(plugin, client, fake_fetch, no_dns_gate):
    """A URL the pre-fetch gate approved but the pinned fetch rejects → 400."""
    fake_fetch({"https://icons.example/evil.png": plugin.UnsafeURL("rebind blocked")})
    r = client.get(f"{PREFIX}/icon.json", params={"url": "https://icons.example/evil.png"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "unsafe_url"


def test_icon_proxy_rejects_non_image_content_type(plugin, client, fake_fetch, no_dns_gate):
    """An HTML page served as 'icon' must never become a renderer data URL."""
    fake_fetch({"https://icons.example/page": lambda h: _png_outcome(plugin, ctype="text/html")})
    r = client.get(f"{PREFIX}/icon.json", params={"url": "https://icons.example/page"})
    assert r.status_code == 200
    assert r.json()["data_url"] is None


def test_icon_proxy_rejects_oversized_body(plugin, client, fake_fetch, no_dns_gate):
    big = PNG_BYTES + b"0" * (plugin.ICON_MAX_BODY_BYTES)
    fake_fetch({"https://icons.example/big.png": lambda h: _png_outcome(plugin, body=big)})
    r = client.get(f"{PREFIX}/icon.json", params={"url": "https://icons.example/big.png"})
    assert r.status_code == 200
    assert r.json()["data_url"] is None


def test_icon_proxy_non_200_yields_null(plugin, client, fake_fetch, no_dns_gate):
    fake_fetch({"https://icons.example/404.png": lambda h: _png_outcome(plugin, status=404)})
    r = client.get(f"{PREFIX}/icon.json", params={"url": "https://icons.example/404.png"})
    assert r.status_code == 200
    assert r.json()["data_url"] is None


def test_icon_proxy_fetch_exception_yields_null(plugin, client, fake_fetch, no_dns_gate):
    fake_fetch({"https://icons.example/down.png": RuntimeError("boom")})
    r = client.get(f"{PREFIX}/icon.json", params={"url": "https://icons.example/down.png"})
    assert r.status_code == 200
    assert r.json()["data_url"] is None


def test_icon_proxy_caches_within_ttl(plugin, client, fake_fetch, no_dns_gate):
    state = {"fetches": 0}

    def counting(_headers):
        state["fetches"] += 1
        return _png_outcome(plugin)

    fake_fetch({"https://icons.example/cached.png": counting})
    r1 = client.get(f"{PREFIX}/icon.json", params={"url": "https://icons.example/cached.png"})
    r2 = client.get(f"{PREFIX}/icon.json", params={"url": "https://icons.example/cached.png"})
    assert r1.json()["data_url"] == EXPECTED_DATA_URL
    assert r2.json() == r1.json()
    assert state["fetches"] == 1  # second hit served from the TTL cache


def test_icon_proxy_negative_results_are_cached_too(plugin, client, fake_fetch, no_dns_gate):
    """A failing icon must not turn into per-render refetch churn."""
    ff = fake_fetch({"https://icons.example/dead.png": RuntimeError("still down")})
    client.get(f"{PREFIX}/icon.json", params={"url": "https://icons.example/dead.png"})
    client.get(f"{PREFIX}/icon.json", params={"url": "https://icons.example/dead.png"})
    assert len(ff.calls) == 1

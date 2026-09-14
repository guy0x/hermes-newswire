"""HTTP policy tests: SSRF blocks, redirects, body cap, content-type rejection.

These exercise the real ``_http_fetch`` (not the fake) through an httpx
MockTransport injected at the ``_build_async_client`` seam, with DNS pinned
via the ``_resolve_host_sync`` seam. No real network is touched. (The
validation→connection boundary itself — DNS rebinding — is covered
adversarially in ``test_dns_pinning.py`` at the network-backend layer.)
"""

from __future__ import annotations

import httpx
import pytest

from conftest import RSS2


def install_transport(plugin, monkeypatch, handler, *, resolve=None):
    """Wire an httpx.MockTransport + deterministic DNS into the real fetcher.

    The mock client is flagged ``_newswire_mock_transport`` — the ONLY
    condition under which ``_http_fetch`` tolerates a missing pin backend
    (MockTransport never opens sockets, so there is nothing to pin). A
    production client without the pin backend fails closed instead.
    """
    def build():
        client = httpx.AsyncClient(
            follow_redirects=False,
            trust_env=False,
            timeout=httpx.Timeout(plugin.TOTAL_TIMEOUT, connect=plugin.CONNECT_TIMEOUT),
            headers={"User-Agent": plugin.USER_AGENT, "Accept": "*/*"},
            transport=httpx.MockTransport(handler),
        )
        client._newswire_mock_transport = True
        return client

    monkeypatch.setattr(plugin, "_build_async_client", build)
    if resolve is not None:
        monkeypatch.setattr(plugin, "_resolve_host_sync", lambda host: resolve)


PUBLIC = ["93.184.216.34"]          # example.com
EVIL_PRIVATE = ["10.0.0.5"]
DUAL = ["93.184.216.34", "169.254.169.254"]


@pytest.fixture
def fetched(plugin, monkeypatch):
    async def run(url: str):
        return await plugin._http_fetch(url)
    return run


# --- SSRF blocks ------------------------------------------------------------

@pytest.mark.anyio
async def test_plain_http_allowed(fetched, plugin, monkeypatch):
    install_transport(plugin, monkeypatch, lambda req: httpx.Response(200, content=RSS2),
                      resolve=PUBLIC)
    out = await fetched("https://example.com/feed.xml")
    assert out.status == 200
    assert out.body == RSS2


@pytest.mark.anyio
async def test_non_http_scheme_blocked(fetched, plugin, monkeypatch):
    install_transport(plugin, monkeypatch, lambda req: httpx.Response(200), resolve=PUBLIC)
    for url in ("file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/x"):
        with pytest.raises(plugin.UnsafeURL):
            await fetched(url)


@pytest.mark.anyio
async def test_loopback_blocked(fetched, plugin, monkeypatch):
    install_transport(plugin, monkeypatch, lambda req: httpx.Response(200), resolve=PUBLIC)
    with pytest.raises(plugin.UnsafeURL, match="non-public"):
        await fetched("http://127.0.0.1:8080/admin")


@pytest.mark.anyio
async def test_literal_private_ip_blocked(fetched, plugin, monkeypatch):
    install_transport(plugin, monkeypatch, lambda req: httpx.Response(200), resolve=PUBLIC)
    for url in (
        "http://10.1.2.3/feed",
        "http://192.168.1.1/feed",
        "http://172.16.0.9/feed",
        "http://169.254.169.254/latest/meta-data/",   # cloud metadata
        "http://100.64.0.1/feed",                      # CGNAT
        "http://0.0.0.0/feed",
        "http://[::1]/feed",
        "http://[fe80::1]/feed",                       # IPv6 link-local
    ):
        with pytest.raises(plugin.UnsafeURL):
            await fetched(url)


@pytest.mark.anyio
async def test_hostname_resolving_private_blocked(fetched, plugin, monkeypatch):
    install_transport(plugin, monkeypatch, lambda req: httpx.Response(200), resolve=EVIL_PRIVATE)
    with pytest.raises(plugin.UnsafeURL, match="non-public"):
        await fetched("https://rebind.example.com/feed")


@pytest.mark.anyio
async def test_dual_record_one_private_blocked(fetched, plugin, monkeypatch):
    """A DNS record mixed public+metadata must be blocked (pinning + mixed)."""
    install_transport(plugin, monkeypatch, lambda req: httpx.Response(200), resolve=DUAL)
    with pytest.raises(plugin.UnsafeURL):
        await fetched("https://mixed.example.com/feed")


@pytest.mark.anyio
async def test_unresolvable_host_blocked(fetched, plugin, monkeypatch):
    install_transport(plugin, monkeypatch, lambda req: httpx.Response(200), resolve=[])
    with pytest.raises(plugin.UnsafeURL, match="cannot resolve"):
        await fetched("https://nonexistent.example.invalid/feed")


# --- Redirects ---------------------------------------------------------------

def _redirector(redirect_map: dict[str, str]):
    def handler(request: httpx.Request) -> httpx.Response:
        target = redirect_map.get(str(request.url))
        if target:
            return httpx.Response(302, headers={"Location": target})
        return httpx.Response(200, content=RSS2)
    return handler


@pytest.mark.anyio
async def test_redirect_to_public_ok(fetched, plugin, monkeypatch):
    install_transport(plugin, monkeypatch,
                      _redirector({"https://example.com/old": "https://example.com/feed.xml"}),
                      resolve=PUBLIC)
    out = await fetched("https://example.com/old")
    assert out.status == 200
    assert out.url == "https://example.com/feed.xml"


@pytest.mark.anyio
async def test_redirect_to_private_blocked_before_fetch(fetched, plugin, monkeypatch):
    """Redirect targets are validated BEFORE following — the private hop is never requested."""
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if str(request.url) == "https://public.example/old":
            return httpx.Response(302, headers={"Location": "http://10.0.0.5/steal"})
        return httpx.Response(200)

    install_transport(plugin, monkeypatch, handler, resolve=PUBLIC)
    with pytest.raises(plugin.UnsafeURL):
        await fetched("https://public.example/old")
    assert all("10.0.0.5" not in r for r in requests)


@pytest.mark.anyio
async def test_redirect_chain_capped(fetched, plugin, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": str(request.url) + "x"})

    install_transport(plugin, monkeypatch, handler, resolve=PUBLIC)
    with pytest.raises(RuntimeError, match="too many redirects"):
        await fetched("https://example.com/loop")


@pytest.mark.anyio
async def test_redirect_without_location(fetched, plugin, monkeypatch):
    install_transport(plugin, monkeypatch, lambda req: httpx.Response(302), resolve=PUBLIC)
    with pytest.raises(RuntimeError, match="without Location"):
        await fetched("https://example.com/bad-redir")


# --- Body cap -----------------------------------------------------------------

@pytest.mark.anyio
async def test_body_cap_aborts_oversized(fetched, plugin, monkeypatch):
    big = b"x" * (plugin.MAX_BODY_BYTES + 1)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=big, headers={"Content-Length": str(len(big))})

    install_transport(plugin, monkeypatch, handler, resolve=PUBLIC)
    with pytest.raises(plugin.UnsafeURL, match="exceeds"):
        await fetched("https://example.com/huge")


# --- Non-feed content -----------------------------------------------------------

@pytest.mark.anyio
async def test_html_response_rejected_by_looks_like_feed(plugin):
    assert not plugin.looks_like_feed(
        b"<!doctype html><html><body>hello</body></html>", "text/html; charset=utf-8"
    )


# --- Timeout mapping --------------------------------------------------------------

@pytest.mark.anyio
async def test_timeout_maps_to_runtime_error(fetched, plugin, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("simulated connect timeout")

    install_transport(plugin, monkeypatch, handler, resolve=PUBLIC)
    with pytest.raises(RuntimeError, match="timeout"):
        await fetched("https://example.com/slow")


# --- anyio backend: asyncio only ----------------------------------------------------

@pytest.fixture
def anyio_backend():
    return "asyncio"

"""OPML export/import round-trip and /discover endpoint tests."""

from __future__ import annotations

from conftest import HTML_PAGE, RSS2, outcome

PREFIX = "/api/plugins/hermes-newswire"


def ok(plugin, body=RSS2, **kw):
    return outcome(plugin, body, **kw)


OPML_IN = """<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>subs</title></head>
  <body>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="Example" xmlUrl="https://example.com/feed.xml" htmlUrl="https://example.com/"/>
      <outline type="rss" text="Atom one" xmlUrl="https://atom.example/feed.atom"/>
    </outline>
  </body>
</opml>
"""


def test_opml_roundtrip(plugin, client, fake_fetch):
    responses = {
        "https://example.com/feed.xml": lambda h: ok(plugin),
        "https://atom.example/feed.atom": lambda h: ok(plugin, b"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom One</title><entry>
<title>e</title><id>i1</id><link rel="alternate" href="https://atom.example/e1"/></entry></feed>""", ctype="application/atom+xml"),
    }
    fake_fetch(responses)
    r = client.post(f"{PREFIX}/opml/import", json={"xml": OPML_IN})
    assert r.status_code == 200, r.text
    data = r.json()
    assert len(data["added"]) == 2
    assert data["skipped"] == [] and data["errors"] == []
    names = {a["name"] for a in data["added"]}
    assert names == {"Example", "Atom one"}  # OPML-provided labels win over feed titles

    # Export and re-import: everything skipped as duplicates
    export = client.get(f"{PREFIX}/opml/export")
    assert export.status_code == 200
    assert 'attachment; filename="hermes-newswire.opml"' in export.headers["content-disposition"]
    xml_out = export.text
    assert 'xmlUrl="https://example.com/feed.xml"' in xml_out
    assert 'htmlUrl="https://example.com/"' in xml_out
    assert xml_out.count("<outline ") >= 2

    r2 = client.post(f"{PREFIX}/opml/import", json={"xml": xml_out})
    assert r2.status_code == 200
    assert len(r2.json()["added"]) == 0
    assert sorted(r2.json()["skipped"]) == sorted([
        "https://example.com/feed.xml", "https://atom.example/feed.atom",
    ])


def test_opml_import_categories_and_errors(plugin, client, fake_fetch):
    opml = """<opml version="2.0"><body>
      <outline type="rss" text="A" xmlUrl="https://a.example/feed" category="news"/>
      <outline type="rss" text="B" xmlUrl="https://dead.example/feed"/>
      <outline type="rss" text="C" xmlUrl="file:///etc/passwd"/>
    </body></opml>"""
    fake_fetch({
        "https://a.example/feed": lambda h: ok(plugin),
        "https://dead.example/feed": RuntimeError("connection refused"),
    })
    r = client.post(f"{PREFIX}/opml/import", json={"xml": opml})
    assert r.status_code == 200
    data = r.json()
    assert [a["feed_url"] for a in data["added"]] == ["https://a.example/feed"]
    assert data["added"][0]["articles_added"] >= 1
    assert [e["feed_url"] for e in data["errors"]] == ["https://dead.example/feed"]
    src = client.get(f"{PREFIX}/sources").json()["sources"][0]
    assert src["category"] == "news"
    assert src["name"] == "A"


def test_opml_import_rejects_garbage(plugin, client):
    assert client.post(f"{PREFIX}/opml/import", json={"xml": "not xml <"}).status_code == 400
    assert client.post(f"{PREFIX}/opml/import", json={}).status_code == 400


def test_opml_export_escapes(plugin, client, fake_fetch):
    fake_fetch({"https://example.com/feed.xml": lambda h: ok(plugin)})
    client.post(f"{PREFIX}/sources", json={"url": "https://example.com/feed.xml", "name": 'Evil " & <name>'})
    xml_out = client.get(f"{PREFIX}/opml/export").text
    assert "&quot;" in xml_out and "&amp;" in xml_out and "&lt;" in xml_out
    # and it round-trips as valid XML
    import xml.etree.ElementTree as ET
    ET.fromstring(xml_out)


def test_discover_endpoint(plugin, client, fake_fetch):
    fake_fetch({
        "https://example.com/": lambda h: ok(plugin, HTML_PAGE, ctype="text/html"),
        "https://example.com/feed.xml": lambda h: ok(plugin),
    })
    r = client.post(f"{PREFIX}/discover", json={"url": "https://example.com/"})
    assert r.status_code == 200
    data = r.json()
    assert data["url"] == "https://example.com/"
    feed_entry = next(c for c in data["candidates"] if c["url"] == "https://example.com/feed.xml")
    assert feed_entry["is_feed"] is True
    assert feed_entry["title"] == "Example RSS2"
    assert feed_entry["format"] == "rss"


def test_discover_endpoint_common_paths(plugin, client, fake_fetch):
    responses = {"https://example.com/": lambda h: ok(plugin, b"<html><body>plain</body></html>", ctype="text/html")}
    for p in plugin.COMMON_FEED_PATHS:
        responses[f"https://example.com{p}"] = (lambda h: ok(plugin)) if p == "/feed" else (lambda h: ok(plugin, b"nope", status=404, ctype="text/plain"))
    ff = fake_fetch(responses)
    r = client.post(f"{PREFIX}/discover", json={"url": "https://example.com/"})
    assert r.status_code == 200
    cands = {c["url"]: c for c in r.json()["candidates"]}
    assert cands["https://example.com/feed"]["is_feed"] is True
    assert cands["https://example.com/rss.xml"]["is_feed"] is False

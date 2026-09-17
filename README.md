# Hermes Newswire

![Hermes Newswire](assets/hermes-newswire-hero.webp)

[![](https://img.shields.io/badge/X-%40tonysimons_-1DA1F2?style=for-the-badge&logo=x&logoColor=white)](https://x.com/tonysimons_)
[![Support the Project](https://img.shields.io/badge/Support_the_Project-X%20Money-black?style=for-the-badge&logo=x&logoColor=white)](https://x.com/tonysimons_)
[![](https://img.shields.io/badge/tonysimons.dev-111827?style=for-the-badge&logo=googlechrome&logoColor=white)](https://tonysimons.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-6c63ff?style=for-the-badge)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-119%20passed-brightgreen?style=for-the-badge)](#test--verify)
[![Zero API keys](https://img.shields.io/badge/zero-API%20keys-00d26a?style=for-the-badge)](#security)
[![No LLM tokens](https://img.shields.io/badge/routine%20ops-no%20model%20tokens-00d26a?style=for-the-badge)](#security)

A breaking-news ticker plugin for [Hermes Desktop](https://hermes-agent.nousresearch.com) — a thin, continuously scrolling newswire strip docked just above the statusbar, backed by a model-free RSS/Atom/JSON-Feed engine.

```
NEWSWIRE ◆ Hacker News: Why is Google still serving dodgy ads? · 56m ◆ The Verge: Apple is reportedly working on… · 14m ◆ …
```

## What it is

- **Bottom ticker strip** — a 28–40px pane docked to the workspace's bottom edge (above the statusbar, never covering it). Continuous marquee, hover-pause, clickable headlines that open in your default browser, source + relative age per story, reduced-motion fallback (static rotating headline), keyboard accessible.
- **Newswire page** (`/newswire`, sidebar row, ⌘K commands) — Latest list with search/filter/unread/mark-read, Sources management with feed discovery (paste `https://www.theverge.com`, get its feed), Settings.
- **Zero LLM usage** — feed retrieval, parsing, dedup, storage, and rendering consume no model tokens and need no API keys.
- **Offline-friendly** — SQLite cache keeps the ticker alive when the network is down; refresh resumes silently on reconnect.

## Install (unified plugin)

```bash
git clone https://github.com/tony-simons-aiowa/hermes-newswire ~/.hermes/plugins/hermes-newswire/
# enable the backend (plugins.enabled must be a real YAML list):
#   edit ~/.hermes/config.yaml → plugins: enabled: [- hermes-newswire]
# restart the desktop's serve child (or restart Hermes Desktop) so the
# backend mounts; the renderer half is lifted automatically:
#   ~/.hermes/desktop-plugins/hermes-newswire/plugin.js
```

Verify: `Mounted plugin API routes: /api/plugins/hermes-newswire/` in `~/.hermes/logs/agent.log`.

### Install & security scan (FAQ)

`hermes plugins install` runs a security scan. This plugin installs with a
**caution** verdict: the scan deliberately inspects test files (hostile
fixtures prove the SSRF gate rejects `file://` and loopback URLs — see
`tests/test_engine.py`, `tests/test_http.py`) and README install commands
(`git clone`, `~/.hermes/config.yaml`). None of it is runtime behavior.

- **CLI:** the installer prints the findings and asks `Install anyway?
  [y/N]` — answer `y` (or run `hermes plugins install <repo> --force`).
  `dangerous` verdicts are never installable; caution is a confirm gate.
- **Desktop/dashboard Plugins page:** the GUI has **no review prompt** —
  the install endpoint accepts no decision callback, so a caution verdict
  is refused outright with the full findings list. Use the CLI for the
  interactive confirm (upstream gap; see TROUBLESHOOTING).

## Troubleshooting

**"Settings does nothing" / "clicking a starter feed does nothing"**
The page needs the plugin backend. Checks, in order:
1. Is the plugin in `plugins.enabled` in `~/.hermes/config.yaml`?
2. Did the serve child restart *after* install? (`hermes gateway restart`,
   or restart Hermes Desktop). The ticker can render from cache while the
   management API 404s.
3. Open Settings or Sources: a red banner now names the exact failure and
   the fix. Starter-feed clicks surface the backend's error inline
   (e.g. `VentureBeat AI could not be added: HTTP 429 fetching …` — some
   publishers bot-block the first fetch; try again or use Discover).

**Installing reports `Security scan blocked plugin install`** — see the
install FAQ above; confirm through the CLI prompt.

## Layout

```
dashboard/          backend  (FastAPI router → /api/plugins/hermes-newswire/)
  manifest.json     name/label/version/api pointer
  plugin_api.py     feed engine, SQLite store, refresh loop, routes
desktop/            renderer (plain ESM plugin.js, loaded uncompiled)
tests/              pytest suite (fixtures only — no live sites)
```

## Supported formats & discovery

RSS 2.0, RSS 1.0/RDF, Atom, JSON Feed. Discovery: `<link rel="alternate">` tags first, then well-known paths (`/feed`, `/rss.xml`, `/atom.xml`, …). Direct feed URLs skip discovery.

## Security

Source URLs are untrusted: http/https only (no file/ftp), loopback/private/link-local/CGNAT/metadata addresses blocked (literal, hex/octal legacy forms, AND post-DNS resolution), redirects validated per hop (max 3), 5s connect / 15s total timeouts, 5 MB body cap, all feed HTML stripped before storage. OPML import validates every URL through the same gates. No telemetry, no remote service, no secrets.

**Favicons are proxied** (`GET /icon.json?url=…`): the backend fetches icons
through the same SSRF gate + validated-IP pinning as feeds and returns a
base64 data URL (image content-type allowlist, 64 KB cap, 24 h TTL cache,
failures return `data_url: null` plus an `error` reason — never raw bytes).
The renderer's `<img>` tags therefore never resolve attacker-controlled
hostnames directly; the desktop SDK exposes no raw-byte door a plugin could
use to fetch binaries itself (upstream seam gap worth closing generically).

## Settings

Ticker enabled · scroll speed · **text size 9–20px** (strip height follows) · pause on hover · show source · relative time · only-unread · max article age · max headlines · refresh interval (30s–24h, default 5min). Conditional GETs (ETag/Last-Modified → 304) keep polling cheap.

## Test & verify

```bash
env -u PYTHONPATH ~/.hermes/hermes-agent/venv/bin/python -m pytest tests/ -q
node --check desktop/plugin.js
node tests/ui/esm-render.mjs        # stateless render smoke (26 checks)
node tests/ui/interaction.mjs       # stateful interaction tests (29 checks)
```

## Agent-friendly development

Coding agents (Hermes, Codex, Claude Code, Cursor, …) start with the root
[`AGENTS.md`](AGENTS.md) — architecture map, critical invariants, exact
verification commands, and a definition of done. The deep reference is
[`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md) (data flow, security model,
safe-change recipes).

Quick gates before any PR: `env -u PYTHONPATH <hermes-venv>/bin/python -m pytest tests/ -q` ·
`node --check desktop/plugin.js` · `hermes plugins validate . --json`.

## Status

v0.1.0 — feature-complete (backend, page, ticker, hardening, search, favicons, grouping) with an independent QA-gated history. 119-test suite + ESM render smoke. Built as a standalone unified plugin against the Hermes Desktop plugin SDK (catalog submission pending).

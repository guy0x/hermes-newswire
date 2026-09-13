/**
 * Hermes Newswire — breaking-news ticker + newswire page.
 *
 * Unified agent+desktop package (electron/desktop-plugins-root.ts):
 *   SOURCE     ~/.hermes/plugins/hermes-newswire/desktop/plugin.js  (this file)
 *   app copy   ~/.hermes/desktop-plugins/hermes-newswire/plugin.js
 *              + .hermes-package.json marker (materialized by the app)
 *   backend    ~/.hermes/plugins/hermes-newswire/dashboard/plugin_api.py
 *              mounted at /api/plugins/hermes-newswire/ (plugins.enabled).
 *
 * Surfaces:
 *   - Bottom pane strip: continuous scrolling headlines in a thin (28px)
 *     persistent strip docked to the workspace's bottom edge — sits above
 *     the statusbar, inserts one layout row, never overlaps other panes.
 *   - ROUTES_AREA /newswire page: Latest / Sources / Settings.
 *   - SIDEBAR_NAV_AREA row + 5 PALETTE_AREA commands.
 *
 * Zero LLM usage: the renderer reads normalized cached state from the plugin
 * backend (SQLite), which alone performs feed polling. Feed HTML never reaches
 * this file — the backend strips tags/entities before storage; the renderer
 * only ever renders plain-text fields as React text children.
 *
 * Plain ESM loaded uncompiled: UI is jsx() calls, NOT JSX syntax; only
 * @hermes/plugin-sdk, react, react/jsx-runtime resolve.
 */

import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  GlyphSpinner,
  host,
  Input,
  PALETTE_AREA,
  ROUTES_AREA,
  ScrollArea,
  SearchField,
  SegmentedControl,
  Separator,
  SIDEBAR_NAV_AREA,
  Switch,
  atom,
  queryClient,
  useMutation,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef, useState } from 'react'

const ID = 'hermes-newswire'
const PAGE_PATH = '/newswire'

// Assigned in register(ctx) — components can't see ctx directly.
let rest = null
let openExternalFn = null
let applyTickerSettingsFn = null
let storageGet = null
let storageSet = null

// Renderer-owned ticker state (this window's presentation, not engine truth).
const $tickerPaused = atom(false)
// Palette "Add Source" signals the page to open the Sources tab + focus add.
const $addSourceSignal = atom(0)
let addFocusArmed = false

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const SPEED_DURATIONS = { slow: 240, normal: 150, fast: 80 } // seconds per loop (slowed ~2.5x on Tony's read-feedback)
const ROTATE_MS = 8000 // reduced-motion: static headline rotation
const TICKER_POLL_MS = 30_000
const PAGE_POLL_MS = 60_000

// Backend setting ranges (dashboard/plugin_api.py):
//   max_article_age_hours: int >= 0 (0 = keep forever)
//   max_headlines: int >= 0 (0 = keep everything)
//   refresh_interval: int in [30, 86400] seconds
const AGE_OPTIONS = [
  { id: '0', label: 'All' }, { id: '6', label: '6h' }, { id: '12', label: '12h' },
  { id: '24', label: '1d' }, { id: '72', label: '3d' }, { id: '168', label: '7d' }, { id: '720', label: '30d' }
]
const LIMIT_OPTIONS = [
  { id: '50', label: '50' }, { id: '100', label: '100' }, { id: '200', label: '200' },
  { id: '500', label: '500' }, { id: '0', label: 'All' }
]
const INTERVAL_OPTIONS = [
  { id: '60', label: '1m' }, { id: '120', label: '2m' }, { id: '300', label: '5m' },
  { id: '600', label: '10m' }, { id: '900', label: '15m' }, { id: '1800', label: '30m' }, { id: '3600', label: '1h' }
]
const SPEED_OPTIONS = [
  { id: 'slow', label: 'Slow' }, { id: 'normal', label: 'Normal' }, { id: 'fast', label: 'Fast' }
]
const FONT_OPTIONS = [
  { id: '9', label: '9' }, { id: '10', label: '10' }, { id: '11', label: '11' }, { id: '12', label: '12' },
  { id: '13', label: '13' }, { id: '14', label: '14' }, { id: '16', label: '16' }, { id: '18', label: '18' }
]
// Strip height follows the font so larger text never clips: a comfortable
// px gap above the tallest glyph (cap-height + descender + breathing room).
const fontToHeight = px => Math.max(28, Math.round(px * 2.1) + 6)

// First-run suggestions — OFFERED only, never auto-added. Neutral, stable,
// public feeds; no political bundles.
const STARTER_FEEDS = [
  { name: 'Hacker News', feed_url: 'https://hnrss.org/frontpage', category: 'developer' },
  { name: 'Ars Technica', feed_url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'technology' },
  { name: 'The Verge', feed_url: 'https://www.theverge.com/rss/index.xml', category: 'technology' },
  { name: 'NASA News', feed_url: 'https://www.nasa.gov/news-release/feed/', category: 'science' },
  { name: 'TechCrunch', feed_url: 'https://techcrunch.com/feed/', category: 'technology' },
  { name: 'VentureBeat AI', feed_url: 'https://venturebeat.com/category/ai/feed/', category: 'ai' }
]

// ─────────────────────────────────────────────────────────────────────────
// Styles (content-compared, hot-reload safe)
// ─────────────────────────────────────────────────────────────────────────

function ensureStyles() {
  const css = [
    /* Ticker strip — pane body is our root: own the full box. */
    `.${ID}-ticker { display: flex; align-items: center; width: 100%; height: 100%; min-width: 0; overflow: hidden; background: var(--ui-bg-sidebar, var(--ui-bg-secondary)); border-top: 1px solid var(--ui-stroke-secondary); }`,
    `.${ID}-brand { display: inline-flex; align-items: center; gap: 0.25rem; flex: none; height: 100%; padding: 0 0.5rem; font-size: 0.625rem; font-weight: 700; letter-spacing: 0.08em; color: var(--ui-accent); cursor: pointer; user-select: none; background: none; border: 0; font-family: inherit; }`,
    `.${ID}-brand:hover { background: var(--chrome-action-hover); }`,
    `.${ID}-viewport { flex: 1 1 0%; min-width: 0; height: 100%; overflow: hidden; }`,
    `.${ID}-track { display: flex; width: max-content; height: 100%; align-items: center; }`,
    `.${ID}-half { display: inline-flex; align-items: center; white-space: nowrap; }`,
    `.${ID}-item { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0 1rem; height: 100%; background: none; border: 0; font: inherit; font-size: var(--nw-font, 11px); line-height: 1; color: var(--ui-text-tertiary); cursor: pointer; text-decoration: none; white-space: nowrap; }`,
    `.${ID}-item:hover { background: var(--chrome-action-hover); color: var(--ui-text-primary); }`,
    `.${ID}-item:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: -1px; }`,
    `.${ID}-item[data-read="1"] .${ID}-headline { color: var(--ui-text-quaternary); }`,
    `.${ID}-src { color: var(--ui-text-quaternary); }`,
    `.${ID}-dot { color: var(--ui-accent); flex: none; }`,
    `.${ID}-age { color: var(--ui-text-quaternary); flex: none; }`,
    `.${ID}-marquee { animation: ${ID}-scroll var(--nw-duration, 55s) linear infinite; }`,
    `.${ID}-ticker:not(.${ID}-no-hover):hover .${ID}-marquee, .${ID}-ticker[data-paused="1"] .${ID}-marquee { animation-play-state: paused; }`,
    `@keyframes ${ID}-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }`,
    `@media (prefers-reduced-motion: reduce) { .${ID}-marquee { animation: none; } }`,
    `.${ID}-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }`,
    `.${ID}-tabs { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 1rem; border-bottom: 1px solid var(--ui-stroke-secondary); flex: none; flex-wrap: wrap; }`,
    `.${ID}-tab { background: none; border: 0; padding: 0.25rem 0.5rem; font-size: 0.8125rem; color: var(--ui-text-secondary); cursor: pointer; border-radius: 0.25rem; font-family: inherit; }`,
    `.${ID}-tab[data-active="1"] { color: var(--ui-text-primary); background: var(--ui-bg-tertiary); font-weight: 600; }`,
    `.${ID}-tab:hover { color: var(--ui-text-primary); }`,
    `.${ID}-scrollwrap { flex: 1 1 0%; min-height: 0; }`,
    `.${ID}-list { display: flex; flex-direction: column; }`,
    `.${ID}-row { display: flex; gap: 0.75rem; padding: 0.625rem 1rem; border-bottom: 1px solid var(--ui-stroke-tertiary, var(--ui-stroke-secondary)); align-items: flex-start; }`,
    `.${ID}-row:hover { background: var(--ui-bg-tertiary); }`,
    `.${ID}-row[data-read="1"] .${ID}-rowtitle { color: var(--ui-text-tertiary); }`,
    `.${ID}-rowmain { flex: 1 1 0%; min-width: 0; display: flex; flex-direction: column; gap: 0.25rem; }`,
    `.${ID}-rowtitle { font-size: 0.875rem; line-height: 1.3; color: var(--ui-text-primary); }`,
    `.${ID}-rowsum { font-size: 0.75rem; line-height: 1.4; color: var(--ui-text-secondary); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }`,
    `.${ID}-meta { display: flex; gap: 0.5rem; align-items: center; font-size: 0.6875rem; color: var(--ui-text-quaternary); flex-wrap: wrap; }`,
    `.${ID}-srcrow { display: flex; align-items: center; gap: 0.75rem; padding: 0.625rem 1rem; border-bottom: 1px solid var(--ui-stroke-tertiary, var(--ui-stroke-secondary)); }`,
    `.${ID}-srcrow:hover { background: var(--ui-bg-tertiary); }`,
    `.${ID}-err { font-size: 0.6875rem; color: var(--ui-red, #e5484d); }`,
    `.${ID}-card { margin: 1rem; padding: 1rem; border: 1px solid var(--ui-stroke-secondary); border-radius: 0.5rem; display: flex; flex-direction: column; gap: 0.75rem; background: var(--ui-bg-card); }`,
    `.${ID}-setrow { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.375rem 0; }`,
    `.${ID}-setlabel { font-size: 0.8125rem; color: var(--ui-text-secondary); }`,
    `.${ID}-setgroup { font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ui-text-quaternary); margin: 0.75rem 0 0.25rem; }`,
    `.${ID}-chips { display: flex; flex-wrap: wrap; gap: 0.5rem; }`,
    `.${ID}-chip { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.25rem 0.625rem; border: 1px solid var(--ui-stroke-secondary); border-radius: 999px; font-size: 0.75rem; color: var(--ui-text-secondary); cursor: pointer; background: none; font-family: inherit; }`,
    `.${ID}-chip:hover { border-color: var(--ui-accent); color: var(--ui-text-primary); }`,
    `.${ID}-cand { display: flex; align-items: center; gap: 0.5rem; padding: 0.375rem 0.5rem; border: 1px solid var(--ui-stroke-tertiary, var(--ui-stroke-secondary)); border-radius: 0.375rem; cursor: pointer; font-size: 0.75rem; color: var(--ui-text-secondary); background: none; font-family: inherit; text-align: left; width: 100%; }`,
    `.${ID}-cand[data-picked="1"] { border-color: var(--ui-accent); color: var(--ui-text-primary); }`,
    `.${ID}-pager { display: flex; align-items: center; gap: 0.5rem; justify-content: center; padding: 0.75rem; }`,
    /* Keyboard a11y: every plugin-owned button (tabs, brand, chips, candidates,
       page-row titles) gets a visible focus ring built from theme vars. */
    `.${ID}-page button:focus-visible, .${ID}-ticker button:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: -1px; }`,
    `.${ID}-page select:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: 1px; }`
  ].join('\n')
  let style = document.getElementById(`${ID}-styles`)
  if (!style) {
    style = document.createElement('style')
    style.id = `${ID}-styles`
    document.head.appendChild(style)
  }
  if (style.textContent !== css) {
    style.textContent = css
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function relTime(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function absTime(iso) {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  return t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// The bridge surfaces backend HTTPException details as "409: {"detail":...}" —
// pull the human message out of the JSON blob when it's there.
function errText(e) {
  const raw = String(e?.message || e || '')
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)
  if (m) {
    try { return JSON.parse(`"${m[1]}"`) } catch { /* fall through */ }
  }
  return raw.slice(0, 300)
}

async function openArticle(url, articleId) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
  try { await openExternalFn(url) } catch { /* result-shaped; ignore */ }
  if (articleId != null) {
    try {
      await rest(`/articles/${articleId}/read`, { method: 'POST', body: { read: true } })
      queryClient.invalidateQueries({ queryKey: [ID] })
    } catch { /* non-fatal */ }
  }
}

// "Ask Hermes about this" — official SDK path: host.request is the gateway
// JSON-RPC door (same one the app itself uses) and prompt.submit is the
// documented submit method. Sends into the FOCUSED chat session.
async function askHermes(a) {
  const prompt = `Summarize this article and tell me why it matters:\n\n${a.title || '(untitled)'}\n${a.canonical_url || ''}`
  const sid = host.state?.focusedSessionId?.get?.() || host.state?.activeSessionId?.get?.() || null
  try {
    if (!sid) throw new Error('No active chat session')
    if (host.state?.busyBySession?.get?.()?.[sid]) {
      host.notify({ kind: 'info', message: 'Chat is busy — try again when the current turn finishes.' })
      return
    }
    const out = await host.request('prompt.submit', { session_id: sid, text: prompt })
    if (out && typeof out === 'object' && out.status && out.status !== 'streaming') {
      throw new Error(`Unexpected submit status: ${out.status}`)
    }
    host.notify({ kind: 'success', message: 'Asked Hermes — see the chat.' })
  } catch (e) {
    host.notifyError(e, 'Could not send to chat')
  }
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  )
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = e => setReduced(e.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

// One shared minute tick so relative ages refresh without per-row timers.
function useAgeTick(ms = 30_000) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

// ─────────────────────────────────────────────────────────────────────────
// Shared data hooks (unwrapped backend envelopes)
// ─────────────────────────────────────────────────────────────────────────

function useSettings() {
  const q = useQuery({
    queryKey: [ID, 'settings'],
    queryFn: async () => ((await rest('/settings')) || {}).settings || null,
    refetchInterval: TICKER_POLL_MS,
    staleTime: 15_000,
    retry: 1
  })
  return [q, q.data]
}

function useSources() {
  const q = useQuery({
    queryKey: [ID, 'sources'],
    queryFn: async () => ((await rest('/sources')) || {}).sources || [],
    refetchInterval: PAGE_POLL_MS,
    staleTime: 10_000,
    retry: 1
  })
  return [q, Array.isArray(q.data) ? q.data : []]
}

// ─────────────────────────────────────────────────────────────────────────
// Ticker (statusbar)
// ─────────────────────────────────────────────────────────────────────────

function TickerItem({ a, settings }) {
  const age = settings?.relative_time !== false ? relTime(a.published_at) : ''
  return jsx('button', {
    className: `${ID}-item`,
    'data-read': a.read ? '1' : '0',
    title: `${a.source_name} — ${a.title}`,
    'aria-label': `${a.source_name}: ${a.title}${age ? ` (${age})` : ''} — activate to open, or right-click / long-press to ask Hermes`,
    onClick: () => void openArticle(a.canonical_url || '', a.id),
    onContextMenu: e => {
      e.preventDefault()
      void askHermes(a)
    },
    children: jsxs('span', {
      style: { display: 'inline-flex', alignItems: 'center', gap: '0.375rem' },
      children: [
        jsx('span', { className: `${ID}-dot`, children: '◆' }),
        settings?.show_source !== false ? jsx('span', { className: `${ID}-src`, children: `${a.source_name}:` }) : null,
        jsx('span', { className: `${ID}-headline`, children: a.title }),
        age ? jsx('span', { className: `${ID}-age`, children: `· ${age}` }) : null
      ]
    })
  })
}

function TickerHalf({ articles, settings }) {
  return jsx('div', {
    className: `${ID}-half`,
    'aria-hidden': 'true',
    children: articles.map(a => jsx(TickerItem, { a, settings }, `h${a.id}`))
  })
}

function NewswireTicker() {
  const [settingsQ, settings] = useSettings()
  const paused = useValue($tickerPaused)
  const enabled = settings ? settings.ticker_enabled !== false : false
  const duration = SPEED_DURATIONS[settings?.ticker_speed] || 150

  const articlesQ = useQuery({
    queryKey: [ID, 'ticker', settings?.only_unread === true],
    queryFn: async () => {
      const unread = settings?.only_unread === true ? '&unread=1' : ''
      const out = await rest(`/articles?limit=50&include_summary=false${unread}`)
      return Array.isArray(out?.items) ? out.items : []
    },
    refetchInterval: TICKER_POLL_MS,
    staleTime: TICKER_POLL_MS - 5_000,
    retry: false
  })
  const reduced = useReducedMotion()
  useAgeTick()
  const fontSizePx = Math.min(20, Math.max(9, Number(settings?.ticker_font_size) || 11))
  const articles = useMemo(() => (paused ? [] : articlesQ.data || []), [settings, articlesQ.data, paused])

  // Pane height tracks the font setting from ANY settings refresh (poll,
  // UI save, or another surface). applyTickerSettings is idempotent on
  // unchanged shape (guarded by lastPaneKey) — the ticker's own remount
  // re-runs this effect but the second call is a no-op, so no loop.
  useEffect(() => {
    if (settings && applyTickerSettingsFn) applyTickerSettingsFn(settings)
  }, [settings?.ticker_font_size, settings?.ticker_enabled])

  // Reduced motion: rotate ONE static headline instead of a marquee.
  const [rotIdx, setRotIdx] = useState(0)
  useEffect(() => {
    if (!reduced || articles.length === 0) return
    const t = setInterval(() => setRotIdx(i => (i + 1) % articles.length), ROTATE_MS)
    return () => clearInterval(t)
  }, [reduced, articles.length])

  if (!enabled) return null
  if (settingsQ.isLoading && !settings) {
    return jsx('div', { className: `${ID}-ticker`, style: { '--nw-font': `${fontSizePx}px` }, children: jsx('span', { className: `${ID}-brand`, children: 'NEWSWIRE' }) })
  }
  if (articles.length === 0) {
    return jsxs('div', {
      className: `${ID}-ticker`,
      style: { '--nw-font': `${fontSizePx}px` },
      role: 'region',
      'aria-label': 'Newswire ticker',
      children: [
        jsx('button', {
          className: `${ID}-brand`,
          onClick: () => host.navigate(PAGE_PATH),
          title: 'Open Newswire',
          children: 'NEWSWIRE'
        }),
        jsx('button', {
          className: `${ID}-item`,
          onClick: () => host.navigate(PAGE_PATH),
          children: paused ? 'Ticker paused' : 'Add a news source →'
        })
      ]
    })
  }

  const content = reduced
    ? jsx('div', { className: `${ID}-viewport`, children: jsx(TickerItem, { a: articles[rotIdx % articles.length], settings }) })
    : jsx('div', { className: `${ID}-viewport`, children:
        jsx('div', {
          className: `${ID}-track ${ID}-marquee`,
          style: { '--nw-duration': `${duration}s` },
          children: [
            jsx(TickerHalf, { articles, settings, key: 'a' }),
            jsx(TickerHalf, { articles, settings, key: 'b' })
          ]
        })})

  return jsxs('div', {
    className: `${ID}-ticker${settings?.pause_on_hover === false ? ` ${ID}-no-hover` : ''}`,
    'data-paused': paused ? '1' : '0',
    role: 'region',
    'aria-label': 'Newswire ticker',
    style: { '--nw-font': `${fontSizePx}px` },
    children: [
      jsx('button', {
        className: `${ID}-brand`,
        onClick: () => host.navigate(PAGE_PATH),
        title: 'Open Newswire',
        children: 'NEWSWIRE'
      }),
      content
    ]
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Page — Latest
// ─────────────────────────────────────────────────────────────────────────

function ArticleRow({ a }) {
  return jsxs('div', { className: `${ID}-row`, 'data-read': a.read ? '1' : '0', children: [
    jsx('div', {
      className: `${ID}-rowmain`,
      children: [
        jsx('button', {
          className: `${ID}-rowtitle`,
          style: { textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit' },
          title: a.canonical_url || '',
          onClick: () => void openArticle(a.canonical_url || '', a.id),
          children: a.title || '(untitled)'
        }),
        a.summary ? jsx('div', { className: `${ID}-rowsum`, children: a.summary }) : null,
        jsxs('div', { className: `${ID}-meta`, children: [
          jsx('span', { children: a.source_name }),
          a.read ? jsx('span', { children: '· read' }) : null,
          jsx('span', { title: absTime(a.published_at), children: relTime(a.published_at) || '—' })
        ]})
      ]
    }),
    jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 'none' }, children: [
      jsx(Button, {
        size: 'xs', variant: 'ghost',
        onClick: () => void openArticle(a.canonical_url || '', a.id),
        children: 'Open'
      }),
      jsx(Button, {
        size: 'xs', variant: 'ghost',
        title: 'Send this headline to the focused Hermes chat',
        onClick: () => void askHermes(a),
        children: 'Ask…'
      }),
      jsx(Button, {
        size: 'xs', variant: 'ghost',
        onClick: async () => {
          try {
            await rest(`/articles/${a.id}/read`, { method: 'POST', body: { read: !a.read } })
            queryClient.invalidateQueries({ queryKey: [ID] })
          } catch { /* surfaced by refetch */ }
        },
        children: a.read ? 'Unread' : 'Read'
      })
    ]})
  ]})
}

const PAGE_SIZE = 50

function LatestTab({ sources, prefs, setPrefs }) {
  const [q, setQ] = useState(prefs.search || '')
  const [sourceId, setSourceId] = useState(prefs.sourceId || 'all')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [offset, setOffset] = useState(0)
  useAgeTick(60_000)

  // Client-side search over fetched pages (backend has no q param); debounce.
  const [debouncedQ, setDebouncedQ] = useState(q)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250)
    return () => clearTimeout(t)
  }, [q])

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
  if (sourceId !== 'all') params.set('source_id', sourceId)
  if (unreadOnly) params.set('unread', '1')

  const arts = useQuery({
    queryKey: [ID, 'articles', sourceId, unreadOnly, offset],
    queryFn: () => rest(`/articles?${params.toString()}`),
    refetchInterval: PAGE_POLL_MS,
    staleTime: 15_000,
    retry: 1
  })

  const markAll = useMutation({
    mutationFn: () => rest('/articles/read-all', { method: 'POST', body: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [ID] })
  })

  const fetched = Array.isArray(arts.data?.items) ? arts.data.items : []
  const needle = debouncedQ.trim().toLowerCase()
  const list = needle
    ? fetched.filter(a =>
        (a.title || '').toLowerCase().includes(needle) ||
        (a.summary || '').toLowerCase().includes(needle) ||
        (a.source_name || '').toLowerCase().includes(needle))
    : fetched
  const total = arts.data?.total ?? 0

  // Persist the last filter for next visit (UI pref, ctx.storage).
  useEffect(() => {
    setPrefs({ search: q, sourceId })
  }, [q, sourceId]) // eslint-disable-line react-hooks/exhaustive-deps

  return jsxs('div', { className: `${ID}-page`, children: [
    jsxs('div', { className: `${ID}-tabs`, children: [
      jsx(SearchField, {
        value: q,
        onChange: v => { setQ(typeof v === 'string' ? v : v?.target?.value ?? ''); setOffset(0) },
        placeholder: 'Search headlines…',
        containerClassName: 'w-64'
      }),
      jsx('select', {
        value: sourceId,
        onChange: e => { setSourceId(e.target.value); setOffset(0) },
        'aria-label': 'Filter articles by source',
        className: 'rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-xs text-(--ui-text-secondary)',
        children: [jsx('option', { value: 'all', children: 'All sources' })].concat(
          sources.map(s => jsx('option', { value: String(s.id), children: s.name }, s.id))
        )
      }),
      jsxs('label', { className: `${ID}-setlabel`, style: { gap: '0.375rem', display: 'inline-flex', alignItems: 'center' }, children: [
        jsx(Switch, { size: 'xs', checked: unreadOnly, onCheckedChange: v => { setUnreadOnly(v); setOffset(0) } }),
        'Unread only'
      ]}),
      jsx('span', { style: { flex: 1 } }),
      jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => void arts.refetch(), children: 'Refresh' }),
      jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => markAll.mutate(), disabled: markAll.isPending, children: 'Mark all read' })
    ]}),
    jsx('div', { className: `${ID}-scrollwrap`, children:
      jsx(ScrollArea, { className: 'h-full', children:
        arts.isLoading
          ? jsx('div', { className: 'grid h-full place-items-center p-4', children: jsx(GlyphSpinner, {}) })
          : arts.isError
            ? jsx('div', { className: 'grid h-full place-items-center p-4', children: jsx(ErrorState, { title: 'Could not load articles', description: errText(arts.error) }) })
            : list.length === 0
              ? jsx('div', { className: 'grid h-full place-items-center p-4', children: jsx(EmptyState, { title: needle ? 'No matching headlines' : 'No articles yet', description: needle ? 'Try a different search.' : 'Add a source and refresh.' }) })
              : jsx('div', { className: `${ID}-list`, children: list.map(a => jsx(ArticleRow, { a, key: a.id })) })
      })
    }),
    jsxs('div', { className: `${ID}-pager`, children: [
      jsx(Button, { size: 'xs', variant: 'outline', disabled: offset === 0, onClick: () => setOffset(Math.max(0, offset - PAGE_SIZE)), children: '← Newer' }),
      jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', children: `${total} article${total === 1 ? '' : 's'}` }),
      jsx(Button, { size: 'xs', variant: 'outline', disabled: fetched.length < PAGE_SIZE, onClick: () => setOffset(offset + PAGE_SIZE), children: 'Older →' })
    ]})
  ]})
}

// ─────────────────────────────────────────────────────────────────────────
// Page — Sources
// ─────────────────────────────────────────────────────────────────────────

function AddSourceCard({ onAdded, autofocus }) {
  const [url, setUrl] = useState('')
  const [candidates, setCandidates] = useState(null)
  const [picked, setPicked] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (autofocus) {
      inputRef.current?.focus()
      addFocusArmed = false
    }
  }, [autofocus])

  const discover = async () => {
    setError(''); setCandidates(null); setBusy(true)
    try {
      const out = await rest('/discover', { method: 'POST', body: { url: url.trim() } })
      const cands = (out.candidates || []).filter(c => c.is_feed)
      setCandidates(cands)
      setPicked(0)
      if (!cands.length) setError('No feed found at that URL.')
    } catch (e) {
      setError(errText(e))
    } finally { setBusy(false) }
  }

  const add = async (feedUrl) => {
    setBusy(true); setError('')
    try {
      await rest('/sources', { method: 'POST', body: { url: url.trim(), feed_url: feedUrl } })
      setUrl(''); setCandidates(null)
      onAdded()
    } catch (e) {
      setError(errText(e))
    } finally { setBusy(false) }
  }

  return jsxs('div', { className: `${ID}-card`, children: [
    jsx('div', { className: `${ID}-setlabel`, style: { fontSize: '0.8125rem', color: 'var(--ui-text-primary)', fontWeight: 600 }, children: 'Add a source' }),
    jsxs('div', { style: { display: 'flex', gap: '0.5rem' }, children: [
      jsx(Input, {
        value: url,
        ref: inputRef,
        onChange: e => setUrl(typeof e === 'string' ? e : e?.target?.value ?? ''),
        onKeyDown: e => { if (e.key === 'Enter' && url.trim() && !busy) void discover() },
        placeholder: 'https://www.theverge.com  or a direct feed URL',
        style: { flex: 1 }
      }),
      jsx(Button, { size: 'sm', onClick: () => void discover(), disabled: busy || !url.trim(), children: busy ? 'Working…' : 'Find feed' })
    ]}),
    error ? jsx('div', { className: `${ID}-err`, children: error }) : null,
    candidates && candidates.length > 0 ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.375rem' }, children: [
      candidates.map((c, i) => jsxs('button', {
        className: `${ID}-cand`,
        'data-picked': picked === i ? '1' : '0',
        onClick: () => setPicked(i),
        children: [
          jsx('span', { children: picked === i ? '◉' : '○' }),
          jsx('span', { children: c.title || c.url }),
          c.format ? jsx(Badge, { variant: 'outline', children: c.format }) : null,
          jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: c.url })
        ]
      }, c.url)),
      jsx('div', { children: jsx(Button, {
        size: 'sm',
        onClick: () => void add(candidates[picked]?.url),
        disabled: busy,
        children: `Add “${candidates[picked]?.title || 'feed'}”`
      }) })
    ]}) : null
  ]})
}

function EditSourceDialog({ s, open, onOpenChange, onSaved }) {
  const [name, setName] = useState(s.name)
  const [category, setCategory] = useState(s.category || '')
  const [interval, setInterval_] = useState(String(s.refresh_interval ?? ''))
  const [error, setError] = useState('')
  const save = useMutation({
    mutationFn: () => rest(`/sources/${s.id}`, {
      method: 'PATCH',
      body: {
        name: name.trim(),
        category: category.trim(),
        ...(interval === '' ? {} : { refresh_interval: Number(interval) })
      }
    }),
    onSuccess: () => { onSaved(); onOpenChange(false) },
    onError: e => setError(errText(e))
  })
  return jsxs(Dialog, { open, onOpenChange, children: [
    jsx(DialogContent, { style: { maxWidth: '32rem' }, children: [
      jsxs(DialogHeader, { children: [
        jsx(DialogTitle, { children: 'Edit source' }),
        jsx(DialogDescription, { children: s.feed_url })
      ]}),
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.75rem', paddingTop: '0.5rem' }, children: [
        jsxs('label', { className: `${ID}-setlabel`, style: { flexDirection: 'column', alignItems: 'stretch', gap: '0.25rem' }, children: [
          'Name',
          jsx(Input, { value: name, onChange: e => setName(typeof e === 'string' ? e : e?.target?.value ?? '') })
        ]}),
        jsxs('label', { className: `${ID}-setlabel`, style: { flexDirection: 'column', alignItems: 'stretch', gap: '0.25rem' }, children: [
          'Category',
          jsx(Input, { value: category, onChange: e => setCategory(typeof e === 'string' ? e : e?.target?.value ?? ''), placeholder: 'technology, science…' })
        ]}),
        jsxs('label', { className: `${ID}-setlabel`, style: { flexDirection: 'column', alignItems: 'stretch', gap: '0.25rem' }, children: [
          'Refresh interval (seconds, empty = default)',
          jsx(Input, { value: interval, onChange: e => setInterval_(typeof e === 'string' ? e : e?.target?.value ?? ''), placeholder: '300' })
        ]}),
        error ? jsx('div', { className: `${ID}-err`, children: error }) : null
      ]}),
      jsxs(DialogFooter, { children: [
        jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => onOpenChange(false), children: 'Cancel' }),
        jsx(Button, { size: 'sm', disabled: save.isPending, onClick: () => save.mutate(), children: save.isPending ? 'Saving…' : 'Save' })
      ]})
    ]})
  ]})
}

function SourceRow({ s, onChanged }) {
  const [armed, setArmed] = useState(false)
  const [editing, setEditing] = useState(false)
  return jsxs('div', { className: `${ID}-srcrow`, children: [
    jsxs('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.125rem' }, children: [
      jsxs('span', { className: 'text-sm text-(--ui-text-primary)', children: [
        s.name,
        s.enabled ? null : jsx(Badge, { variant: 'outline', children: 'disabled' }),
        s.category ? jsx(Badge, { variant: 'outline', children: s.category }) : null
      ]}),
      jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: s.feed_url }),
      s.last_error
        ? jsxs('span', { className: `${ID}-err`, title: `last ok: ${s.last_success_at || 'never'}`, children: ['⚠ ', s.last_error, s.error_count > 1 ? ` (${s.error_count}×)` : ''] })
        : s.last_checked_at
          ? jsxs('span', { className: 'text-xs text-(--ui-text-quaternary)', children: [s.last_success_at ? 'ok' : 'never succeeded', ' · checked ', relTime(s.last_checked_at), ' ago'] })
          : jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', children: 'not checked yet' })
    ]}),
    jsx(Switch, {
      size: 'xs',
      checked: !!s.enabled,
      onCheckedChange: async v => {
        try {
          await rest(`/sources/${s.id}`, { method: 'PATCH', body: { enabled: v } })
          onChanged()
        } catch { /* refetch surfaces */ }
      }
    }),
    jsx(Button, {
      size: 'xs', variant: 'ghost',
      onClick: async () => {
        try { await rest(`/sources/${s.id}/refresh`, { method: 'POST', body: {} }); onChanged() } catch { /* surfaced */ }
      },
      children: 'Refresh'
    }),
    jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => setEditing(true), children: 'Edit' }),
    jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => setArmed(true), children: 'Delete' }),
    jsx(ConfirmDialog, {
      open: armed,
      onClose: () => setArmed(false),
      title: `Delete “${s.name}”?`,
      description: `Removes the source and its ${s.article_count ?? 0} cached article${s.article_count === 1 ? '' : 's'}.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        try { await rest(`/sources/${s.id}`, { method: 'DELETE' }); onChanged() } catch { /* surfaced */ }
      }
    }),
    editing ? jsx(EditSourceDialog, { s, open: editing, onOpenChange: setEditing, onSaved: onChanged }) : null
  ]})
}

function SourcesTab({ sources, onChanged, autofocusAdd }) {
  const refreshAll = useMutation({
    mutationFn: () => rest('/refresh-all', { method: 'POST', body: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [ID] })
  })
  const importRef = useRef(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importMsg, setImportMsg] = useState('')

  const doImport = async file => {
    setImportBusy(true); setImportMsg('')
    try {
      const xml = await file.text()
      const out = await rest('/opml/import', { method: 'POST', body: { xml } })
      const { added = [], skipped = [], errors = [] } = out || {}
      setImportMsg(`Imported ${added.length}, skipped ${skipped.length}${errors.length ? `, failed ${errors.length}` : ''}`)
      onChanged()
    } catch (e) {
      setImportMsg(errText(e))
    } finally {
      setImportBusy(false)
      if (importRef.current) importRef.current.value = ''
    }
  }

  return jsxs('div', { className: `${ID}-page`, children: [
    jsxs('div', { className: `${ID}-tabs`, children: [
      jsx('span', { className: 'text-sm text-(--ui-text-primary)', children: `Sources (${sources.length})` }),
      jsx('span', { style: { flex: 1 } }),
      importMsg ? jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', children: importMsg }) : null,
      jsx(Button, { size: 'xs', variant: 'ghost', disabled: importBusy, onClick: () => importRef.current?.click(), children: importBusy ? 'Importing…' : 'Import OPML' }),
      jsx('input', { ref: importRef, type: 'file', accept: '.opml,.xml,text/xml,text/x-opml', style: { display: 'none' }, onChange: e => { const f = e.target.files?.[0]; if (f) void doImport(f) } }),
      jsx(Button, {
        size: 'xs', variant: 'ghost',
        onClick: async () => {
          try {
            // JSON twin route: the plugin REST bridge (Electron fetchJson)
            // only resolves JSON bodies — the raw text/xml route rejects.
            const out = await rest('/opml/export.json')
            const xml = typeof out === 'string' ? out : out?.xml || ''
            if (!xml) throw new Error('empty OPML document')
            const blob = new Blob([xml], { type: 'text/x-opml' })
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = 'newswire-sources.opml'
            a.click()
            URL.revokeObjectURL(a.href)
            setImportMsg(`Exported ${sources.length} source${sources.length === 1 ? '' : 's'}`)
          } catch (e) {
            host.notifyError(e, 'OPML export failed')
          }
        },
        children: 'Export OPML'
      }),
      jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => void refreshAll.mutate(), disabled: refreshAll.isPending, children: refreshAll.isPending ? 'Refreshing…' : 'Refresh all' })
    ]}),
    jsx('div', { className: `${ID}-scrollwrap`, children:
      jsx(ScrollArea, { className: 'h-full', children:
        jsxs('div', { children: [
          jsx(AddSourceCard, { onAdded: onChanged, autofocus: autofocusAdd }),
          sources.length === 0
            ? jsxs('div', { className: `${ID}-card`, children: [
                jsx('span', { className: `${ID}-setlabel`, style: { fontSize: '0.8125rem', color: 'var(--ui-text-primary)', fontWeight: 600 }, children: 'Starter feeds (optional)' }),
                jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', children: 'Pick any to subscribe — nothing is added without your click.' }),
                jsx('div', { className: `${ID}-chips`, children: STARTER_FEEDS.map(f => jsxs('button', {
                  className: `${ID}-chip`,
                  onClick: async () => {
                    try {
                      await rest('/sources', { method: 'POST', body: { feed_url: f.feed_url, name: f.name, category: f.category } })
                      onChanged()
                    } catch { /* surfaced on refetch */ }
                  },
                  children: [`+ ${f.name}`, jsx(Badge, { variant: 'outline', children: f.category })]
                }, f.feed_url)) })
              ]})
            : jsx('div', { className: `${ID}-list`, children: sources.map(s => jsx(SourceRow, { s, key: s.id, onChanged })) })
        ]})
      })
    })
  ]})
}

// ─────────────────────────────────────────────────────────────────────────
// Page — Settings
// ─────────────────────────────────────────────────────────────────────────

function SettingsTab() {
  const [settingsQ, s] = useSettings()
  const save = useMutation({
    mutationFn: patch => rest('/settings', { method: 'PATCH', body: patch }),
    onSuccess: (_data, patch) => {
      queryClient.invalidateQueries({ queryKey: [ID, 'settings'] })
      // Pane registration follows ticker_enabled / ticker_font_size live.
      if (patch && ('ticker_enabled' in patch || 'ticker_font_size' in patch) && applyTickerSettingsFn) {
        applyTickerSettingsFn({ ...s, ...patch })
      }
    }
  })
  if (!s) return jsx('div', { className: 'grid h-full place-items-center p-4', children: jsx(GlyphSpinner, {}) })

  const Toggle = ({ label, k }) => jsxs('div', { className: `${ID}-setrow`, children: [
    jsx('span', { className: `${ID}-setlabel`, children: label }),
    jsx(Switch, { size: 'xs', checked: s[k] !== false, onCheckedChange: v => save.mutate({ [k]: v }) })
  ]})
  const Choice = ({ label, k, options }) => jsxs('div', { className: `${ID}-setrow`, children: [
    jsx('span', { className: `${ID}-setlabel`, children: label }),
    jsx(SegmentedControl, {
      value: String(s[k]),
      onChange: v => save.mutate({ [k]: Number(v) }),
      options
    })
  ]})

  return jsx('div', { className: `${ID}-page`, children:
    jsx('div', { className: `${ID}-scrollwrap`, children:
      jsx(ScrollArea, { className: 'h-full', children:
        jsxs('div', { className: `${ID}-card`, style: { maxWidth: '38rem' }, children: [
          jsx('div', { className: `${ID}-setgroup`, children: 'Ticker' }),
          jsx(Toggle, { label: 'Ticker enabled', k: 'ticker_enabled' }),
          jsx(Toggle, { label: 'Pause on hover', k: 'pause_on_hover' }),
          jsxs('div', { className: `${ID}-setrow`, children: [
            jsx('span', { className: `${ID}-setlabel`, children: 'Scroll speed' }),
            jsx(SegmentedControl, {
              value: s.ticker_speed || 'normal',
              onChange: v => save.mutate({ ticker_speed: v }),
              options: SPEED_OPTIONS
            })
          ]}),
          jsxs('div', { className: `${ID}-setrow`, children: [
            jsx('span', { className: `${ID}-setlabel`, children: 'Text size (px)' }),
            jsx(SegmentedControl, {
              value: String(s.ticker_font_size || 11),
              onChange: v => save.mutate({ ticker_font_size: Number(v) }),
              options: FONT_OPTIONS
            })
          ]}),
          jsx(Toggle, { label: 'Show source name', k: 'show_source' }),
          jsx(Toggle, { label: 'Show relative time', k: 'relative_time' }),
          jsx(Toggle, { label: 'Only show unread', k: 'only_unread' }),
          jsx(Separator, {}),
          jsx('div', { className: `${ID}-setgroup`, children: 'Engine' }),
          jsx(Choice, { label: 'Default refresh interval', k: 'refresh_interval', options: INTERVAL_OPTIONS }),
          jsx(Choice, { label: 'Max article age', k: 'max_article_age_hours', options: AGE_OPTIONS }),
          jsx(Choice, { label: 'Max stored headlines', k: 'max_headlines', options: LIMIT_OPTIONS }),
          jsx('div', { className: 'text-xs text-(--ui-text-quaternary)', children: 'Feeds are polled by the backend with ETag/Last-Modified caching; unchanged feeds are not re-downloaded. Per-source refresh overrides: Sources → Edit.' })
        ]})
      })
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Page shell
// ─────────────────────────────────────────────────────────────────────────

function NewswirePage() {
  const [tab, setTab] = useState(() => storageGet?.('lastTab', 'latest') || 'latest')
  const [prefs, setPrefsRaw] = useState(() => storageGet?.('latestPrefs', {}) || {})
  const addSignal = useValue($addSourceSignal)
  const addArmed = useRef(0)
  const [, sources] = useSources()
  const onChanged = () => queryClient.invalidateQueries({ queryKey: [ID] })

  const setPrefs = p => setPrefsRaw(p)
  useEffect(() => { storageSet?.('latestPrefs', prefs) }, [prefs]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { storageSet?.('lastTab', tab) }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  // Palette "Add Source" → land on Sources tab with the add card focused.
  useEffect(() => {
    if (addSignal > addArmed.current) {
      addArmed.current = addSignal
      setTab('sources')
    }
  }, [addSignal])

  return jsxs('div', { className: `${ID}-page`, children: [
    jsxs('div', { className: `${ID}-tabs`, role: 'tablist', 'aria-label': 'Newswire sections', children: [
      jsx('span', { style: { fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.08em', color: 'var(--ui-accent)' }, children: 'NEWSWIRE' }),
      jsx('button', { className: `${ID}-tab`, role: 'tab', 'aria-selected': tab === 'latest' ? 'true' : 'false', 'data-active': tab === 'latest' ? '1' : '0', onClick: () => setTab('latest'), children: 'Latest' }),
      jsx('button', { className: `${ID}-tab`, role: 'tab', 'aria-selected': tab === 'sources' ? 'true' : 'false', 'data-active': tab === 'sources' ? '1' : '0', onClick: () => setTab('sources'), children: `Sources${sources.length ? ` (${sources.length})` : ''}` }),
      jsx('button', { className: `${ID}-tab`, role: 'tab', 'aria-selected': tab === 'settings' ? 'true' : 'false', 'data-active': tab === 'settings' ? '1' : '0', onClick: () => setTab('settings'), children: 'Settings' })
    ]}),
    tab === 'latest' ? jsx(LatestTab, { sources, prefs, setPrefs }) :
    tab === 'sources' ? jsx(SourcesTab, { sources, onChanged, autofocusAdd: addFocusArmed }) :
    jsx(SettingsTab, {})
  ]})
}

// ─────────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Hermes Newswire',
  description: 'Breaking-news ticker in the statusbar + full newswire page. RSS/Atom/JSON Feed, no API keys, no model usage.',
  defaultEnabled: true,

  register(ctx) {
    ensureStyles()
    rest = ctx.rest
    openExternalFn = ctx.os?.openExternal
      ? url => ctx.os.openExternal(url)
      : async () => false
    storageGet = (key, fallback) => ctx.storage.get(key, fallback)
    storageSet = (key, value) => ctx.storage.set(key, value)

    // Ticker pane registration is synced to the ticker_enabled setting:
    // registered = the strip exists in the layout (a thin row above the
    // statusbar); unregistered = the layout row is gone entirely. This
    // avoids a dead blank strip when the user disables the ticker, while
    // keeping the dock hint so re-enabling re-adopts the same spot.
    // Height follows the font-size setting (readability knob): re-register
    // on change — the pane system sizes a single-pane zone by its declared
    // height at adoption, and registerMany/register replaces same-id
    // contributions cleanly.
    const makeTickerPane = heightPx => ({
      id: 'ticker',
      // Thin persistent strip ABOVE the statusbar: a real layout split on
      // the workspace's bottom edge (pane system), NOT a statusbar row —
      // Tony: statusbar placement covered the app's own items. placement
      // 'main' + headerVeto: the strip is not a tab-able surface (like
      // full-page views), so the zone renders headerless and the whole
      // track is content. A single-pane zone declaring height is a fixed
      // track (same rule as the terminal deck).
      area: 'panes',
      title: 'Newswire',
      data: {
        placement: 'main',
        headerVeto: true,
        dock: { pane: 'workspace', pos: 'bottom' },
        height: `${heightPx}px`
      },
      render: () => jsx(NewswireTicker, {})
    })
    let tickerRegistered = false
    let disposeTicker = null
    let lastPaneKey = null
    const applyTickerSettings = settings => {
      const enabled = !settings || settings.ticker_enabled !== false
      const fontPx = Math.min(20, Math.max(9, Number(settings?.ticker_font_size) || 11))
      const heightPx = fontToHeight(fontPx)
      // Guard: only touch the registry when the pane's shape actually
      // changes. Re-registering unconditionally makes the pane remount,
      // which re-runs the caller's effect, which re-registers — the
      // React #185 loop. Same key = no-op.
      const key = `${enabled}|${heightPx}`
      if (key === lastPaneKey) return
      lastPaneKey = key
      if (!enabled) {
        if (tickerRegistered && disposeTicker) {
          disposeTicker()
          disposeTicker = null
          tickerRegistered = false
        }
        return
      }
      if (tickerRegistered && disposeTicker) {
        disposeTicker()
      }
      // (Re)register with the current height — same id, clean replace.
      disposeTicker = ctx.register(makeTickerPane(heightPx))
      tickerRegistered = true
    }

    // Initial state from the backend; keep in sync as settings change.
    applyTickerSettingsFn = applyTickerSettings
    void rest('/settings')
      .then(out => applyTickerSettings(out?.settings))
      .catch(() => applyTickerSettings(null))
    ctx.onDispose(() => { if (disposeTicker) disposeTicker() })

    const dispose = ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: PAGE_PATH },
        render: () => jsx(NewswirePage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 60,
        data: { codicon: 'radio-tower', label: 'Newswire', path: PAGE_PATH }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.open`,
          label: 'Newswire: Open',
          keywords: ['newswire', 'news', 'ticker'],
          run: () => host.navigate(PAGE_PATH)
        }
      },
      {
        id: 'refresh',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.refresh`,
          label: 'Newswire: Refresh Now',
          keywords: ['newswire', 'refresh', 'news'],
          run: () => void rest('/refresh-all', { method: 'POST', body: {} })
            .then(() => queryClient.invalidateQueries({ queryKey: [ID] }))
            .catch(() => {})
        }
      },
      {
        id: 'pause',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.pause`,
          label: 'Newswire: Pause Ticker',
          keywords: ['newswire', 'pause', 'ticker'],
          run: () => $tickerPaused.set(true)
        }
      },
      {
        id: 'resume',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.resume`,
          label: 'Newswire: Resume Ticker',
          keywords: ['newswire', 'resume', 'ticker'],
          run: () => $tickerPaused.set(false)
        }
      },
      {
        id: 'addSource',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.addSource`,
          label: 'Newswire: Add Source',
          keywords: ['newswire', 'add', 'source', 'feed', 'rss'],
          run: () => {
            addFocusArmed = true
            $addSourceSignal.set($addSourceSignal.get() + 1)
            host.navigate(PAGE_PATH)
          }
        }
      }
    ])

    return dispose
  }
}

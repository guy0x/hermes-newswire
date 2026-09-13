/**
 * ESM registration + render smoke tests for the hermes-newswire plugin.
 *
 * Loads the REAL plugin.js as an actual ESM module with a temporary Node
 * loader mapping @hermes/plugin-sdk, react, and react/jsx-runtime to local
 * stubs (pattern: hermes-desktop-plugin-development skill / approval-inbox),
 * then asserts:
 *   - import-scan clean (only SDK/react specifiers in source)
 *   - register(ctx) registers page + nav + 5 palette commands, and the ticker
 *     pane once settings resolve (ticker_enabled default true)
 *   - ticker pane is docked bottom, headerless, height follows font setting
 *   - ticker render produces region+brand+items; articles render as buttons
 *     with aria-labels; context-menu handler asks Hermes via prompt.submit
 *   - page render produces tablist with three role=tab buttons
 *   - Export OPML button calls the JSON-twin route (/opml/export.json)
 *
 * Run: node tests/ui/esm-render.mjs
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { register } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STUBS_DIR = join(__dirname, '.stubs')
const PLUGIN_PATH = join(__dirname, '..', '..', 'desktop', 'plugin.js')

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let failures = 0
let checks = 0
const check = (cond, msg) => {
  checks += 1
  if (!cond) {
    failures += 1
    console.error('FAIL: ' + msg)
  }
}

// ---------------------------------------------------------------------------
// SDK stub — mirrors every export plugin.js imports
// ---------------------------------------------------------------------------

const calls = globalThis.__nwCalls = { rest: [], notify: [], hostRequest: [] }

const hostStub = {
  navigate: () => {},
  notify: input => globalThis.__nwCalls.notify.push(input),
  notifyError: (e, fallback) => globalThis.__nwCalls.notify.push({ kind: 'error', message: fallback || String(e) }),
  request: async (method, params) => {
    globalThis.__nwCalls.hostRequest.push({ method, params })
    return { status: 'streaming' }
  },
  state: {
    focusedSessionId: { get: () => 'sess-1' },
    activeSessionId: { get: () => 'sess-1' },
    busyBySession: { get: () => ({}) }
  }
}

const atom = initial => {
  let value = initial
  return {
    get: () => value,
    set: v => { value = v },
    subscribe: () => () => {}
  }
}

const settings = {
  refresh_interval: 300,
  max_article_age_hours: 168,
  max_headlines: 500,
  ticker_enabled: true,
  ticker_speed: 'normal',
  ticker_font_size: 11,
  pause_on_hover: true,
  show_source: true,
  relative_time: true,
  only_unread: false
}

const restResponses = {
  '/settings': { settings },
  '/sources': { sources: [] },
  '/articles?limit=50&include_summary=false': {
    items: [
      { id: 1, source_id: 1, title: 'First headline', source_name: 'Feed A', canonical_url: 'https://a.example/1', published_at: new Date(Date.now() - 60_000).toISOString(), read: false },
      { id: 2, source_id: 2, title: 'Second headline', source_name: 'Feed B', canonical_url: 'https://b.example/2', published_at: new Date(Date.now() - 3600_000).toISOString(), read: true }
    ],
    total: 2
  },
  '/opml/export.json': { xml: '<?xml version="1.0"?><opml version="2.0"><body/></opml>' }
}

const useMutationStub = options => ({
  mutate: vars => {
    if (options && typeof options.mutationFn === 'function') {
      Promise.resolve(options.mutationFn(vars)).catch(() => {})
    }
  },
  isPending: false
})

// Query results injected into the generated stub module (the stub runs in a
// separate module scope and cannot close over this file's variables).
// NOTE: these are the POST-queryFn shapes — the component's queryFn normally
// unwraps envelopes (e.g. .items), and the stub bypasses queryFn.
const stubQueryData = {
  'hermes-newswire|settings': settings,
  'hermes-newswire|sources': [],
  'ticker': [
    { id: 1, source_id: 1, title: 'First headline', source_name: 'Feed A', canonical_url: 'https://a.example/1', published_at: new Date(Date.now() - 60_000).toISOString(), read: false },
    { id: 2, source_id: 2, title: 'Second headline', source_name: 'Feed B', canonical_url: 'https://b.example/2', published_at: new Date(Date.now() - 3600_000).toISOString(), read: true }
  ],
  'articles': { items: [
    { id: 1, source_id: 1, title: 'First headline', source_name: 'Feed A', canonical_url: 'https://a.example/1', published_at: new Date(Date.now() - 60_000).toISOString(), read: false, summary: 'Sum one' },
    { id: 2, source_id: 2, title: 'Second headline', source_name: 'Feed B', canonical_url: 'https://b.example/2', published_at: new Date(Date.now() - 3600_000).toISOString(), read: true, summary: 'Sum two' }
  ], total: 2 }
}

// The stub module runs in its own scope: every value it touches must be
// INLINED into its source (closures over this file don't cross the boundary).
const stubDataLiteral = JSON.stringify(stubQueryData)

const useQueryStubSource = `const stubQueryData = ${stubDataLiteral}
export const useQuery = options => {
  const key = options && Array.isArray(options.queryKey) ? options.queryKey.join('|') : ''
  let data
  if (key.includes('|settings')) data = stubQueryData['hermes-newswire|settings']
  else if (key.includes('|sources')) data = stubQueryData['hermes-newswire|sources']
  else if (key.includes('ticker')) data = stubQueryData.ticker
  else if (key.includes('articles')) data = stubQueryData.articles
  return { data, isLoading: !data, isError: false, error: null, refetch: async () => {} }
}`

const useValueImpl = a => (a && typeof a.get === 'function' ? a.get() : undefined)

const sdkStub = {
  Badge: 'Badge',
  Button: 'Button',
  ConfirmDialog: 'ConfirmDialog',
  Dialog: 'Dialog',
  DialogContent: 'DialogContent',
  DialogDescription: 'DialogDescription',
  DialogFooter: 'DialogFooter',
  DialogHeader: 'DialogHeader',
  DialogTitle: 'DialogTitle',
  EmptyState: 'EmptyState',
  ErrorState: 'ErrorState',
  GlyphSpinner: 'GlyphSpinner',
  host: hostStub,
  Input: 'Input',
  PALETTE_AREA: 'palette',
  ROUTES_AREA: 'routes',
  ScrollArea: ({ children }) => ({ type: 'div', props: { children } }),
  SearchField: 'SearchField',
  SegmentedControl: 'SegmentedControl',
  Separator: 'Separator',
  SIDEBAR_NAV_AREA: 'sidebar.nav',
  Switch: 'Switch',
  atom,
  queryClient: { invalidateQueries: () => {} },
  useMutation: useMutationStub,
  useQuery: () => ({ data: undefined, isLoading: true, isError: false, error: null, refetch: async () => {} }),
  useValue: useValueImpl
}

const reactStub = {
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: fn => (typeof fn === 'function' ? fn() : fn),
  useRef: initial => ({ current: initial }),
  createElement: (type, props, ...children) => ({ type, props, children })
}

const jsxRuntimeStub = {
  // Invoke function components like real React would (hooks are stubbed
  // stateless), so the render tree contains real element nodes to assert on.
  jsx: (type, props) => render(type, props),
  jsxs: (type, props) => render(type, props),
  Fragment: 'Fragment'
}

function render(type, props) {
  if (typeof type === 'function') {
    try {
      return type(props || {})
    } catch (err) {
      return { type, props: props || {}, renderError: err }
    }
  }
  return { type, props: props || {}, $$jsx: true }
}

// ---------------------------------------------------------------------------
// Write stub modules + loader, then import the plugin through it
// ---------------------------------------------------------------------------

mkdirSync(STUBS_DIR, { recursive: true })

// Functions are serialized as their source; reattach everything explicitly
// (JSON.stringify silently drops function-valued properties). useQuery's stub
// is a multi-statement block (inline data + function), emitted raw.
const functionExports = {
  atom: atom.toString(),
  useValue: useValueImpl.toString(),
  useMutation: useMutationStub.toString()
}
const constantKeys = Object.keys(sdkStub).filter(k => !(k in functionExports) && k !== 'useQuery' && k !== 'host')
const constantJson = JSON.stringify(
  Object.fromEntries(constantKeys.map(k => [k, sdkStub[k]])),
  null, 2
)
// host has nested functions (notify/notifyError/request + state atoms with
// get()) — JSON drops them, so serialize it function-aware.
const hostSerialized = serializeHost(hostStub)
function serializeHost(h) {
  const lines = []
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === 'function') lines.push(`  ${k}: ${v.toString()}`)
    else if (v && typeof v === 'object' && k === 'state') {
      const stateLines = Object.entries(v).map(([sk, sv]) =>
        typeof sv === 'function' ? `    ${sk}: ${sv.toString()}` :
        (sv && typeof sv === 'object' && typeof sv.get === 'function') ? `    ${sk}: { get: ${sv.get.toString()} }` :
        `    ${sk}: ${JSON.stringify(sv)}`
      ).join(',\n')
      lines.push(`  state: {\n${stateLines}\n  }`)
    } else if (v && typeof v === 'object') lines.push(`  ${k}: ${JSON.stringify(v)}`)
    else lines.push(`  ${k}: ${JSON.stringify(v)}`)
  }
  return `{\n${lines.join(',\n')}\n}`
}
const sdkStubSource = [
  `const __atom = ${functionExports.atom}`,
  `const __useValue = ${functionExports.useValue}`,
  `const __useMutation = ${functionExports.useMutation}`,
  useQueryStubSource.replace('export const useQuery', 'const __useQuery'),
  `const sdk = ${constantJson}`,
  'sdk.host = ' + hostSerialized,
  'sdk.atom = __atom',
  'sdk.useValue = __useValue',
  'sdk.useMutation = __useMutation',
  'sdk.useQuery = __useQuery',
  'export default sdk',
  'export const atom = __atom',
  'export const useValue = __useValue',
  'export const useMutation = __useMutation',
  'export const useQuery = __useQuery',
  'export const host = sdk.host',
  ...constantKeys.map(k => `export const ${k} = sdk.${k}`),
  ''
].join('\n')
writeFileSync(join(STUBS_DIR, 'sdk.mjs'), sdkStubSource)

writeFileSync(
  join(STUBS_DIR, 'react.mjs'),
  `export const useState = ${reactStub.useState.toString()}\n` +
    `export const useEffect = ${reactStub.useEffect.toString()}\n` +
    `export const useMemo = ${reactStub.useMemo.toString()}\n` +
    `export const useRef = ${reactStub.useRef.toString()}\n` +
    'export default { useState, useEffect, useMemo, useRef }\n'
)

writeFileSync(join(STUBS_DIR, 'jsx-runtime.mjs'), `function invokeComponent(type, props) {
  if (typeof type === 'function') {
    try {
      return type(props || {})
    } catch (err) {
      return { type, props: props || {}, renderError: err }
    }
  }
  return { type, props: props || {}, $$jsx: true }
}
export const jsx = (type, props) => invokeComponent(type, props)
export const jsxs = (type, props) => invokeComponent(type, props)
export const Fragment = 'Fragment'
`)

const loaderSrc = `const STUB_URLS = ${JSON.stringify({
  '@hermes/plugin-sdk': pathToFileURL(join(STUBS_DIR, 'sdk.mjs')).href,
  react: pathToFileURL(join(STUBS_DIR, 'react.mjs')).href,
  'react/jsx-runtime': pathToFileURL(join(STUBS_DIR, 'jsx-runtime.mjs')).href
}, null, 2)}
export function resolve(specifier, context, nextResolve) {
  if (STUB_URLS[specifier]) {
    return { url: STUB_URLS[specifier], shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
`
writeFileSync(join(__dirname, 'loader-hooks.mjs'), loaderSrc)
register(new URL('./loader-hooks.mjs', import.meta.url))

// ---------------------------------------------------------------------------
// Minimal DOM shim: plugin.js touches document (style element) and
// window.matchMedia at render time. Node has neither.
// ---------------------------------------------------------------------------

const styleElements = []
globalThis.document = {
  getElementById: () => null,
  createElement: tag => ({
    tag,
    id: '',
    textContent: '',
    appendChild() {},
    click() {},
    set href(v) { this._href = v },
    get href() { return this._href },
    download: ''
  }),
  head: { appendChild: el => styleElements.push(el) }
}
globalThis.window = globalThis.window || {}
globalThis.window.matchMedia = globalThis.window.matchMedia || (q => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
if (!globalThis.matchMedia) {
  globalThis.matchMedia = globalThis.window.matchMedia
}
globalThis.URL = globalThis.URL || URL
globalThis.Blob = globalThis.Blob || class Blob { constructor(parts) { this.parts = parts } }


const flush = () => new Promise(resolve => setTimeout(resolve, 20))

// ---------------------------------------------------------------------------
// 1) import-scan on raw source
// ---------------------------------------------------------------------------

const src = readFileSync(PLUGIN_PATH, 'utf8')
const importMatches = src.match(/from\s+['"][^'"]+['"]/g) || []
const allowed = new Set(["from '@hermes/plugin-sdk'", "from 'react'", "from 'react/jsx-runtime'"])
const illegal = importMatches.map(m => m.trim()).filter(m => !allowed.has(m))
check(illegal.length === 0, 'loader import-scan found illegal specifiers: ' + JSON.stringify(illegal))

// 2) import + register
let plugin
try {
  plugin = (await import(pathToFileURL(PLUGIN_PATH).href + '?t=' + Date.now())).default
} catch (err) {
  check(false, 'plugin failed to import: ' + err.message)
  console.log('FAILURES: ' + failures)
  process.exit(1)
}

check(plugin.id === 'hermes-newswire', 'plugin id')
check(typeof plugin.register === 'function', 'register is a function')

const contributions = []
const tickerDisposers = []
const ctx = {
  rest: async (path, opts) => {
    calls.rest.push({ path, opts })
    if (path in restResponses) return restResponses[path]
    // queryFn-built article paths:
    if (path.startsWith('/articles')) return restResponses['/articles?limit=50&include_summary=false']
    return {}
  },
  os: { openExternal: async () => true },
  // Land the page on the Sources tab so the export/import chrome renders
  // (stateless hook stubs can't click tabs).
  storage: { get: (k, fb) => (k === 'lastTab' ? 'sources' : fb), set: () => {} },
  onDispose: () => {},
  register: c => { contributions.push(c); return () => {} },
  registerMany: cs => { contributions.push(...cs); return () => {} }
}

try {
  plugin.register(ctx)
  check(true, 'register() completed')
} catch (err) {
  check(false, 'register() threw: ' + (err && err.stack ? err.stack : err))
}

await flush() // let the initial /settings promise resolve -> ticker pane registers

const areas = contributions.map(c => c.area)
check(areas.includes('routes'), 'ROUTES_AREA page contribution')
check(areas.includes('sidebar.nav'), 'SIDEBAR_NAV_AREA contribution')
check(areas.filter(a => a === 'palette').length === 5, 'five PALETTE_AREA commands, got ' + areas.filter(a => a === 'palette').length)
check(areas.includes('panes'), 'ticker pane registered once settings resolved')
check(contributions.filter(c => c.area === 'panes').length === 1, 'exactly one ticker pane (no duplicate registration)')

const pane = contributions.find(c => c.area === 'panes')
check(pane && pane.data && pane.data.dock && pane.data.dock.pos === 'bottom', 'ticker pane docked bottom')
check(pane && pane.data && pane.data.headerVeto === true, 'ticker pane headerVeto')
check(pane && pane.data && typeof pane.data.height === 'string' && pane.data.height.endsWith('px'), 'ticker pane fixed px height (font-derived)')

const page = contributions.find(c => c.area === 'routes')
check(page && page.data && page.data.path === '/newswire', 'page path /newswire')

// 3) ticker render: region, brand, items as buttons with aria + context menu
let tickerNode
try {
  tickerNode = pane.render()
} catch (err) {
  check(false, 'ticker render threw: ' + (err && err.stack ? err.stack : err))
}
if (tickerNode) {
  await flush()
  tickerNode = pane.render() // second render picks up resolved query data
  check(tickerNode.props && tickerNode.props.role === 'region', 'ticker root role=region')
  check(tickerNode.props && /Newswire ticker/i.test(String(tickerNode.props['aria-label'] || '')), 'ticker aria-label')
  const flat = JSON.stringify(tickerNode)
  check(flat.includes('First headline'), 'ticker renders article titles')
  // Find the item buttons and verify aria-label + onContextMenu wired
  const buttons = collect(tickerNode, n => n.type === 'button' && n.props && n.props.onContextMenu)
  check(buttons.length >= 2, 'ticker items are buttons with context-menu handlers, got ' + buttons.length)
  if (buttons[0]) {
    check(/First headline/.test(String(buttons[0].props['aria-label'] || '')), 'ticker item aria-label includes headline')
    // Invoke the context menu -> askHermes -> host.request('prompt.submit')
    calls.hostRequest.length = 0
    const ev = { preventDefault: () => {} }
    buttons[0].props.onContextMenu(ev)
    await flush()
    check(calls.hostRequest.length === 1 && calls.hostRequest[0].method === 'prompt.submit', 'context menu submits prompt.submit')
    check(calls.hostRequest[0] && /First headline/.test(String(calls.hostRequest[0].params.text)), 'prompt text carries the headline')
    check(calls.hostRequest[0] && calls.hostRequest[0].params.session_id === 'sess-1', 'prompt targets focused session')
  }
}

// 4) page render: tablist semantics
let pageNode
try {
  pageNode = page.render()
} catch (err) {
  check(false, 'page render threw: ' + (err && err.stack ? err.stack : err))
}
if (pageNode) {
  await flush()
  pageNode = page.render()
  const tabsRow = collect(pageNode, n => n.props && n.props.role === 'tablist')[0]
  check(!!tabsRow, 'page tabs have role=tablist')
  const tabs = collect(pageNode, n => n.props && n.props.role === 'tab')
  check(tabs.length === 3, 'three role=tab buttons, got ' + tabs.length)
  check(tabs.every(t => t.props['aria-selected'] === 'true' || t.props['aria-selected'] === 'false'), 'tabs carry aria-selected')
}

// 5) export button hits the JSON twin route
calls.rest.length = 0
const exportBtn = collect(pageNode, n => n.type === 'button' && Array.isArray(n.props.children) === false && n.props.children === 'Export OPML')[0]
  || collectDeep(pageNode, 'Export OPML')[0]
check(!!exportBtn, 'Export OPML button found in page tree')
if (exportBtn) {
  await exportBtn.props.onClick()
  await flush()
  const exportCall = calls.rest.find(c => c.path === '/opml/export.json')
  check(!!exportCall, 'Export calls /opml/export.json (JSON twin), got: ' + JSON.stringify(calls.rest.map(c => c.path)))
}

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? `PASS: hermes-newswire ESM render smoke (${checks} checks)`
    : `FAILURES: ${failures} of ${checks}`
)
try { rmSync(join(__dirname, 'loader-hooks.mjs')) } catch { /* best effort */ }
// Keep .stubs/ (loader-hooks content is regenerated each run; but the probe
// needs it) — regenerate for the probe instead:
writeFileSync(join(__dirname, 'loader-hooks.mjs'), loaderSrc)
process.exit(failures === 0 ? 0 : 1)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function collect(node, pred, acc = [], seen = new Set()) {
  if (!node || typeof node !== 'object') return acc
  if (seen.has(node)) return acc
  seen.add(node)
  if (pred(node)) acc.push(node)
  const kids = node.props && node.props.children
  if (Array.isArray(kids)) kids.forEach(k => collect(k, pred, acc, seen))
  else if (kids && typeof kids === 'object') collect(kids, pred, acc, seen)
  return acc
}

function collectDeep(node, text, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (node.props) {
    if (node.props.children === text) acc.push(node)
    else if (Array.isArray(node.props.children)) node.props.children.forEach(k => collectDeep(k, text, acc))
    else if (node.props.children && typeof node.props.children === 'object') collectDeep(node.props.children, text, acc)
  }
  return acc
}

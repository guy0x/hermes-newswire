/**
 * Interaction tests for the hermes-newswire plugin renderer.
 *
 * Unlike esm-render.mjs (stateless smoke), this harness implements STATEFUL
 * React hook stubs — useState keeps its value across re-invocations, so
 * invoking a handler and re-rendering exercises the real component update
 * path. It drives the REAL desktop/plugin.js:
 *
 *   - Settings tab opens and renders its controls
 *   - flipping a setting issues the correct PATCH /settings
 *   - a failed settings save surfaces a visible error + notifyError
 *   - starter-feed click sends POST /sources with the correct body
 *   - a successful add re-renders the sources list (starter card gone)
 *   - a failed add (429 / duplicate) renders an actionable inline error
 *   - in-flight feeds are guarded against duplicate submits
 *   - a missing/failing backend renders a diagnostic banner, not a dead tab
 *   - favicon <img> sources go through the SSRF-gated backend icon proxy
 *
 * Run: node tests/ui/interaction.mjs
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { register } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STUBS_DIR = join(__dirname, '.stubs-interaction')
const PLUGIN_PATH = join(__dirname, '..', '..', 'desktop', 'plugin.js')

let failures = 0
let checks = 0
const check = (cond, msg) => {
  checks += 1
  if (!cond) {
    failures += 1
    console.error('FAIL: ' + msg)
  }
}
const flush = () => new Promise(r => setTimeout(r, 10))

// ---------------------------------------------------------------------------
// Stateful hook implementations. Shared state lives on globalThis because
// these functions are serialized into separate stub modules that must agree.
// ---------------------------------------------------------------------------

function useState(initial) {
  const frame = globalThis.__nwCurrentFrame
  const i = frame.idx++
  if (!(i in frame.slots)) frame.slots[i] = typeof initial === 'function' ? initial() : initial
  return [frame.slots[i], v => {
    frame.slots[i] = typeof v === 'function' ? v(frame.slots[i]) : v
  }]
}
const useEffect = () => {}
const useMemo = fn => (typeof fn === 'function' ? fn() : fn)
const useRef = v => ({ current: v })

// Terminal-element unwrapping shared by invokeComponent + normalizeOut.
function unwrapTerm(out) {
  return (out && typeof out === 'object' && out.el !== undefined && !out.props) ? out.el : out
}

// Invoke a component with a fresh hook frame. Returns a NORMALIZED node:
// type/props describe the RETURNED element (for tree walking); __callProps
// keeps the invocation props so deepRerender can re-invoke faithfully.
const invokeComponent = (type, props) => {
  const frame = { slots: [], idx: 0 }
  const prev = globalThis.__nwCurrentFrame
  globalThis.__nwCurrentFrame = frame
  try {
    const term = unwrapTerm(type(props || {}))
    return {
      __frame: frame,
      __origType: type,
      __callProps: props || {},
      type: term && term.type,
      props: (term && term.props) || {},
      $$jsx: term ? term.$$jsx : undefined,
      renderError: term ? term.renderError : undefined
    }
  } catch (err) {
    return { __frame: frame, __origType: type, __callProps: props || {}, type, props: props || {}, renderError: err }
  } finally {
    globalThis.__nwCurrentFrame = prev
  }
}

// Re-invoke component frames recursively so updated hook slots are read
// (this harness's stand-in for React re-render). Child frames are adopted
// positionally from the previous tree — React reconciles by position, and
// without this, state written by handlers (pending flags, inline errors)
// would be discarded on every re-render.
function normalizeOut(out) {
  const term = unwrapTerm(out)
  return {
    type: term && term.type,
    props: (term && term.props) || {},
    renderError: term ? term.renderError : undefined
  }
}
function asArray(v) {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object') return [v]
  return []
}
function reconcileKids(kids, oldKids) {
  const o = asArray(oldKids)
  const n = asArray(kids)
  for (let i = 0; i < n.length; i++) {
    if (n[i] && typeof n[i] === 'object') adopt(n[i], o[i])
  }
}
function adopt(node, oldNode) {
  if (!node || typeof node !== 'object') return
  if (node.__frame === undefined || typeof node.__origType !== 'function') {
    // host element: nothing to re-invoke; walk children positionally
    if (node.props) reconcileKids(node.props.children, oldNode && oldNode.props ? oldNode.props.children : undefined)
    return
  }
  if (oldNode && oldNode.__origType === node.__origType && oldNode.__frame) {
    node.__frame = oldNode.__frame // state persists across re-renders
  }
  node.__frame.idx = 0
  const prev = globalThis.__nwCurrentFrame
  globalThis.__nwCurrentFrame = node.__frame
  let out
  try { out = node.__origType(node.__callProps || {}) } finally { globalThis.__nwCurrentFrame = prev }
  const norm = normalizeOut(out)
  node.type = norm.type; node.props = norm.props; node.renderError = norm.renderError
  reconcileKids(node.props.children, oldNode && oldNode.props ? oldNode.props.children : undefined)
}
function deepRerender(root) {
  if (!root || typeof root !== 'object') return root
  if (root.__frame !== undefined && typeof root.__origType === 'function') {
    const oldChildren = root.props ? root.props.children : undefined
    root.__frame.idx = 0
    const prev = globalThis.__nwCurrentFrame
    globalThis.__nwCurrentFrame = root.__frame
    let out
    try { out = root.__origType(root.__callProps || {}) } finally { globalThis.__nwCurrentFrame = prev }
    const norm = normalizeOut(out)
    root.type = norm.type; root.props = norm.props; root.renderError = norm.renderError
    reconcileKids(root.props.children, oldChildren)
  } else if (root.props) {
    reconcileKids(root.props.children, undefined)
  }
  return root
}

const jsx = (type, props) => {
  if (typeof type === 'function') return invokeComponent(type, props)
  return { type, props: props || {}, $$jsx: true }
}
const jsxs = jsx

// ---------------------------------------------------------------------------
// Scriptable query + rest layer
// ---------------------------------------------------------------------------

globalThis.__nwQueries = {}
const Q = globalThis.__nwQueries

const restLog = []
let restBehavior = () => ({ body: {} })
const scriptRest = fn => { restBehavior = fn }
const setQuery = (key, data) => { Q[key] = { data } }
const clearQueries = () => { for (const k of Object.keys(Q)) delete Q[k] }

const SETTINGS = {
  refresh_interval: 300, max_article_age_hours: 168, max_headlines: 500,
  ticker_enabled: true, ticker_speed: 'normal', ticker_font_size: 11,
  ticker_grouping: 'newest', pause_on_hover: true, show_source: true,
  relative_time: true, open_article_behavior: 'internal', only_unread: false
}

function useQuery(options) {
  const key = options && Array.isArray(options.queryKey) ? options.queryKey.join('|') : ''
  // Icon queries run through the harness's scripted rest() door. Memoize by
  // key (React Query caches across renders; a bare promise would re-fetch and
  // never resolve before the synchronous return).
  if (key.includes('|icon')) {
    const cache = (globalThis.__nwIconCache = globalThis.__nwIconCache || {})
    let st = cache[key]
    if (!st) {
      st = cache[key] = { data: undefined, error: null }
      void Promise.resolve()
        .then(() => options.queryFn())
        .then(d => { st.data = d })
        .catch(e => { st.error = e })
    }
    return {
      get data() { return st.data },
      get error() { return st.error },
      get isLoading() { return st.data === undefined && !st.error },
      get isError() { return !!st.error },
      refetch: async () => {}
    }
  }
  const q = globalThis.__nwQueries || {}
  let st = { data: undefined, error: null }
  if (key.includes('|settings') && q['hermes-newswire|settings']) st = q['hermes-newswire|settings']
  else if (key.includes('|sources') && q['hermes-newswire|sources']) st = q['hermes-newswire|sources']
  else if (key.includes('ticker') && q['hermes-newswire|ticker']) st = q['hermes-newswire|ticker']
  else if (key.includes('|articles') && q['hermes-newswire|articles']) st = q['hermes-newswire|articles']
  return {
    data: st.data, error: st.error || null,
    isLoading: st.data === undefined && !st.error,
    isError: !!st.error,
    refetch: async () => {}
  }
}

const useMutation = options => ({
  mutate: vars => {
    void Promise.resolve().then(() => options.mutationFn(vars))
      .then(d => options.onSuccess && options.onSuccess(d, vars))
      .catch(e => options.onError && options.onError(e, vars))
  },
  isPending: false
})

// ---------------------------------------------------------------------------
// SDK + runtime stubs
// ---------------------------------------------------------------------------

const calls = globalThis.__nwCalls = { notify: [], hostRequest: [] }
const hostStub = {
  navigate: () => {},
  notify: input => globalThis.__nwCalls.notify.push(input),
  notifyError: (e, fallback) => globalThis.__nwCalls.notify.push({ kind: 'error', message: fallback || String(e) }),
  request: async (method, params) => { globalThis.__nwCalls.hostRequest.push({ method, params }); return { status: 'streaming' } },
  state: {
    focusedSessionId: { get: () => 'sess-1' },
    activeSessionId: { get: () => 'sess-1' },
    busyBySession: { get: () => ({}) }
  }
}
const atom = initial => {
  let value = initial
  return { get: () => value, set: v => { value = v }, subscribe: () => () => {} }
}
const useValue = a => (a && typeof a.get === 'function' ? a.get() : undefined)

const sdkPlain = {
  Badge: 'Badge', Button: 'Button', ConfirmDialog: 'ConfirmDialog',
  Dialog: 'Dialog', DialogContent: 'DialogContent', DialogDescription: 'DialogDescription',
  DialogFooter: 'DialogFooter', DialogHeader: 'DialogHeader', DialogTitle: 'DialogTitle',
  EmptyState: 'EmptyState', ErrorState: 'ErrorState', GlyphSpinner: 'GlyphSpinner',
  Input: 'Input', PALETTE_AREA: 'palette', ROUTES_AREA: 'routes',
  ScrollArea: 'ScrollArea', SearchField: 'SearchField', SegmentedControl: 'SegmentedControl',
  Separator: 'Separator', SIDEBAR_NAV_AREA: 'sidebar.nav', Switch: 'Switch'
}

const sdkStubSource = [
  `const unwrapTerm = ${unwrapTerm.toString()}`,
  `const __atom = ${atom.toString()}`,
  `const __useValue = ${useValue.toString()}`,
  `const __useMutation = ${useMutation.toString()}`,
  `const __useQuery = ${useQuery.toString()}`,
  `const __host = ${serializeHost(hostStub)}`,
  `const sdk = ${JSON.stringify(sdkPlain, null, 2)}`,
  'sdk.host = __host',
  'sdk.atom = __atom',
  'sdk.useValue = __useValue',
  'sdk.useMutation = __useMutation',
  'sdk.useQuery = __useQuery',
  'sdk.queryClient = { invalidateQueries: () => {} }',
  'export const queryClient = sdk.queryClient',
  'export default sdk',
  'export const atom = __atom',
  'export const useValue = __useValue',
  'export const useMutation = __useMutation',
  'export const useQuery = __useQuery',
  'export const host = __host',
  ...Object.keys(sdkPlain).map(k => `export const ${k} = sdk.${k}`),
  ''
].join('\n')

function serializeHost(h) {
  const lines = []
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === 'function') lines.push(`  ${k}: ${v.toString()}`)
    else if (v && typeof v === 'object' && k === 'state') {
      const stateLines = Object.entries(v).map(([sk, sv]) => {
        if (typeof sv === 'function') return `    ${sk}: ${sv.toString()}`
        if (sv && typeof sv.get === 'function') return `    ${sk}: { get: ${sv.get.toString()} }`
        return `    ${sk}: ${JSON.stringify(sv)}`
      }).join(',\n')
      lines.push(`  state: {\n${stateLines}\n  }`)
    } else if (v && typeof v === 'object') lines.push(`  ${k}: ${JSON.stringify(v)}`)
    else lines.push(`  ${k}: ${JSON.stringify(v)}`)
  }
  return `{\n${lines.join(',\n')}\n}`
}

rmSync(STUBS_DIR, { recursive: true, force: true })
mkdirSync(STUBS_DIR, { recursive: true })
writeFileSync(join(STUBS_DIR, 'sdk.mjs'), sdkStubSource)
writeFileSync(join(STUBS_DIR, 'react.mjs'), [
  `export const useState = ${useState.toString()}`,
  `export const useEffect = ${useEffect.toString()}`,
  `export const useMemo = ${useMemo.toString()}`,
  `export const useRef = ${useRef.toString()}`,
  'export default { useState, useEffect, useMemo, useRef }'
].join('\n'))
writeFileSync(join(STUBS_DIR, 'jsx-runtime.mjs'), [
  `const unwrapTerm = ${unwrapTerm.toString()}`,
  `const __invoke = ${invokeComponent.toString()}`,
  `const __jsx = (type, props) => {
    if (typeof type === 'function') return __invoke(type, props)
    return { type, props: props || {}, $$jsx: true }
  }`,
  'export const jsx = __jsx',
  'export const jsxs = __jsx',
  'export const Fragment = \'Fragment\''
].join('\n'))

const loaderSrc = `const STUB_URLS = ${JSON.stringify({
  '@hermes/plugin-sdk': pathToFileURL(join(STUBS_DIR, 'sdk.mjs')).href,
  react: pathToFileURL(join(STUBS_DIR, 'react.mjs')).href,
  'react/jsx-runtime': pathToFileURL(join(STUBS_DIR, 'jsx-runtime.mjs')).href
})}
export function resolve(specifier, context, nextResolve) {
  if (STUB_URLS[specifier]) return { url: STUB_URLS[specifier], shortCircuit: true }
  return nextResolve(specifier, context)
}
`
rmSync(join(__dirname, 'interaction-loader.mjs'), { force: true })
writeFileSync(join(__dirname, 'interaction-loader.mjs'), loaderSrc)
register(new URL('./interaction-loader.mjs', import.meta.url))

// Minimal DOM shim
globalThis.document = {
  getElementById: () => null,
  createElement: tag => ({ tag, id: '', textContent: '', appendChild() {}, click() {} }),
  head: { appendChild: () => {} }
}
globalThis.window = globalThis.window || {}
globalThis.window.matchMedia = q => ({ matches: false, addEventListener() {}, removeEventListener() {} })
if (!globalThis.matchMedia) globalThis.matchMedia = globalThis.window.matchMedia

// ---------------------------------------------------------------------------
// Import the REAL plugin and register it
// ---------------------------------------------------------------------------

const plugin = (await import(pathToFileURL(PLUGIN_PATH).href + '?t=' + Date.now())).default

const contributions = []
const ctx = {
  rest: async (path, opts) => {
    restLog.push({ path, opts })
    const out = restBehavior({ path, opts })
    if (out && out.throw) throw out.throw
    return (out && out.body) || {}
  },
  os: { openExternal: async () => true },
  storage: { get: (k, fb) => (k === 'lastTab' ? (globalThis.__nwLastTab || fb) : fb), set: () => {} },
  onDispose: () => {},
  register: c => { contributions.push(c); return () => {} },
  registerMany: cs => { contributions.push(...cs); return () => {} }
}
plugin.register(ctx)
await flush()

const pageCont = contributions.find(c => c.area === 'routes')
const tickerCont = contributions.find(c => c.area === 'panes')

// Tree helpers: nodes are normalized {type, props} (component nodes carry
// __frame/__origType for deepRerender). children are nodes again.
function walk(node, fn, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return
  seen.add(node)
  if (node.props === undefined) return
  fn(node)
  const kids = node.props.children
  if (Array.isArray(kids)) kids.forEach(k => walk(k, fn, seen))
  else if (kids && typeof kids === 'object') walk(kids, fn, seen)
}
function flat(node) {
  const out = []
  walk(node, n => out.push(n))
  return out
}
const findAll = (node, pred) => flat(node).filter(n => pred(n))
const findButtons = (node, pred) =>
  findAll(node, n => (n.type === 'button' || typeof n.type === 'function') && n.props && pred(n))
const textOf = node => {
  let s = ''
  walk(node, n => {
    const c = n.props.children
    if (typeof c === 'string') s += c + ' '
    else if (Array.isArray(c)) for (const k of c) if (typeof k === 'string') s += k + ' '
    if (typeof n.props.label === 'string') s += n.props.label + ' '
    if (typeof n.props.placeholder === 'string') s += n.props.placeholder + ' '
    if (typeof n.props.title === 'string') s += n.props.title + ' '
  })
  return s
}
const directText = n => {
  const c = n.props && n.props.children
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter(k => typeof k === 'string').join(' ')
  return ''
}

// ---------------------------------------------------------------------------
// Seed healthy default queries, then render the page
// ---------------------------------------------------------------------------

setQuery('hermes-newswire|settings', SETTINGS)
setQuery('hermes-newswire|sources', { data: [] })
Q['hermes-newswire|sources'] = { data: [] }
Q['hermes-newswire|articles'] = { data: { items: [], total: 0 } }
Q['hermes-newswire|ticker'] = { data: [] }

let pageNode = pageCont.render()
await flush()
if (process.env.__NW_DEBUG) {
  console.log('DEBUG pageNode:', JSON.stringify(pageNode, (k, v) => {
    if (typeof v === 'function') return 'ƒ:' + (v.name || 'anon')
    if (v instanceof Error) return 'ERR:' + v.message
    return v
  }).slice(0, 800))
}

// ---------------------------------------------------------------------------
// 1) Tab navigation: Latest -> Settings opens and renders
// ---------------------------------------------------------------------------

let tabs = findButtons(pageNode, n => n.props.role === 'tab')
check(tabs.length === 3, 'page shows three tabs, got ' + tabs.length)
const settingsTab = tabs.find(t => directText(t).includes('Settings'))
check(!!settingsTab, 'Settings tab exists')
if (!settingsTab) {
  console.log(`FAILURES: ${failures} of ${checks}`)
  process.exit(1)
}
settingsTab.props.onClick()
await flush()
deepRerender(pageNode) // in-place re-render: tab state persists in the frame
const settingsText = textOf(pageNode)
check(settingsText.includes('Ticker enabled'), 'Settings renders ticker controls')
check(settingsText.includes('Scroll speed'), 'Settings renders speed control')
check(settingsText.includes('Open articles in'), 'Settings renders article-open control')

// ---------------------------------------------------------------------------
// 2) Flipping a setting PATCHes /settings with the right body
// ---------------------------------------------------------------------------

restLog.length = 0
scriptRest(({ path, opts }) => {
  if (path === '/settings' && opts && opts.method === 'PATCH') return { body: { ok: true } }
  return { body: {} }
})
const switches = findAll(pageNode, n => n.type === 'Switch' && n.props && typeof n.props.onCheckedChange === 'function')
check(switches.length >= 3, 'settings controls render switches, got ' + switches.length)
const pauseSwitch = switches[0] // first row = Ticker enabled
pauseSwitch.props.onCheckedChange(!pauseSwitch.props.checked)
await flush()
deepRerender(pageNode)
const patchCall = restLog.find(c => c.path === '/settings' && c.opts && c.opts.method === 'PATCH')
check(!!patchCall, 'setting change issued PATCH /settings')
check(patchCall && patchCall.opts.body && Object.keys(patchCall.opts.body).length === 1, 'PATCH body carries exactly the changed key')

// ---------------------------------------------------------------------------
// 3) A failed settings save surfaces a visible error (no silent failure)
// ---------------------------------------------------------------------------

scriptRest(({ path, opts }) => {
  if (path === '/settings' && opts && opts.method === 'PATCH') {
    return { throw: new Error('request failed (400): {"code":"bad_value","message":"ticker_speed must be one of slow/normal/fast"}') }
  }
  return { body: {} }
})
const sw2 = findAll(pageNode, n => n.type === 'Switch' && n.props && typeof n.props.onCheckedChange === 'function')[0]
sw2.props.onCheckedChange(!sw2.props.checked)
await flush()
deepRerender(pageNode)
check(textOf(pageNode).includes('Could not save setting'), 'failed settings save shows inline error')
check(textOf(pageNode).includes('bad_value') || calls.notify.some(n => /could not save/i.test(n.message || '')), 'settings save error carries detail or toast')

// ---------------------------------------------------------------------------
// 4) Starter feeds: correct request, success path updates the list
// ---------------------------------------------------------------------------

clearQueries()
setQuery('hermes-newswire|settings', SETTINGS)
Q['hermes-newswire|sources'] = { data: [] } // empty -> starter card
globalThis.__nwLastTab = 'sources'
scriptRest(({ path, opts }) => {
  if (path === '/sources' && opts && opts.method === 'POST') return { body: { id: 1, ok: true } }
  return { body: {} }
})
restLog.length = 0
pageNode = pageCont.render() // fresh mount re-reads the storage-backed tab
await flush()
deepRerender(pageNode)
let chips = findButtons(pageNode, n => directText(n).startsWith('+ '))
check(chips.length >= 6, 'starter feed chips render, got ' + chips.length)
const vb = chips.find(c => directText(c).includes('VentureBeat AI'))
check(!!vb, 'VentureBeat AI starter chip exists')
if (vb) {
  check(vb.props['data-pending'] === '0' && vb.props.disabled === false, 'chip is enabled before click')
  vb.props.onClick()
  await flush()
  deepRerender(pageNode)
}
const addCall = restLog.find(c => c.path === '/sources' && c.opts && c.opts.method === 'POST')
check(!!addCall, 'starter click POSTs /sources')
check(addCall && addCall.opts.body.feed_url === 'https://venturebeat.com/category/ai/feed/', 'POST body carries the VentureBeat AI feed URL')
check(addCall && addCall.opts.body.name === 'VentureBeat AI' && addCall.opts.body.category === 'ai', 'POST body carries name + category')

// Success: sources query now returns one source -> starter card replaced by list
Q['hermes-newswire|sources'] = { data: [{ id: 1, name: 'VentureBeat AI', feed_url: 'https://venturebeat.com/category/ai/feed/', enabled: true }] }
await flush()
deepRerender(pageNode)
check(!textOf(pageNode).includes('Starter feeds (optional)'), 'successful add removes the starter card')
check(textOf(pageNode).includes('Sources (1)'), 'sources list reflects the addition')

// ---------------------------------------------------------------------------
// 5) Failed addition -> visible, actionable error (the reported defect)
// ---------------------------------------------------------------------------

clearQueries()
setQuery('hermes-newswire|settings', SETTINGS)
Q['hermes-newswire|sources'] = { data: [] }
restLog.length = 0
scriptRest(({ path, opts }) => {
  if (path === '/sources' && opts && opts.method === 'POST') {
    // Exact failure shape observed live: VentureBeat 429s the backend fetch.
    return { throw: new Error('upstream error (502): {"code":"fetch_failed","message":"HTTP 429 fetching https://venturebeat.com/category/ai/feed/"}') }
  }
  return { body: {} }
})
pageNode = pageCont.render()
await flush()
deepRerender(pageNode)
const vbChip = findButtons(pageNode, n => directText(n).startsWith('+ '))
  .find(c => directText(c).includes('VentureBeat AI'))
vbChip.props.onClick()
await flush()
deepRerender(pageNode)
const pageText = textOf(pageNode)
check(pageText.includes('VentureBeat AI could not be added'), 'failed add shows actionable inline error')
check(pageText.includes('HTTP 429'), 'error carries the backend detail (HTTP 429)')
check(findAll(pageNode, n => n.props && n.props.role === 'alert').length > 0, 'error is announced via role=alert')

// ---------------------------------------------------------------------------
// 6) In-flight guard: no duplicate submits while a POST is pending
// ---------------------------------------------------------------------------

clearQueries()
setQuery('hermes-newswire|settings', SETTINGS)
Q['hermes-newswire|sources'] = { data: [] }
restLog.length = 0
let releasePost
scriptRest(({ path, opts }) => {
  if (path === '/sources' && opts && opts.method === 'POST') {
    return { body: new Promise(resolve => { releasePost = resolve }) }
  }
  return { body: {} }
})
pageNode = pageCont.render()
await flush()
deepRerender(pageNode)
const hnChip = findButtons(pageNode, n => directText(n).startsWith('+ '))
  .find(c => directText(c).includes('Hacker News'))
check(!!hnChip, 'Hacker News starter chip exists')
if (hnChip) {
  hnChip.props.onClick()
  await flush()
  deepRerender(pageNode)
}
let pendingChips = findButtons(pageNode, n => directText(n).startsWith('+ '))
  .filter(c => c.props['data-pending'] === '1' || c.props.disabled === true)
check(pendingChips.length === 1, 'clicked chip shows pending state while in flight')
const postCount1 = restLog.filter(c => c.opts && c.opts.method === 'POST').length
pendingChips[0] && pendingChips[0].props.onClick && pendingChips[0].props.onClick()
await flush()
const postCount2 = restLog.filter(c => c.opts && c.opts.method === 'POST').length
check(postCount1 === 1 && postCount2 === 1, 'second click while pending does not re-POST')
releasePost({ id: 2, ok: true })
await flush()

// Duplicate response (409) renders the friendly message
clearQueries()
setQuery('hermes-newswire|settings', SETTINGS)
Q['hermes-newswire|sources'] = { data: [] }
scriptRest(({ path, opts }) => {
  if (path === '/sources' && opts && opts.method === 'POST') {
    return { throw: new Error('client error (409): {"code":"duplicate","message":"source already exists (id 3) for https://hnrss.org/frontpage"}') }
  }
  return { body: {} }
})
pageNode = pageCont.render()
await flush()
deepRerender(pageNode)
const dupChip = findButtons(pageNode, n => directText(n).startsWith('+ '))
  .find(c => directText(c).includes('Hacker News'))
check(!!dupChip, 'Hacker News chip exists for duplicate test')
if (dupChip) {
  dupChip.props.onClick()
  await flush()
  deepRerender(pageNode)
}
check(textOf(pageNode).includes('Hacker News is already in your sources'), 'duplicate add gets a friendly message')

// ---------------------------------------------------------------------------
// 7) Missing/failing backend -> diagnostic banner on Sources and Settings
// ---------------------------------------------------------------------------

clearQueries()
setQuery('hermes-newswire|settings', SETTINGS)
Q['hermes-newswire|sources'] = { error: new Error('request failed (404): {"code":"not_found","message":"No route /sources — plugin backend not mounted"}') }
scriptRest(() => ({ body: {} }))
globalThis.__nwLastTab = 'sources'
pageNode = pageCont.render()
await flush()
deepRerender(pageNode)
check(textOf(pageNode).includes('Could not reach the Newswire backend (sources)'), 'sources backend failure renders diagnostic banner')
check(textOf(pageNode).includes('plugins.enabled'), 'banner names the enable/install fix')

globalThis.__nwLastTab = 'settings'
Q['hermes-newswire|settings'] = { error: new Error('request failed (500): {"code":"backend_error","message":"database unavailable"}') }
pageNode = pageCont.render()
await flush()
deepRerender(pageNode)
check(textOf(pageNode).includes('Could not reach the Newswire backend (settings)'), 'settings backend failure renders diagnostic banner instead of a dead spinner')

// ---------------------------------------------------------------------------
// 8) Favicons go through the backend icon proxy (issue #6)
// ---------------------------------------------------------------------------

clearQueries()
setQuery('hermes-newswire|settings', SETTINGS)
Q['hermes-newswire|ticker'] = { data: [
  { id: 1, source_id: 1, title: 'Headline', source_name: 'Feed A', canonical_url: 'https://a.example/1', published_at: new Date().toISOString(), read: false, favicon_url: 'https://icons.example/favicon.ico' }
] }
// The renderer fetches the data: URL through rest('/icon.json?url=…') — the
// SDK's namespace-scoped JSON door — and uses the returned data_url as src.
const ICON_URL = 'https://icons.example/favicon.ico'
const ICON_DATA_URL = 'data:image/x-icon;base64,AAABAAEAA'
scriptRest(({ path }) => {
  if (path.startsWith('/icon.json?url=')) {
    return { body: { url: decodeURIComponent(path.split('url=')[1]), data_url: ICON_DATA_URL } }
  }
  return { body: {} }
})
let tickerNode = tickerCont.render()
for (let i = 0; i < 6; i++) {
  await flush()
  tickerNode = tickerCont.render() // fresh frames each render; queryFn memoized by real React cache in prod
}
const imgs = findAll(tickerNode, n => n.type === 'img' && n.props && n.props.src)
check(imgs.length >= 1, 'ticker renders favicon img from proxied data URL')
check(imgs[0] && imgs[0].props.src === ICON_DATA_URL,
  'favicon src is the data: URL fetched via rest(/icon.json), got ' + (imgs[0] && String(imgs[0].props.src).slice(0, 40)))
const iconCall = restLog.find(c => c.path.startsWith('/icon.json?url='))
check(!!iconCall && iconCall.path.includes(encodeURIComponent(ICON_URL)), 'renderer requested the icon through the backend proxy door')

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? `PASS: hermes-newswire interaction tests (${checks} checks)`
    : `FAILURES: ${failures} of ${checks}`
)
process.exit(failures === 0 ? 0 : 1)

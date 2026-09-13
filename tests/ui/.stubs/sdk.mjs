const __atom = initial => {
  let value = initial
  return {
    get: () => value,
    set: v => { value = v },
    subscribe: () => () => {}
  }
}
const __useValue = a => (a && typeof a.get === 'function' ? a.get() : undefined)
const __useMutation = options => ({
  mutate: vars => {
    if (options && typeof options.mutationFn === 'function') {
      Promise.resolve(options.mutationFn(vars)).catch(() => {})
    }
  },
  isPending: false
})
const stubQueryData = {"hermes-newswire|settings":{"refresh_interval":300,"max_article_age_hours":168,"max_headlines":500,"ticker_enabled":true,"ticker_speed":"normal","ticker_font_size":11,"pause_on_hover":true,"show_source":true,"relative_time":true,"only_unread":false},"hermes-newswire|sources":[],"ticker":[{"id":1,"source_id":1,"title":"First headline","source_name":"Feed A","canonical_url":"https://a.example/1","published_at":"2026-09-13T19:08:41.015Z","read":false},{"id":2,"source_id":2,"title":"Second headline","source_name":"Feed B","canonical_url":"https://b.example/2","published_at":"2026-09-13T18:09:41.015Z","read":true}],"articles":{"items":[{"id":1,"source_id":1,"title":"First headline","source_name":"Feed A","canonical_url":"https://a.example/1","published_at":"2026-09-13T19:08:41.015Z","read":false,"summary":"Sum one"},{"id":2,"source_id":2,"title":"Second headline","source_name":"Feed B","canonical_url":"https://b.example/2","published_at":"2026-09-13T18:09:41.015Z","read":true,"summary":"Sum two"}],"total":2}}
const __useQuery = options => {
  const key = options && Array.isArray(options.queryKey) ? options.queryKey.join('|') : ''
  let data
  if (key.includes('|settings')) data = stubQueryData['hermes-newswire|settings']
  else if (key.includes('|sources')) data = stubQueryData['hermes-newswire|sources']
  else if (key.includes('ticker')) data = stubQueryData.ticker
  else if (key.includes('articles')) data = stubQueryData.articles
  return { data, isLoading: !data, isError: false, error: null, refetch: async () => {} }
}
const sdk = {
  "Badge": "Badge",
  "Button": "Button",
  "ConfirmDialog": "ConfirmDialog",
  "Dialog": "Dialog",
  "DialogContent": "DialogContent",
  "DialogDescription": "DialogDescription",
  "DialogFooter": "DialogFooter",
  "DialogHeader": "DialogHeader",
  "DialogTitle": "DialogTitle",
  "EmptyState": "EmptyState",
  "ErrorState": "ErrorState",
  "GlyphSpinner": "GlyphSpinner",
  "Input": "Input",
  "PALETTE_AREA": "palette",
  "ROUTES_AREA": "routes",
  "SearchField": "SearchField",
  "SegmentedControl": "SegmentedControl",
  "Separator": "Separator",
  "SIDEBAR_NAV_AREA": "sidebar.nav",
  "Switch": "Switch",
  "queryClient": {}
}
sdk.host = {
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
sdk.atom = __atom
sdk.useValue = __useValue
sdk.useMutation = __useMutation
sdk.useQuery = __useQuery
export default sdk
export const atom = __atom
export const useValue = __useValue
export const useMutation = __useMutation
export const useQuery = __useQuery
export const host = sdk.host
export const Badge = sdk.Badge
export const Button = sdk.Button
export const ConfirmDialog = sdk.ConfirmDialog
export const Dialog = sdk.Dialog
export const DialogContent = sdk.DialogContent
export const DialogDescription = sdk.DialogDescription
export const DialogFooter = sdk.DialogFooter
export const DialogHeader = sdk.DialogHeader
export const DialogTitle = sdk.DialogTitle
export const EmptyState = sdk.EmptyState
export const ErrorState = sdk.ErrorState
export const GlyphSpinner = sdk.GlyphSpinner
export const Input = sdk.Input
export const PALETTE_AREA = sdk.PALETTE_AREA
export const ROUTES_AREA = sdk.ROUTES_AREA
export const ScrollArea = sdk.ScrollArea
export const SearchField = sdk.SearchField
export const SegmentedControl = sdk.SegmentedControl
export const Separator = sdk.Separator
export const SIDEBAR_NAV_AREA = sdk.SIDEBAR_NAV_AREA
export const Switch = sdk.Switch
export const queryClient = sdk.queryClient

import type { ExchangeSummary } from '../../shared'

/** Resource types, as the chips in Chrome's Network panel group them. */
export const RESOURCE_TYPES = ['fetch', 'doc', 'css', 'js', 'font', 'img', 'media', 'other'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]
export const TYPE_LABELS: Record<ResourceType, string> = {
  fetch: 'Fetch/XHR',
  doc: 'Doc',
  css: 'CSS',
  js: 'JS',
  font: 'Font',
  img: 'Img',
  media: 'Media',
  other: 'Other',
}

/** Keys the filter box understands, as `key:value`. */
export const FILTER_KEYS = ['method', 'status-code', 'domain', 'path', 'app', 'mime-type', 'scheme', 'larger-than', 'smaller-than', 'is'] as const

const EXT: [RegExp, ResourceType][] = [
  [/\.(css)$/, 'css'],
  [/\.(m?js|cjs)$/, 'js'],
  [/\.(woff2?|ttf|otf|eot)$/, 'font'],
  [/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|heic)$/, 'img'],
  [/\.(mp4|webm|m3u8|ts|m4s|mp3|aac|ogg|wav|m4a|mpd)$/, 'media'],
  [/\.(html?)$/, 'doc'],
]

/** Best guess at the resource type from the response type, then the file extension. */
export function resourceType(e: Pick<ExchangeSummary, 'contentType' | 'path'>): ResourceType {
  const t = (e.contentType ?? '').toLowerCase().split(';')[0].trim()
  if (t) {
    if (t === 'text/html' || t === 'application/xhtml+xml') return 'doc'
    if (t === 'text/css') return 'css'
    if (/javascript|ecmascript/.test(t)) return 'js'
    if (t.startsWith('font/') || /font/.test(t)) return 'font'
    if (t.startsWith('image/')) return 'img'
    if (t.startsWith('video/') || t.startsWith('audio/') || /mpegurl|dash\+xml/.test(t)) return 'media'
    if (/json|xml|protobuf|proto|grpc|x-www-form-urlencoded|text\/plain|thrift|msgpack|cbor/.test(t)) return 'fetch'
  }
  const file = e.path.split(/[?#]/)[0].toLowerCase()
  for (const [re, type] of EXT) if (re.test(file)) return type
  return t ? 'other' : 'fetch'
}

interface Clause {
  negate: boolean
  test: (e: ExchangeSummary) => boolean
}

function bytes(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb)?$/i.exec(value)
  if (!m) return undefined
  const unit = (m[2] ?? '').toLowerCase()
  return Number(m[1]) * (unit.startsWith('m') ? 1048576 : unit.startsWith('k') ? 1024 : 1)
}

/** `*` matches anything; otherwise the value is a case-insensitive substring. */
function glob(value: string): (s: string) => boolean {
  const v = value.toLowerCase()
  if (!v.includes('*')) return (s) => s.toLowerCase().includes(v)
  const re = new RegExp(`^${v.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
  return (s) => re.test(s)
}

const hostOnly = (host: string) => host.replace(/:\d+$/, '')

function keyClause(key: string, value: string): ((e: ExchangeSummary) => boolean) | undefined {
  const values = value.split(',').filter(Boolean)
  if (values.length === 0) return undefined
  const any = (f: (v: string) => (e: ExchangeSummary) => boolean) => {
    const tests = values.map(f)
    return (e: ExchangeSummary) => tests.some((t) => t(e))
  }
  switch (key) {
    case 'method':
      return any((v) => (e) => e.method.toLowerCase() === v.toLowerCase())
    case 'status-code':
    case 'status':
      return any((v) => {
        // 4xx / 40x style ranges.
        const re = new RegExp(`^${v.replace(/x/gi, '\\d')}$`)
        return (e) => (e.state === 'aborted' ? v.toLowerCase() === 'aborted' : e.status !== undefined && re.test(String(e.status)))
      })
    case 'domain':
    case 'host':
      return any((v) => {
        const m = glob(v)
        return (e) => m(hostOnly(e.host))
      })
    case 'path':
      return any((v) => {
        const m = glob(v)
        return (e) => m(e.path)
      })
    case 'app':
      return any((v) => {
        const m = glob(v)
        return (e) => !!e.app && m(e.app)
      })
    case 'mime-type':
      return any((v) => {
        const m = glob(v)
        return (e) => !!e.contentType && m(e.contentType.split(';')[0].trim())
      })
    case 'scheme':
      return any((v) => (e) => e.url.toLowerCase().startsWith(`${v.toLowerCase()}:`))
    case 'larger-than':
    case 'smaller-than': {
      const n = bytes(value)
      if (n === undefined) return undefined
      return key === 'larger-than' ? (e) => (e.responseBodySize ?? 0) > n : (e) => (e.responseBodySize ?? 0) < n
    }
    case 'is':
      return any((v) => {
        const s = v.toLowerCase()
        if (s === 'running' || s === 'pending') return (e) => e.state === 'pending'
        if (s === 'aborted' || s === 'failed') return (e) => e.state === 'aborted'
        if (s === 'error') return (e) => e.state === 'aborted' || (e.status ?? 0) >= 400
        if (s === 'tagged') return (e) => !!e.app
        return () => false
      })
    case 'type':
    case 'resource-type':
      return any((v) => (e) => resourceType(e) === v.toLowerCase())
  }
  return undefined
}

/** Splits on spaces, keeping `"quoted text"` and `/regex with spaces/` whole. */
function tokens(query: string): string[] {
  return query.match(/-?\/(?:\\.|[^/])+\/[a-z]*|-?[\w-]+:"[^"]*"|-?"[^"]*"|\S+/gi) ?? []
}

/**
 * Parses a Chrome-style network filter. Space-separated terms must all match.
 * - `text`: the URL contains it. `-text` excludes.
 * - `/regex/`: the URL matches.
 * - `key:value`: see FILTER_KEYS. Commas mean "any of": `method:POST,PUT`. `*` is a wildcard in domain, path, app and mime-type.
 * An unknown `key:value` is treated as plain text, so URLs like `http://` still work.
 */
export function parseFilter(query: string): (e: ExchangeSummary) => boolean {
  const clauses: Clause[] = []
  for (let token of tokens(query.trim())) {
    let negate = false
    if (token.length > 1 && token.startsWith('-')) {
      negate = true
      token = token.slice(1)
    }
    const regex = /^\/(.+)\/([a-z]*)$/i.exec(token)
    if (regex) {
      try {
        const re = new RegExp(regex[1], regex[2].includes('i') ? regex[2] : `${regex[2]}i`)
        clauses.push({ negate, test: (e) => re.test(e.url) })
        continue
      } catch {
        // Not a valid regex yet (still typing): fall through to plain text.
      }
    }
    const kv = /^([a-z-]+):(.*)$/i.exec(token)
    if (kv) {
      const test = keyClause(kv[1].toLowerCase(), kv[2].replace(/^"|"$/g, ''))
      if (test) {
        clauses.push({ negate, test })
        continue
      }
      // A known key with no value yet: ignore it while the user types.
      if ((FILTER_KEYS as readonly string[]).includes(kv[1].toLowerCase()) && kv[2] === '') continue
    }
    const text = token.replace(/^"|"$/g, '').toLowerCase()
    if (!text) continue
    clauses.push({ negate, test: (e) => e.url.toLowerCase().includes(text) })
  }
  if (clauses.length === 0) return () => true
  return (e) => clauses.every((c) => c.test(e) !== c.negate)
}

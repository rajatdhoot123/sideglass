import { toCurl } from './curl'
import { toHar } from './har'
import type { Exchange } from './proxy'

/** Formats a person can open in another tool without converting the file first. */
export const SAVE_FORMATS = ['har', 'postman', 'curl', 'http'] as const
export type SaveFormat = (typeof SAVE_FORMATS)[number]
/** `one` is a single file. `each` is a folder with one file per request. */
export type SaveLayout = 'one' | 'each'

export interface SaveRequest {
  ids: string[]
  format: SaveFormat
  layout: SaveLayout
}

const SKIP = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'x-sideglass-app'])

export function isSaveFormat(value: unknown): value is SaveFormat {
  return value === 'har' || value === 'postman' || value === 'curl' || value === 'http'
}

export function saveExtension(format: SaveFormat): string {
  return { har: 'har', postman: 'json', curl: 'sh', http: 'http' }[format]
}

export function saveFilterName(format: SaveFormat): string {
  return { har: 'HAR', postman: 'Postman collection', curl: 'cURL script', http: 'HTTP file' }[format]
}

/** Checks the arguments from the window before any file dialog opens. */
export function parseSaveRequest(ids: unknown, format: unknown, layout: unknown): SaveRequest {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('Nothing to save')
  if (ids.length > 20000) throw new Error('Too many requests to save at once')
  if (!ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 500 && !/[\0\r\n]/.test(id))) {
    throw new Error('Nothing to save')
  }
  if (!isSaveFormat(format) || (layout !== 'one' && layout !== 'each')) throw new Error('Pick a format')
  return { ids, format, layout }
}

/**
 * Every selected call in one document.
 * HAR and Postman keep the response. cURL and HTTP are the request, so they can be sent again.
 */
export function renderCalls(exchanges: Exchange[], format: SaveFormat): string {
  switch (format) {
    case 'har':
      return `${JSON.stringify(toHar(exchanges), null, 2)}\n`
    case 'postman':
      return `${JSON.stringify(toPostman(exchanges), null, 2)}\n`
    case 'curl':
      return toCurlScript(exchanges)
    case 'http':
      return toHttpFile(exchanges)
  }
}

/** `index` starts at 1. The result is a single file name, never a path. */
export function callFileName(exchange: Exchange, index: number, total: number, format: SaveFormat): string {
  const width = Math.max(3, String(Math.max(total, 1)).length)
  const n = String(index).padStart(width, '0')
  const host = exchange.host.replace(/:\d+$/, '')
  const path = exchange.path.split(/[?#]/)[0]
  const raw = `${n}-${exchange.method}-${host}${path}`
  // Dots stay (host names). A slash or `..` would make this a path, so neither survives.
  const clean = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return `${(clean || n).slice(0, 80)}.${saveExtension(format)}`
}

/** One name per call. A name already in `taken`, or already used in this batch, gets `-2`, `-3`, … */
export function fileNames(exchanges: Exchange[], format: SaveFormat, taken: (name: string) => boolean = () => false): string[] {
  const used = new Set<string>()
  return exchanges.map((exchange, index) => {
    const name = unusedName(callFileName(exchange, index + 1, exchanges.length, format), (candidate) => taken(candidate) || used.has(candidate))
    used.add(name)
    return name
  })
}

export function unusedName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base}-${n}${ext}`
    if (!taken(candidate)) return candidate
  }
  throw new Error('Could not pick a file name')
}

/** A stand-in Sideglass shows instead of a body. Sending it again would not be the real call. */
function replayBody(body?: string): string | undefined {
  if (!body) return undefined
  if (/^<\d+ bytes, too large to show>$/.test(body)) return undefined
  if (/^<binary, \d+ bytes>$/.test(body)) return undefined
  return body
}

function note(exchange: Exchange): string {
  const bits: string[] = []
  if (exchange.state === 'aborted') bits.push('aborted')
  else if (exchange.status !== undefined) bits.push(`${exchange.status}${exchange.statusMessage ? ` ${exchange.statusMessage}` : ''}`)
  if (exchange.durationMs !== undefined) bits.push(`${exchange.durationMs} ms`)
  if (exchange.app) bits.push(exchange.app)
  return bits.join(' · ')
}

function itemName(exchange: Exchange): string {
  const path = exchange.path.split(/[?#]/)[0] || '/'
  const host = exchange.host.replace(/:\d+$/, '')
  const name = `${exchange.method} ${host}${path}`
  return name.length > 140 ? `${name.slice(0, 139)}…` : name
}

function headerList(
  headers: Record<string, string | string[] | undefined> | undefined,
  replay: boolean,
): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined || name.startsWith(':')) continue
    if (replay && SKIP.has(name.toLowerCase())) continue
    for (const item of Array.isArray(value) ? value : [value]) {
      // A newline in a header would become a second header when the file is read back.
      const text = item.replace(/[\r\n]+/g, ' ')
      if (text) out.push({ key: name, value: text })
    }
  }
  return out
}

function bodyLanguage(contentType: string | undefined, body: string): 'json' | 'xml' | undefined {
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('json') || /^\s*[[{]/.test(body)) return 'json'
  if (type.includes('xml')) return 'xml'
  return undefined
}

function postmanRequest(exchange: Exchange): Record<string, unknown> {
  const header = headerList(exchange.requestHeaders, true)
  const body = replayBody(exchange.requestBody)
  const contentType = header.find((item) => item.key.toLowerCase() === 'content-type')?.value
  const request: Record<string, unknown> = { method: exchange.method, header, url: exchange.url }
  const about = note(exchange)
  if (about) request.description = about
  if (body !== undefined) {
    const language = bodyLanguage(contentType, body)
    request.body = { mode: 'raw', raw: body, ...(language ? { options: { raw: { language } } } : {}) }
  }
  return request
}

function toPostman(exchanges: Exchange[]): object {
  return {
    info: {
      name: 'Sideglass capture',
      description: `${exchanges.length} request${exchanges.length === 1 ? '' : 's'} saved from Sideglass`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: exchanges.map((exchange) => {
      const request = postmanRequest(exchange)
      const saved =
        exchange.state !== 'aborted' && exchange.status !== undefined
          ? {
              name: note(exchange) || String(exchange.status),
              originalRequest: request,
              status: exchange.statusMessage ?? '',
              code: exchange.status,
              header: headerList(exchange.responseHeaders, false),
              body: exchange.responseBody ?? '',
            }
          : undefined
      return { name: itemName(exchange), request, ...(saved ? { response: [saved] } : {}) }
    }),
  }
}

function toCurlScript(exchanges: Exchange[]): string {
  const lines = ['#!/bin/sh', `# Sideglass — ${exchanges.length} request${exchanges.length === 1 ? '' : 's'}`, '']
  for (const exchange of exchanges) {
    const about = note(exchange)
    lines.push(`# ${exchange.method} ${exchange.url}${about ? ` — ${about}` : ''}`)
    const requestHeaders: Record<string, string> = {}
    for (const header of headerList(exchange.requestHeaders, true)) {
      const previous = requestHeaders[header.key]
      requestHeaders[header.key] = previous ? `${previous}, ${header.value}` : header.value
    }
    lines.push(toCurl({ method: exchange.method, url: exchange.url, requestHeaders, requestBody: replayBody(exchange.requestBody) }))
    lines.push('')
  }
  return `${lines.join('\n')}`
}

/** VS Code REST Client and the JetBrains HTTP client both read this. */
function toHttpFile(exchanges: Exchange[]): string {
  const blocks = exchanges.map((exchange) => {
    const lines = [`### ${itemName(exchange)}`]
    const about = note(exchange)
    if (about) lines.push(`# ${about}`)
    lines.push(`${exchange.method} ${exchange.url}`)
    for (const header of headerList(exchange.requestHeaders, true)) lines.push(`${header.key}: ${header.value}`)
    const body = replayBody(exchange.requestBody)
    if (body !== undefined) {
      lines.push('')
      lines.push(body)
    }
    return lines.join('\n')
  })
  return `${blocks.join('\n\n')}\n`
}

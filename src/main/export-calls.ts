import { curlStdin, isHeaderName, joinHeader, oneLine, REPLAY_SKIP, toCurl } from './curl'
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

/** One name per call. Each starts with its own index, so no two are the same. */
export function fileNames(exchanges: Exchange[], format: SaveFormat): string[] {
  return exchanges.map((exchange, index) => callFileName(exchange, index + 1, exchanges.length, format))
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

/**
 * The body to send again. `text` goes in the file as is. `bytes` is protobuf or gRPC: the captured text
 * is Sideglass's decoded view of it, so only the raw bytes are the real call. `left` says why a body
 * that was captured is not in the file.
 */
interface ReplayBody {
  text?: string
  bytes?: Buffer
  left?: string
}

const PROTOBUF_LEFT = 'Body left out: it is binary protobuf, which this format cannot hold. Save as cURL to send it.'

function replayBody(exchange: Exchange): ReplayBody {
  const body = exchange.requestBody
  if (!body || exchange.method === 'GET' || exchange.method === 'HEAD') return {}
  const protobuf = isProtobuf(exchange)
  const placeholder = /^<\d+ bytes, too large to show>$/.test(body) || /^<binary, \d+ bytes>$/.test(body)
  // A failed decode still stores the raw buffer. The placeholder is only the text view.
  if (placeholder && protobuf && exchange.requestBytes) {
    return { bytes: exchange.requestBytes, left: PROTOBUF_LEFT }
  }
  if (placeholder) {
    return {
      left: protobuf
        ? 'Body left out: it is binary protobuf and the raw bytes were not kept.'
        : 'Body left out: Sideglass did not keep it as text.',
    }
  }
  if (protobuf) {
    return exchange.requestBytes ? { bytes: exchange.requestBytes, left: PROTOBUF_LEFT } : { left: 'Body left out: it is binary protobuf and the raw bytes were not kept.' }
  }
  return { text: body }
}

function isProtobuf(exchange: Exchange): boolean {
  const type = requestHeader(exchange, 'content-type').toLowerCase()
  return type.includes('grpc') || type.includes('protobuf')
}

function requestHeader(exchange: Exchange, name: string): string {
  for (const [key, value] of Object.entries(exchange.requestHeaders ?? {})) {
    if (key.toLowerCase() === name && value !== undefined) return Array.isArray(value) ? value.join(', ') : value
  }
  return ''
}

function note(exchange: Exchange): string {
  const bits: string[] = []
  if (exchange.state === 'aborted') bits.push('aborted')
  else if (exchange.status !== undefined) bits.push(`${exchange.status}${exchange.statusMessage ? ` ${exchange.statusMessage}` : ''}`)
  if (exchange.durationMs !== undefined) bits.push(`${exchange.durationMs} ms`)
  if (exchange.app) bits.push(exchange.app)
  return oneLine(bits.join(' · '))
}

function itemName(exchange: Exchange): string {
  const path = exchange.path.split(/[?#]/)[0] || '/'
  const host = exchange.host.replace(/:\d+$/, '')
  const name = oneLine(`${exchange.method} ${host}${path}`)
  return name.length > 140 ? `${name.slice(0, 139)}…` : name
}

function headerList(
  headers: Record<string, string | string[] | undefined> | undefined,
  replay: boolean,
): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  // A control character in a value would become a second header when the file is read back.
  const clean = (text: string) => oneLine(text)
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined || !isHeaderName(name)) continue
    if (replay && REPLAY_SKIP.has(name.toLowerCase())) continue
    const items = Array.isArray(value) ? value : [value]
    // A request sends repeated headers as one line. Cookies split over HTTP/2 frames join with `; `.
    if (replay) {
      const text = clean(joinHeader(name, items.filter(Boolean)))
      if (text) out.push({ key: name, value: text })
      continue
    }
    for (const item of items) {
      const text = clean(item)
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
  const body = replayBody(exchange)
  const contentType = header.find((item) => item.key.toLowerCase() === 'content-type')?.value
  const request: Record<string, unknown> = { method: oneLine(exchange.method), header, url: oneLine(exchange.url) }
  const about = [note(exchange), body.left].filter(Boolean).join('\n\n')
  if (about) request.description = about
  if (body.text !== undefined) {
    const language = bodyLanguage(contentType, body.text)
    request.body = { mode: 'raw', raw: body.text, ...(language ? { options: { raw: { language } } } : {}) }
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
      const header = request.header as { value: string }[]
      const raw = (request.body as { raw?: unknown } | undefined)?.raw
      const texts = [String(request.url), ...header.map((item) => item.value), ...(typeof raw === 'string' ? [raw] : [])]
      const exec = literalBraces(texts)
      return {
        name: itemName(exchange),
        ...(exec ? { event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec } }] } : {}),
        request,
        ...(saved ? { response: [saved] } : {}),
      }
    }),
  }
}

/**
 * Postman replaces `{{name}}` before sending, including `$guid` and any workspace variable.
 * A local variable set to that same text wins, and the script never writes the brace pair or Postman would replace it too.
 */
function literalBraces(texts: string[]): string[] | undefined {
  const tokens = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) tokens.add(match[1])
  }
  if (tokens.size === 0) return undefined
  const lines = ['// Keep captured braces literal. A local variable outranks a workspace or dynamic one.']
  for (const token of tokens) {
    lines.push(`pm.variables.set(${JSON.stringify(token)}, "{" + "{" + ${JSON.stringify(token)} + "}" + "}");`)
  }
  return lines
}

function toCurlScript(exchanges: Exchange[]): string {
  const lines = ['#!/bin/sh', `# Sideglass — ${exchanges.length} request${exchanges.length === 1 ? '' : 's'}`, '']
  for (const exchange of exchanges) {
    const about = note(exchange)
    lines.push(`# ${oneLine(exchange.method)} ${oneLine(exchange.url)}${about ? ` — ${about}` : ''}`)
    const requestHeaders: Record<string, string> = {}
    for (const header of headerList(exchange.requestHeaders, true)) requestHeaders[header.key] = header.value
    const body = replayBody(exchange)
    const command = toCurl({ method: exchange.method, url: exchange.url, requestHeaders })
    if (body.bytes || body.text !== undefined) {
      lines.push(curlStdin(command, body.bytes ?? Buffer.from(body.text ?? '')))
    } else {
      if (body.left) lines.push(`# ${oneLine(body.left)}`)
      lines.push(command)
    }
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
    const body = replayBody(exchange)
    // This format has no escape: a `###` line starts the next request, and `{{name}}` is a variable.
    const left = body.text !== undefined && /^###|\{\{/m.test(body.text) ? 'Body left out: it contains ### or {{, which this format reads as syntax. Save as cURL or Postman to keep it.' : body.left
    if (left) lines.push(`# ${left}`)
    lines.push(`${oneLine(exchange.method)} ${oneLine(exchange.url)}`)
    for (const header of headerList(exchange.requestHeaders, true)) lines.push(`${header.key}: ${header.value}`)
    if (body.text !== undefined && !left) {
      lines.push('')
      lines.push(body.text)
    }
    return lines.join('\n')
  })
  return `${blocks.join('\n\n')}\n`
}

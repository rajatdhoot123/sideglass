import type { CurlRequest } from './curl'
import type { Exchange } from './proxy'

export interface ReplayEdit {
  url?: string
  method?: string
  body?: string
}

const SKIP = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'x-sideglass-app'])

/** Send a captured request from this computer and return it as a new exchange. */
export async function sendReplay(request: CurlRequest, edit?: ReplayEdit): Promise<Exchange> {
  const url = edit?.url?.trim() || request.url
  const method = (edit?.method?.trim() || request.method).toUpperCase()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Replay needs a full http or https URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Replay only sends http and https')
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.requestHeaders)) {
    if (value === undefined || name.startsWith(':') || SKIP.has(name.toLowerCase())) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  const body = edit?.body !== undefined ? edit.body : request.requestBody
  const started = Date.now()
  const response = await fetch(parsed, {
    method,
    headers,
    body: body && method !== 'GET' && method !== 'HEAD' ? body : undefined,
  })
  const text = await response.text()
  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  const requestHeaders: Record<string, string> = {}
  headers.forEach((value, key) => {
    requestHeaders[key] = value
  })
  return {
    id: `replay-${started}`,
    startedAt: started,
    method,
    url: parsed.toString(),
    host: parsed.host,
    path: parsed.pathname + parsed.search,
    httpVersion: '1.1',
    requestHeaders,
    requestBody: body,
    requestBodySize: body?.length ?? 0,
    status: response.status,
    statusMessage: response.statusText,
    responseHeaders,
    responseBody: text,
    responseBodySize: Buffer.byteLength(text),
    durationMs: Date.now() - started,
    state: 'done',
    contentType: response.headers.get('content-type') ?? '',
  }
}

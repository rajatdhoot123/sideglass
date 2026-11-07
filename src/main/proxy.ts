import { EventEmitter } from 'node:events'
import * as mockttp from 'mockttp'
import type { CaFiles } from './certificate'

/** One HTTP exchange as the UI shows it. Bodies are kept as text when they decode as UTF-8. */
export interface Exchange {
  id: string
  startedAt: number
  method: string
  url: string
  host: string
  path: string
  httpVersion: string
  requestHeaders: Record<string, string | string[] | undefined>
  requestBody?: string
  requestBodySize: number
  status?: number
  statusMessage?: string
  responseHeaders?: Record<string, string | string[] | undefined>
  responseBody?: string
  responseBodySize?: number
  durationMs?: number
  state: 'pending' | 'done' | 'aborted'
  contentType?: string
}

/** A TLS handshake the app refused: usually certificate pinning. */
export interface TlsFailure {
  id: string
  at: number
  host: string
  cause: string
}

export type ExchangeSummary = Omit<Exchange, 'requestHeaders' | 'requestBody' | 'responseHeaders' | 'responseBody'>

const MAX_BODY = 2 * 1024 * 1024
const MAX_EXCHANGES = 5000

async function bodyText(body: { getDecodedBuffer(): Promise<Buffer | undefined>; buffer: Buffer }): Promise<{ text?: string; size: number }> {
  const decoded = (await body.getDecodedBuffer().catch(() => undefined)) ?? body.buffer
  const size = decoded.length
  if (size === 0) return { size }
  if (size > MAX_BODY) return { text: `<${size} bytes, too large to show>`, size }
  const text = decoded.toString('utf8')
  // Mostly-printable means text; otherwise show it as binary.
  const bad = text.match(/[\u0000-\u0008\u000e-\u001f\ufffd]/g)?.length ?? 0
  if (bad > text.length * 0.05) return { text: `<binary, ${size} bytes>`, size }
  return { text, size }
}

export function summarize(e: Exchange): ExchangeSummary {
  const { requestHeaders: _a, requestBody: _b, responseHeaders: _c, responseBody: _d, ...rest } = e
  return rest
}

/**
 * The intercepting proxy. Every request is passed through to the real server unchanged and
 * recorded. Non-HTTP traffic in a tunnel is passed through untouched.
 */
export class CaptureProxy extends EventEmitter {
  private server: mockttp.Mockttp | null = null
  readonly exchanges = new Map<string, Exchange>()
  readonly tlsFailures: TlsFailure[] = []

  get port(): number {
    if (!this.server) throw new Error('proxy not started')
    return this.server.port
  }

  async start(ca: CaFiles, port?: number): Promise<number> {
    const server = mockttp.getLocal({
      https: { key: ca.key, cert: ca.cert },
      http2: 'fallback',
      passthrough: ['unknown-protocol'],
      recordTraffic: false,
    })
    await server.start(port ? { startPort: port, endPort: port + 50 } : undefined)
    await server.forAnyRequest().thenPassThrough({ ignoreHostHttpsErrors: false })
    await server.forAnyWebSocket().thenPassThrough()

    await server.on('request', async (req) => {
      const body = await bodyText(req.body)
      const url = new URL(req.url)
      const e: Exchange = {
        id: req.id,
        startedAt: req.timingEvents.startTime,
        method: req.method,
        url: req.url,
        host: url.host,
        path: url.pathname + url.search,
        httpVersion: req.httpVersion,
        requestHeaders: req.headers,
        requestBody: body.text,
        requestBodySize: body.size,
        state: 'pending',
      }
      this.exchanges.set(e.id, e)
      this.trim()
      this.emit('exchange', summarize(e))
    })
    await server.on('response', async (res) => {
      const e = this.exchanges.get(res.id)
      if (!e) return
      const body = await bodyText(res.body)
      e.status = res.statusCode
      e.statusMessage = res.statusMessage
      e.responseHeaders = res.headers
      e.responseBody = body.text
      e.responseBodySize = body.size
      e.contentType = String(res.headers['content-type'] ?? '')
      const t = res.timingEvents
      e.durationMs = t.responseSentTimestamp ? Math.round(t.responseSentTimestamp - t.startTimestamp) : undefined
      e.state = 'done'
      this.emit('exchange', summarize(e))
    })
    await server.on('abort', (req) => {
      const e = this.exchanges.get(req.id)
      if (!e) return
      e.state = 'aborted'
      this.emit('exchange', summarize(e))
    })
    await server.on('tls-client-error', (failure) => {
      const host = failure.tlsMetadata?.sniHostname ?? failure.destination?.hostname ?? failure.remoteIpAddress ?? 'unknown host'
      const entry: TlsFailure = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, at: Date.now(), host, cause: failure.failureCause }
      this.tlsFailures.push(entry)
      if (this.tlsFailures.length > 1000) this.tlsFailures.shift()
      this.emit('tls-failure', entry)
    })
    this.server = server
    return server.port
  }

  clear(): void {
    this.exchanges.clear()
    this.tlsFailures.length = 0
  }

  async stop(): Promise<void> {
    await this.server?.stop()
    this.server = null
  }

  private trim(): void {
    while (this.exchanges.size > MAX_EXCHANGES) {
      const first = this.exchanges.keys().next().value
      if (first === undefined) break
      this.exchanges.delete(first)
    }
  }
}

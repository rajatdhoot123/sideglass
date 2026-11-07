import { EventEmitter } from 'node:events'
import * as mockttp from 'mockttp'
import type { CaFiles } from './certificate'
import { presentBody } from './protobody'

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
  /** Package that owned the socket, when the phone's TCP table could say. */
  app?: string
  /** Input this request followed, when it started within two seconds. */
  inputId?: string
}

/** A TLS handshake the app refused: usually certificate pinning. */
export interface TlsFailure {
  id: string
  at: number
  host: string
  cause: string
}

export type ExchangeSummary = Omit<Exchange, 'requestHeaders' | 'requestBody' | 'responseHeaders' | 'responseBody'>

const MAX_EXCHANGES = 5000

async function bodyText(
  body: { getDecodedBuffer(): Promise<Buffer | undefined>; buffer: Buffer },
  contentType: string,
): Promise<{ text?: string; size: number }> {
  const decoded = (await body.getDecodedBuffer().catch(() => undefined)) ?? body.buffer
  return presentBody(decoded, contentType)
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
  /** Package for a request host, filled in after the phone's socket table is checked. */
  lookupApp?: (host: string, port: number) => Promise<string | undefined>
  /** Input id for a request that started at this time. */
  inputFor?: (at: number) => string | undefined

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
      const url = new URL(req.url)
      const type = String(req.headers['content-type'] ?? '')
      const body = await bodyText(req.body, type)
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
        inputId: this.inputFor?.(req.timingEvents.startTime),
      }
      this.exchanges.set(e.id, e)
      this.trim()
      this.emit('exchange', summarize(e))
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
      void this.tagApp(e, url.hostname, port)
    })
    await server.on('response', async (res) => {
      const e = this.exchanges.get(res.id)
      if (!e) return
      const body = await bodyText(res.body, String(res.headers['content-type'] ?? ''))
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

  /** Ask again once: the socket poll can land a moment after the request. */
  private async tagApp(e: Exchange, host: string, port: number): Promise<void> {
    if (!this.lookupApp) return
    let app = await this.lookupApp(host, port).catch(() => undefined)
    if (!app) {
      await new Promise((r) => setTimeout(r, 400))
      app = await this.lookupApp(host, port).catch(() => undefined)
    }
    if (!app || e.app || !this.exchanges.has(e.id)) return
    e.app = app
    this.emit('exchange', summarize(e))
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

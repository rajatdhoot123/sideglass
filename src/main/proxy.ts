import { EventEmitter } from 'node:events'
import * as mockttp from 'mockttp'
import { takeAppHeader } from './app-header'
import type { CaFiles } from './certificate'
import { presentBody } from './protobody'
import { findRule, type ProxyRule } from './rules'

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
  /** Raw body when it is protobuf or gRPC, so a loaded .proto can decode it. Not sent to the window. */
  requestBytes?: Buffer
  responseBytes?: Buffer
}

/** A TLS handshake the app refused: usually certificate pinning. */
export interface TlsFailure {
  id: string
  at: number
  host: string
  cause: string
  /** Package that owned the socket, when the phone's TCP table could say. */
  app?: string
}

export type ExchangeSummary = Omit<
  Exchange,
  'requestHeaders' | 'requestBody' | 'responseHeaders' | 'responseBody' | 'requestBytes' | 'responseBytes'
>

/** Drop raw protobuf bytes before a value crosses IPC. */
export function publicExchange(exchange: Exchange): Omit<Exchange, 'requestBytes' | 'responseBytes'> {
  const { requestBytes: _requestBytes, responseBytes: _responseBytes, ...rest } = exchange
  return rest
}

const MAX_EXCHANGES = 5000

async function bodyText(
  body: { getDecodedBuffer(): Promise<Buffer | undefined>; buffer: Buffer },
  contentType: string,
): Promise<{ text?: string; size: number; bytes?: Buffer }> {
  const decoded = (await body.getDecodedBuffer().catch(() => undefined)) ?? body.buffer
  const presented = presentBody(decoded, contentType)
  return { ...presented, bytes: keepBytes(decoded, contentType) }
}

function keepBytes(buf: Buffer, type: string): Buffer | undefined {
  const kind = type.toLowerCase()
  if (buf.length === 0 || buf.length > 2 * 1024 * 1024) return undefined
  if (!kind.includes('grpc') && !kind.includes('protobuf')) return undefined
  return buf
}

export function summarize(e: Exchange): ExchangeSummary {
  const { requestHeaders: _a, requestBody: _b, responseHeaders: _c, responseBody: _d, requestBytes: _e, responseBytes: _f, ...rest } = e
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
  /** Called with the full exchange whenever it is recorded or updated. */
  persist?: (exchange: Exchange) => void
  private rules: ProxyRule[] = []

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
    try {
      // Exactly this port: the emulator routes to it by name, so drifting to a neighbour
      // port would silently send the phone's traffic nowhere.
      await server.start(port ? { startPort: port, endPort: port } : undefined)
    } catch (error) {
      if (port)
        throw new Error(
          `Could not start the capture proxy on port ${port} — another Sideglass session may still be running. Stop it and try again.`,
        )
      throw error
    }
    const stripAppHeader = (headers: Record<string, string | string[] | undefined>) => {
      const copy = { ...headers }
      takeAppHeader(copy)
      return copy
    }
    await server.forAnyRequest().matching((req) => findRule(this.rules, req.url) !== undefined).thenCallback((req) => {
      const rule = findRule(this.rules, req.url)
      if (!rule || rule.kind === 'block') return { statusCode: 403, statusMessage: 'Blocked', body: 'Blocked by Sideglass' }
      return {
        statusCode: rule.status ?? 200,
        body: rule.body ?? '',
        headers: { 'content-type': rule.contentType ?? 'text/plain' },
      }
    })
    await server.forUnmatchedRequest().thenPassThrough({
      ignoreHostHttpsErrors: false,
      beforeRequest: (req) => ({ headers: stripAppHeader(req.headers) }),
    })
    await server.forAnyWebSocket().thenPassThrough()

    await server.on('request', async (req) => {
      const url = new URL(req.url)
      const type = String(req.headers['content-type'] ?? '')
      const body = await bodyText(req.body, type)
      const headers = { ...req.headers }
      const app = takeAppHeader(headers)
      const raw = body.bytes
      const e: Exchange = {
        id: req.id,
        startedAt: req.timingEvents.startTime,
        method: req.method,
        url: req.url,
        host: url.host,
        path: url.pathname + url.search,
        httpVersion: req.httpVersion,
        requestHeaders: headers,
        requestBody: body.text,
        requestBodySize: body.size,
        requestBytes: raw,
        state: 'pending',
        app,
        inputId: this.inputFor?.(req.timingEvents.startTime),
      }
      this.exchanges.set(e.id, e)
      this.trim()
      this.touch(e)
      const destPort = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
      if (!app) void this.tagApp(e, url.hostname, destPort)
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
      e.responseBytes = body.bytes
      const t = res.timingEvents
      e.durationMs = t.responseSentTimestamp ? Math.round(t.responseSentTimestamp - t.startTimestamp) : undefined
      e.state = 'done'
      this.touch(e)
    })
    await server.on('abort', (req) => {
      const e = this.exchanges.get(req.id)
      if (!e) return
      e.state = 'aborted'
      this.touch(e)
    })
    await server.on('tls-client-error', (failure) => {
      const host = failure.tlsMetadata?.sniHostname ?? failure.destination?.hostname ?? failure.remoteIpAddress ?? 'unknown host'
      const entry: TlsFailure = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, at: Date.now(), host, cause: failure.failureCause }
      this.tlsFailures.push(entry)
      if (this.tlsFailures.length > 1000) this.tlsFailures.shift()
      this.emit('tls-failure', entry)
      void this.tagFailure(entry)
    })
    this.server = server
    return server.port
  }

  clear(): void {
    this.exchanges.clear()
    this.tlsFailures.length = 0
  }

  listRules(): ProxyRule[] {
    return this.rules.slice()
  }

  addRule(input: Omit<ProxyRule, 'id'>): ProxyRule[] {
    const pattern = input.pattern.trim()
    if (!pattern || pattern.length > 2000 || /[\r\n]/.test(pattern)) throw new Error('Give a URL or host to match')
    this.rules.push({ ...input, pattern, id: `${Date.now()}-${this.rules.length}` })
    return this.listRules()
  }

  removeRule(id: string): ProxyRule[] {
    this.rules = this.rules.filter((rule) => rule.id !== id)
    return this.listRules()
  }

  /** A request this computer sent again, shown in the same list as phone traffic. */
  record(exchange: Exchange): void {
    this.exchanges.set(exchange.id, exchange)
    this.trim()
    this.touch(exchange)
  }

  bytes(id: string, side: 'request' | 'response'): Buffer | undefined {
    const exchange = this.exchanges.get(id)
    return side === 'request' ? exchange?.requestBytes : exchange?.responseBytes
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
    this.touch(e)
  }

  private async tagFailure(entry: TlsFailure): Promise<void> {
    if (!this.lookupApp) return
    const hostname = entry.host.replace(/:\d+$/, '')
    const port = Number(entry.host.split(':')[1]) || 443
    let app = await this.lookupApp(hostname, port).catch(() => undefined)
    if (!app) {
      await new Promise((r) => setTimeout(r, 400))
      app = await this.lookupApp(hostname, port).catch(() => undefined)
    }
    if (!app) return
    entry.app = app
    this.emit('tls-failure', entry)
  }

  private touch(exchange: Exchange): void {
    this.persist?.(exchange)
    this.emit('exchange', summarize(exchange))
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { joinHeader, REPLAY_SKIP } from './curl'
import type { Exchange } from './proxy'

/**
 * The API Watcher: a separate Cloudflare Worker (thecurio-watcher) that re-sends a captured
 * request every N seconds, minutes, hours or days and keeps a diff each time the response
 * changes. Sideglass hands requests over to it, opens its dashboard, and shows a desktop
 * notification for each change while Sideglass is open.
 */

export type IntervalUnit = 'sec' | 'min' | 'hr' | 'day'
export const INTERVAL_UNITS: readonly IntervalUnit[] = ['sec', 'min', 'hr', 'day']
const UNIT_SECONDS: Record<IntervalUnit, number> = { sec: 1, min: 60, hr: 3600, day: 86_400 }
/** Must match the worker's limits (apps/watcher/src/contract.ts). */
export const MIN_INTERVAL_SECONDS = 10
export const MAX_INTERVAL_SECONDS = 30 * 86_400
const MAX_REQUEST_BODY = 256 * 1024

export interface WatcherConfig {
  /** Base URL of the watcher worker, e.g. https://thecurio-watcher.<account>.workers.dev */
  url: string
  token: string
}

/** What the window may know: the token never goes back to it. */
export interface WatcherStatus {
  url: string
  hasToken: boolean
}

export interface WatchOptions {
  name: string
  every: { value: number; unit: IntervalUnit }
  ignoreKeys: string[]
}

export interface WatchCreated {
  id: string
  name: string
}

export interface WatcherChange {
  seq: number
  watchId: string
  name: string
  changeId: number
  at: number
  added: number
  removed: number
  statusBefore: number | null
  statusAfter: number | null
}

/** Encrypts the token at rest when the OS keychain is available (Electron safeStorage). */
export interface TokenCipher {
  available(): boolean
  encrypt(text: string): string
  decrypt(stored: string): string
}

interface StoredConfig {
  url?: string
  token?: string
  encrypted?: boolean
}

export function normalizeWatcherUrl(input: string): string {
  const text = input.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new Error('Watcher URL must be a full URL, like https://thecurio-watcher.example.workers.dev')
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  // The token rides on every call, so it only goes over https (or to this computer).
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error('Watcher URL must use https')
  if (parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) throw new Error('Use the watcher base URL, without a path')
  return parsed.origin
}

export function loadWatcherConfig(file: string, cipher: TokenCipher): WatcherConfig | null {
  if (!existsSync(file)) return null
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredConfig
    if (typeof stored.url !== 'string' || typeof stored.token !== 'string' || !stored.url || !stored.token) return null
    const token = stored.encrypted ? cipher.decrypt(stored.token) : stored.token
    return { url: normalizeWatcherUrl(stored.url), token }
  } catch {
    return null
  }
}

export function saveWatcherConfig(file: string, cipher: TokenCipher, config: WatcherConfig): void {
  mkdirSync(dirname(file), { recursive: true })
  const encrypted = cipher.available()
  const stored: StoredConfig = { url: config.url, token: encrypted ? cipher.encrypt(config.token) : config.token, encrypted }
  writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 })
}

/**
 * A body the watcher can send as captured. Sideglass shows binary bodies, and bodies over 2 MB,
 * as placeholder text (protobody.presentBody), and protobuf as a decoded field dump: sending
 * that text would watch a different request.
 */
function sendableAsText(exchange: Exchange): boolean {
  if (exchange.method === 'GET' || exchange.method === 'HEAD' || !exchange.requestBody) return true
  if (exchange.requestBytes) return false
  const header = exchange.requestHeaders['content-type'] ?? exchange.requestHeaders['Content-Type'] ?? ''
  const type = (Array.isArray(header) ? header.join(',') : header).toLowerCase()
  if (type.includes('grpc') || type.includes('protobuf')) return false
  const body = exchange.requestBody
  return !/^<\d+ bytes, too large to show>$/.test(body) && !/^<binary, \d+ bytes>$/.test(body)
}

export function parseWatchOptions(input: unknown): WatchOptions {
  if (!input || typeof input !== 'object') throw new Error('Missing watch options')
  const raw = input as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : ''
  if (!name) throw new Error('Give the watch a name')
  const every = (raw.every ?? {}) as Record<string, unknown>
  const value = Number(every.value)
  const unit = INTERVAL_UNITS.find((u) => u === every.unit)
  if (!unit || !Number.isInteger(value) || value <= 0) throw new Error('Pick how often to check')
  const seconds = value * UNIT_SECONDS[unit]
  if (seconds < MIN_INTERVAL_SECONDS) throw new Error(`Check at most every ${MIN_INTERVAL_SECONDS} seconds`)
  if (seconds > MAX_INTERVAL_SECONDS) throw new Error('Check at least every 30 days')
  const ignoreKeys = Array.isArray(raw.ignoreKeys)
    ? raw.ignoreKeys.filter((key): key is string => typeof key === 'string').map((key) => key.trim()).filter(Boolean).slice(0, 100)
    : []
  return { name, every: { value, unit }, ignoreKeys }
}

/** The request as the worker will send it: captured headers and body, minus transport headers. */
export function watchRequestOf(exchange: Exchange): { method: string; url: string; headers: Record<string, string>; body?: string } {
  if (!/^https?:\/\//i.test(exchange.url)) throw new Error('Only http and https requests can be watched')
  if (!sendableAsText(exchange)) throw new Error('This request has a binary or very large body. The watcher can only send text bodies.')
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(exchange.requestHeaders)) {
    if (value === undefined || name.startsWith(':') || REPLAY_SKIP.has(name.toLowerCase())) continue
    headers[name] = Array.isArray(value) ? joinHeader(name, value) : value
  }
  const body = exchange.requestBody && exchange.method !== 'GET' && exchange.method !== 'HEAD' ? exchange.requestBody : undefined
  if (body && body.length > MAX_REQUEST_BODY) throw new Error('The request body is over 256 KB, too big to watch')
  return { method: exchange.method, url: exchange.url, headers, ...(body ? { body } : {}) }
}

/** The dashboard page with the token in the fragment, which the browser never sends to the server. */
export function dashboardUrl(config: WatcherConfig, watchId?: string): string {
  const fragment = new URLSearchParams({ token: config.token, ...(watchId ? { watch: watchId } : {}) })
  return `${config.url}/#${fragment.toString()}`
}

type Fetch = typeof fetch

async function call<T>(config: WatcherConfig, path: string, init: RequestInit = {}, fetcher: Fetch = fetch): Promise<T> {
  let response: Response
  try {
    response = await fetcher(`${config.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${config.token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new Error(`Could not reach the watcher: ${(error as Error).message}`)
  }
  if (response.status === 401) throw new Error('The watcher refused the token. Check it in Watcher settings.')
  const text = await response.text()
  let data: { error?: string } & Record<string, unknown> = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    // Not JSON: fall through to the status check.
  }
  if (!response.ok) throw new Error(data.error ?? `Watcher answered ${response.status}`)
  return data as T
}

export async function checkWatcher(config: WatcherConfig, fetcher: Fetch = fetch): Promise<number> {
  const data = await call<{ watches: unknown[] }>(config, '/v1/watches', {}, fetcher)
  return data.watches.length
}

export async function createWatch(
  config: WatcherConfig,
  exchange: Exchange,
  options: WatchOptions,
  fetcher: Fetch = fetch,
): Promise<WatchCreated> {
  const body = { name: options.name, request: watchRequestOf(exchange), every: options.every, ignoreKeys: options.ignoreKeys, source: 'sideglass' }
  const data = await call<{ watch: WatchCreated }>(config, '/v1/watches', { method: 'POST', body: JSON.stringify(body) }, fetcher)
  return { id: data.watch.id, name: data.watch.name }
}

export function changeMessage(change: WatcherChange): string {
  const status = change.statusBefore !== change.statusAfter ? `Status ${change.statusBefore ?? '–'} → ${change.statusAfter ?? '–'}. ` : ''
  return `${status}+${change.added} −${change.removed} lines`
}

/**
 * Polls the watcher's change feed and calls `notify` for each new change. The first poll only
 * learns where the feed ends, so changes from before Sideglass opened do not all pop up at once.
 */
export class ChangePoller {
  private timer: NodeJS.Timeout | null = null
  /** Last feed seq seen; null until the first poll. */
  private since: number | null = null
  private busy = false
  /** Bumped by reset(), so a poll still out to the old watcher is thrown away. */
  private generation = 0
  /** A reset arrived while a poll was out: poll again when it ends. */
  private again = false

  constructor(
    private readonly config: () => WatcherConfig | null,
    private readonly notify: (change: WatcherChange) => void,
    private readonly everyMs = 60_000,
    private readonly fetcher: Fetch = fetch,
  ) {}

  start(): void {
    if (this.timer) return
    void this.poll()
    this.timer = setInterval(() => void this.poll(), this.everyMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** After the URL or token changes, start again from the new feed's end. */
  reset(): void {
    this.generation++
    this.since = null
    if (this.busy) this.again = true
    else void this.poll()
  }

  async poll(): Promise<void> {
    const config = this.config()
    if (!config || this.busy) return
    this.busy = true
    const generation = this.generation
    try {
      const path = this.since === null ? '' : `since=${this.since}&`
      const feed = await call<{ changes: WatcherChange[]; latest: number }>(config, `/v1/changes?${path}limit=50`, {}, this.fetcher)
      if (generation !== this.generation) return
      // First poll, or the feed restarted (new worker, all watches deleted): take its end.
      if (this.since === null || feed.latest < this.since) {
        this.since = feed.latest
        return
      }
      for (const change of feed.changes) {
        this.notify(change)
        this.since = change.seq
      }
    } catch {
      // The watcher is a convenience: an outage must not bother the capture window.
    } finally {
      this.busy = false
      if (this.again) {
        this.again = false
        void this.poll()
      }
    }
  }
}

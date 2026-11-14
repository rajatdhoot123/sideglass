import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Exchange } from './proxy'
import {
  ChangePoller,
  createWatch,
  dashboardUrl,
  loadWatcherConfig,
  normalizeWatcherUrl,
  parseWatchOptions,
  saveWatcherConfig,
  watchRequestOf,
  type TokenCipher,
  type WatcherChange,
} from './watcher'

const exchange = (patch: Partial<Exchange> = {}): Exchange => ({
  id: '1',
  startedAt: 1,
  method: 'POST',
  url: 'https://api.example.com/v1/prices?x=1',
  host: 'api.example.com',
  path: '/v1/prices?x=1',
  httpVersion: '1.1',
  requestHeaders: { authorization: 'Bearer t', host: 'api.example.com', 'content-length': '7', 'X-Sideglass-App': 'com.x', cookie: ['a=1', 'b=2'], ':path': '/v1' },
  requestBody: '{"n":1}',
  requestBodySize: 7,
  state: 'done',
  ...patch,
})

const plain: TokenCipher = { available: () => false, encrypt: (t) => t, decrypt: (t) => t }
const rot: TokenCipher = {
  available: () => true,
  encrypt: (t) => Buffer.from(t).toString('base64'),
  decrypt: (t) => Buffer.from(t, 'base64').toString(),
}

test('watch request keeps auth headers and body, drops transport headers', () => {
  const request = watchRequestOf(exchange())
  assert.deepEqual(request, {
    method: 'POST',
    url: 'https://api.example.com/v1/prices?x=1',
    headers: { authorization: 'Bearer t', cookie: 'a=1; b=2' },
    body: '{"n":1}',
  })
  assert.equal(watchRequestOf(exchange({ method: 'GET' })).body, undefined)
})

test('binary and non-http requests cannot be watched', () => {
  assert.throws(() => watchRequestOf(exchange({ requestBytes: Buffer.from([1, 2]) })), /binary/)
  assert.throws(() => watchRequestOf(exchange({ url: 'ws://x/y' })), /http/)
  assert.throws(() => watchRequestOf(exchange({ requestBody: '<binary, 48213 bytes>' })), /binary/)
  assert.throws(() => watchRequestOf(exchange({ requestBody: '<3000000 bytes, too large to show>' })), /binary/)
  assert.throws(() => watchRequestOf(exchange({ requestHeaders: { 'content-type': 'application/x-protobuf' }, requestBody: '1: 2' })), /binary/)
  // A GET carries no body, so a placeholder there does not matter.
  assert.equal(watchRequestOf(exchange({ method: 'GET', requestBody: '<binary, 5 bytes>' })).body, undefined)
})

test('watch options are checked like the worker checks them', () => {
  assert.deepEqual(parseWatchOptions({ name: ' Prices ', every: { value: 5, unit: 'min' }, ignoreKeys: [' ts ', '', 3] }), {
    name: 'Prices',
    every: { value: 5, unit: 'min' },
    ignoreKeys: ['ts'],
  })
  assert.throws(() => parseWatchOptions({ name: 'x', every: { value: 5, unit: 'sec' } }), /10 seconds/)
  assert.throws(() => parseWatchOptions({ name: 'x', every: { value: 31, unit: 'day' } }), /30 days/)
  assert.throws(() => parseWatchOptions({ name: 'x', every: { value: 1.5, unit: 'min' } }), /how often/)
  assert.throws(() => parseWatchOptions({ name: '', every: { value: 1, unit: 'min' } }), /name/)
})

test('watcher URL must be an https origin (or http on this computer)', () => {
  assert.equal(normalizeWatcherUrl(' https://w.example.workers.dev/ '), 'https://w.example.workers.dev')
  assert.equal(normalizeWatcherUrl('http://localhost:8798'), 'http://localhost:8798')
  assert.throws(() => normalizeWatcherUrl('http://w.example.com'), /https/)
  assert.throws(() => normalizeWatcherUrl('https://w.example.com/v1'), /without a path/)
  assert.throws(() => normalizeWatcherUrl('nope'), /full URL/)
})

test('config round-trips and the token is encrypted when the keychain is available', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-'))
  try {
    const file = join(dir, 'watcher.json')
    assert.equal(loadWatcherConfig(file, rot), null)
    saveWatcherConfig(file, rot, { url: 'https://w.example.com', token: 'secret' })
    assert.ok(!readFileSync(file, 'utf8').includes('secret'))
    assert.deepEqual(loadWatcherConfig(file, rot), { url: 'https://w.example.com', token: 'secret' })
    saveWatcherConfig(file, plain, { url: 'https://w.example.com', token: 'secret' })
    assert.deepEqual(loadWatcherConfig(file, plain), { url: 'https://w.example.com', token: 'secret' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dashboard URL carries the token only in the fragment', () => {
  const url = new URL(dashboardUrl({ url: 'https://w.example.com', token: 'a b&c' }, 'w_1'))
  assert.equal(url.search, '')
  const hash = new URLSearchParams(url.hash.slice(1))
  assert.equal(hash.get('token'), 'a b&c')
  assert.equal(hash.get('watch'), 'w_1')
})

test('createWatch posts the request with the bearer token and reports errors', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ watch: { id: 'w_1', name: 'P' } }), { status: 201 })
  }) as typeof fetch
  const created = await createWatch({ url: 'https://w.example.com', token: 'tk' }, exchange(), parseWatchOptions({ name: 'P', every: { value: 1, unit: 'hr' } }), fetcher)
  assert.deepEqual(created, { id: 'w_1', name: 'P' })
  assert.equal(calls[0]?.url, 'https://w.example.com/v1/watches')
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, 'Bearer tk')
  const sent = JSON.parse(String(calls[0]?.init.body))
  assert.equal(sent.source, 'sideglass')
  assert.equal(sent.request.headers.authorization, 'Bearer t')

  const refused = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
  await assert.rejects(createWatch({ url: 'https://w.example.com', token: 'bad' }, exchange(), parseWatchOptions({ name: 'P', every: { value: 1, unit: 'hr' } }), refused), /refused the token/)
  const bad = (async () => new Response('{"error":"Interval must be…"}', { status: 400 })) as unknown as typeof fetch
  await assert.rejects(createWatch({ url: 'https://w.example.com', token: 'tk' }, exchange(), parseWatchOptions({ name: 'P', every: { value: 1, unit: 'hr' } }), bad), /Interval must be/)
})

test('poller skips old changes, then notifies each new one once', async () => {
  const change = (seq: number): WatcherChange => ({ seq, watchId: 'w', name: 'n', changeId: seq, at: 0, added: 1, removed: 1, statusBefore: 200, statusAfter: 200 })
  let feed: WatcherChange[] = [change(1), change(2)]
  const asked: string[] = []
  const fetcher = (async (url: string) => {
    asked.push(url)
    const since = new URL(url).searchParams.get('since')
    const latest = feed.at(-1)?.seq ?? 0
    const changes = since === null ? [] : feed.filter((c) => c.seq > Number(since))
    return new Response(JSON.stringify({ changes, latest }))
  }) as typeof fetch
  const seen: number[] = []
  const poller = new ChangePoller(() => ({ url: 'https://w.example.com', token: 't' }), (c) => seen.push(c.seq), 60_000, fetcher)
  await poller.poll()
  assert.deepEqual(seen, [])
  await poller.poll()
  assert.deepEqual(seen, [])
  feed = [...feed, change(3), change(4)]
  await poller.poll()
  assert.deepEqual(seen, [3, 4])
  await poller.poll()
  assert.deepEqual(seen, [3, 4])
  // Feed restarted (all watches removed): pick up from its new end, no repeats.
  feed = [change(1)]
  await poller.poll()
  feed = [change(1), change(2)]
  await poller.poll()
  assert.deepEqual(seen, [3, 4, 2])
  assert.ok(!asked[0]?.includes('since='))
})

test('a reset while a poll is out drops that poll and starts from the new feed end', async () => {
  let release: () => void = () => undefined
  const feeds: Record<string, number> = { 'https://a.example': 5, 'https://b.example': 40 }
  const asked: string[] = []
  let hold = true
  const fetcher = (async (url: string) => {
    asked.push(url)
    const parsed = new URL(url)
    if (hold && parsed.origin === 'https://a.example') await new Promise<void>((r) => (release = r))
    return new Response(JSON.stringify({ changes: [], latest: feeds[parsed.origin] }))
  }) as typeof fetch
  let config = { url: 'https://a.example', token: 't' }
  const poller = new ChangePoller(() => config, () => assert.fail('no notifications expected'), 60_000, fetcher)
  const first = poller.poll()
  config = { url: 'https://b.example', token: 't' }
  poller.reset()
  hold = false
  release()
  await first
  await new Promise((r) => setTimeout(r, 10))
  await poller.poll()
  // After the reset it learned B's end (40), not A's (5).
  assert.ok(asked.at(-1)?.startsWith('https://b.example/v1/changes?since=40'), asked.join(' '))
})

test('poller pages through a burst instead of skipping to the tip', async () => {
  const all = Array.from({ length: 80 }, (_, i): WatcherChange => ({ seq: i + 11, watchId: 'w', name: 'n', changeId: i, at: 0, added: 1, removed: 0, statusBefore: 200, statusAfter: 200 }))
  let feed: WatcherChange[] = []
  const fetcher = (async (url: string) => {
    const since = new URL(url).searchParams.get('since')
    const latest = feed.at(-1)?.seq ?? 10
    if (since === null) return new Response(JSON.stringify({ changes: [], cursor: latest, latest, more: false }))
    const changes = feed.filter((c) => c.seq > Number(since)).slice(0, 50)
    const cursor = changes.length >= 50 ? (changes.at(-1)?.seq ?? latest) : latest
    return new Response(JSON.stringify({ changes, cursor, latest, more: cursor < latest }))
  }) as typeof fetch
  const seen: number[] = []
  const poller = new ChangePoller(() => ({ url: 'https://w.example.com', token: 't' }), (c) => seen.push(c.seq), 60_000, fetcher)
  await poller.poll()
  feed = all
  await poller.poll()
  assert.equal(seen.length, 80)
  assert.deepEqual(seen, all.map((c) => c.seq))
})

test('watcher calls refuse redirects', async () => {
  let redirect: RequestRedirect | undefined
  const fetcher = (async (_url: string, init: RequestInit) => {
    redirect = init.redirect
    return new Response(JSON.stringify({ watch: { id: 'w_1', name: 'P' } }), { status: 201 })
  }) as typeof fetch
  await createWatch({ url: 'https://w.example.com', token: 'tk' }, exchange(), parseWatchOptions({ name: 'P', every: { value: 1, unit: 'hr' } }), fetcher)
  assert.equal(redirect, 'error')
})

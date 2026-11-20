import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadOrCreateCa } from './certificate'
import { CaptureProxy, forwardHeaders } from './proxy'

function proxyGet(port: number, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: url, headers: { host: new URL(url).host, ...headers }, timeout: 8_000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('proxy request timed out')))
    req.end()
  })
}

const WEBVIEW_UA =
  'Mozilla/5.0 (Linux; Android 15; sdk_gphone64_arm64 Build/AE3A.240806.036; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36'

test('a browser user agent is forwarded as okhttp and the capture keeps the original', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sideglass-proxy-ua-'))
  const ca = await loadOrCreateCa(join(dir, 'ca'))
  let upstreamUa: string | string[] | undefined
  const upstream = http.createServer((req, res) => {
    upstreamUa = req.headers['user-agent']
    res.end('upstream')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const proxy = new CaptureProxy()
  try {
    const port = await proxy.start(ca)
    const forwarded = await proxyGet(port, `http://127.0.0.1:${upstreamPort}/ua`, {
      'User-Agent': WEBVIEW_UA,
      'X-Sideglass-App': 'in.mohalla.reva',
    })
    assert.equal(forwarded.status, 200)
    assert.equal(upstreamUa, 'okhttp/4.12.0')
    const exchange = [...proxy.exchanges.values()].find((item) => item.url.includes('/ua'))
    assert.equal(headerValue(exchange?.requestHeaders ?? {}, 'user-agent'), WEBVIEW_UA)
    assert.equal(exchange?.app, 'in.mohalla.reva')
    assert.equal(headerValue(exchange?.requestHeaders ?? {}, 'x-sideglass-app'), undefined)
  } finally {
    await proxy.stop()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})

test('forwardHeaders leaves a non-browser user agent alone', () => {
  const headers = forwardHeaders({ 'User-Agent': 'okhttp/4.12.0', 'X-Sideglass-App': 'in.mohalla.reva' })
  assert.equal(headers['User-Agent'], 'okhttp/4.12.0')
  assert.equal(headers['X-Sideglass-App'], undefined)
})

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[Object.keys(headers).find((key) => key.toLowerCase() === name) ?? '']
  return Array.isArray(value) ? value[0] : value
}

test('the proxy strips the app header, tags the exchange, and can block a URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sideglass-proxy-'))
  const ca = await loadOrCreateCa(join(dir, 'ca'))
  const upstreamHeaders: Record<string, string | string[] | undefined> = {}
  const upstream = http.createServer((req, res) => {
    Object.assign(upstreamHeaders, req.headers)
    res.end('upstream')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const proxy = new CaptureProxy()
  try {
    const port = await proxy.start(ca)
    proxy.addRule({ kind: 'block', pattern: 'blocked.test' })
    const blocked = await proxyGet(port, 'http://blocked.test/secret', { 'X-Sideglass-App': 'com.example.blocked' })
    assert.equal(blocked.status, 403)
    const blockedExchange = [...proxy.exchanges.values()].find((exchange) => exchange.url.includes('blocked.test'))
    assert.equal(blockedExchange?.app, 'com.example.blocked')
    assert.equal(blockedExchange?.requestHeaders['x-sideglass-app'], undefined)
    assert.equal(blockedExchange?.requestHeaders['X-Sideglass-App'], undefined)

    const forwarded = await proxyGet(port, `http://127.0.0.1:${upstreamPort}/hello`, { 'X-Sideglass-App': 'com.example.forward' })
    assert.equal(forwarded.status, 200)
    assert.equal(forwarded.body, 'upstream')
    assert.equal(upstreamHeaders['x-sideglass-app'], undefined)
    const forwardedExchange = [...proxy.exchanges.values()].find((exchange) => exchange.url.includes('/hello'))
    assert.equal(forwardedExchange?.app, 'com.example.forward')
  } finally {
    await proxy.stop()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})

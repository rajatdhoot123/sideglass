import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callFileName, fileNames, parseSaveRequest, renderCalls, unusedName } from './export-calls'
import type { Exchange } from './proxy'

const exchange = (patch: Partial<Exchange> = {}): Exchange => ({
  id: '1',
  startedAt: 1_700_000_000_000,
  method: 'POST',
  url: 'https://example.com/v1/listen?x=1',
  host: 'example.com',
  path: '/v1/listen?x=1',
  httpVersion: '1.1',
  requestHeaders: { 'content-type': 'application/json', host: 'example.com', 'X-Sideglass-App': 'com.example.app', 'X-Bad': 'a\r\nX-Injected: yes' },
  requestBody: '{"n":1}',
  requestBodySize: 7,
  status: 200,
  statusMessage: 'OK',
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: '{"ok":true}',
  responseBodySize: 11,
  durationMs: 12,
  state: 'done',
  contentType: 'application/json',
  app: 'com.example.app',
  ...patch,
})

test('parseSaveRequest accepts a filtered id list and rejects a bad format', () => {
  assert.deepEqual(parseSaveRequest(['abc'], 'http', 'each'), { ids: ['abc'], format: 'http', layout: 'each' })
  assert.throws(() => parseSaveRequest([], 'har', 'one'), /Nothing to save/)
  assert.throws(() => parseSaveRequest(Array.from({ length: 20001 }, (_, i) => String(i)), 'har', 'one'), /Too many/)
  assert.throws(() => parseSaveRequest(['ok'], 'yaml', 'one'), /Pick a format/)
  assert.throws(() => parseSaveRequest(['ok'], 'har', 'folder'), /Pick a format/)
})

test('HAR keeps the response and Postman is a v2.1 collection', () => {
  const har = JSON.parse(renderCalls([exchange()], 'har')) as { log: { entries: { response: { content: { text: string } } }[] } }
  assert.equal(har.log.entries[0].response.content.text, '{"ok":true}')

  const collection = JSON.parse(renderCalls([exchange(), exchange({ id: '2', state: 'aborted', status: undefined })], 'postman')) as {
    info: { schema: string }
    item: { name: string; request: { method: string; url: string; header: { key: string; value: string }[]; body: { raw: string; options: { raw: { language: string } } } }; response?: { code: number; body: string }[] }[]
  }
  assert.equal(collection.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json')
  assert.equal(collection.item[0].request.method, 'POST')
  assert.equal(collection.item[0].request.url, 'https://example.com/v1/listen?x=1')
  assert.equal(collection.item[0].request.body.raw, '{"n":1}')
  assert.equal(collection.item[0].request.body.options.raw.language, 'json')
  assert.equal(collection.item[0].response?.[0].code, 200)
  assert.equal(collection.item[0].response?.[0].body, '{"ok":true}')
  assert.equal(collection.item[1].response, undefined)
  const keys = collection.item[0].request.header.map((header) => header.key.toLowerCase())
  assert.ok(keys.includes('content-type'))
  assert.ok(!keys.includes('x-sideglass-app'))
  assert.ok(!keys.includes('host'))
  assert.equal(collection.item[0].request.header.find((header) => header.key === 'X-Bad')?.value, 'a X-Injected: yes')
})

test('a placeholder body is left out of replay files and a real body is kept', () => {
  const binary = exchange({ requestBody: '<binary, 40 bytes>' })
  const http = renderCalls([binary], 'http')
  assert.match(http, /^### POST example.com\/v1\/listen$/m)
  assert.match(http, /^POST https:\/\/example.com\/v1\/listen\?x=1$/m)
  assert.match(http, /# 200 OK · 12 ms · com\.example\.app/)
  assert.doesNotMatch(http, /binary, 40 bytes/)
  assert.doesNotMatch(http, /X-Sideglass-App/)
  assert.doesNotMatch(http, /\{"ok":true\}/)

  const script = renderCalls([exchange(), binary], 'curl')
  assert.match(script, /^#!\/bin\/sh/)
  assert.equal((script.match(/curl -X/g) ?? []).length, 2)
  assert.match(script, /--data-binary '\{"n":1\}'/)
  assert.doesNotMatch(script, /binary, 40 bytes/)
  assert.match(script, /X-Bad: a X-Injected: yes/)
  assert.doesNotMatch(script, /X-Bad: a\n/)

  const both = renderCalls([exchange(), exchange({ id: '2', method: 'GET', requestBody: undefined })], 'http')
  assert.equal((both.match(/^### /gm) ?? []).length, 2)
})

test('file names stay in one folder and do not collide with a file already there', () => {
  const name = callFileName(exchange({ method: 'GET/../../x', host: 'ex.com:443', path: '/v1/a b?x=1' }), 1, 1, 'har')
  assert.equal(name.includes('/'), false)
  assert.equal(name.includes('\\'), false)
  assert.equal(name.includes('?'), false)
  assert.doesNotMatch(name, /\.\./)
  assert.match(name, /^001-GET-/)
  assert.match(name, /ex\.com/)
  assert.match(name, /v1-a-b\.har$/)

  const first = fileNames([exchange()], 'http')[0]
  const again = fileNames([exchange()], 'http', (candidate) => candidate === first)[0]
  assert.notEqual(again, first)
  assert.match(again, /-2\.http$/)
  assert.equal(unusedName('note', () => false), 'note')
})

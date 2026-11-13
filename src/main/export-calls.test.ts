import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  assert.match(script, /base64 --decode <<'SIDEGLASS' \| curl .* --data-binary @-\neyJuIjoxfQ==\nSIDEGLASS/)
  assert.doesNotMatch(script, /--data-raw/)
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

  const names = fileNames([exchange(), exchange()], 'http')
  assert.notEqual(names[0], names[1])
  assert.equal(unusedName('note', () => false), 'note')
  assert.equal(unusedName('sideglass-3', (name) => name === 'sideglass-3'), 'sideglass-3-2')
})

test('protobuf goes in the cURL script as raw bytes and stays out of text formats', () => {
  const proto = exchange({
    requestHeaders: { 'content-type': 'application/x-protobuf' },
    requestBody: '1: "abc"\n2: 5',
    requestBytes: Buffer.from([0x0a, 0x03, 0x61, 0x62, 0x63, 0x10, 0x05]),
  })
  const script = renderCalls([proto], 'curl')
  assert.match(script, /base64 --decode <<'SIDEGLASS' \| curl .* --data-binary @-\nCgNhYmMQBQ==\nSIDEGLASS/)
  assert.doesNotMatch(script, /1: "abc"/)
  assert.doesNotMatch(renderCalls([proto], 'http'), /1: "abc"/)
  const collection = JSON.parse(renderCalls([proto], 'postman')) as { item: { request: { body?: unknown; description: string } }[] }
  assert.equal(collection.item[0].request.body, undefined)
  assert.match(collection.item[0].request.description, /protobuf/)
  const lost = renderCalls([exchange({ requestHeaders: { 'content-type': 'application/grpc' }, requestBody: 'frame 1' })], 'curl')
  assert.doesNotMatch(lost, /frame 1|--data-binary/)
})

test('replay headers drop Content-Encoding and join split cookies with a semicolon', () => {
  const gz = exchange({ requestHeaders: { 'content-type': 'application/json', 'Content-Encoding': 'gzip', cookie: ['a=1', 'b=2'] } })
  for (const format of ['curl', 'http'] as const) {
    const text = renderCalls([gz], format)
    assert.doesNotMatch(text, /content-encoding/i)
    assert.match(text, /cookie: a=1; b=2/)
  }
  const collection = JSON.parse(renderCalls([gz], 'postman')) as { item: { request: { header: { key: string; value: string }[] } }[] }
  assert.deepEqual(collection.item[0].request.header.filter((header) => header.key === 'cookie'), [{ key: 'cookie', value: 'a=1; b=2' }])
})

test('the .http file leaves out a body it would misread, and GET bodies are left out everywhere', () => {
  const http = renderCalls([exchange({ requestBody: 'intro\n### not a request' }), exchange({ requestBody: '{"a":"{{x}}"}' })], 'http')
  assert.equal((http.match(/^### /gm) ?? []).length, 2)
  assert.equal((http.match(/# Body left out: it contains ###/g) ?? []).length, 2)
  assert.doesNotMatch(http, /\{\{x\}\}/)

  const get = exchange({ method: 'GET', requestBody: '{"n":1}' })
  const collection = JSON.parse(renderCalls([get], 'postman')) as { item: { request: { body?: unknown } }[] }
  assert.equal(collection.item[0].request.body, undefined)
  assert.doesNotMatch(renderCalls([get], 'http'), /\{"n":1\}/)
  assert.doesNotMatch(renderCalls([get], 'curl'), /--data-binary/)
})

test('undecoded protobuf bytes are still sent by the cURL script', () => {
  const raw = Buffer.from([0x0a, 0x03, 0x61, 0x62, 0x63])
  const proto = exchange({
    requestHeaders: { 'content-type': 'application/grpc' },
    requestBody: '<binary, 5 bytes>',
    requestBytes: raw,
  })
  const script = renderCalls([proto], 'curl')
  assert.match(script, /CgNhYmM=/)
  assert.doesNotMatch(script, /binary, 5 bytes/)
  const http = renderCalls([proto], 'http')
  assert.match(http, /binary protobuf/)
  assert.doesNotMatch(http, /CgNhYmM=/)
  const lost = exchange({ requestHeaders: { 'content-type': 'application/grpc' }, requestBody: '<binary, 5 bytes>' })
  assert.match(renderCalls([lost], 'curl'), /raw bytes were not kept/)
  assert.doesNotMatch(renderCalls([lost], 'curl'), /--data-binary/)
})

test('the cURL script sends the captured body and does not read a file or start a new command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sideglass-curl-'))
  try {
    const out = join(dir, 'body')
    const pwned = join(dir, 'pwned')
    const curlBin = join(dir, 'curl')
    writeFileSync(curlBin, `#!/bin/sh\ncat > ${JSON.stringify(out)}\n`)
    chmodSync(curlBin, 0o755)
    const body = "@/etc/hosts\na'b"
    const script = renderCalls(
      [
        exchange({
          url: `https://example.com/\ntouch ${pwned}`,
          statusMessage: `OK\ntouch ${pwned}`,
          app: `com.app\ntouch ${pwned}`,
          requestHeaders: { 'content-type': 'text/plain', 'X-Bad\nX-Evil': '1', 'X-Ok': 'v' },
          requestBody: body,
        }),
      ],
      'curl',
    )
    assert.doesNotMatch(script, /^touch /m)
    assert.doesNotMatch(script, /^X-Evil:/m)
    const http = renderCalls(
      [exchange({ url: `https://example.com/\ntouch ${pwned}`, requestHeaders: { 'X-Bad\nX-Evil': '1', 'X-Ok': 'v' }, requestBody: 'hi' })],
      'http',
    )
    assert.doesNotMatch(http, /^touch /m)
    assert.match(http, /^X-Ok: v$/m)
    assert.doesNotMatch(http, /X-Evil/)
    const file = join(dir, 'run.sh')
    writeFileSync(file, script)
    const result = spawnSync('sh', [file], { env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(out, 'utf8'), body)
    assert.equal(existsSync(pwned), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a large body stays off the curl command line', () => {
  const big = 'x'.repeat(200_000)
  const script = renderCalls([exchange({ requestBody: big })], 'curl')
  const command = script.split('\n').find((line) => line.startsWith('base64 '))
  assert.ok(command)
  assert.equal(command.includes(big), false)
  assert.match(command, /--data-binary @-/)
})

test('Postman keeps literal brace names that it would otherwise replace', () => {
  const body = '{"id":"{{$guid}}","user":"{{username}}"}'
  const collection = JSON.parse(renderCalls([exchange({ requestBody: body, url: 'https://example.com/{{$timestamp}}' })], 'postman')) as {
    item: { event?: { script: { exec: string[] } }[]; request: { url: string; body: { raw: string } } }[]
  }
  const item = collection.item[0]
  assert.equal(item.request.body.raw, body)
  assert.equal(item.request.url, 'https://example.com/{{$timestamp}}')
  const exec = item.event?.[0].script.exec ?? []
  assert.equal(exec.some((line) => line.includes('{{')), false)
  const locals: Record<string, string> = { $guid: 'GUID', username: 'secret', $timestamp: 'TIME' }
  const pm = { variables: { set: (key: string, value: string) => { locals[key] = value } } }
  for (const line of exec) new Function('pm', line)(pm)
  const dynamic: Record<string, string> = { $guid: 'GUID', $timestamp: 'TIME' }
  const resolve = (raw: string) => {
    let value = raw
    for (let i = 0; i < 19; i++) {
      let replacements = 0
      value = value.replace(/\{\{([^{}]*?)\}\}/g, (match, token) => {
        replacements += 1
        if (Object.prototype.hasOwnProperty.call(locals, token)) return locals[token]
        if (Object.prototype.hasOwnProperty.call(dynamic, token)) return dynamic[token]
        return match
      })
      if (!replacements) break
    }
    return value
  }
  assert.equal(resolve(item.request.body.raw), body)
  assert.equal(resolve(item.request.url), 'https://example.com/{{$timestamp}}')
})

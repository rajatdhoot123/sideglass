import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { generateCACertificate } from 'mockttp'
import { takeAppHeader } from './app-header'
import { subjectHashOld } from './certificate'
import { toCurl } from './curl'
import { decompressXz, fridaArch, isElf, isXz, serverAsset } from './frida'
import { fromHar, toHar } from './har'
import { History } from './history'
import { parseLogLine } from './logcat'
import type { Exchange } from './proxy'
import { isProxyNoise } from './quiet'
import { findRule, type ProxyRule } from './rules'
import { ProtoSchema } from './schema'
import { commandLineToolsZip, findToolsRoot, installToolsTree, javaHome } from './sdk'
import { previewDatabase } from './storage'
import { packageFromPlayLink } from './store/play'
import { DatabaseSync } from 'node:sqlite'

const exchange = (patch: Partial<Exchange> = {}): Exchange => ({
  id: '1',
  startedAt: 1_700_000_000_000,
  method: 'POST',
  url: 'https://example.com/v1/listen?x=1',
  host: 'example.com',
  path: '/v1/listen?x=1',
  httpVersion: '1.1',
  requestHeaders: { 'content-type': 'application/json', 'X-Sideglass-App': 'com.example.app' },
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

test('subject_hash_old is eight lowercase hex characters', async () => {
  const ca = await generateCACertificate({ subject: { commonName: 'sideglass test' } })
  assert.match(subjectHashOld(ca.cert), /^[0-9a-f]{8}$/)
})

test('packageFromPlayLink accepts a package, a web link and a market link', () => {
  assert.equal(packageFromPlayLink('com.example.app'), 'com.example.app')
  assert.equal(packageFromPlayLink('https://play.google.com/store/apps/details?id=com.example.app&hl=en'), 'com.example.app')
  assert.equal(packageFromPlayLink('market://details?id=com.example.app'), 'com.example.app')
  assert.equal(packageFromPlayLink('https://example.com'), null)
})

test('parseLogLine reads a threadtime line', () => {
  const line = parseLogLine('11-07 12:01:02.003  4321  4322 I ExampleTag: hello')
  assert.deepEqual(line, { at: '11-07 12:01:02.003', pid: 4321, level: 'I', tag: 'ExampleTag', message: 'hello' })
  assert.equal(parseLogLine('not a log line'), null)
})

test('HAR export round-trips the request and the app tag', () => {
  const har = toHar([exchange()])
  const back = fromHar(JSON.stringify(har))
  assert.equal(back[0].method, 'POST')
  assert.equal(back[0].url, 'https://example.com/v1/listen?x=1')
  assert.equal(back[0].app, 'com.example.app')
  assert.equal(back[0].responseBody, '{"ok":true}')
})

test('toCurl quotes a body that contains a single quote', () => {
  const command = toCurl({ ...exchange(), requestBody: "a'b" })
  assert.match(command, /curl -X 'POST' 'https:\/\/example.com\/v1\/listen\?x=1'/)
  assert.match(command, /--data-binary 'a'\\''b'/)
  assert.doesNotMatch(command, /X-Sideglass-App|content-length/i)
})

test('takeAppHeader records a package and removes the header', () => {
  const headers: Record<string, string> = { 'X-Sideglass-App': 'com.example.app', host: 'example.com' }
  assert.equal(takeAppHeader(headers), 'com.example.app')
  assert.equal(headers['X-Sideglass-App'], undefined)
  assert.equal(headers.host, 'example.com')
  assert.equal(takeAppHeader({ 'x-sideglass-app': 'not a package' }), undefined)
})

test('findRule returns the first matching block', () => {
  const rules: ProxyRule[] = [
    { id: '1', kind: 'block', pattern: 'example.com/v1' },
    { id: '2', kind: 'mock', pattern: 'other.test' },
  ]
  assert.equal(findRule(rules, 'https://example.com/v1/listen')?.id, '1')
  assert.equal(findRule(rules, 'https://nope.test/'), undefined)
})

test('mockttp certificate noise is recognized and other logs are not', () => {
  assert.equal(isProxyNoise('Unknown TLS error: SSLV3_ALERT_CERTIFICATE_UNKNOWN'), true)
  assert.equal(isProxyNoise('Frida 17.26.2 is running'), false)
})

test('a loaded .proto decodes a Firestore-shaped listen request', () => {
  const schema = new ProtoSchema()
  const types = schema.loadSource(`
    syntax = "proto3";
    package google.firestore.v1;
    message ListenRequest {
      string database = 1;
      int32 target_id = 2;
    }
  `)
  assert.deepEqual(types, ['google.firestore.v1.ListenRequest'])
  const encoded = Buffer.from([0x0a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x10, 0x07])
  const text = schema.decode(encoded, 'application/x-protobuf', 'google.firestore.v1.ListenRequest')
  assert.match(text, /"database": "hello"/)
  assert.match(text, /"targetId": 7/)
})

test('history saves a session and searches it by host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sideglass-history-'))
  const history = new History(join(dir, 'history.sqlite'))
  history.open()
  history.save(exchange())
  const found = history.search('example.com')
  assert.equal(found.length, 1)
  assert.equal(found[0].path, '/v1/listen?x=1')
  const full = history.find('1')
  assert.equal(full?.app, 'com.example.app')
  assert.equal(history.load(history.sessionId).length, 1)
  history.close()
})

test('frida asset names follow the phone ABI', () => {
  assert.equal(fridaArch('arm64-v8a'), 'android-arm64')
  assert.equal(fridaArch('x86_64'), 'android-x86_64')
  assert.equal(fridaArch('armeabi-v7a'), 'android-arm')
  assert.equal(fridaArch('mips'), null)
  assert.equal(serverAsset('android-arm64'), 'frida-server-17.26.2-android-arm64')
})

test('xz bytes decompress', () => {
  const xz = execFileSync('python3', ['-c', 'import lzma,sys; sys.stdout.buffer.write(lzma.compress(b"frida-test"))'])
  assert.equal(isXz(xz), true)
  return decompressXz(xz).then((out) => {
    assert.equal(out.toString(), 'frida-test')
    assert.equal(isElf(out), false)
  })
})

test('java home prefers JAVA_HOME, then Android Studio', () => {
  assert.equal(
    javaHome({ JAVA_HOME: '/opt/jdk' }, (path) => path === '/opt/jdk/bin/java', 'linux', '/home/dev'),
    '/opt/jdk',
  )
  const studio = '/Applications/Android Studio.app/Contents/jbr/Contents/Home'
  assert.equal(javaHome({}, (path) => path === `${studio}/bin/java`, 'darwin', '/Users/dev'), studio)
  assert.equal(javaHome({}, () => false, 'linux', '/home/dev'), undefined)
})

test('command-line tools zip name follows the OS', () => {
  assert.match(commandLineToolsZip('darwin', 'arm64'), /^commandlinetools-mac_arm64-\d+_latest\.zip$/)
  assert.match(commandLineToolsZip('linux', 'x64'), /^commandlinetools-linux-\d+_latest\.zip$/)
  assert.match(commandLineToolsZip('win32', 'x64'), /^commandlinetools-win-\d+_latest\.zip$/)
})

test('unpacked command-line tools are moved to cmdline-tools/latest', () => {
  const extracted = mkdtempSync(join(tmpdir(), 'sideglass-tools-'))
  const sdk = mkdtempSync(join(tmpdir(), 'sideglass-sdk-'))
  mkdirSync(join(extracted, 'cmdline-tools', 'bin'), { recursive: true })
  writeFileSync(join(extracted, 'cmdline-tools', 'bin', 'sdkmanager'), '#!/bin/sh\n')
  const found = findToolsRoot(extracted)
  assert.ok(found)
  const dest = installToolsTree(found, sdk)
  assert.equal(readFileSync(join(dest, 'bin', 'sdkmanager'), 'utf8'), '#!/bin/sh\n')
})

test('a database preview lists a table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sideglass-preview-'))
  const file = join(dir, 'app.db')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES (\'hello\')')
  db.close()
  const preview = previewDatabase(readFileSync(file))
  assert.match(preview, /notes/)
  assert.match(preview, /hello/)
})

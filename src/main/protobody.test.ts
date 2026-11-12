import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { test } from 'node:test'
import { decodeGrpc, decodeProtobuf, formatFields, presentBody } from './protobody'

test('decodes a string and a varint without a schema', () => {
  // field 1, length-delimited "hi"; field 2, varint 150
  const buf = Buffer.from([0x0a, 0x02, 0x68, 0x69, 0x10, 0x96, 0x01])
  const fields = decodeProtobuf(buf)
  assert.ok(fields)
  assert.equal(formatFields(fields), '1: "hi"\n2: 150')
})

test('decodes a nested message', () => {
  // field 3, embedded { field 1: "a" }
  const inner = Buffer.from([0x0a, 0x01, 0x61])
  const buf = Buffer.concat([Buffer.from([0x1a, inner.length]), inner])
  const fields = decodeProtobuf(buf)
  assert.equal(formatFields(fields!), '3: {\n  1: "a"\n}')
})

test('keeps a long nested string as a message, not one flat string', () => {
  const text = 'com.example.very.long.package.name'
  const inner = Buffer.concat([Buffer.from([0x0a, text.length]), Buffer.from(text)])
  const buf = Buffer.concat([Buffer.from([0x12, inner.length]), inner])
  const fields = decodeProtobuf(buf)
  assert.equal(formatFields(fields!), `2: {\n  1: ${JSON.stringify(text)}\n}`)
  const short = '0123456789'
  const shortInner = Buffer.concat([Buffer.from([0x0a, short.length]), Buffer.from(short)])
  const shortBuf = Buffer.concat([Buffer.from([0x1a, shortInner.length]), shortInner])
  assert.match(formatFields(decodeProtobuf(shortBuf)!), /3: \{\n  1: "0123456789"\n\}/)
})

test('decodes a gzipped gRPC frame from the content type', () => {
  const message = Buffer.from([0x0a, 0x02, 0x68, 0x69])
  const gzip = gzipSync(message)
  const frame = Buffer.alloc(5 + gzip.length)
  frame[0] = 1
  frame.writeUInt32BE(gzip.length, 1)
  gzip.copy(frame, 5)
  assert.equal(decodeGrpc(frame)?.length, 1)
  const shown = presentBody(frame, 'application/grpc')
  assert.match(shown.text ?? '', /frame 1/)
  assert.match(shown.text ?? '', /"hi"/)
})

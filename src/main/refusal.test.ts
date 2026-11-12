import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogLine } from './logcat'
import { classifyRefusal } from './refusal'

function line(message: string, pid = 10): LogLine {
  return { at: '01-01 00:00:00.000', pid, level: 'I', tag: 'App', message }
}

test('a passing integrity label is not a refusal', () => {
  assert.equal(classifyRefusal([line('MEETS_DEVICE_INTEGRITY')], 'com.example', 10), null)
  assert.equal(classifyRefusal([line('frida is a toolkit')], 'com.example', 10), null)
})

test('a crash outranks an integrity line in the same batch', () => {
  const hit = classifyRefusal(
    [line('integrity check failed'), line('FATAL EXCEPTION: main')],
    'com.example',
    10,
  )
  assert.equal(hit?.kind, 'crash')
})

test('a real root or frida detection is reported', () => {
  assert.equal(classifyRefusal([line('device is rooted')], 'com.example', 10)?.kind, 'root')
  assert.equal(classifyRefusal([line('frida-server was detected')], 'com.example', 10)?.kind, 'frida')
})

test('log lines from another pid are ignored', () => {
  assert.equal(classifyRefusal([line('FATAL EXCEPTION: main', 99)], 'com.example', 10), null)
})

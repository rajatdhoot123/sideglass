import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLockPid } from './emulator'

test('parseLockPid reads the NUL-terminated pid qemu writes', () => {
  assert.equal(parseLockPid('65385\0'), 65385)
  assert.equal(parseLockPid('65385 \n'), 65385)
})

test('parseLockPid treats an empty lock as no pid and junk as invalid', () => {
  assert.equal(parseLockPid(''), 0)
  assert.equal(parseLockPid('\0\0'), 0)
  assert.ok(Number.isNaN(parseLockPid('abc')))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consoleError, recordingName } from './recorder'

test('reads a refusal from the emulator console, which exits 0 either way', () => {
  assert.equal(consoleError('OK\n'), null)
  assert.equal(consoleError('OK: recording is already stopped.\nOK\n'), null)
  assert.equal(consoleError('KO: Recording has already started\n'), 'Recording has already started')
  assert.equal(consoleError('KO\n'), 'the emulator refused the command')
})

test('names a saved recording by local time, with no characters a file system refuses', () => {
  const name = recordingName(new Date(2026, 10, 20, 9, 5, 7), 'webm')
  assert.equal(name, 'Sideglass 2026-11-20 09.05.07.webm')
  assert.doesNotMatch(name, /[:/\\\\]/)
})

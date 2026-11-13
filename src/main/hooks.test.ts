import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_SOURCE } from './agent'
import { namesFromPs, pidOfName, usapRestartNeeded } from './hooks'

test('a pre-forked app pool has to be cleared before icon taps can be hooked', () => {
  assert.equal(usapRestartNeeded('false', ['zygote64', 'system_server']), false)
  assert.equal(usapRestartNeeded('false', ['zygote64', 'usap64']), true)
  assert.equal(usapRestartNeeded('null', ['zygote64']), true)
  assert.equal(usapRestartNeeded('', []), true)
  assert.equal(usapRestartNeeded('true', []), true)
})

test('ps rows yield pids and names', () => {
  const table = 'PID NAME\n1 init\n200 zygote64\n201 usap64\n'
  assert.deepEqual(namesFromPs(table), ['init', 'zygote64', 'usap64'])
  assert.equal(pidOfName(table, 'zygote64'), '200')
  assert.equal(pidOfName(table, 'missing'), '')
})

test('the hooks agent does not touch Java until the host calls prepare', () => {
  assert.match(AGENT_SOURCE, /rpc\.exports/)
  assert.match(AGENT_SOURCE, /prepare: function/)
  assert.match(AGENT_SOURCE, /uid >= 10000/)
  assert.equal(AGENT_SOURCE.includes('\nhookNative()\n'), false)
})

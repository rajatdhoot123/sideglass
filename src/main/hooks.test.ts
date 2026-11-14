import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_SOURCE } from './agent'
import { namesFromPs, pidOfName, processStopped, runtimeSettled, usapRestartNeeded } from './hooks'

test('a restarted runtime counts as ready only once the user is unlocked and System UI runs', () => {
  const ps = 'PID NAME\n200 zygote64\n300 system_server\n400 com.android.systemui\n'
  assert.equal(runtimeSettled('    State: RUNNING_UNLOCKED\n', ps), true)
  assert.equal(runtimeSettled('    State: BOOTING\n', ps), false)
  assert.equal(runtimeSettled('    State: RUNNING_UNLOCKED\n', 'PID NAME\n200 zygote64\n'), false)
  assert.equal(runtimeSettled('', ps), false)
})

test('a zygote held by a tracer is reported as stopped', () => {
  assert.equal(processStopped('Name:\tzygote64\nState:\tt (tracing stop)\nTracerPid:\t3424\n'), true)
  assert.equal(processStopped('Name:\tzygote64\nState:\tT (stopped)\n'), true)
  assert.equal(processStopped('Name:\tzygote64\nState:\tS (sleeping)\n'), false)
  assert.equal(processStopped(''), false)
})

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
  assert.match(AGENT_SOURCE, /appId >= 10000 && appId <= 19999/)
  assert.match(AGENT_SOURCE, /if \(!pkg\) return true/)
  assert.match(AGENT_SOURCE, /started: function/)
  assert.equal(AGENT_SOURCE.includes('\nhookNative()\n'), false)
})

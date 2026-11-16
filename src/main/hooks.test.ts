import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_SOURCE } from './agent'
import { namesFromPs, pidOfName, processStopped, runtimeSettled, usapRestartNeeded, zygoteSample } from './hooks'

test('a restarted runtime is ready once System UI is up, including on the lock screen', () => {
  const ps = 'PID NAME\n200 zygote64\n300 system_server\n400 com.android.systemui\n'
  assert.equal(runtimeSettled('    State: RUNNING_UNLOCKED\n', ps), true)
  assert.equal(runtimeSettled('    State: RUNNING_LOCKED\n', ps), true)
  assert.equal(runtimeSettled('    State: RUNNING_UNLOCKING\n', ps), true)
  assert.equal(runtimeSettled('    State: BOOTING\n', ps), false)
  assert.equal(runtimeSettled('    State: STOPPING\n', ps), false)
  assert.equal(runtimeSettled('    State: RUNNING_UNLOCKED\n', 'PID NAME\n200 zygote64\n'), false)
  assert.equal(runtimeSettled('', ps), false)
})

test('a zygote held by a tracer is reported as stopped', () => {
  assert.equal(processStopped('Name:\tzygote64\nState:\tt (tracing stop)\nTracerPid:\t3424\n'), true)
  assert.equal(processStopped('Name:\tzygote64\nState:\tT (stopped)\n'), true)
  assert.equal(processStopped('Name:\tzygote64\nState:\tS (sleeping)\n'), false)
  assert.equal(processStopped(''), false)
})

test('an unreadable zygote status is not treated as a running process', () => {
  assert.equal(zygoteSample('Name:\tzygote64\nState:\tS (sleeping)\n'), 'running')
  assert.equal(zygoteSample('Name:\tzygote64\nState:\tR (running)\n'), 'running')
  assert.equal(zygoteSample('Name:\tzygote64\nState:\tt (tracing stop)\nTracerPid:\t3424\n'), 'stopped')
  assert.equal(zygoteSample('Name:\tzygote64\nState:\tT (stopped)\n'), 'stopped')
  assert.equal(zygoteSample(''), 'unreadable')
  assert.equal(zygoteSample('cat: /proc//status: No such file'), 'unreadable')
})

test('a pre-forked app pool has to be cleared before icon taps can be hooked', () => {
  assert.equal(usapRestartNeeded('false', ['zygote64', 'system_server']), false)
  assert.equal(usapRestartNeeded('false', ['zygote64', 'usap64']), true)
  // Never set means off on current Android. Restarting for it took system_server down every session.
  assert.equal(usapRestartNeeded('null', ['zygote64']), false)
  assert.equal(usapRestartNeeded('', []), false)
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

test('proc maps are filtered in native code and read() stays unhooked', () => {
  assert.match(AGENT_SOURCE, /new CModule\(MAPS_FILTER_C/)
  assert.match(AGENT_SOURCE, /memfd_create/)
  assert.match(AGENT_SOURCE, /\/proc\/self\/maps/)
  assert.match(AGENT_SOURCE, /\/proc\/self\/status/)
  for (const word of ['linjector', 'gadget', 'zygisk']) {
    assert.ok(AGENT_SOURCE.includes(word), word)
  }
  assert.equal(AGENT_SOURCE.includes('readByteArray'), false)
  assert.match(AGENT_SOURCE, /arm\(globalExport\('__openat_2'\), ptr\(2\)\)/)
  assert.match(AGENT_SOURCE, /arm\(globalExport\('__open_2'\), ptr\(1\)\)/)
  assert.match(AGENT_SOURCE, /if \(!skipPackage\(pkg\)\) \{/)
  assert.match(AGENT_SOURCE, /installMapsFilter\(!!\(options && options\.running\)\)/)
  assert.match(AGENT_SOURCE, /if \(mapsWanted\) installMapsFilter\(true\)/)
  const prepareAt = AGENT_SOURCE.indexOf('prepare: function')
  const prepareBody = AGENT_SOURCE.slice(prepareAt, AGENT_SOURCE.indexOf('started: function'))
  assert.ok(prepareBody.indexOf('installMapsFilter') !== -1)
  assert.ok(prepareBody.indexOf('installMapsFilter') < prepareBody.indexOf('queueJava(function'))
})

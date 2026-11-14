import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPin, keyguardShowingFrom } from './lock'

test('reads whether the lock screen is showing from dumpsys window policy', () => {
  const policy = 'WINDOW MANAGER POLICY STATE\n    KeyguardServiceDelegate\n      showing=true\n      inputRestricted=true\n'
  assert.equal(keyguardShowingFrom(policy), true)
  assert.equal(keyguardShowingFrom(policy.replace('showing=true', 'showing=false')), false)
  assert.equal(keyguardShowingFrom('mShowingDream=false\n'), null)
})

test('only types PINs made of digits', () => {
  assert.equal(isPin('1234'), true)
  assert.equal(isPin('12'), false)
  assert.equal(isPin('12 34; reboot'), false)
})

test('storage only reads plain paths inside the app folders', async () => {
  const { readablePath } = await import('./storage')
  assert.equal(readablePath('/data/data/com.a.b/shared_prefs/x.xml', 'com.a.b', 'su'), true)
  assert.equal(readablePath('/data/data/com.a.b/shared_prefs/a;id>x.xml', 'com.a.b', 'su'), false)
  assert.equal(readablePath('/data/data/com.a.b/databases/../../x', 'com.a.b', 'shell'), false)
  assert.equal(readablePath('/data/data/com.other/databases/x.db', 'com.a.b', 'su'), false)
  assert.equal(readablePath('databases/app.db', 'com.a.b', 'run-as'), true)
})

test('only a refused PIN stops the lock keeper; a silent or failed verify is retried', async () => {
  const { verifyResult } = await import('./lock')
  assert.equal(verifyResult('Lock credential verified successfully\n'), 'verified')
  assert.equal(verifyResult("Old password '1234' didn't match\n"), 'rejected')
  assert.equal(verifyResult(''), 'unknown')
  assert.equal(verifyResult(null), 'unknown')
  assert.equal(verifyResult("Can't find service: lock_settings\n"), 'unknown')
})

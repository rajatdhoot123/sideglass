import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const agent = readFileSync(join(process.cwd(), 'scripts', 'frida-agent', 'index.mjs'), 'utf8')

test('the unpinning script covers the libraries the roadmap names', () => {
  for (const name of [
    'com.android.org.conscrypt.TrustManagerImpl',
    'okhttp3.CertificatePinner',
    'android.security.net.config.NetworkSecurityTrustManager',
    'SSL_CTX_set_custom_verify',
    'flutter|ssl|boring|cronet|conscrypt',
  ]) {
    assert.match(agent, new RegExp(name.replace(/[.]/g, '\\.')))
  }
  assert.doesNotMatch(agent, /httptoolkit/i)
})

test('the unpinning agent compiles with the Java bridge', async (t) => {
  const frida = await import('frida').catch(() => null)
  if (!frida || typeof frida.Compiler !== 'function') {
    t.skip('frida native module is not installed')
    return
  }
  const compiler = new frida.Compiler()
  const bundle = await compiler.build(join(process.cwd(), 'scripts', 'frida-agent', 'index.mjs'), { projectRoot: process.cwd() })
  assert.match(bundle, /TrustManagerImpl/)
  assert.match(bundle, /CertificatePinner/)
  assert.match(bundle, /SSL_CTX_set_custom_verify/)
})

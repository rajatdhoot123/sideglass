import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_SOURCE } from './agent'
import { sha256, trustedServerXz } from './frida'

test('the hooks agent unpins the TLS stacks the roadmap names', () => {
  for (const name of [
    'com.android.org.conscrypt.TrustManagerImpl',
    'okhttp3.CertificatePinner',
    'android.security.net.config.NetworkSecurityTrustManager',
    'SSL_CTX_set_custom_verify',
    'ssl|boring|cronet|conscrypt',
    'X509_verify_cert',
  ]) {
    assert.ok(AGENT_SOURCE.includes(name), name)
  }
  assert.doesNotMatch(AGENT_SOURCE, /httptoolkit/i)
})

test('the hooks agent keeps FLAG_SECURE off so the mirror is not black', () => {
  assert.match(AGENT_SOURCE, /FLAG_SECURE off/)
  assert.match(AGENT_SOURCE, /SurfaceView/)
})

test('only the published frida-server release files are trusted', () => {
  assert.equal(trustedServerXz('android-arm64', Buffer.from('not frida')), false)
  assert.equal(trustedServerXz('android-x86', Buffer.from('x')), false)
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExchangeSummary } from '../../shared'
import { parseFilter, resourceType } from './netfilter'

const ex = (over: Partial<ExchangeSummary>): ExchangeSummary => ({
  id: '1',
  startedAt: 0,
  method: 'GET',
  url: 'https://api.example.com/v1/users?id=2',
  host: 'api.example.com',
  path: '/v1/users?id=2',
  httpVersion: '1.1',
  requestBodySize: 0,
  status: 200,
  state: 'done',
  contentType: 'application/json',
  responseBodySize: 2048,
  app: 'com.example.shop',
  ...over,
})

const keep = (q: string, e: ExchangeSummary) => parseFilter(q)(e)

test('plain text, negation and regex match the URL', () => {
  const e = ex({})
  assert.ok(keep('', e))
  assert.ok(keep('users', e))
  assert.ok(keep('USERS v1', e))
  assert.ok(!keep('users orders', e))
  assert.ok(!keep('-users', e))
  assert.ok(keep('-analytics', e))
  assert.ok(keep('/v\\d+\\/users/', e))
  assert.ok(!keep('/v\\d+\\/orders/', e))
  assert.doesNotThrow(() => keep('/users[/', e), 'invalid regex falls back to text')
})

test('property filters', () => {
  const e = ex({})
  assert.ok(keep('method:get', e))
  assert.ok(keep('method:POST,GET', e))
  assert.ok(!keep('method:POST', e))
  assert.ok(keep('status-code:200', e))
  assert.ok(keep('status-code:2xx', e))
  assert.ok(!keep('status-code:4xx', e))
  assert.ok(keep('domain:*.example.com', e))
  assert.ok(!keep('domain:*.other.com', e))
  assert.ok(keep('-domain:cdn.example.com', e))
  assert.ok(keep('app:shop', e))
  assert.ok(keep('mime-type:application/json', e))
  assert.ok(keep('larger-than:1k', e))
  assert.ok(!keep('larger-than:1M', e))
  assert.ok(keep('smaller-than:3kb', e))
  assert.ok(keep('scheme:https', e))
  assert.ok(keep('is:running', ex({ state: 'pending', status: undefined })))
  assert.ok(keep('is:error', ex({ status: 500 })))
  assert.ok(keep('method:', e), 'empty value is ignored while typing')
  assert.ok(keep('https://api', e), 'unknown key is plain text')
})

test('resource types', () => {
  assert.equal(resourceType({ contentType: 'application/json; charset=utf-8', path: '/a' }), 'fetch')
  assert.equal(resourceType({ contentType: 'application/x-protobuf', path: '/a' }), 'fetch')
  assert.equal(resourceType({ contentType: 'image/webp', path: '/a' }), 'img')
  assert.equal(resourceType({ contentType: 'text/html', path: '/' }), 'doc')
  assert.equal(resourceType({ contentType: undefined, path: '/app.js?v=2' }), 'js')
  assert.equal(resourceType({ contentType: 'application/octet-stream', path: '/seg.m4s' }), 'media')
  assert.equal(resourceType({ contentType: 'application/octet-stream', path: '/blob' }), 'other')
  assert.equal(resourceType({ contentType: undefined, path: '/api' }), 'fetch')
})

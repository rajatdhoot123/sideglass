import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codeQueryFor, looksStatic } from './codequery'
import { classPathFor, highlightJava } from './codeview'

test('codeQueryFor keeps the hand-written part of a path', () => {
  assert.equal(codeQueryFor('https://api.example.com/v1/users/12345/posts?x=1'), 'v1/users')
  assert.equal(codeQueryFor('https://api.example.com/v2/feed/home-timeline'), 'v2/feed/home-timeline')
  assert.equal(codeQueryFor('https://api.example.com/items/3f2a1b4c-1111-2222-3333-444455556666/like'), 'items')
})

test('codeQueryFor falls back to the host for generic or empty paths', () => {
  assert.equal(codeQueryFor('https://events.example.io/'), 'events.example.io')
  assert.equal(codeQueryFor('https://example.com/api/123'), 'example.com')
  assert.equal(codeQueryFor('not a url'), 'not a url')
})

test('looksStatic rejects ids and tokens', () => {
  assert.equal(looksStatic('users'), true)
  assert.equal(looksStatic('v1'), true)
  assert.equal(looksStatic('98765'), false)
  assert.equal(looksStatic('aB3dE5fG7hJ9kL1mN3pQ5'), false)
})

test('highlightJava marks keywords, strings and comments', () => {
  const tokens = highlightJava('public String x = "a\\"b"; // note')
  assert.deepEqual(
    tokens.filter((t) => t.kind).map((t) => [t.kind, t.text]),
    [
      ['kw', 'public'],
      ['type', 'String'],
      ['str', '"a\\"b"'],
      ['com', '// note'],
    ],
  )
  assert.equal(tokens.map((t) => t.text).join(''), 'public String x = "a\\"b"; // note')
})

test('classPathFor resolves imports, the same package, then a unique simple name', () => {
  const files = ['sources/com/app/Main.java', 'sources/com/app/Helper.java', 'sources/com/lib/Api.java', 'sources/com/other/Only.java']
  const source = 'package com.app;\n\nimport com.lib.Api;\n\nclass Main {}'
  assert.equal(classPathFor('Api', source, 'sources/com/app/Main.java', files), 'sources/com/lib/Api.java')
  assert.equal(classPathFor('Helper', source, 'sources/com/app/Main.java', files), 'sources/com/app/Helper.java')
  assert.equal(classPathFor('Only', source, 'sources/com/app/Main.java', files), 'sources/com/other/Only.java')
  assert.equal(classPathFor('Missing', source, 'sources/com/app/Main.java', files), null)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inputForRequest, type PhoneInput } from './timeline'

const input = (id: string, at: number): PhoneInput => ({ id, at, device: 'capture', kind: 'tap', label: id })

test('groups a request under the latest input inside two seconds', () => {
  const inputs = [input('a', 1000), input('b', 2000)]
  assert.equal(inputForRequest(inputs, 2500), 'b')
  assert.equal(inputForRequest(inputs, 1900), 'a')
  assert.equal(inputForRequest(inputs, 4500), undefined)
  assert.equal(inputForRequest(inputs, 500), undefined)
})

test('does not attach capture traffic to a Play phone gesture', () => {
  const inputs = [input('cap', 1000), { ...input('play', 1500), device: 'play' as const }]
  assert.equal(inputForRequest(inputs, 1600), 'cap')
})

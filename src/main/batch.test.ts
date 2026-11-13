import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Batcher } from './batch'

test('keeps the latest state of each id and flushes once', async () => {
  const flushed: { id: string; v: number }[][] = []
  const batch = new Batcher<{ id: string; v: number }>((items) => flushed.push(items), 10)
  batch.push({ id: 'a', v: 1 })
  batch.push({ id: 'b', v: 1 })
  batch.push({ id: 'a', v: 2 })
  assert.equal(flushed.length, 0)
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(flushed, [
    [
      { id: 'a', v: 2 },
      { id: 'b', v: 1 },
    ],
  ])
})

test('discard drops pending items', async () => {
  const flushed: unknown[] = []
  const batch = new Batcher<{ id: string }>((items) => flushed.push(items), 10)
  batch.push({ id: 'a' })
  batch.discard()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(flushed.length, 0)
})

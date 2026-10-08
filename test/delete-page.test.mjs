import test from 'node:test'
import assert from 'node:assert/strict'
import { removePageStorage } from '../ui/deletePage.js'

function harness({ fail = () => null } = {}) {
  const calls = []
  async function attempt(path) {
    calls.push(path)
    const error = fail(path)
    if (error) throw error
    return { synced: true }
  }
  return {
    calls,
    storage: { removeConfirmed: attempt, remove: attempt, removeFolder: attempt },
  }
}

test('the record goes before its content, and the saved page data goes too', async () => {
  const h = harness()
  await removePageStorage(h.storage, 'p1')
  assert.equal(h.calls[0], 'artifacts/p1.json',
    'the record that makes the page exist is removed first')
  assert.deepEqual(h.calls.slice(1).sort(), [
    'artifact-data/p1',
    'projects/p1',
    'shares/p1.json',
    'versions/p1',
  ])
})

test('a failed record removal leaves the whole page intact for a retry', async () => {
  const h = harness({ fail: path => (path === 'artifacts/p1.json' ? new Error('nope') : null) })
  await assert.rejects(removePageStorage(h.storage, 'p1'), /nope/)
  assert.deepEqual(h.calls, ['artifacts/p1.json'],
    'no content is removed while the page is still listed')
})

test('one unremovable leftover cannot fail the deletion or block the others', async () => {
  const h = harness({ fail: path => (path === 'versions/p1' ? new Error('locked') : null) })
  await removePageStorage(h.storage, 'p1')
  assert.deepEqual(h.calls.slice(1).sort(), [
    'artifact-data/p1',
    'projects/p1',
    'shares/p1.json',
    'versions/p1',
  ])
})

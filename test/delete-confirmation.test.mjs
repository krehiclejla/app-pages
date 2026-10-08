import test from 'node:test'
import assert from 'node:assert/strict'
import { makeStorage } from '../storage.js'
import { removePageStorage } from '../ui/deletePage.js'

// Runtime contract double: remove owns the optimistic mirror and coalesces
// older same-path writes before draining. HTTP GET sees only server state.
function harness(t, mode = 'confirmed') {
  const path = 'artifacts/p1.json', record = { id: 'p1', title: 'Fixture page' }
  const server = new Map([[path, record]]), cache = new Map(server)
  let outbox = [{ method: 'PUT', path, value: record }]
  const calls = [], folders = []
  const runtime = {
    async get(key) { return cache.get(key) ?? null },
    async remove(key) {
      calls.push(['runtime-remove', key])
      if (mode === 'throws') throw new Error('runtime unavailable')
      cache.delete(key)
      outbox = outbox.filter(op => op.path !== key)
      outbox.push({ method: 'DELETE', path: key })
      if (mode === 'queued') return { queued: true }
      outbox = []
      if (mode === 'refused') { cache.set(key, server.get(key)); return { synced: true } }
      server.delete(key)
      return { synced: true }
    },
  }
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const key = url.replace('/api/storage/apps/fixture/', '')
    calls.push([init.method || 'GET', key])
    if (init.method === 'DELETE') {
      assert.equal(server.has(path), false, 'server record is absent before content cleanup')
      if (key.startsWith('folder/')) folders.push(key)
      server.delete(key)
      return { ok: true, status: 204 }
    }
    assert.equal(init.cache, 'no-store', 'confirmation cannot reuse an HTTP cache entry')
    if (mode === 'read-fails') throw new Error('confirmation unavailable')
    return { ok: server.has(key), status: server.has(key) ? 200 : 404,
      json: async () => server.get(key) }
  })
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  globalThis.window = { mobius: { storage: runtime } }
  t.after(() => {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
    else delete globalThis.window
  })
  const storage = makeStorage('fixture', 'synthetic-token')
  return { storage, calls, folders, server, cache, pending: () => outbox }
}

for (const mode of ['queued', 'refused', 'throws', 'read-fails']) {
  test(`${mode} record deletion cannot start content cleanup through the actual adapter`, async t => {
    const h = harness(t, mode)
    await assert.rejects(removePageStorage(h.storage, 'p1'))
    assert.deepEqual(h.folders, [])
    assert.equal(h.calls.some(([method]) => method === 'DELETE'), false)
    if (mode !== 'read-fails') assert.ok(h.server.has('artifacts/p1.json'))
  })
}

test('confirmed runtime deletion precedes cleanup, retains a tombstone and supersedes stale queued puts', async t => {
  const h = harness(t)
  await removePageStorage(h.storage, 'p1')
  assert.deepEqual(h.calls.slice(0, 2), [
    ['runtime-remove', 'artifacts/p1.json'], ['GET', 'artifacts/p1.json'],
  ])
  assert.equal(h.folders.length, 3)
  assert.equal(await h.storage.get('artifacts/p1.json'), null)
  assert.deepEqual(h.pending(), [], 'no old PUT can resurrect the record on reconnect')
  assert.equal(h.server.has('artifacts/p1.json'), false)
})

for (const status of [403, 503, 404]) {
  test(`without runtime, HTTP ${status} deletion is ${status === 404 ? 'confirmed before cleanup' : 'failure-propagating'}`, async t => {
    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    delete globalThis.window
    t.after(() => { if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow) })
    const calls = []
    t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
      const path = url.replace('/api/storage/apps/fixture/', '')
      calls.push([init.method || 'GET', path])
      const record = path === 'artifacts/p1.json'
      return { ok: !record, status: record ? (init.method === 'DELETE' ? status : 404) : 204 }
    })
    const storage = makeStorage('fixture', 'synthetic-token')
    if (status === 404) {
      await removePageStorage(storage, 'p1')
      assert.deepEqual(calls.slice(0, 2), [['DELETE', 'artifacts/p1.json'], ['GET', 'artifacts/p1.json']])
      assert.equal(calls.length, 6)
    } else {
      await assert.rejects(removePageStorage(storage, 'p1'), new RegExp(String(status)))
      assert.deepEqual(calls, [['DELETE', 'artifacts/p1.json']])
    }
  })
}

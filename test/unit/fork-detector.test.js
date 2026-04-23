import test from 'brittle'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { ForkDetector, FORK_DETECTOR_SCHEMA_VERSION } from 'p2p-hiverelay/core/fork-detector.js'

function validHex () {
  return Array.from({ length: 64 }).map((_, i) => (i % 16).toString(16)).join('')
}

function altHex () {
  return Array.from({ length: 64 }).map((_, i) => ((i + 7) % 16).toString(16)).join('')
}

function evidence (relay, suffix = '1') {
  return {
    fromRelay: relay,
    block: 'block-bytes-' + suffix,
    signature: 'sig-' + suffix
  }
}

async function setup (t) {
  const dir = await mkdtemp(join(tmpdir(), 'fork-detector-'))
  t.teardown(async () => { try { await rm(dir, { recursive: true, force: true }) } catch (_) {} })
  return new ForkDetector({ storagePath: join(dir, 'forks.json') })
}

test('schema version is exposed for forward compat', async (t) => {
  t.is(FORK_DETECTOR_SCHEMA_VERSION, 1)
})

test('starts empty + isQuarantined returns false for unknown keys', async (t) => {
  const fd = await setup(t)
  t.absent(fd.isQuarantined(validHex()))
  t.is(fd.unresolvedCount(), 0)
  t.is(fd.list().length, 0)
})

test('report records a new fork and emits fork-detected', async (t) => {
  const fd = await setup(t)
  let fired = null
  fd.on('fork-detected', (info) => { fired = info })
  const result = fd.report({
    hypercoreKey: validHex(),
    blockIndex: 42,
    evidenceA: evidence('relayA', 'a'),
    evidenceB: evidence('relayB', 'b')
  })
  t.ok(result.ok)
  t.is(result.recordExists, false)
  t.ok(fired)
  t.is(fired.record.blockIndex, 42)
  t.is(fired.record.evidence.length, 2)
})

test('report rejects bad inputs with clear reasons', async (t) => {
  const fd = await setup(t)
  t.is(fd.report({ hypercoreKey: 'not-hex', blockIndex: 0, evidenceA: evidence('a'), evidenceB: evidence('b', '2') }).reason, 'bad hypercoreKey')
  t.is(fd.report({ hypercoreKey: validHex(), blockIndex: -1, evidenceA: evidence('a'), evidenceB: evidence('b', '2') }).reason, 'bad blockIndex')
  t.is(fd.report({ hypercoreKey: validHex(), blockIndex: 1.5, evidenceA: evidence('a'), evidenceB: evidence('b', '2') }).reason, 'bad blockIndex')
  t.is(fd.report({ hypercoreKey: validHex(), blockIndex: 0, evidenceA: { foo: 'bar' }, evidenceB: evidence('b', '2') }).reason, 'evidence requires fromRelay + block + signature')
})

test('identical-signature evidence pair is rejected (not actually a fork)', async (t) => {
  const fd = await setup(t)
  const sameSig = evidence('relayA', 'same')
  const sameSigDifferentRelay = { ...sameSig, fromRelay: 'relayB' }
  const result = fd.report({
    hypercoreKey: validHex(),
    blockIndex: 1,
    evidenceA: sameSig,
    evidenceB: sameSigDifferentRelay
  })
  t.absent(result.ok)
  t.ok(result.reason.includes('identical signatures'))
})

test('isQuarantined returns true for unresolved fork', async (t) => {
  const fd = await setup(t)
  const key = validHex()
  fd.report({
    hypercoreKey: key,
    blockIndex: 1,
    evidenceA: evidence('a', '1'),
    evidenceB: evidence('b', '2')
  })
  t.ok(fd.isQuarantined(key))
})

test('reporting same fork twice appends additional evidence (not duplicates)', async (t) => {
  const fd = await setup(t)
  const key = validHex()
  fd.report({
    hypercoreKey: key,
    blockIndex: 5,
    evidenceA: evidence('relayA', '1'),
    evidenceB: evidence('relayB', '2')
  })
  let evidenceAdded = false
  fd.on('evidence-added', () => { evidenceAdded = true })
  // Re-report from the same two relays — no new evidence
  const dup = fd.report({
    hypercoreKey: key,
    blockIndex: 5,
    evidenceA: evidence('relayA', '1'),
    evidenceB: evidence('relayB', '2')
  })
  t.ok(dup.ok)
  t.ok(dup.recordExists)
  t.absent(evidenceAdded)

  // Report from a third relay observing the same divergence — adds evidence
  fd.report({
    hypercoreKey: key,
    blockIndex: 5,
    evidenceA: evidence('relayA', '1'),
    evidenceB: evidence('relayC', '3')
  })
  t.ok(evidenceAdded)
  const list = fd.list()
  t.is(list[0].evidence.length, 3)
})

test('resolve marks fork as handled and clears quarantine', async (t) => {
  const fd = await setup(t)
  const key = validHex()
  fd.report({ hypercoreKey: key, blockIndex: 0, evidenceA: evidence('a', '1'), evidenceB: evidence('b', '2') })
  t.ok(fd.isQuarantined(key))
  let resolved = false
  fd.on('fork-resolved', () => { resolved = true })
  const r = fd.resolve(key, { resolution: 'rotated', note: 'Operator rotated keys' })
  t.ok(r.ok)
  t.absent(fd.isQuarantined(key), 'no longer quarantined after resolution')
  t.ok(resolved)
})

test('resolve rejects unknown resolution values', async (t) => {
  const fd = await setup(t)
  const key = validHex()
  fd.report({ hypercoreKey: key, blockIndex: 0, evidenceA: evidence('a', '1'), evidenceB: evidence('b', '2') })
  const r = fd.resolve(key, { resolution: 'maybe-later' })
  t.absent(r.ok)
  t.ok(r.reason.includes('must be one of'))
})

test('resolve rejects unknown hypercore key', async (t) => {
  const fd = await setup(t)
  const r = fd.resolve(validHex(), { resolution: 'rotated' })
  t.absent(r.ok)
  t.ok(r.reason.includes('no fork'))
})

test('unresolvedCount tracks open forks correctly', async (t) => {
  const fd = await setup(t)
  const k1 = validHex()
  const k2 = altHex()
  fd.report({ hypercoreKey: k1, blockIndex: 0, evidenceA: evidence('a', '1'), evidenceB: evidence('b', '2') })
  fd.report({ hypercoreKey: k2, blockIndex: 0, evidenceA: evidence('a', '3'), evidenceB: evidence('b', '4') })
  t.is(fd.unresolvedCount(), 2)
  fd.resolve(k1, { resolution: 'rotated' })
  t.is(fd.unresolvedCount(), 1)
})

test('save + load persists records across instances', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fork-detector-'))
  t.teardown(async () => { try { await rm(dir, { recursive: true, force: true }) } catch (_) {} })
  const path = join(dir, 'forks.json')

  const fd1 = new ForkDetector({ storagePath: path })
  const key = validHex()
  fd1.report({ hypercoreKey: key, blockIndex: 7, evidenceA: evidence('a', '1'), evidenceB: evidence('b', '2') })
  await fd1.save()

  const fd2 = new ForkDetector({ storagePath: path })
  await fd2.load()
  t.ok(fd2.isQuarantined(key))
  t.is(fd2.list().length, 1)
  t.is(fd2.list()[0].blockIndex, 7)
})

test('load tolerates corrupted JSON', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fork-detector-'))
  t.teardown(async () => { try { await rm(dir, { recursive: true, force: true }) } catch (_) {} })
  const path = join(dir, 'forks.json')
  await writeFile(path, '{not real json', 'utf8')

  const fd = new ForkDetector({ storagePath: path })
  let errored = false
  fd.on('load-error', () => { errored = true })
  await fd.load()
  t.ok(errored)
  t.is(fd.list().length, 0)
})

test('load is no-op on missing file (first run)', async (t) => {
  const fd = await setup(t)
  await fd.load()
  t.is(fd.list().length, 0)
})

test('enforces maxForks cap with oldest-first eviction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fork-detector-'))
  t.teardown(async () => { try { await rm(dir, { recursive: true, force: true }) } catch (_) {} })
  const fd = new ForkDetector({ storagePath: join(dir, 'forks.json'), maxForks: 2 })
  let evicted = 0
  fd.on('evicted', () => { evicted++ })
  // Three distinct keys
  const k1 = '11' + 'a'.repeat(62)
  const k2 = '22' + 'a'.repeat(62)
  const k3 = '33' + 'a'.repeat(62)
  fd.report({ hypercoreKey: k1, blockIndex: 0, evidenceA: evidence('a', '1'), evidenceB: evidence('b', '2') })
  await new Promise(resolve => setTimeout(resolve, 5))
  fd.report({ hypercoreKey: k2, blockIndex: 0, evidenceA: evidence('a', '3'), evidenceB: evidence('b', '4') })
  await new Promise(resolve => setTimeout(resolve, 5))
  fd.report({ hypercoreKey: k3, blockIndex: 0, evidenceA: evidence('a', '5'), evidenceB: evidence('b', '6') })
  t.is(fd.list().length, 2)
  t.is(evicted, 1, 'oldest evicted')
  // k1 was oldest
  t.absent(fd.isQuarantined(k1))
  t.ok(fd.isQuarantined(k2))
  t.ok(fd.isQuarantined(k3))
})

test('list() returns all records in a snapshot-friendly shape', async (t) => {
  const fd = await setup(t)
  fd.report({ hypercoreKey: validHex(), blockIndex: 0, evidenceA: evidence('a', '1'), evidenceB: evidence('b', '2') })
  const list = fd.list()
  t.is(list.length, 1)
  t.ok(list[0].hypercoreKey)
  t.ok(typeof list[0].discoveredAt === 'number')
  t.is(list[0].evidence.length, 2)
})

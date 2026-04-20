import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PersistentStore, openStore } from 'p2p-hiverelay/core/persistence/store.js'
import { CreditManager } from 'p2p-hiverelay/incentive/credits/index.js'
import { ReputationSystem } from 'p2p-hiverelay/incentive/reputation/index.js'

function tmpDir () {
  return mkdtempSync(join(tmpdir(), 'hiverelay-store-'))
}

test('PersistentStore - set/get/delete/entries', () => {
  const dir = tmpDir()
  try {
    const s = openStore(dir, { autoSnapshot: false })

    s.set('a', { n: 1 })
    s.set('b', { n: 2 })
    assert.deepEqual(s.get('a'), { n: 1 })
    assert.deepEqual(s.get('b'), { n: 2 })
    assert.equal(s.size, 2)

    assert.equal(s.delete('a'), true)
    assert.equal(s.get('a'), undefined)
    assert.equal(s.size, 1)

    const entries = [...s.entries()]
    assert.equal(entries.length, 1)
    assert.equal(entries[0][0], 'b')

    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PersistentStore - crash recovery replays WAL without snapshot', () => {
  const dir = tmpDir()
  try {
    const s1 = openStore(dir, { autoSnapshot: false })
    s1.set('k1', 'v1')
    s1.set('k2', 'v2')
    s1.set('k1', 'v1-updated')
    s1.delete('k2')
    // Do NOT call snapshot — simulate a crash before snapshot runs
    s1.flush()
    // Simulate abrupt close (don't trigger snapshot-on-close)
    s1._opsSinceSnapshot = 0 // so close() doesn't snapshot
    s1.close()

    assert.ok(existsSync(join(dir, 'wal.jsonl')))
    assert.equal(existsSync(join(dir, 'current.json')), false)

    const s2 = openStore(dir, { autoSnapshot: false })
    assert.equal(s2.get('k1'), 'v1-updated')
    assert.equal(s2.get('k2'), undefined)
    s2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PersistentStore - snapshot compacts WAL', () => {
  const dir = tmpDir()
  try {
    const s = openStore(dir, { autoSnapshot: false })
    for (let i = 0; i < 50; i++) s.set('k' + i, i)
    s.flush()

    const walBefore = readFileSync(join(dir, 'wal.jsonl'), 'utf8')
    assert.ok(walBefore.length > 0)

    s.snapshot()

    const walAfter = readFileSync(join(dir, 'wal.jsonl'), 'utf8')
    assert.equal(walAfter.length, 0, 'WAL should be truncated after snapshot')
    assert.ok(existsSync(join(dir, 'current.json')))

    // In-memory state unchanged
    for (let i = 0; i < 50; i++) assert.equal(s.get('k' + i), i)

    s.close()

    // Reopen - should load purely from snapshot
    const s2 = openStore(dir, { autoSnapshot: false })
    for (let i = 0; i < 50; i++) assert.equal(s2.get('k' + i), i)
    s2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PersistentStore - snapshot + subsequent WAL replay', () => {
  const dir = tmpDir()
  try {
    const s1 = openStore(dir, { autoSnapshot: false })
    s1.set('a', 1)
    s1.set('b', 2)
    s1.snapshot()
    s1.set('c', 3)
    s1.set('a', 10) // update after snapshot
    s1._opsSinceSnapshot = 0 // prevent snapshot-on-close
    s1.close()

    const s2 = openStore(dir, { autoSnapshot: false })
    assert.equal(s2.get('a'), 10)
    assert.equal(s2.get('b'), 2)
    assert.equal(s2.get('c'), 3)
    s2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PersistentStore - auto-snapshot triggers after ops threshold', () => {
  const dir = tmpDir()
  try {
    const s = new PersistentStore(dir, { snapshotOps: 5, autoSnapshot: true, snapshotMs: 0 })
    s.open()
    let snapshots = 0
    s.on('snapshot', () => snapshots++)

    for (let i = 0; i < 12; i++) s.set('k' + i, i)

    // At least two auto-snapshots (at 5 and 10)
    assert.ok(snapshots >= 2, `expected >= 2 snapshots, got ${snapshots}`)
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PersistentStore - corrupt trailing WAL line is tolerated', () => {
  const dir = tmpDir()
  try {
    const s = openStore(dir, { autoSnapshot: false })
    s.set('ok', 'value')
    s.flush()
    s._opsSinceSnapshot = 0
    s.close()

    // Append a partial/corrupt line
    const fd = openSync(join(dir, 'wal.jsonl'), 'a')
    writeSync(fd, '{"op":"set","k":"broken"')
    closeSync(fd)

    const s2 = openStore(dir, { autoSnapshot: false })
    assert.equal(s2.get('ok'), 'value')
    assert.equal(s2.get('broken'), undefined)
    s2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PersistentStore - load empty snapshot file', () => {
  const dir = tmpDir()
  try {
    // Pre-create an empty snapshot file
    writeFileSync(join(dir, 'current.json'), '')
    const s = openStore(dir, { autoSnapshot: false })
    assert.equal(s.size, 0)
    s.set('x', 1)
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PersistentStore - creates directory if missing', () => {
  const dir = join(tmpdir(), 'hiverelay-store-missing-' + Date.now())
  try {
    assert.equal(existsSync(dir), false)
    const s = openStore(dir, { autoSnapshot: false })
    s.set('a', 1)
    assert.ok(existsSync(dir))
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CreditManager - persists wallet changes via store and recovers after restart', () => {
  const dir = tmpDir()
  try {
    const s1 = openStore(dir, { autoSnapshot: false })
    const cm1 = new CreditManager({ persistence: s1, welcomeCredits: 0 })
    cm1.topUp('app-1', 5000)
    cm1.deduct('app-1', 100, 'ai.infer')
    assert.equal(cm1.getBalance('app-1'), 4900)
    s1._opsSinceSnapshot = 0
    s1.close()

    const s2 = openStore(dir, { autoSnapshot: false })
    const cm2 = new CreditManager({ persistence: s2, welcomeCredits: 0 })
    assert.equal(cm2.getBalance('app-1'), 4900)
    assert.equal(cm2.getWallet('app-1').totalSpent, 100)
    s2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CreditManager - without persistence falls back to in-memory (backward compat)', () => {
  const cm = new CreditManager({ welcomeCredits: 0 })
  cm.topUp('app-x', 1000)
  assert.equal(cm.getBalance('app-x'), 1000)
  // No persistence store means no error on operations and no file I/O
  assert.equal(cm.persistence, null)
})

test('ReputationSystem - persists records via store and recovers after restart', () => {
  const dir = tmpDir()
  try {
    const s1 = openStore(dir, { autoSnapshot: false })
    const r1 = new ReputationSystem({ persistence: s1 })
    r1.recordChallenge('relay-a', true, 100)
    r1.recordChallenge('relay-a', true, 200)
    r1.recordBandwidth('relay-a', 10 * 1024 * 1024)
    const scoreBefore = r1.getScore('relay-a')
    s1._opsSinceSnapshot = 0
    s1.close()

    const s2 = openStore(dir, { autoSnapshot: false })
    const r2 = new ReputationSystem({ persistence: s2 })
    const record = r2.getRecord('relay-a')
    assert.ok(record, 'record should be restored')
    assert.equal(record.totalChallenges, 2)
    assert.equal(record.passedChallenges, 2)
    assert.equal(r2.getScore('relay-a'), scoreBefore)
    s2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ReputationSystem - without persistence falls back to in-memory', () => {
  const r = new ReputationSystem()
  r.recordChallenge('relay-b', true, 150)
  assert.equal(r.getRecord('relay-b').totalChallenges, 1)
  assert.equal(r.persistence, null)
})

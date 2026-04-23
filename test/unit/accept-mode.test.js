import test from 'brittle'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, rm } from 'fs/promises'
import { RelayNode } from 'p2p-hiverelay/core/relay-node/index.js'
import { Federation } from 'p2p-hiverelay/core/federation.js'

// We test the accept-mode resolver and disposition decisions in isolation —
// no swarm, no storage, no async lifecycle. The relay node is constructed
// purely so its config defaults and helper methods are available.

function makeNode (configOverrides = {}) {
  const node = new RelayNode({ storage: '/tmp/hr-accept-mode-test-' + Date.now(), ...configOverrides })
  return node
}

test('acceptMode default is review (per spec)', async (t) => {
  const node = makeNode()
  t.is(node._resolveAcceptMode(), 'review', 'no acceptMode set → review')
})

test('acceptMode honors explicit setting', async (t) => {
  for (const mode of ['open', 'review', 'allowlist', 'closed']) {
    const node = makeNode({ acceptMode: mode })
    t.is(node._resolveAcceptMode(), mode, `acceptMode: '${mode}'`)
  }
})

test('registryAutoAccept maps to acceptMode for backward compat', async (t) => {
  const open = makeNode({ registryAutoAccept: true })
  t.is(open._resolveAcceptMode(), 'open', 'registryAutoAccept:true → open')

  const review = makeNode({ registryAutoAccept: false })
  t.is(review._resolveAcceptMode(), 'review', 'registryAutoAccept:false → review')
})

test('homehive profile defaults to allowlist', async (t) => {
  const node = new RelayNode({ mode: 'homehive', storage: '/tmp/hr-hh-' + Date.now() })
  t.is(node._resolveAcceptMode(), 'allowlist', 'homehive operator review-by-default would be wrong; allowlist is the explicit dev-key gate')
})

test('decideAcceptance: closed rejects everything', async (t) => {
  const node = makeNode({ acceptMode: 'closed' })
  const req = { appKey: 'a'.repeat(64), publisherPubkey: 'b'.repeat(64) }
  t.is(node._decideAcceptance(req, 'closed'), 'reject')
})

test('decideAcceptance: open accepts everything', async (t) => {
  const node = makeNode({ acceptMode: 'open' })
  const req = { appKey: 'a'.repeat(64), publisherPubkey: 'b'.repeat(64) }
  t.is(node._decideAcceptance(req, 'open'), 'accept')
})

test('decideAcceptance: review queues everything', async (t) => {
  const node = makeNode({ acceptMode: 'review' })
  const req = { appKey: 'a'.repeat(64), publisherPubkey: 'b'.repeat(64) }
  t.is(node._decideAcceptance(req, 'review'), 'queue')
})

test('decideAcceptance: allowlist accepts when publisher matches, rejects otherwise', async (t) => {
  const allowed = 'd'.repeat(64)
  const node = makeNode({ acceptMode: 'allowlist', acceptAllowlist: [allowed] })
  const inList = { appKey: 'a'.repeat(64), publisherPubkey: allowed }
  const notInList = { appKey: 'a'.repeat(64), publisherPubkey: 'e'.repeat(64) }
  const noPublisher = { appKey: 'a'.repeat(64), publisherPubkey: null }

  t.is(node._decideAcceptance(inList, 'allowlist'), 'accept', 'allowlisted publisher accepted')
  t.is(node._decideAcceptance(notInList, 'allowlist'), 'reject', 'non-allowlisted rejected')
  t.is(node._decideAcceptance(noPublisher, 'allowlist'), 'reject', 'no publisher → reject (no implicit accept)')
})

// ─── Federation ──────────────────────────────────────────────────────

test('Federation: follow / mirror / unfollow are idempotent and tracked', async (t) => {
  const node = makeNode({ acceptMode: 'review' })
  // Standalone Federation instance — we don't need the node's start() chain.
  const fed = new Federation({ node })

  fed.follow('http://relay-a.example')
  fed.follow('http://relay-a.example') // duplicate
  fed.mirror('http://relay-b.example', { pubkey: 'f'.repeat(64) })

  const snap = fed.snapshot()
  t.is(snap.followed.length, 1, 'follow is keyed by URL — second call is a no-op')
  t.is(snap.mirrored.length, 1)
  t.is(snap.followed[0].url, 'http://relay-a.example')
  t.is(snap.mirrored[0].pubkey, 'f'.repeat(64))

  t.ok(fed.isMirroredPubkey('f'.repeat(64)), 'mirrored pubkey indexed for fast peer lookup')
  t.absent(fed.isMirroredPubkey('a'.repeat(64)), 'unrelated pubkey not mirrored')

  const removed = fed.unfollow('http://relay-a.example')
  t.ok(removed)
  t.is(fed.snapshot().followed.length, 0)
})

test('Federation: poll routes new apps through accept-mode (review queues)', async (t) => {
  const node = makeNode({ acceptMode: 'review' })
  // Stub appRegistry.has so we don't need to fully start the node.
  node.appRegistry.has = () => false

  const fed = new Federation({ node })

  // Bypass the HTTP fetch — invoke the per-relay poll handler directly.
  fed._fetchCatalog = async () => ({
    apps: [
      { appKey: 'a'.repeat(64), publisherPubkey: 'p'.repeat(64), type: 'app' },
      { appKey: 'b'.repeat(64), publisherPubkey: 'q'.repeat(64), type: 'app' }
    ]
  })

  const queued = await fed._pollOne({ url: 'http://other.example' })
  t.is(queued, 2, 'both apps queued under review mode')
  t.is(node._pendingRequests.size, 2, 'pending queue populated')
  t.is(node._pendingRequests.get('a'.repeat(64)).source, 'federation')
  t.is(node._pendingRequests.get('a'.repeat(64)).sourceRelay, 'http://other.example')
})

test('Federation: poll under closed mode rejects everything (no queue)', async (t) => {
  const node = makeNode({ acceptMode: 'closed' })
  node.appRegistry.has = () => false

  const fed = new Federation({ node })
  fed._fetchCatalog = async () => ({
    apps: [{ appKey: 'a'.repeat(64), publisherPubkey: 'p'.repeat(64), type: 'app' }]
  })

  let rejectedCount = 0
  fed.on('federation-rejected', () => { rejectedCount++ })

  const queued = await fed._pollOne({ url: 'http://other.example' })
  t.is(queued, 0, 'closed mode queues nothing')
  t.is(rejectedCount, 1, 'rejection emitted')
  t.is(node._pendingRequests.size, 0, 'pending queue stays empty')
})

test('Federation: follow/mirror state survives restart via storagePath', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-fed-persist-'))
  const storagePath = join(dir, 'federation.json')
  t.teardown(() => rm(dir, { recursive: true, force: true }))

  // Session 1 — operator picks two subscriptions and one mirror.
  const node1 = makeNode()
  const fed1 = new Federation({ node: node1, storagePath })
  fed1.follow('http://relay-a.example')
  fed1.follow('http://relay-b.example')
  fed1.mirror('http://relay-c.example', { pubkey: 'c'.repeat(64) })
  await fed1.save() // ensure write completes before we cut the session

  // Session 2 — fresh process, same storagePath. State should rehydrate.
  const node2 = makeNode()
  const fed2 = new Federation({ node: node2, storagePath })
  await fed2.load()

  const snap = fed2.snapshot()
  t.is(snap.followed.length, 2, 'two follows restored')
  t.is(snap.mirrored.length, 1, 'one mirror restored')
  t.ok(fed2.isMirroredPubkey('c'.repeat(64)), 'mirrored pubkey index rebuilt on load')
  t.is(snap.followed[0].url, 'http://relay-a.example')
})

test('Federation: load() on missing file is a no-op (first boot)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-fed-empty-'))
  const storagePath = join(dir, 'federation.json')
  t.teardown(() => rm(dir, { recursive: true, force: true }))

  const fed = new Federation({ node: makeNode(), storagePath })
  await fed.load() // should not throw, even though file doesn't exist
  t.is(fed.snapshot().followed.length, 0)
  t.is(fed.snapshot().mirrored.length, 0)
  t.is(fed.snapshot().republished.length, 0)
})

test('Federation: republish records attribution and persists', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-fed-republish-'))
  const storagePath = join(dir, 'federation.json')
  t.teardown(() => rm(dir, { recursive: true, force: true }))

  const fed1 = new Federation({ node: makeNode(), storagePath })
  fed1.republish('a'.repeat(64), {
    sourceUrl: 'http://upstream.example',
    sourcePubkey: 'b'.repeat(64),
    channel: 'curated-tools',
    note: 'editor pick'
  })
  await fed1.save()

  // Reload in a fresh instance — attribution survives.
  const fed2 = new Federation({ node: makeNode(), storagePath })
  await fed2.load()
  const snap = fed2.snapshot()
  t.is(snap.republished.length, 1)
  t.is(snap.republished[0].sourceUrl, 'http://upstream.example')
  t.is(snap.republished[0].channel, 'curated-tools')
  t.is(snap.republished[0].note, 'editor pick')

  // Unrepublish removes it cleanly.
  const removed = fed2.unrepublish('a'.repeat(64))
  t.ok(removed)
  t.is(fed2.snapshot().republished.length, 0)
  // unrepublish triggers a fire-and-forget save() — wait for it to settle
  // before teardown rm, otherwise the new atomic write+rename can race the
  // rm and trip ENOTEMPTY.
  await fed2.save()
})

test('Federation: republish does NOT auto-seed (operator must approve separately)', async (t) => {
  const node = makeNode({ acceptMode: 'review' })
  let seedCalls = 0
  node.seedApp = async () => { seedCalls++; return { discoveryKey: 'x' } }

  const fed = new Federation({ node })
  fed.republish('a'.repeat(64), { sourceUrl: 'http://other.example' })

  t.is(seedCalls, 0, 'republish is pure attribution — never triggers a seed')
  t.is(node._pendingRequests.size, 0, 'and never enqueues either')
})

// ─── applyMode must not stomp the live Federation instance ──────────
// Regression test: applyMode() rebuilds this.config, which used to
// include federation state. The live `this.federation` instance must
// keep its in-memory follows/mirrors regardless, and the persisted file
// must remain intact so a subsequent restart still rehydrates them.

test('applyMode preserves the live Federation instance and its on-disk state', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-applymode-fed-'))
  t.teardown(() => rm(dir, { recursive: true, force: true }))

  const node = makeNode({ storage: dir })
  const fed = new Federation({ node, storagePath: join(dir, 'federation.json') })
  node.federation = fed
  fed.follow('http://kept-after-applymode.example')
  fed.mirror('http://also-kept.example', { pubkey: 'a'.repeat(64) })
  await fed.save()

  const snapshotBefore = fed.snapshot()

  // Apply a different operating mode. RelayNode.applyMode() drops federation
  // out of the carry list so presets can override it — but the live
  // instance and the persisted file must not be touched.
  await node.applyMode('homehive')

  // Live instance still has both subscriptions.
  t.is(fed.snapshot().followed.length, snapshotBefore.followed.length, 'follows survive applyMode in memory')
  t.is(fed.snapshot().mirrored.length, snapshotBefore.mirrored.length, 'mirrors survive applyMode in memory')
  t.ok(fed.isMirroredPubkey('a'.repeat(64)), 'mirror pubkey index intact')

  // Persisted file is unchanged so a fresh process re-hydrates the same state.
  const fedRestart = new Federation({ node: makeNode(), storagePath: join(dir, 'federation.json') })
  await fedRestart.load()
  t.is(fedRestart.snapshot().followed.length, snapshotBefore.followed.length, 'persisted follows survive a restart after applyMode')
})

// ─── Shared accept-mode helpers ──────────────────────────────────────
// These run in plain Node, but the helpers themselves are also imported by
// BareRelay. Pin the shared semantics here so a regression on either runtime
// breaks the same test.

test('shared accept-mode: resolveAcceptMode and decideAcceptance are pure', async (t) => {
  const { resolveAcceptMode, decideAcceptance } = await import('p2p-hiverelay/core/accept-mode.js')

  t.is(resolveAcceptMode({}), 'review', 'no config → review default')
  t.is(resolveAcceptMode({ acceptMode: 'open' }), 'open')
  t.is(resolveAcceptMode({ registryAutoAccept: true }), 'open', 'legacy alias true → open')
  t.is(resolveAcceptMode({ registryAutoAccept: false }), 'review', 'legacy alias false → review')
  t.is(resolveAcceptMode({ acceptMode: 'allowlist', registryAutoAccept: true }), 'allowlist',
    'explicit acceptMode wins over legacy alias')

  t.is(decideAcceptance({ publisherPubkey: 'p' }, 'closed', []), 'reject')
  t.is(decideAcceptance({ publisherPubkey: 'p' }, 'open', []), 'accept')
  t.is(decideAcceptance({ publisherPubkey: 'p' }, 'review', []), 'queue')
  t.is(decideAcceptance({ publisherPubkey: 'allowed-key' }, 'allowlist', ['allowed-key']), 'accept')
  t.is(decideAcceptance({ publisherPubkey: 'other-key' }, 'allowlist', ['allowed-key']), 'reject')
  t.is(decideAcceptance({ publisherPubkey: null }, 'allowlist', ['allowed-key']), 'reject',
    'no publisher → reject in allowlist mode (no implicit accept)')
})

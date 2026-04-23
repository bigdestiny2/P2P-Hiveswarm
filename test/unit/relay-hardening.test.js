import test from 'brittle'
import { RelayNode } from 'p2p-hiverelay/core/relay-node/index.js'
import path from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

function tmpStorage () {
  return path.join(tmpdir(), 'hiverelay-hardening-' + randomBytes(8).toString('hex'))
}

function makeEntry (i, ts) {
  return {
    publisherPubkey: 'pub' + i,
    contentType: 'app',
    privacyTier: 'public',
    source: 'remote-catalog',
    discoveredAt: ts,
    mode: 'review'
  }
}

// ─── Item 1: Bounded _pendingRequests queue ─────────────────────────

test('RelayNode - default maxPendingRequests is 5000', (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false })
  t.is(node.config.maxPendingRequests, 5000, 'default cap is 5000')
})

test('RelayNode - custom maxPendingRequests is honored', (t) => {
  const node = new RelayNode({
    storage: tmpStorage(),
    enableAPI: false,
    maxPendingRequests: 3
  })
  t.is(node.config.maxPendingRequests, 3, 'custom cap propagated')

  for (let i = 0; i < 3; i++) {
    node._addPendingRequest('appKey' + i, makeEntry(i, 1000 + i))
  }
  t.is(node._pendingRequests.size, 3, 'queue at cap')

  // Adding one more should evict the oldest (appKey0 with discoveredAt=1000)
  node._addPendingRequest('appKey3', makeEntry(3, 2000))
  t.is(node._pendingRequests.size, 3, 'queue size still at cap after eviction')
  t.is(node._pendingRequests.has('appKey0'), false, 'oldest evicted')
  t.is(node._pendingRequests.has('appKey3'), true, 'new entry inserted')
})

test('RelayNode - eviction picks the lowest discoveredAt regardless of insertion order', (t) => {
  const node = new RelayNode({
    storage: tmpStorage(),
    enableAPI: false,
    maxPendingRequests: 3
  })

  // Insert in non-monotonic timestamp order
  node._addPendingRequest('a', makeEntry('a', 5000))
  node._addPendingRequest('b', makeEntry('b', 1000)) // oldest
  node._addPendingRequest('c', makeEntry('c', 3000))

  t.is(node._pendingRequests.size, 3)

  node._addPendingRequest('d', makeEntry('d', 9000))

  t.is(node._pendingRequests.has('b'), false, 'oldest by discoveredAt evicted')
  t.is(node._pendingRequests.has('a'), true, 'a kept')
  t.is(node._pendingRequests.has('c'), true, 'c kept')
  t.is(node._pendingRequests.has('d'), true, 'd inserted')
})

test('RelayNode - eviction emits pending-evicted with evicted appKey', (t) => {
  t.plan(3)
  const node = new RelayNode({
    storage: tmpStorage(),
    enableAPI: false,
    maxPendingRequests: 2
  })

  node._addPendingRequest('first', makeEntry('first', 1000))
  node._addPendingRequest('second', makeEntry('second', 2000))

  node.on('pending-evicted', (payload) => {
    t.is(payload.appKey, 'first', 'evicted appKey is the oldest')
    t.is(payload.reason, 'queue-full', 'reason is queue-full')
  })

  node._addPendingRequest('third', makeEntry('third', 3000))
  t.is(node._pendingRequests.size, 2, 'still within cap after eviction')
})

test('RelayNode - duplicate appKey does not evict or grow queue', (t) => {
  const node = new RelayNode({
    storage: tmpStorage(),
    enableAPI: false,
    maxPendingRequests: 2
  })

  node._addPendingRequest('a', makeEntry('a', 1000))
  node._addPendingRequest('b', makeEntry('b', 2000))

  let evictions = 0
  node.on('pending-evicted', () => { evictions++ })

  const inserted = node._addPendingRequest('a', makeEntry('a-dup', 3000))
  t.is(inserted, false, 'duplicate insertion returns false')
  t.is(evictions, 0, 'no eviction on duplicate')
  t.is(node._pendingRequests.size, 2, 'queue unchanged')
})

// ─── Item 2: Surface DHT-relay-WS in getStats() ─────────────────────

test('RelayNode - getStats includes dhtRelayWs: null when transport not enabled', (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false })
  // Construct-only, no start() — dhtRelayWs is null on construction.
  const stats = node.getStats()
  t.ok('dhtRelayWs' in stats, 'dhtRelayWs key present')
  t.is(stats.dhtRelayWs, null, 'dhtRelayWs is null when transport not enabled')
})

test('RelayNode - getStats includes dhtRelayWs stats when enabled', (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false })
  node.dhtRelayWs = {
    getStats: () => ({ stub: true, running: true, port: 8766, activeConnections: 0 })
  }
  const stats = node.getStats()
  t.ok(stats.dhtRelayWs, 'dhtRelayWs object present')
  t.is(stats.dhtRelayWs.stub, true, 'stub field present')
  t.is(stats.dhtRelayWs.running, true, 'running field present')
  t.is(stats.dhtRelayWs.port, 8766, 'port field present')
  t.is(stats.dhtRelayWs.activeConnections, 0, 'activeConnections field present')
})

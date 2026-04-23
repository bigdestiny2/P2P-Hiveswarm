/**
 * Unit tests for the per-peer pair-attempt rate limiter.
 *
 * Exercises the _checkPeerRateLimit primitive in isolation — no swarm, no
 * Protomux. This lets us verify the token-bucket math without standing up
 * a full pairing testnet (which test/integration/pairing.test.js covers).
 */

import test from 'brittle'
import { PairingManager } from 'p2p-hiverelay-client/pairing.js'

function makeManager (opts = {}) {
  // PairingManager uses very few methods on `client` — only inside
  // createPairingCode/claimPairingCode, neither of which we exercise here.
  const stubClient = { _started: false }
  return new PairingManager(stubClient, opts)
}

test('pair rate limit: default cap is 6/min/peer', (t) => {
  const mgr = makeManager()
  t.is(mgr.maxAttemptsPerMinutePerPeer, 6)
  t.is(mgr.rateLimitWindowMs, 60_000)
})

test('pair rate limit: 6 attempts in-window pass, 7th is blocked', (t) => {
  const mgr = makeManager({ maxAttemptsPerMinutePerPeer: 6, rateLimitWindowMs: 60_000 })
  const peer = 'a'.repeat(64)

  for (let i = 1; i <= 6; i++) {
    t.ok(mgr._checkPeerRateLimit(peer), `attempt ${i} allowed`)
  }
  t.absent(mgr._checkPeerRateLimit(peer), 'attempt 7 blocked (cap hit)')
  t.absent(mgr._checkPeerRateLimit(peer), 'subsequent attempts also blocked')
})

test('pair rate limit: null/empty peerKey is always allowed (no identity to bucket)', (t) => {
  const mgr = makeManager({ maxAttemptsPerMinutePerPeer: 1 })
  // null → we can't rate-limit without an identity; allow and move on
  for (let i = 0; i < 5; i++) {
    t.ok(mgr._checkPeerRateLimit(null), 'null peer always allowed')
    t.ok(mgr._checkPeerRateLimit(''), 'empty peer always allowed')
  }
})

test('pair rate limit: disabled when maxAttemptsPerMinutePerPeer <= 0', (t) => {
  const mgr = makeManager({ maxAttemptsPerMinutePerPeer: 0 })
  const peer = 'b'.repeat(64)
  // No cap — 100 attempts still pass
  for (let i = 0; i < 100; i++) {
    t.ok(mgr._checkPeerRateLimit(peer), 'attempt ' + i)
  }
})

test('pair rate limit: different peers have independent buckets', (t) => {
  const mgr = makeManager({ maxAttemptsPerMinutePerPeer: 2 })
  const peerA = 'a'.repeat(64)
  const peerB = 'b'.repeat(64)

  t.ok(mgr._checkPeerRateLimit(peerA))
  t.ok(mgr._checkPeerRateLimit(peerA))
  t.absent(mgr._checkPeerRateLimit(peerA), 'A hit cap')

  t.ok(mgr._checkPeerRateLimit(peerB), 'B still has budget')
  t.ok(mgr._checkPeerRateLimit(peerB))
  t.absent(mgr._checkPeerRateLimit(peerB), 'B hit cap independently')
})

test('pair rate limit: window resets after rateLimitWindowMs', async (t) => {
  // Tiny window so we can exercise the reset synchronously.
  const mgr = makeManager({ maxAttemptsPerMinutePerPeer: 2, rateLimitWindowMs: 80 })
  const peer = 'c'.repeat(64)

  t.ok(mgr._checkPeerRateLimit(peer))
  t.ok(mgr._checkPeerRateLimit(peer))
  t.absent(mgr._checkPeerRateLimit(peer), 'hit cap')

  await new Promise(resolve => setTimeout(resolve, 120))

  t.ok(mgr._checkPeerRateLimit(peer), 'post-window: bucket refills')
  t.ok(mgr._checkPeerRateLimit(peer), 'second attempt in new window')
  t.absent(mgr._checkPeerRateLimit(peer), 'cap applies in new window too')
})

test('pair rate limit: _prunePeerAttempts drops stale entries', async (t) => {
  const mgr = makeManager({ maxAttemptsPerMinutePerPeer: 6, rateLimitWindowMs: 50 })
  mgr._checkPeerRateLimit('x'.repeat(64))
  mgr._checkPeerRateLimit('y'.repeat(64))
  t.is(mgr._peerAttempts.size, 2)

  // Wait past 2x the window (stale threshold) so prune can reclaim them.
  await new Promise(resolve => setTimeout(resolve, 150))
  mgr._prunePeerAttempts()
  t.is(mgr._peerAttempts.size, 0, 'stale buckets evicted')
})

test('pair rate limit: destroy() clears the bucket map', (t) => {
  const mgr = makeManager()
  mgr._checkPeerRateLimit('a'.repeat(64))
  mgr._checkPeerRateLimit('b'.repeat(64))
  t.is(mgr._peerAttempts.size, 2)
  mgr.destroy()
  t.is(mgr._peerAttempts.size, 0)
})

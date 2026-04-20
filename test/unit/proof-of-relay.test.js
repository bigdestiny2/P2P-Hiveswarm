import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { ProofOfRelay } from 'p2p-hiverelay/core/protocol/proof-of-relay.js'

function randomKey () {
  const buf = b4a.alloc(32)
  sodium.randombytes_buf(buf)
  return buf
}

test('ProofOfRelay - challenge stores pending entry', async (t) => {
  const por = new ProofOfRelay({ maxLatencyMs: 5000 })

  const mockChannel = {
    opened: true,
    _hiverelay: {
      challengeMsg: { send () {} },
      responseMsg: { send () {} }
    }
  }

  por.challenge(mockChannel, randomKey(), 0, randomKey())
  t.is(por.pendingChallenges.size, 1)

  por.destroy()
})

test('ProofOfRelay - valid response scores a pass', async (t) => {
  t.plan(2)
  const por = new ProofOfRelay({ maxLatencyMs: 5000 })
  const coreKey = randomKey()
  const relayPubkey = randomKey()
  const nonce = b4a.alloc(32)
  sodium.randombytes_buf(nonce)

  // Manually insert a pending challenge
  por.pendingChallenges.set(b4a.toString(nonce, 'hex'), {
    coreKey: b4a.toString(coreKey, 'hex'),
    blockIndex: 5,
    sentAt: Date.now(),
    relayPubkey: b4a.toString(relayPubkey, 'hex')
  })

  por.on('proof-result', (result) => {
    t.ok(result.passed, 'challenge passed')
  })

  // Simulate response
  por._onResponse(null, {
    coreKey,
    blockIndex: 5,
    blockData: Buffer.from('block-data'),
    merkleProof: Buffer.from('proof'),
    nonce
  })

  const score = por.getScore(b4a.toString(relayPubkey, 'hex'))
  t.is(score.passes, 1)

  por.destroy()
})

test('ProofOfRelay - latency exceeded scores a fail', async (t) => {
  const por = new ProofOfRelay({ maxLatencyMs: 1 })
  const coreKey = randomKey()
  const relayPubkey = randomKey()
  const nonce = b4a.alloc(32)
  sodium.randombytes_buf(nonce)

  por.pendingChallenges.set(b4a.toString(nonce, 'hex'), {
    coreKey: b4a.toString(coreKey, 'hex'),
    blockIndex: 0,
    sentAt: Date.now() - 1000, // sent 1s ago, max is 1ms
    relayPubkey: b4a.toString(relayPubkey, 'hex')
  })

  por._onResponse(null, {
    coreKey,
    blockIndex: 0,
    blockData: Buffer.from('data'),
    merkleProof: Buffer.from('proof'),
    nonce
  })

  const score = por.getScore(b4a.toString(relayPubkey, 'hex'))
  t.is(score.fails, 1)

  por.destroy()
})

test('ProofOfRelay - unknown nonce emits unexpected-response', async (t) => {
  t.plan(1)
  const por = new ProofOfRelay()

  por.on('unexpected-response', () => {
    t.pass('unexpected-response emitted')
  })

  por._onResponse(null, {
    coreKey: randomKey(),
    blockIndex: 0,
    blockData: Buffer.from('data'),
    merkleProof: Buffer.from('proof'),
    nonce: randomKey()
  })

  por.destroy()
})

test('ProofOfRelay - getReliability', async (t) => {
  const por = new ProofOfRelay({ maxLatencyMs: 5000 })
  const relay = b4a.toString(randomKey(), 'hex')

  // Simulate 4 passes and 1 fail via _updateScore
  for (let i = 0; i < 4; i++) por._updateScore(relay, true, 100)
  por._updateScore(relay, false, 0)

  t.is(por.getReliability(relay), 0.8)

  por.destroy()
})

test('ProofOfRelay - stale challenge cleanup', async (t) => {
  const por = new ProofOfRelay({ maxLatencyMs: 50 })

  por.pendingChallenges.set('stale', {
    coreKey: 'abc',
    blockIndex: 0,
    sentAt: Date.now() - 200, // well past 2 * 50ms
    relayPubkey: 'def'
  })

  por.pendingChallenges.set('fresh', {
    coreKey: 'abc',
    blockIndex: 1,
    sentAt: Date.now(),
    relayPubkey: 'def'
  })

  por._cleanupStale()

  t.is(por.pendingChallenges.size, 1)
  t.ok(por.pendingChallenges.has('fresh'))

  por.destroy()
})

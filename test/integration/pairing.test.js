import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
import Hyperswarm from 'hyperswarm'
import { HiveRelayClient, _pairing } from 'p2p-hiverelay-client'
const { deriveTopic, generateCode, proofFor } = _pairing
import b4a from 'b4a'
import path from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

function tmpStorage () {
  return path.join(tmpdir(), 'hiverelay-pair-test-' + randomBytes(8).toString('hex'))
}

async function makeClient (testnet) {
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const client = new HiveRelayClient({ swarm, storage: tmpStorage() })
  await client.start()
  return { client, swarm }
}

// ─── Code generator basics ────────────────────────────────────────

test('pairing: generateCode returns 6-digit string', async (t) => {
  for (let i = 0; i < 50; i++) {
    const c = generateCode()
    t.is(typeof c, 'string', 'is string')
    t.is(c.length, 6, '6 chars')
    t.ok(/^[0-9]{6}$/.test(c), 'all digits')
  }
})

test('pairing: deriveTopic is 32 bytes and deterministic', async (t) => {
  const a = deriveTopic('123456')
  const b = deriveTopic('123456')
  const c = deriveTopic('654321')
  t.is(a.length, 32, '32 bytes')
  t.ok(b4a.equals(a, b), 'same code → same topic')
  t.ok(!b4a.equals(a, c), 'different code → different topic')
})

test('pairing: proofFor depends on both code and nonce', async (t) => {
  const nonce = randomBytes(32)
  const p1 = proofFor('111111', nonce)
  const p2 = proofFor('222222', nonce)
  const p3 = proofFor('111111', randomBytes(32))
  t.is(p1.length, 32, 'HMAC-SHA256 = 32 bytes')
  t.ok(!b4a.equals(p1, p2), 'different code → different proof')
  t.ok(!b4a.equals(p1, p3), 'different nonce → different proof')
})

// ─── createPairingCode shape ──────────────────────────────────────

test('pairing: createPairingCode returns 6-digit code, expiresAt, topic', async (t) => {
  const testnet = await createTestnet(3)
  const { client, swarm } = await makeClient(testnet)
  t.teardown(async () => {
    await client.destroy()
    await swarm.destroy()
    await testnet.destroy()
  })

  const result = await client.createPairingCode({ ttlMs: 60_000 })
  t.is(typeof result.code, 'string', 'code is string')
  t.ok(/^[0-9]{6}$/.test(result.code), 'code is 6 digits')
  t.is(typeof result.expiresAt, 'number', 'expiresAt is number')
  t.ok(result.expiresAt > Date.now(), 'expiresAt is in the future')
  t.is(result.topic.length, 32, 'topic is 32 bytes')
})

test('pairing: createPairingCode throws if no identity', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const client = new HiveRelayClient({ swarm, storage: tmpStorage() })
  await client.start()
  // Force-clear identity to simulate "no identity" condition.
  client.keyPair = null
  t.teardown(async () => {
    await client.destroy()
    await swarm.destroy()
    await testnet.destroy()
  })

  let threw = false
  try {
    await client.createPairingCode()
  } catch (err) {
    threw = true
    t.ok(/identity/i.test(err.message), 'error mentions identity')
  }
  t.ok(threw, 'throws')
})

// ─── End-to-end pairing ───────────────────────────────────────────

test('pairing: end-to-end — B claims A\'s code and inherits identity', async (t) => {
  const testnet = await createTestnet(3)
  const a = await makeClient(testnet)
  const b = await makeClient(testnet)
  t.teardown(async () => {
    await a.client.destroy()
    await b.client.destroy()
    await a.swarm.destroy()
    await b.swarm.destroy()
    await testnet.destroy()
  })

  // Sanity: keys differ at the start.
  t.ok(!b4a.equals(a.client.keyPair.publicKey, b.client.keyPair.publicKey), 'keys differ initially')

  const aPub = a.client.exportIdentity().publicKey

  const { code } = await a.client.createPairingCode({ ttlMs: 60_000 })

  const result = await b.client.claimPairingCode(code, { timeoutMs: 30_000 })
  t.ok(result.ok, 'claim succeeded: ' + JSON.stringify(result))
  t.is(result.identity.publicKey, aPub, 'B inherited A\'s pubkey')

  // Confirm B's keyPair is now A's.
  const bPubAfter = b4a.toString(b.client.keyPair.publicKey, 'hex')
  t.is(bPubAfter, aPub, 'B.keyPair.publicKey === A.keyPair.publicKey')
})

// ─── Single-use semantics ─────────────────────────────────────────

test('pairing: code is single-use — second claim fails', async (t) => {
  const testnet = await createTestnet(3)
  const a = await makeClient(testnet)
  const b = await makeClient(testnet)
  const c = await makeClient(testnet)
  t.teardown(async () => {
    await a.client.destroy()
    await b.client.destroy()
    await c.client.destroy()
    await a.swarm.destroy()
    await b.swarm.destroy()
    await c.swarm.destroy()
    await testnet.destroy()
  })

  const { code } = await a.client.createPairingCode({ ttlMs: 60_000 })

  const r1 = await b.client.claimPairingCode(code, { timeoutMs: 30_000 })
  t.ok(r1.ok, 'first claim succeeded')

  // Second claim with the same code should not succeed (A has cleaned up
  // the topic and listener).
  const r2 = await c.client.claimPairingCode(code, { timeoutMs: 5_000 })
  t.absent(r2.ok, 'second claim failed')
  t.is(r2.reason, 'timeout', 'second claim times out')
})

// ─── Wrong code — failed claim doesn't burn the code ──────────────

test('pairing: wrong code claim fails and does not burn the original code', async (t) => {
  const testnet = await createTestnet(3)
  const a = await makeClient(testnet)
  const b = await makeClient(testnet)
  const c = await makeClient(testnet)
  t.teardown(async () => {
    await a.client.destroy()
    await b.client.destroy()
    await c.client.destroy()
    await a.swarm.destroy()
    await b.swarm.destroy()
    await c.swarm.destroy()
    await testnet.destroy()
  })

  const aPub = a.client.exportIdentity().publicKey
  const { code } = await a.client.createPairingCode({ ttlMs: 60_000 })

  // B tries the WRONG code first. A different code derives a different
  // topic, so B's lookup never finds A and we get a timeout (no
  // bad-proof reaches A). The point of this test: A's code must still
  // be usable afterward — the failed claim must not 'burn' the code.
  const wrongCode = code === '000000' ? '111111' : '000000'
  const r1 = await b.client.claimPairingCode(wrongCode, { timeoutMs: 2_000 })
  t.absent(r1.ok, 'wrong code claim failed')
  t.is(r1.reason, 'timeout', 'wrong code times out (different topic)')

  // C claims with the CORRECT code — should still work.
  const r2 = await c.client.claimPairingCode(code, { timeoutMs: 30_000 })
  t.ok(r2.ok, 'correct code still works after wrong attempt: ' + JSON.stringify(r2))
  t.is(r2.identity.publicKey, aPub, 'inherited A\'s pubkey')
})

// ─── Bad-proof path via internal patching ─────────────────────────

test('pairing: server rejects wrong proof and keeps code claimable', async (t) => {
  // To hit the server-side bad-proof branch we need two clients that
  // agree on the TOPIC but disagree on the CODE. The PairingManager
  // keys both topic and proof off the same `code` argument, so we
  // monkey-patch `proofFor` for B's manager to send a deliberately
  // wrong proof while still hashing to the right topic.
  const testnet = await createTestnet(3)
  const a = await makeClient(testnet)
  const b = await makeClient(testnet)
  const c = await makeClient(testnet)
  t.teardown(async () => {
    await a.client.destroy()
    await b.client.destroy()
    await c.client.destroy()
    await a.swarm.destroy()
    await b.swarm.destroy()
    await c.swarm.destroy()
    await testnet.destroy()
  })

  const aPub = a.client.exportIdentity().publicKey
  const { code } = await a.client.createPairingCode({ ttlMs: 60_000 })

  // Capture A's bad-proof event.
  const badProofs = []
  a.client.on('pairing-failed', (e) => { if (e.reason === 'bad-proof') badProofs.push(e) })

  // Trigger lazy manager attachment on b.client by calling
  // createPairingCode (its only side-effect we care about is the
  // attachment of the PairingManager to b.client._pairing).
  await b.client.createPairingCode({ ttlMs: 1_000 }).catch(() => {})
  const bMgr = b.client._pairing
  t.ok(bMgr, 'B has a pairing manager')

  // Override _runClient to send a wrong proof: same topic (so we still
  // reach A) but a different code for the HMAC.
  const orig = bMgr._runClient.bind(bMgr)
  bMgr._runClient = async function (claimCode, ch) {
    return orig.call(this, claimCode === code ? 'wrong0' : claimCode, ch)
  }

  const r1 = await b.client.claimPairingCode(code, { timeoutMs: 5_000 })
  t.absent(r1.ok, 'wrong-proof claim failed')
  t.ok(r1.reason === 'bad-proof' || r1.reason === 'timeout', 'reason is bad-proof or timeout: ' + r1.reason)
  t.ok(badProofs.length >= 1, 'A emitted bad-proof event (' + badProofs.length + ')')

  // Restore B's manager and verify A's code is still valid via C.
  bMgr._runClient = orig
  const r2 = await c.client.claimPairingCode(code, { timeoutMs: 30_000 })
  t.ok(r2.ok, 'legitimate claim still succeeds after bad-proof: ' + JSON.stringify(r2))
  t.is(r2.identity.publicKey, aPub, 'inherited A\'s pubkey')
})

// ─── Timeout when no code was ever created ─────────────────────────

test('pairing: claim of never-created code times out', async (t) => {
  const testnet = await createTestnet(3)
  const b = await makeClient(testnet)
  t.teardown(async () => {
    await b.client.destroy()
    await b.swarm.destroy()
    await testnet.destroy()
  })

  const r = await b.client.claimPairingCode('999999', { timeoutMs: 2_000 })
  t.absent(r.ok, 'claim failed')
  t.is(r.reason, 'timeout', 'reason is timeout')
})

// ─── Invalid code format ───────────────────────────────────────────

test('pairing: claim with invalid format → invalid-code-format', async (t) => {
  const testnet = await createTestnet(3)
  const b = await makeClient(testnet)
  t.teardown(async () => {
    await b.client.destroy()
    await b.swarm.destroy()
    await testnet.destroy()
  })

  for (const bad of ['12345', '1234567', 'abcdef', '12345a', '', null]) {
    const r = await b.client.claimPairingCode(bad, { timeoutMs: 1_000 })
    t.absent(r.ok, 'rejected: ' + bad)
    t.is(r.reason, 'invalid-code-format', 'reason: ' + r.reason)
  }
})

// ─── Code expiry ──────────────────────────────────────────────────

test('pairing: code expires after TTL — late claim times out', async (t) => {
  const testnet = await createTestnet(3)
  const a = await makeClient(testnet)
  const b = await makeClient(testnet)
  t.teardown(async () => {
    await a.client.destroy()
    await b.client.destroy()
    await a.swarm.destroy()
    await b.swarm.destroy()
    await testnet.destroy()
  })

  // Capture the pairing-failed event for expiry.
  const expiredEvents = []
  a.client.on('pairing-failed', (e) => {
    if (e.reason === 'expired') expiredEvents.push(e)
  })

  const { code } = await a.client.createPairingCode({ ttlMs: 100 })
  // Wait for expiry.
  await new Promise(resolve => setTimeout(resolve, 400))

  // A should have emitted a pairing-failed { reason: 'expired' }.
  t.ok(expiredEvents.length >= 1, 'A emitted pairing-failed expired (got ' + expiredEvents.length + ')')

  // Now B claims it — should time out (A no longer listening).
  const r = await b.client.claimPairingCode(code, { timeoutMs: 2_000 })
  t.absent(r.ok, 'late claim failed')
  t.is(r.reason, 'timeout', 'reason is timeout')
})

// ─── Events ───────────────────────────────────────────────────────

test('pairing: emits pairing-completed events on both sides', async (t) => {
  const testnet = await createTestnet(3)
  const a = await makeClient(testnet)
  const b = await makeClient(testnet)
  t.teardown(async () => {
    await a.client.destroy()
    await b.client.destroy()
    await a.swarm.destroy()
    await b.swarm.destroy()
    await testnet.destroy()
  })

  const aEvents = []
  const bEvents = []
  a.client.on('pairing-completed', (e) => aEvents.push(e))
  b.client.on('pairing-completed', (e) => bEvents.push(e))

  const aPub = a.client.exportIdentity().publicKey
  const { code } = await a.client.createPairingCode({ ttlMs: 60_000 })
  const r = await b.client.claimPairingCode(code, { timeoutMs: 30_000 })
  t.ok(r.ok, 'paired')

  // Allow events to flush.
  await new Promise(resolve => setTimeout(resolve, 100))

  t.ok(aEvents.length >= 1, 'A got pairing-completed (' + aEvents.length + ')')
  t.ok(bEvents.length >= 1, 'B got pairing-completed (' + bEvents.length + ')')
  t.is(aEvents[0].role, 'server', 'A role=server')
  t.is(bEvents[0].role, 'client', 'B role=client')
  t.is(aEvents[0].publicKey, aPub, 'A event has A\'s pubkey')
  t.is(bEvents[0].publicKey, aPub, 'B event has A\'s pubkey')
})

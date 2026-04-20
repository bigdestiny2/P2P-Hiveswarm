/**
 * Revocation primitives tests — createRevocation / verifyRevocation pair,
 * plus the RelayNode.submitRevocation store integration and the
 * _checkDelegation fast-path rejection for a revoked cert signature.
 */

import test from 'brittle'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import { EventEmitter } from 'events'
import { createRevocation, verifyRevocation, verifyDelegationCert } from 'p2p-hiverelay/core/delegation.js'
import { HiveRelayClient } from 'p2p-hiverelay-client'
import { RelayNode } from 'p2p-hiverelay/core/relay-node/index.js'

// Swarm mock matching the shape used across the other client tests.
function mockSwarm (keyPair) {
  const swarm = new EventEmitter()
  swarm.keyPair = keyPair || { publicKey: Buffer.alloc(32, 0xaa), secretKey: null }
  swarm.connections = new Set()
  swarm.join = () => ({ destroy: () => {} })
  swarm.leave = async () => {}
  swarm.flush = async () => {}
  swarm.destroy = async () => {}
  return swarm
}

function genKeypair () {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function makeCert (primaryKp, deviceKp, ttlMs = 60_000) {
  const devicePub = b4a.toString(deviceKp.publicKey, 'hex')
  const expiresAt = Date.now() + ttlMs
  const label = 'test-device'
  const primaryPub = b4a.toString(primaryKp.publicKey, 'hex')
  const expBuf = b4a.alloc(8)
  new DataView(expBuf.buffer, expBuf.byteOffset).setBigUint64(0, BigInt(expiresAt), false)
  const labelBuf = b4a.from(label, 'utf8')
  const payload = b4a.concat([primaryKp.publicKey, deviceKp.publicKey, expBuf, labelBuf])
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, payload, primaryKp.secretKey)
  return {
    version: 1,
    primaryPubkey: primaryPub,
    devicePubkey: devicePub,
    expiresAt,
    label,
    signature: b4a.toString(sig, 'hex')
  }
}

function makeNode () {
  return new RelayNode({ storage: '/tmp/hr-rev-test-' + Date.now() + '-' + Math.random() })
}

// ─── Primitive tests ──────────────────────────────────────────────

test('revocation: round-trip verifies', (t) => {
  const primaryKp = genKeypair()
  const deviceKp = genKeypair()
  const cert = makeCert(primaryKp, deviceKp)

  const rev = createRevocation(cert, primaryKp.secretKey, { reason: 'device lost' })
  t.is(rev.version, 1)
  t.is(rev.primaryPubkey, cert.primaryPubkey)
  t.is(rev.revokedCertSignature, cert.signature)
  t.is(rev.reason, 'device lost')
  t.ok(rev.revokedAt <= Date.now())

  const result = verifyRevocation(rev)
  t.is(result.valid, true)
  t.is(result.revokedCertSignature, cert.signature)
})

test('revocation: rejects forged signature', (t) => {
  const primaryKp = genKeypair()
  const attackerKp = genKeypair()
  const deviceKp = genKeypair()
  const cert = makeCert(primaryKp, deviceKp)

  // Attacker tries to revoke a cert they didn't issue.
  const rev = createRevocation(cert, attackerKp.secretKey)
  // createRevocation produces a valid-looking rev signed by attacker,
  // but verifyRevocation uses cert.primaryPubkey as the expected signer,
  // so the signature check fails.
  const result = verifyRevocation(rev)
  t.is(result.valid, false)
  t.is(result.reason, 'bad signature')
})

test('revocation: rejects malformed inputs without throwing', (t) => {
  const cases = [null, {}, { version: 99 }, { version: 1, primaryPubkey: 'x', revokedCertSignature: 'y', signature: 'z' }]
  for (const rev of cases) {
    const result = verifyRevocation(rev)
    t.is(result.valid, false)
  }
})

test('revocation: reason ≤ 256 bytes accepted; > 256 rejected', (t) => {
  const primaryKp = genKeypair()
  const deviceKp = genKeypair()
  const cert = makeCert(primaryKp, deviceKp)

  // 256 bytes exactly — fine
  const ok = createRevocation(cert, primaryKp.secretKey, { reason: 'a'.repeat(256) })
  t.is(verifyRevocation(ok).valid, true)

  // 257 bytes — rejected at create time
  try {
    createRevocation(cert, primaryKp.secretKey, { reason: 'a'.repeat(257) })
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('256'))
  }
})

test('revocation: createRevocation validates the secret key length', (t) => {
  const primaryKp = genKeypair()
  const deviceKp = genKeypair()
  const cert = makeCert(primaryKp, deviceKp)
  try {
    createRevocation(cert, b4a.alloc(32))
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('64-byte'))
  }
})

// ─── RelayNode integration ─────────────────────────────────────────

test('RelayNode: submitRevocation stores + listRevocations returns entries', (t) => {
  const primaryKp = genKeypair()
  const deviceKp = genKeypair()
  const cert = makeCert(primaryKp, deviceKp)
  const rev = createRevocation(cert, primaryKp.secretKey, { reason: 'rotation' })

  const node = makeNode()
  const result = node.submitRevocation(rev, { certExpiresAt: cert.expiresAt })
  t.is(result.ok, true)
  t.is(result.revokedCertSignature, cert.signature)

  const list = node.listRevocations()
  t.is(list.length, 1)
  t.is(list[0].revokedCertSignature, cert.signature)
  t.is(list[0].reason, 'rotation')
  t.is(list[0].expiresAt, cert.expiresAt)
})

test('RelayNode: submitRevocation rejects forged revocations', (t) => {
  const primaryKp = genKeypair()
  const attackerKp = genKeypair()
  const deviceKp = genKeypair()
  const cert = makeCert(primaryKp, deviceKp)
  // Attacker signs a would-be revocation
  const forgedRev = createRevocation(cert, attackerKp.secretKey)
  const node = makeNode()
  const result = node.submitRevocation(forgedRev)
  t.is(result.ok, false)
  t.is(result.reason, 'bad signature')
  t.is(node.listRevocations().length, 0, 'store unchanged after forgery rejection')
})

test('RelayNode._checkDelegation: rejects a valid cert once revoked', (t) => {
  const primaryKp = genKeypair()
  const deviceKp = genKeypair()
  const cert = makeCert(primaryKp, deviceKp)

  const node = makeNode()

  // Synthesize a signed seed request from the device. The request-signature
  // path is already well-tested elsewhere; here we only care that the
  // revocation check fires ahead of the fine-grained checks.
  const appKey = b4a.alloc(32, 0x11)
  const discoveryKeys = [b4a.alloc(32, 0x22)]
  const dkHash = b4a.alloc(32)
  sodium.crypto_generichash(dkHash, b4a.concat(discoveryKeys))
  const meta = b4a.alloc(28)
  const view = new DataView(meta.buffer, meta.byteOffset)
  view.setUint8(0, 3)
  view.setBigUint64(8, BigInt(500 * 1024 * 1024))
  view.setBigUint64(16, BigInt(30 * 24 * 3600))
  view.setUint32(24, 0)
  const payload = b4a.concat([appKey, dkHash, meta])
  const reqSig = b4a.alloc(64)
  sodium.crypto_sign_detached(reqSig, payload, deviceKp.secretKey)

  const req = {
    appKey,
    discoveryKeys,
    replicationFactor: 3,
    maxStorageBytes: 500 * 1024 * 1024,
    ttlSeconds: 30 * 24 * 3600,
    bountyRate: 0,
    publisherPubkey: deviceKp.publicKey,
    publisherSignature: reqSig,
    delegationCert: cert
  }

  // Sanity: the chain is fine before revocation.
  const beforeCertCheck = verifyDelegationCert(cert)
  t.is(beforeCertCheck.valid, true, 'cert itself is well-formed + unexpired')

  const before = node._checkDelegation(req)
  t.is(before.ok, true, 'delegation accepted pre-revocation')

  // Submit the revocation.
  const rev = createRevocation(cert, primaryKp.secretKey, { reason: 'compromised' })
  node.submitRevocation(rev, { certExpiresAt: cert.expiresAt })

  // Now the same request must be rejected with reason 'revoked'.
  const after = node._checkDelegation(req)
  t.is(after.ok, false)
  t.is(after.reason, 'revoked')
})

test('RelayNode: _sweepRevocations drops entries past certExpiresAt', (t) => {
  const primaryKp = genKeypair()
  const deviceKp = genKeypair()
  const cert = makeCert(primaryKp, deviceKp)
  const rev = createRevocation(cert, primaryKp.secretKey)

  const node = makeNode()
  // Expiry in the past → sweep should drop immediately.
  node.submitRevocation(rev, { certExpiresAt: Date.now() - 1000 })
  t.is(node.listRevocations().length, 1)
  let sweptCount = 0
  node.on('revocations-swept', ({ dropped }) => { sweptCount = dropped })
  node._sweepRevocations()
  t.is(sweptCount, 1)
  t.is(node.listRevocations().length, 0)
})

// ─── Client SDK method ────────────────────────────────────────────

test('HiveRelayClient.createCertRevocation: signs + verifies', async (t) => {
  const primaryKp = genKeypair()
  const deviceKp = genKeypair()
  const cert = makeCert(primaryKp, deviceKp)

  const client = new HiveRelayClient({ swarm: mockSwarm(primaryKp), keyPair: primaryKp })
  await client.start()

  const rev = client.createCertRevocation(cert, { reason: 'lost device' })
  t.is(rev.primaryPubkey, b4a.toString(primaryKp.publicKey, 'hex'))
  t.is(rev.revokedCertSignature, cert.signature)
  t.is(rev.reason, 'lost device')

  // And it verifies cleanly.
  const result = verifyRevocation(rev)
  t.is(result.valid, true)

  await client.destroy()
})

test('HiveRelayClient.createCertRevocation: rejects certs signed by a different primary', async (t) => {
  const myKp = genKeypair()
  const otherKp = genKeypair()
  const deviceKp = genKeypair()
  const otherCert = makeCert(otherKp, deviceKp)

  const client = new HiveRelayClient({ swarm: mockSwarm(myKp), keyPair: myKp })
  await client.start()

  try {
    client.createCertRevocation(otherCert)
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('did not issue'), 'refuses to sign revocation for a cert from another identity')
  }

  await client.destroy()
})

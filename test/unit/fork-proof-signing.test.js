import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import {
  signForkProof,
  verifyForkProof,
  FORK_PROOF_SIGNATURE_VERSION,
  DEFAULT_FRESHNESS_WINDOW_MS,
  FUTURE_SKEW_TOLERANCE_MS
} from 'p2p-hiverelay/core/fork-proof-signing.js'

function makeKeyPair () {
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

const validHex = (n = 64) => Array.from({ length: n }).map((_, i) => (i % 16).toString(16)).join('')

function happyProof () {
  return {
    hypercoreKey: validHex(),
    blockIndex: 5,
    evidence: [
      { fromRelay: 'r1', block: 'b1', signature: 's1' },
      { fromRelay: 'r2', block: 'b2', signature: 's2' }
    ]
  }
}

test('signature constants are exposed', async (t) => {
  t.is(FORK_PROOF_SIGNATURE_VERSION, 1)
  t.ok(DEFAULT_FRESHNESS_WINDOW_MS > 0)
  t.ok(FUTURE_SKEW_TOLERANCE_MS > 0)
})

test('signForkProof produces a verifiable envelope', async (t) => {
  const kp = makeKeyPair()
  const signed = signForkProof(happyProof(), kp)
  t.is(signed.version, 1)
  t.ok(signed.proof)
  t.ok(signed.observer)
  t.is(signed.observer.pubkey, b4a.toString(kp.publicKey, 'hex'))
  t.is(signed.observer.signature.length, 128)
  t.ok(typeof signed.observer.attestedAt === 'number')

  const v = verifyForkProof(signed)
  t.ok(v.valid)
  t.is(v.observer, signed.observer.pubkey)
})

test('verify catches tampered hypercoreKey', async (t) => {
  const kp = makeKeyPair()
  const signed = signForkProof(happyProof(), kp)
  signed.proof.hypercoreKey = '0'.repeat(64)
  const v = verifyForkProof(signed)
  t.absent(v.valid)
  t.is(v.reason, 'signature verification failed')
})

test('verify catches tampered evidence', async (t) => {
  const kp = makeKeyPair()
  const signed = signForkProof(happyProof(), kp)
  signed.proof.evidence[0].signature = 'modified-sig'
  const v = verifyForkProof(signed)
  t.absent(v.valid)
})

test('verify catches tampered observer pubkey', async (t) => {
  const kp = makeKeyPair()
  const otherKp = makeKeyPair()
  const signed = signForkProof(happyProof(), kp)
  signed.observer.pubkey = b4a.toString(otherKp.publicKey, 'hex')
  const v = verifyForkProof(signed)
  t.absent(v.valid)
})

test('verify catches tampered attestedAt', async (t) => {
  const kp = makeKeyPair()
  const signed = signForkProof(happyProof(), kp)
  signed.observer.attestedAt = signed.observer.attestedAt - 10
  const v = verifyForkProof(signed)
  t.absent(v.valid)
  t.is(v.reason, 'signature verification failed')
})

test('verify rejects future-dated attestation beyond skew tolerance', async (t) => {
  const kp = makeKeyPair()
  const futureTime = Date.now() + FUTURE_SKEW_TOLERANCE_MS + 60_000
  const signed = signForkProof(happyProof(), kp, { attestedAt: futureTime })
  const v = verifyForkProof(signed)
  t.absent(v.valid)
  t.is(v.reason, 'attestedAt is in the future')
})

test('verify rejects too-old attestation (replay protection)', async (t) => {
  const kp = makeKeyPair()
  const oldTime = Date.now() - DEFAULT_FRESHNESS_WINDOW_MS - 60_000
  const signed = signForkProof(happyProof(), kp, { attestedAt: oldTime })
  const v = verifyForkProof(signed)
  t.absent(v.valid)
  t.ok(v.reason.includes('too old'))
})

test('verify accepts attestation within freshness window', async (t) => {
  const kp = makeKeyPair()
  const recentTime = Date.now() - 60_000 // 1 minute old
  const signed = signForkProof(happyProof(), kp, { attestedAt: recentTime })
  const v = verifyForkProof(signed)
  t.ok(v.valid)
})

test('signForkProof rejects bad inputs', async (t) => {
  const kp = makeKeyPair()
  try { signForkProof(null, kp); t.fail() } catch (err) { t.ok(err.message.includes('proof required')) }
  try { signForkProof(happyProof(), null); t.fail() } catch (err) { t.ok(err.message.includes('observerKeyPair')) }
  try {
    signForkProof({ ...happyProof(), hypercoreKey: 'not-hex' }, kp); t.fail()
  } catch (err) { t.ok(err.message.includes('64 hex')) }
  try {
    signForkProof({ ...happyProof(), evidence: [happyProof().evidence[0]] }, kp); t.fail()
  } catch (err) { t.ok(err.message.includes('at least 2')) }
})

test('verify handles malformed envelopes gracefully', async (t) => {
  t.absent(verifyForkProof(null).valid)
  t.absent(verifyForkProof({}).valid)
  t.absent(verifyForkProof({ version: 999 }).valid)
  const validBare = signForkProof(happyProof(), makeKeyPair())
  // Malform individual fields
  t.absent(verifyForkProof({ ...validBare, observer: { ...validBare.observer, pubkey: 'short' } }).valid)
  t.absent(verifyForkProof({ ...validBare, observer: { ...validBare.observer, signature: 'short' } }).valid)
  t.absent(verifyForkProof({ ...validBare, observer: { ...validBare.observer, attestedAt: 'not-a-number' } }).valid)
})

test('JSON round-trip preserves signature validity', async (t) => {
  const kp = makeKeyPair()
  const signed = signForkProof(happyProof(), kp)
  const roundtripped = JSON.parse(JSON.stringify(signed))
  const v = verifyForkProof(roundtripped)
  t.ok(v.valid)
})

test('different observer keys produce different signatures for same proof', async (t) => {
  const proof = happyProof()
  const a = signForkProof(proof, makeKeyPair())
  const b = signForkProof(proof, makeKeyPair())
  t.unlike(a.observer.signature, b.observer.signature)
})

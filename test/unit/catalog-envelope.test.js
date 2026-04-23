import test from 'brittle'
import { RelayNode } from 'p2p-hiverelay/core/relay-node/index.js'
import path from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import sodium from 'sodium-universal'
import b4a from 'b4a'

// ─── Helpers ──────────────────────────────────────────────────────────────

function tmpStorage () {
  return path.join(tmpdir(), 'hiverelay-test-' + randomBytes(8).toString('hex'))
}

function makeKeypair () {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return {
    publicKey,
    secretKey,
    publicKeyHex: b4a.toString(publicKey, 'hex')
  }
}

/**
 * Replicates the signing logic from RelayNode._getCatalogEnvelope
 * (relay-node/index.js line ~609). Builds a payload of
 * `JSON.stringify({ apps, relayPubkey, catalogTimestamp })` and signs it
 * with the supplied secretKey. Returns a hex signature.
 */
function signEnvelope ({ apps, relayPubkey, catalogTimestamp, secretKey }) {
  const payload = b4a.from(JSON.stringify({ apps, relayPubkey, catalogTimestamp }))
  const signature = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, payload, secretKey)
  return b4a.toString(signature, 'hex')
}

/**
 * Constructs a RelayNode without starting the swarm. The verifier only
 * touches `this.config`, so the node never needs to be `.start()`ed.
 */
function makeNode (extraConfig = {}) {
  return new RelayNode({
    storage: tmpStorage(),
    enableAPI: false,
    catalogSignatureMaxAgeMs: 5 * 60 * 1000,
    ...extraConfig
  })
}

// ─── Positive controls ────────────────────────────────────────────────────

test('verifyCatalogEnvelope - empty apps array with valid signature passes', (t) => {
  const node = makeNode()
  const kp = makeKeypair()
  const apps = []
  const catalogTimestamp = Date.now()
  const signature = signEnvelope({
    apps,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp,
    secretKey: kp.secretKey
  })

  const ok = node._verifyCatalogEnvelope({
    apps,
    remotePubkey: kp.publicKeyHex,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp,
    signature
  })

  t.is(ok, true, 'empty apps + valid sig accepted')
})

test('verifyCatalogEnvelope - single-app valid signature passes', (t) => {
  const node = makeNode()
  const kp = makeKeypair()
  const apps = [{ appKey: 'a'.repeat(64), publisherPubkey: 'b'.repeat(64) }]
  const catalogTimestamp = Date.now()
  const signature = signEnvelope({
    apps,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp,
    secretKey: kp.secretKey
  })

  const ok = node._verifyCatalogEnvelope({
    apps,
    remotePubkey: kp.publicKeyHex,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp,
    signature
  })

  t.is(ok, true, 'single-app envelope accepted')
})

// ─── Forgery / tampering ──────────────────────────────────────────────────

test('verifyCatalogEnvelope - signature signed by a different key is rejected', (t) => {
  const node = makeNode()
  const honest = makeKeypair()
  const attacker = makeKeypair()
  const apps = [{ appKey: 'c'.repeat(64) }]
  const catalogTimestamp = Date.now()

  // Attacker signs the payload, but we present the honest key as relayPubkey.
  // To trip the verifier (rather than an earlier remote/relay mismatch),
  // remotePubkey must equal relayPubkey — so the only thing wrong is that
  // the signature won't verify under the honest key.
  const signature = signEnvelope({
    apps,
    relayPubkey: honest.publicKeyHex,
    catalogTimestamp,
    secretKey: attacker.secretKey
  })

  const ok = node._verifyCatalogEnvelope({
    apps,
    remotePubkey: honest.publicKeyHex,
    relayPubkey: honest.publicKeyHex,
    catalogTimestamp,
    signature
  })

  t.is(ok, false, 'forged signature rejected')
})

test('verifyCatalogEnvelope - tampered apps array invalidates the signature', (t) => {
  const node = makeNode()
  const kp = makeKeypair()
  const originalApps = [{ appKey: 'd'.repeat(64) }]
  const tamperedApps = [{ appKey: 'e'.repeat(64) }]
  const catalogTimestamp = Date.now()

  // Sign the original apps...
  const signature = signEnvelope({
    apps: originalApps,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp,
    secretKey: kp.secretKey
  })

  // ...then verify against a tampered apps array. Should fail.
  const ok = node._verifyCatalogEnvelope({
    apps: tamperedApps,
    remotePubkey: kp.publicKeyHex,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp,
    signature
  })

  t.is(ok, false, 'tampered apps rejected')
})

test('verifyCatalogEnvelope - relayPubkey does not match remotePubkey is rejected', (t) => {
  const node = makeNode()
  const honest = makeKeypair()
  const other = makeKeypair()
  const apps = []
  const catalogTimestamp = Date.now()
  const signature = signEnvelope({
    apps,
    relayPubkey: honest.publicKeyHex,
    catalogTimestamp,
    secretKey: honest.secretKey
  })

  const ok = node._verifyCatalogEnvelope({
    apps,
    remotePubkey: other.publicKeyHex, // different peer
    relayPubkey: honest.publicKeyHex,
    catalogTimestamp,
    signature
  })

  t.is(ok, false, 'relayPubkey/remotePubkey mismatch rejected')
})

// ─── Time bounds ──────────────────────────────────────────────────────────

test('verifyCatalogEnvelope - expired timestamp (older than maxAge) is rejected', (t) => {
  const node = makeNode({ catalogSignatureMaxAgeMs: 5 * 60 * 1000 })
  const kp = makeKeypair()
  const apps = []
  // 10 minutes in the past — past the 5-min default window
  const catalogTimestamp = Date.now() - (10 * 60 * 1000)
  const signature = signEnvelope({
    apps,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp,
    secretKey: kp.secretKey
  })

  const ok = node._verifyCatalogEnvelope({
    apps,
    remotePubkey: kp.publicKeyHex,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp,
    signature
  })

  t.is(ok, false, 'expired catalog rejected')
})

test('verifyCatalogEnvelope - future timestamp beyond skew window is rejected', (t) => {
  // The verifier uses Math.abs(now - ts) > maxAgeMs, so future skew shares
  // the same bound. Push the timestamp 10 minutes ahead of "now" — outside
  // any reasonable skew tolerance.
  const node = makeNode({ catalogSignatureMaxAgeMs: 5 * 60 * 1000 })
  const kp = makeKeypair()
  const apps = []
  const catalogTimestamp = Date.now() + (10 * 60 * 1000)
  const signature = signEnvelope({
    apps,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp,
    secretKey: kp.secretKey
  })

  const ok = node._verifyCatalogEnvelope({
    apps,
    remotePubkey: kp.publicKeyHex,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp,
    signature
  })

  t.is(ok, false, 'far-future catalog rejected')
})

test('verifyCatalogEnvelope - non-numeric timestamp is rejected', (t) => {
  const node = makeNode({ requireSignedCatalog: true })
  const kp = makeKeypair()
  const apps = []
  // Use a structurally valid 128-hex signature so the early "missing field"
  // backward-compat branch doesn't short-circuit.
  const signature = 'a'.repeat(128)

  const ok = node._verifyCatalogEnvelope({
    apps,
    remotePubkey: kp.publicKeyHex,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp: 'not-a-number',
    signature
  })

  t.is(ok, false, 'non-numeric timestamp rejected')
})

// ─── Missing fields (must not throw) ──────────────────────────────────────

test('verifyCatalogEnvelope - missing signature returns false cleanly when strict', (t) => {
  // Strict mode flips the backward-compat fallback into a hard reject so we
  // can confirm the verifier rejects (rather than silently accepts) missing
  // signatures. Either way it must not throw.
  const node = makeNode({ requireSignedCatalog: true })
  const kp = makeKeypair()

  let result
  try {
    result = node._verifyCatalogEnvelope({
      apps: [],
      remotePubkey: kp.publicKeyHex,
      relayPubkey: kp.publicKeyHex,
      catalogTimestamp: Date.now(),
      signature: undefined
    })
  } catch (err) {
    t.fail('verifier threw on missing signature: ' + err.message)
    return
  }

  t.is(result, false, 'missing signature rejected in strict mode')
})

test('verifyCatalogEnvelope - missing relayPubkey returns false cleanly when strict', (t) => {
  const node = makeNode({ requireSignedCatalog: true })

  let result
  try {
    result = node._verifyCatalogEnvelope({
      apps: [],
      remotePubkey: 'a'.repeat(64),
      relayPubkey: undefined,
      catalogTimestamp: Date.now(),
      signature: 'a'.repeat(128)
    })
  } catch (err) {
    t.fail('verifier threw on missing relayPubkey: ' + err.message)
    return
  }

  t.is(result, false, 'missing relayPubkey rejected in strict mode')
})

test('verifyCatalogEnvelope - missing catalogTimestamp returns false cleanly when strict', (t) => {
  const node = makeNode({ requireSignedCatalog: true })
  const kp = makeKeypair()

  let result
  try {
    result = node._verifyCatalogEnvelope({
      apps: [],
      remotePubkey: kp.publicKeyHex,
      relayPubkey: kp.publicKeyHex,
      catalogTimestamp: undefined,
      signature: 'a'.repeat(128)
    })
  } catch (err) {
    t.fail('verifier threw on missing catalogTimestamp: ' + err.message)
    return
  }

  t.is(result, false, 'missing catalogTimestamp rejected in strict mode')
})

test('verifyCatalogEnvelope - missing fields accepted in lax (default) mode for back-compat', (t) => {
  // Document the back-compat behavior: with requireSignedCatalog !== true,
  // an unsigned envelope is accepted to support legacy peers.
  const node = makeNode() // requireSignedCatalog defaults to false
  const kp = makeKeypair()

  const ok = node._verifyCatalogEnvelope({
    apps: [],
    remotePubkey: kp.publicKeyHex,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp: Date.now(),
    signature: undefined
  })

  t.is(ok, true, 'lax mode accepts unsigned envelope')
})

// ─── Malformed inputs (must not throw) ────────────────────────────────────

test('verifyCatalogEnvelope - malformed signature length is rejected', (t) => {
  const node = makeNode()
  const kp = makeKeypair()

  let result
  try {
    result = node._verifyCatalogEnvelope({
      apps: [],
      remotePubkey: kp.publicKeyHex,
      relayPubkey: kp.publicKeyHex,
      catalogTimestamp: Date.now(),
      signature: 'ab' // way too short
    })
  } catch (err) {
    t.fail('verifier threw on short signature: ' + err.message)
    return
  }

  t.is(result, false, 'short signature rejected')
})

test('verifyCatalogEnvelope - non-hex signature is rejected', (t) => {
  const node = makeNode()
  const kp = makeKeypair()

  // 128 chars but not all hex — must trip the regex check.
  const sig = 'z'.repeat(128)

  let result
  try {
    result = node._verifyCatalogEnvelope({
      apps: [],
      remotePubkey: kp.publicKeyHex,
      relayPubkey: kp.publicKeyHex,
      catalogTimestamp: Date.now(),
      signature: sig
    })
  } catch (err) {
    t.fail('verifier threw on non-hex signature: ' + err.message)
    return
  }

  t.is(result, false, 'non-hex signature rejected')
})

test('verifyCatalogEnvelope - malformed relayPubkey length is rejected', (t) => {
  const node = makeNode()
  const kp = makeKeypair()
  const apps = []
  const catalogTimestamp = Date.now()
  // Sign with a real key so the signature passes structure checks; but we
  // present a malformed-length relayPubkey on the envelope.
  const signature = signEnvelope({
    apps,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp,
    secretKey: kp.secretKey
  })

  const shortKey = 'ab' // not 64 hex chars

  let result
  try {
    result = node._verifyCatalogEnvelope({
      apps,
      remotePubkey: shortKey,
      relayPubkey: shortKey,
      catalogTimestamp,
      signature
    })
  } catch (err) {
    t.fail('verifier threw on short relayPubkey: ' + err.message)
    return
  }

  t.is(result, false, 'short relayPubkey rejected')
})

test('verifyCatalogEnvelope - non-hex relayPubkey is rejected', (t) => {
  const node = makeNode()
  const kp = makeKeypair()
  const apps = []
  const catalogTimestamp = Date.now()
  const signature = signEnvelope({
    apps,
    relayPubkey: kp.publicKeyHex,
    catalogTimestamp,
    secretKey: kp.secretKey
  })

  const badKey = 'z'.repeat(64) // right length, wrong alphabet

  let result
  try {
    result = node._verifyCatalogEnvelope({
      apps,
      remotePubkey: badKey,
      relayPubkey: badKey,
      catalogTimestamp,
      signature
    })
  } catch (err) {
    t.fail('verifier threw on non-hex relayPubkey: ' + err.message)
    return
  }

  t.is(result, false, 'non-hex relayPubkey rejected')
})

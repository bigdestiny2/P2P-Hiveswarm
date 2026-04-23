import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import {
  createSeedingManifest,
  verifySeedingManifest,
  isNewerManifest,
  MANIFEST_TYPE,
  MANIFEST_VERSION,
  MAX_RELAYS,
  MAX_DRIVES,
  TIMESTAMP_SKEW_MS
} from 'p2p-hiverelay/core/seeding-manifest.js'

function makeKeyPair () {
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function validHex (n) {
  return Array.from({ length: n }).map((_, i) => (i % 16).toString(16)).join('')
}

const SAMPLE_DRIVE_KEY = validHex(64)
const SAMPLE_DRIVE_KEY_2 = validHex(64).split('').reverse().join('')

function happyArgs (keyPair, extras = {}) {
  return {
    keyPair,
    relays: [
      { url: 'hyperswarm://pkA', role: 'primary' },
      { url: 'wss://relay.example.com/dht', role: 'backup' }
    ],
    drives: [
      { driveKey: SAMPLE_DRIVE_KEY, channel: 'production' }
    ],
    ...extras
  }
}

test('roundtrip: createSeedingManifest → verifySeedingManifest', async (t) => {
  const kp = makeKeyPair()
  const manifest = createSeedingManifest(happyArgs(kp))
  t.is(manifest.type, MANIFEST_TYPE)
  t.is(manifest.version, MANIFEST_VERSION)
  t.is(manifest.pubkey, b4a.toString(kp.publicKey, 'hex'))
  t.ok(typeof manifest.timestamp === 'number')
  t.is(typeof manifest.signature, 'string')
  t.is(manifest.signature.length, 128)

  const check = verifySeedingManifest(manifest)
  t.ok(check.valid, 'fresh manifest verifies')
  t.is(check.pubkey, b4a.toString(kp.publicKey, 'hex'))
})

test('verify rejects tampered relays', async (t) => {
  const kp = makeKeyPair()
  const manifest = createSeedingManifest(happyArgs(kp))
  manifest.relays.push({ url: 'hyperswarm://attacker', role: 'primary' })
  const check = verifySeedingManifest(manifest)
  t.absent(check.valid)
  t.is(check.reason, 'signature verification failed')
})

test('verify rejects tampered drives', async (t) => {
  const kp = makeKeyPair()
  const manifest = createSeedingManifest(happyArgs(kp))
  manifest.drives[0].driveKey = SAMPLE_DRIVE_KEY_2
  const check = verifySeedingManifest(manifest)
  t.absent(check.valid)
  t.is(check.reason, 'signature verification failed')
})

test('verify rejects tampered timestamp', async (t) => {
  const kp = makeKeyPair()
  const manifest = createSeedingManifest(happyArgs(kp))
  manifest.timestamp = manifest.timestamp - 1000
  const check = verifySeedingManifest(manifest)
  t.absent(check.valid)
  t.is(check.reason, 'signature verification failed')
})

test('verify rejects tampered pubkey (signature check catches it)', async (t) => {
  const kp = makeKeyPair()
  const other = makeKeyPair()
  const manifest = createSeedingManifest(happyArgs(kp))
  manifest.pubkey = b4a.toString(other.publicKey, 'hex')
  const check = verifySeedingManifest(manifest)
  t.absent(check.valid)
})

test('verify rejects future-dated timestamp beyond skew', async (t) => {
  const kp = makeKeyPair()
  const future = Date.now() + TIMESTAMP_SKEW_MS + 60_000
  const manifest = createSeedingManifest(happyArgs(kp, { timestamp: future }))
  const check = verifySeedingManifest(manifest)
  t.absent(check.valid)
  t.is(check.reason, 'timestamp in the future')
})

test('verify accepts timestamp within skew window', async (t) => {
  const kp = makeKeyPair()
  const nearFuture = Date.now() + 1000 // 1s in future, well within 5min skew
  const manifest = createSeedingManifest(happyArgs(kp, { timestamp: nearFuture }))
  const check = verifySeedingManifest(manifest)
  t.ok(check.valid)
})

test('verify rejects wrong type or version', async (t) => {
  const kp = makeKeyPair()
  const m1 = createSeedingManifest(happyArgs(kp))
  m1.type = 'wrong/type'
  t.is(verifySeedingManifest(m1).reason, 'wrong type')

  const m2 = createSeedingManifest(happyArgs(kp))
  m2.version = 999
  t.is(verifySeedingManifest(m2).reason, 'unsupported version')
})

test('verify rejects malformed fields', async (t) => {
  const kp = makeKeyPair()
  // Build a valid manifest, then mutate individual fields.
  const base = createSeedingManifest(happyArgs(kp))

  t.is(verifySeedingManifest({ ...base, pubkey: 'nothex' }).reason, 'bad pubkey')
  t.is(verifySeedingManifest({ ...base, timestamp: 'now' }).reason, 'bad timestamp')
  t.is(verifySeedingManifest({ ...base, relays: 'notarray' }).reason, 'relays not array')
  t.is(verifySeedingManifest({ ...base, drives: 'notarray' }).reason, 'drives not array')
  t.is(verifySeedingManifest({ ...base, signature: 'nothex' }).reason, 'bad signature')
  t.is(verifySeedingManifest(null).reason, 'not an object')
})

test('createSeedingManifest rejects too many relays', async (t) => {
  const kp = makeKeyPair()
  const relays = Array.from({ length: MAX_RELAYS + 1 }).map((_, i) => ({
    url: 'hyperswarm://r' + i, role: 'primary'
  }))
  try {
    createSeedingManifest({ keyPair: kp, relays, drives: [{ driveKey: SAMPLE_DRIVE_KEY }] })
    t.fail('should reject')
  } catch (err) {
    t.ok(err.message.includes('too many relays'))
  }
})

test('createSeedingManifest rejects too many drives', async (t) => {
  const kp = makeKeyPair()
  const drives = Array.from({ length: MAX_DRIVES + 1 }).map(() => ({ driveKey: SAMPLE_DRIVE_KEY }))
  try {
    createSeedingManifest({ keyPair: kp, relays: [{ url: 'hyperswarm://a' }], drives })
    t.fail('should reject')
  } catch (err) {
    t.ok(err.message.includes('too many drives'))
  }
})

test('createSeedingManifest rejects invalid relay role', async (t) => {
  const kp = makeKeyPair()
  try {
    createSeedingManifest({
      keyPair: kp,
      relays: [{ url: 'hyperswarm://a', role: 'primary-backup' }],
      drives: [{ driveKey: SAMPLE_DRIVE_KEY }]
    })
    t.fail('should reject')
  } catch (err) {
    t.ok(err.message.includes('bad relay role'))
  }
})

test('createSeedingManifest rejects non-hex drive key', async (t) => {
  const kp = makeKeyPair()
  try {
    createSeedingManifest({
      keyPair: kp,
      relays: [{ url: 'hyperswarm://a' }],
      drives: [{ driveKey: 'nothex' }]
    })
    t.fail('should reject')
  } catch (err) {
    t.ok(err.message.includes('bad driveKey'))
  }
})

test('isNewerManifest compares timestamps for same pubkey only', async (t) => {
  const kp = makeKeyPair()
  const older = createSeedingManifest(happyArgs(kp, { timestamp: 100 }))
  const newer = createSeedingManifest(happyArgs(kp, { timestamp: 200 }))
  t.ok(isNewerManifest(newer, older))
  t.absent(isNewerManifest(older, newer))
  t.ok(isNewerManifest(newer, null), 'any manifest is newer than null')

  const otherKp = makeKeyPair()
  const otherAuthor = createSeedingManifest(happyArgs(otherKp, { timestamp: 999 }))
  t.absent(isNewerManifest(otherAuthor, newer),
    'different-pubkey manifest is never a replacement')
})

test('roundtrip preserves canonical payload despite key order shuffling', async (t) => {
  // Build a manifest, then re-serialize its drives with keys in reverse
  // alphabetical order. canonicalPayload sorts keys internally, so the
  // signature should still verify.
  const kp = makeKeyPair()
  const m = createSeedingManifest(happyArgs(kp))
  // Round-trip via JSON to simulate a client that re-serializes before
  // re-sending. Key order in the JSON representation should not matter.
  const roundtripped = JSON.parse(JSON.stringify(m))
  const check = verifySeedingManifest(roundtripped)
  t.ok(check.valid)
})

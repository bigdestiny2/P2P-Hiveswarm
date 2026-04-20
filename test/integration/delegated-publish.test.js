/**
 * Integration tests for delegated publish via a device-attestation cert.
 *
 * The relay's seed acceptance path (`_scanRegistry`) optionally accepts
 * registry entries that carry a `delegationCert`. When the cert verifies
 * (and the seed-request signature was made by the device named in the cert),
 * the relay accepts the request but attributes it to the *primary* identity
 * named on the cert. Otherwise it emits `'delegation-rejected'` and skips.
 */

import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
import { RelayNode } from 'p2p-hiverelay/core/relay-node/index.js'
import { verifyDelegationCert } from 'p2p-hiverelay/core/delegation.js'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import path from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

function tmpStorage () {
  return path.join(tmpdir(), 'hiverelay-deleg-' + randomBytes(8).toString('hex'))
}

function createNode (testnet, overrides = {}) {
  return new RelayNode({
    storage: tmpStorage(),
    bootstrapNodes: testnet.bootstrap,
    enableAPI: false,
    enableMetrics: false,
    enableServices: false,
    acceptMode: 'open',
    ...overrides
  })
}

// Generate an Ed25519 keypair (libsodium).
function keygen () {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

// Create a delegation cert exactly as `HiveRelayClient.createDeviceAttestation`
// does. This must match the format the verifier expects.
function createDelegationCert (primary, devicePubkey, opts = {}) {
  const ttl = opts.ttlMs || 24 * 60 * 60 * 1000
  const expiresAt = typeof opts.expiresAt === 'number'
    ? opts.expiresAt
    : Date.now() + ttl
  const label = opts.label || ''

  const expBuf = b4a.alloc(8)
  new DataView(expBuf.buffer, expBuf.byteOffset).setBigUint64(0, BigInt(expiresAt), false)
  const labelBuf = b4a.from(label, 'utf8')
  const payload = b4a.concat([primary.publicKey, devicePubkey, expBuf, labelBuf])

  const signature = b4a.alloc(64)
  sodium.crypto_sign_detached(signature, payload, primary.secretKey)

  return {
    version: 1,
    primaryPubkey: b4a.toString(primary.publicKey, 'hex'),
    devicePubkey: b4a.toString(devicePubkey, 'hex'),
    expiresAt,
    label,
    signature: b4a.toString(signature, 'hex')
  }
}

// Produce a `publisherSignature` over the seed-request payload using the
// SeedProtocol's serialization rules (appKey || hash(discoveryKeys) || meta).
function signSeedRequest (entry, secretKey) {
  const appKeyBuf = b4a.from(entry.appKey, 'hex')
  const dkHash = b4a.alloc(32)
  if (entry.discoveryKeys && entry.discoveryKeys.length > 0) {
    const dkBufs = entry.discoveryKeys.map(dk => b4a.from(dk, 'hex'))
    sodium.crypto_generichash(dkHash, b4a.concat(dkBufs))
  }
  const meta = b4a.alloc(28)
  const view = new DataView(meta.buffer, meta.byteOffset)
  view.setUint8(0, entry.replicationFactor || 0)
  view.setBigUint64(8, BigInt(entry.maxStorageBytes || 0))
  view.setBigUint64(16, BigInt(entry.ttlSeconds || 0))
  view.setUint32(24, entry.bountyRate || 0)

  const payload = b4a.concat([appKeyBuf, dkHash, meta])
  const sig = b4a.alloc(64)
  sodium.crypto_sign_detached(sig, payload, secretKey)
  return b4a.toString(sig, 'hex')
}

// Build a synthetic registry seed-request entry. Caller supplies the device
// secret key for signing; pass `signWith` to override (e.g. to produce an
// invalid signature signed by the wrong key).
function makeRegistryEntry ({ device, primary, cert, appKey, discoveryKey, signWith }) {
  const entry = {
    type: 'seed-request',
    timestamp: Date.now(),
    appKey: b4a.toString(appKey, 'hex'),
    discoveryKeys: [b4a.toString(discoveryKey, 'hex')],
    contentType: 'app',
    parentKey: null,
    mountPath: null,
    replicationFactor: 1,
    geoPreference: [],
    maxStorageBytes: 0,
    bountyRate: 0,
    ttlSeconds: 3600,
    privacyTier: 'public',
    publisherPubkey: b4a.toString(device.publicKey, 'hex')
  }
  entry.publisherSignature = signSeedRequest(entry, signWith || device.secretKey)
  if (cert !== undefined) entry.delegationCert = cert
  return entry
}

// Inject a synthetic registry entry into the relay's `seedingRegistry`
// in-memory index, then drive `_scanRegistry()` once. Returns the array of
// emitted events of interest.
async function injectAndScan (node, entry, eventNames = ['registry-seed-accepted', 'delegation-rejected', 'registry-rejected', 'registry-skipped-policy', 'registry-pending']) {
  const events = []
  const handlers = new Map()
  for (const name of eventNames) {
    const h = (payload) => events.push({ name, payload })
    handlers.set(name, h)
    node.on(name, h)
  }
  node.seedingRegistry._requests.set(entry.appKey, entry)
  try {
    await node._scanRegistry()
  } finally {
    for (const [name, h] of handlers) node.removeListener(name, h)
  }
  return events
}

// ─── verifier sanity ────────────────────────────────────────────────

test('verifyDelegationCert agrees with the createDeviceAttestation format', async (t) => {
  const primary = keygen()
  const device = keygen()
  const cert = createDelegationCert(primary, device.publicKey, { label: 'iPhone' })
  const result = verifyDelegationCert(cert)
  t.is(result.valid, true, 'cert valid')
  t.is(result.primaryPubkey, b4a.toString(primary.publicKey, 'hex'), 'returns primary pubkey')

  // Tamper with signature
  const bad = { ...cert, signature: 'ff'.repeat(64) }
  t.is(verifyDelegationCert(bad).valid, false, 'tampered signature rejected')

  // Expired
  const expired = createDelegationCert(primary, device.publicKey, { expiresAt: Date.now() - 1000 })
  t.is(verifyDelegationCert(expired).valid, false, 'expired rejected')
})

// ─── happy path ──────────────────────────────────────────────────────

test('relay accepts seed request with valid delegation cert; primary attributed', async (t) => {
  const testnet = await createTestnet(3)
  const node = createNode(testnet)
  t.teardown(async () => {
    await node.stop()
    await testnet.destroy()
  })
  await node.start()

  const primary = keygen()
  const device = keygen()
  const cert = createDelegationCert(primary, device.publicKey, { label: 'laptop' })

  const appKey = randomBytes(32)
  const discoveryKey = randomBytes(32)
  const entry = makeRegistryEntry({ device, primary, cert, appKey, discoveryKey })

  const events = await injectAndScan(node, entry)

  const accepted = events.find(e => e.name === 'registry-seed-accepted')
  t.ok(accepted, 'registry-seed-accepted emitted')
  const rejected = events.find(e => e.name === 'delegation-rejected')
  t.absent(rejected, 'no delegation-rejected event')

  // Attribution: the seeded app should record the *primary* pubkey, not the
  // device pubkey.
  const seeded = node.seededApps.get(entry.appKey)
  t.ok(seeded, 'app is seeded')
  t.is(seeded.publisherPubkey, b4a.toString(primary.publicKey, 'hex'),
    'stored publisherPubkey is the primary identity')
})

// ─── negative: tampered cert signature ───────────────────────────────

test('rejects when delegation cert signature is tampered', async (t) => {
  const testnet = await createTestnet(3)
  const node = createNode(testnet)
  t.teardown(async () => {
    await node.stop()
    await testnet.destroy()
  })
  await node.start()

  const primary = keygen()
  const device = keygen()
  const cert = createDelegationCert(primary, device.publicKey)
  cert.signature = 'aa'.repeat(64) // tamper

  const appKey = randomBytes(32)
  const discoveryKey = randomBytes(32)
  const entry = makeRegistryEntry({ device, primary, cert, appKey, discoveryKey })

  const events = await injectAndScan(node, entry)

  const rejected = events.find(e => e.name === 'delegation-rejected')
  t.ok(rejected, 'delegation-rejected emitted')
  t.is(rejected.payload.reason, 'bad signature', 'reason is bad signature')
  const accepted = events.find(e => e.name === 'registry-seed-accepted')
  t.absent(accepted, 'not accepted')
  t.is(node.seededApps.has(entry.appKey), false, 'app not seeded')
})

// ─── negative: expired cert ──────────────────────────────────────────

test('rejects when delegation cert is expired', async (t) => {
  const testnet = await createTestnet(3)
  const node = createNode(testnet)
  t.teardown(async () => {
    await node.stop()
    await testnet.destroy()
  })
  await node.start()

  const primary = keygen()
  const device = keygen()
  const cert = createDelegationCert(primary, device.publicKey, { expiresAt: Date.now() - 60_000 })

  const appKey = randomBytes(32)
  const discoveryKey = randomBytes(32)
  const entry = makeRegistryEntry({ device, primary, cert, appKey, discoveryKey })

  const events = await injectAndScan(node, entry)

  const rejected = events.find(e => e.name === 'delegation-rejected')
  t.ok(rejected, 'delegation-rejected emitted')
  t.is(rejected.payload.reason, 'expired', 'reason is expired')
  t.is(node.seededApps.has(entry.appKey), false, 'app not seeded')
})

// ─── negative: cert.devicePubkey ≠ publisherPubkey ───────────────────

test('rejects when cert.devicePubkey does not match request publisherPubkey', async (t) => {
  const testnet = await createTestnet(3)
  const node = createNode(testnet)
  t.teardown(async () => {
    await node.stop()
    await testnet.destroy()
  })
  await node.start()

  const primary = keygen()
  const device = keygen()
  const otherDevice = keygen()
  // Cert authorises `device`, but the request is signed by `otherDevice`
  const cert = createDelegationCert(primary, device.publicKey)

  const appKey = randomBytes(32)
  const discoveryKey = randomBytes(32)
  const entry = makeRegistryEntry({
    device: otherDevice, // request publisher = otherDevice
    primary,
    cert,
    appKey,
    discoveryKey
  })

  const events = await injectAndScan(node, entry)

  const rejected = events.find(e => e.name === 'delegation-rejected')
  t.ok(rejected, 'delegation-rejected emitted')
  t.is(rejected.payload.reason, 'cert.devicePubkey mismatch', 'reason is mismatch')
  t.is(node.seededApps.has(entry.appKey), false, 'app not seeded')
})

// ─── negative: missing fields ────────────────────────────────────────

test('rejects when delegation cert is missing required fields', async (t) => {
  const testnet = await createTestnet(3)
  const node = createNode(testnet)
  t.teardown(async () => {
    await node.stop()
    await testnet.destroy()
  })
  await node.start()

  const primary = keygen()
  const device = keygen()

  // Cert with no signature
  const cert = createDelegationCert(primary, device.publicKey)
  delete cert.signature

  const appKey = randomBytes(32)
  const discoveryKey = randomBytes(32)
  const entry = makeRegistryEntry({ device, primary, cert, appKey, discoveryKey })

  const events = await injectAndScan(node, entry)

  const rejected = events.find(e => e.name === 'delegation-rejected')
  t.ok(rejected, 'delegation-rejected emitted')
  t.is(rejected.payload.reason, 'missing signature', 'reason is missing signature')
  t.is(node.seededApps.has(entry.appKey), false, 'app not seeded')

  // Also test: cert with wrong version. Clear the registry first so the
  // previous (missing-signature) entry doesn't re-fire its own event.
  node.seedingRegistry._requests.clear()
  const cert2 = createDelegationCert(primary, device.publicKey)
  cert2.version = 99
  const appKey2 = randomBytes(32)
  const entry2 = makeRegistryEntry({ device, primary, cert: cert2, appKey: appKey2, discoveryKey })
  const events2 = await injectAndScan(node, entry2)
  const rejected2 = events2.find(e => e.name === 'delegation-rejected' && e.payload.appKey === entry2.appKey)
  t.ok(rejected2, 'unsupported version rejected')
  t.is(rejected2.payload.reason, 'unsupported version', 'reason is unsupported version')
})

// ─── negative: valid cert but request signed by wrong key ────────────

test('rejects when request signature is not from the device named in cert', async (t) => {
  const testnet = await createTestnet(3)
  const node = createNode(testnet)
  t.teardown(async () => {
    await node.stop()
    await testnet.destroy()
  })
  await node.start()

  const primary = keygen()
  const device = keygen()
  const wrong = keygen()

  const cert = createDelegationCert(primary, device.publicKey)
  const appKey = randomBytes(32)
  const discoveryKey = randomBytes(32)
  // publisherPubkey says `device`, but the signature was made by `wrong`
  const entry = makeRegistryEntry({
    device,
    primary,
    cert,
    appKey,
    discoveryKey,
    signWith: wrong.secretKey
  })

  const events = await injectAndScan(node, entry)

  const rejected = events.find(e => e.name === 'delegation-rejected')
  t.ok(rejected, 'delegation-rejected emitted')
  t.is(rejected.payload.reason, 'request signature mismatch', 'reason is request signature mismatch')
  t.is(node.seededApps.has(entry.appKey), false, 'app not seeded')
})

// ─── backward compatibility ──────────────────────────────────────────

test('seed request without delegation cert still works (backward compatible)', async (t) => {
  const testnet = await createTestnet(3)
  const node = createNode(testnet)
  t.teardown(async () => {
    await node.stop()
    await testnet.destroy()
  })
  await node.start()

  const publisher = keygen()
  const appKey = randomBytes(32)
  const discoveryKey = randomBytes(32)
  // No cert; entry has the standard publisher pubkey only.
  const entry = makeRegistryEntry({
    device: publisher,
    primary: publisher,
    cert: undefined,
    appKey,
    discoveryKey
  })
  delete entry.delegationCert
  // also drop publisherSignature — the legacy registry path doesn't rely on it
  delete entry.publisherSignature

  const events = await injectAndScan(node, entry)
  const accepted = events.find(e => e.name === 'registry-seed-accepted')
  t.ok(accepted, 'accepted with no cert')
  const rejected = events.find(e => e.name === 'delegation-rejected')
  t.absent(rejected, 'no delegation-rejected event')

  const seeded = node.seededApps.get(entry.appKey)
  t.ok(seeded, 'app seeded')
  t.is(seeded.publisherPubkey, b4a.toString(publisher.publicKey, 'hex'),
    'stored publisherPubkey is the original publisher')
})

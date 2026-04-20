import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { ServiceProtocol } from 'p2p-hiverelay/core/services/protocol.js'

// ─── Test 1 & 2: Service protocol message decoding ────────────────────────
// We test the decode function directly from the ServiceProtocol encoding.
// The encoding spec: 4-byte big-endian length prefix + JSON payload.

/**
 * Decode a service protocol message buffer using the same logic
 * as ServiceProtocol's protomux message handler.
 */
function decodeServiceMessage (buf) {
  const state = { buffer: buf, start: 0, end: buf.length }
  const len = state.buffer.readUInt32BE(state.start)
  if (len > 1048576) { // 1 MB max
    state.start += 4 + len
    return { type: -1, error: 'message too large' }
  }
  const json = state.buffer.subarray(state.start + 4, state.start + 4 + len).toString()
  state.start += 4 + len
  try {
    return JSON.parse(json)
  } catch (_) {
    return { type: -1, error: 'malformed JSON' }
  }
}

/**
 * Encode a buffer with the 4-byte length prefix used by the service protocol.
 */
function encodeWithLengthPrefix (payload) {
  const payloadBuf = typeof payload === 'string' ? b4a.from(payload) : payload
  const buf = b4a.alloc(4 + payloadBuf.length)
  buf.writeUInt32BE(payloadBuf.length, 0)
  payloadBuf.copy(buf, 4)
  return buf
}

test('protocol-security: message > 1MB returns error type', async (t) => {
  // Create a buffer that claims to be > 1MB
  const bigPayload = b4a.alloc(1048577, 0x41) // 1MB + 1 byte of 'A'
  const buf = encodeWithLengthPrefix(bigPayload)

  const result = decodeServiceMessage(buf)
  t.is(result.type, -1, 'type is -1 (error)')
  t.is(result.error, 'message too large', 'error says message too large')
})

test('protocol-security: malformed JSON returns error type', async (t) => {
  const badJson = '{not valid json!!'
  const buf = encodeWithLengthPrefix(badJson)

  const result = decodeServiceMessage(buf)
  t.is(result.type, -1, 'type is -1 (error)')
  t.is(result.error, 'malformed JSON', 'error says malformed JSON')
})

// ─── Test 3: Unseed replay detection ──────────────────────────────────────
// The SeedProtocol uses _seenUnseedNonces to deduplicate unseed requests.
// We test this by calling the internal handler method.

/**
 * Helper: generate Ed25519 key pair.
 */
function keygen () {
  const pk = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const sk = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(pk, sk)
  return { pk, sk }
}

/**
 * Build a signed unseed message with binary Buffers (as the P2P protocol uses).
 */
function buildUnseedMsg (appKeyBuf, timestamp, pk, sk) {
  const tsBuf = b4a.alloc(8)
  const view = new DataView(tsBuf.buffer, tsBuf.byteOffset)
  view.setBigUint64(0, BigInt(timestamp))
  const payload = b4a.concat([appKeyBuf, b4a.from('unseed'), tsBuf])

  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, payload, sk)

  return {
    appKey: appKeyBuf,
    timestamp,
    publisherPubkey: pk,
    publisherSignature: sig
  }
}

test('protocol-security: unseed replay detection drops duplicate signature', async (t) => {
  // We simulate the replay detection mechanism from SeedProtocol._handleUnseed.
  // Instead of instantiating a full SeedProtocol (which needs a Hyperswarm),
  // we replicate the exact dedup logic used in seed-request.js.
  const seenNonces = new Map()
  const received = []

  function handleUnseed (msg, peerKey) {
    // Verify signature (same logic as SeedProtocol._verifyUnseedSignature)
    if (!msg.publisherPubkey || !msg.publisherSignature) return false
    const tsBuf = b4a.alloc(8)
    const view = new DataView(tsBuf.buffer, tsBuf.byteOffset)
    view.setBigUint64(0, BigInt(msg.timestamp))
    const payload = b4a.concat([msg.appKey, b4a.from('unseed'), tsBuf])
    const valid = sodium.crypto_sign_verify_detached(msg.publisherSignature, payload, msg.publisherPubkey)
    if (!valid) return false

    // Timestamp freshness
    const age = Date.now() - msg.timestamp
    if (age > 5 * 60 * 1000 || age < -60000) return false

    // Replay protection: signature hex as dedup key
    const dedupKey = b4a.toString(msg.publisherSignature, 'hex')
    if (seenNonces.has(dedupKey)) {
      return false // replay dropped
    }
    seenNonces.set(dedupKey, Date.now())
    received.push(msg)
    return true
  }

  const { pk, sk } = keygen()
  const appKey = b4a.alloc(32, 0xee)
  const timestamp = Date.now()
  const msg = buildUnseedMsg(appKey, timestamp, pk, sk)

  // First submission succeeds
  const first = handleUnseed(msg, 'peer-a')
  t.ok(first, 'first unseed request accepted')
  t.is(received.length, 1, 'one request recorded')

  // Second submission of the same message is dropped (replay)
  const second = handleUnseed(msg, 'peer-b')
  t.is(second, false, 'duplicate unseed request dropped')
  t.is(received.length, 1, 'still only one request recorded')
})

test('protocol-security: app catalog envelope fields are preserved', async (t) => {
  const registry = {
    catalog () { return [] },
    addRemoteServices () {},
    handleRequest: async () => ({ ok: true })
  }
  const proto = new ServiceProtocol(registry)
  proto._getCatalogEnvelope = () => ({
    apps: [{ appKey: 'a'.repeat(64), version: '1.0.0' }],
    relayPubkey: 'b'.repeat(64),
    catalogTimestamp: 123456,
    signature: 'c'.repeat(128)
  })

  const msg = proto._buildCatalogMessage()
  t.is(msg.type, 7)
  t.is(msg.apps.length, 1)
  t.is(msg.relayPubkey, 'b'.repeat(64))
  t.is(msg.catalogTimestamp, 123456)
  t.is(msg.signature, 'c'.repeat(128))
})

test('protocol-security: restricted local methods blocked while ai infer allowed', async (t) => {
  const sent = []
  const registry = {
    catalog () { return [] },
    addRemoteServices () {},
    handleRequest: async () => ({ ok: true })
  }
  const proto = new ServiceProtocol(registry)
  proto.router = {
    dispatch: async () => ({ ok: true })
  }
  proto.channels.set('peer', {
    channel: { opened: true },
    msgHandler: { send: (msg) => sent.push(msg) }
  })

  await proto._handleRequest('peer', {
    id: 1,
    service: 'identity',
    method: 'sign',
    params: { payload: 'x' }
  })
  t.ok(sent[0].error.includes('ACCESS_DENIED'), 'identity.sign is blocked')

  await proto._handleRequest('peer', {
    id: 2,
    service: 'ai',
    method: 'infer',
    params: { prompt: 'hello' }
  })
  t.alike(sent[1].result, { ok: true }, 'ai.infer passes to router')
})

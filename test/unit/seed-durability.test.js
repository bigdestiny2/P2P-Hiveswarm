/**
 * Tests for the accept-vs-replicate distinction added after PearBrowser
 * reported "relays accept seed but drive.core.peers stays at 0."
 *
 *   - Issue #1 fix: client.seed now uses the proper hypercore discoveryKey
 *     (keyed BLAKE2b, not plain BLAKE2b), so the discoveryKey in the
 *     signed request advertises the same DHT topic as the actual drive.
 *   - New helpers: getDurableStatus / waitForDurable surface the
 *     acceptance-vs-active-peers distinction that was previously hidden.
 */

import test from 'brittle'
import { EventEmitter } from 'events'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import hypercoreCrypto from 'hypercore-crypto'
import { HiveRelayClient } from 'p2p-hiverelay-client'

function mockSwarm () {
  const swarm = new EventEmitter()
  swarm.keyPair = { publicKey: Buffer.alloc(32, 0xaa), secretKey: null }
  swarm.connections = new Set()
  swarm.join = () => ({ destroy: () => {} })
  swarm.leave = async () => {}
  swarm.flush = async () => {}
  swarm.destroy = async () => {}
  return swarm
}

// ─── Issue #1 — discoveryKey is now correct ──────────────────────────

test('seed() advertises the hypercore-derived discoveryKey, not a plain hash', async (t) => {
  // Track what topic the swarm joins with. This is the topic the publisher
  // announces on; if it doesn't match the drive's discoveryKey, relays
  // looking for the drive never find us.
  const joins = []
  const swarm = mockSwarm()
  swarm.join = (topic, opts) => { joins.push({ topic: b4a.toString(topic, 'hex'), opts }); return { destroy: () => {} } }

  // Keypair so signing path runs cleanly
  const pk = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const sk = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(pk, sk)
  swarm.keyPair = { publicKey: pk, secretKey: sk }

  const client = new HiveRelayClient({ swarm, keyPair: swarm.keyPair })
  await client.start()

  // Pick an arbitrary 32-byte app key; the correct discoveryKey is the
  // hypercore-crypto keyed BLAKE2b, NOT a plain BLAKE2b.
  const appKey = b4a.alloc(32, 0x42)
  const expectedHex = b4a.toString(hypercoreCrypto.discoveryKey(appKey), 'hex')
  const wrongPlainHash = b4a.alloc(32)
  sodium.crypto_generichash(wrongPlainHash, appKey)
  const wrongHex = b4a.toString(wrongPlainHash, 'hex')

  // Patch out the actual broadcast path — we're testing the topic, not the wire.
  client.seedRequests = new Map()
  await client.seed(appKey, { timeout: 50, retryPersistent: false })

  const topics = joins.map(j => j.topic)
  t.ok(topics.includes(expectedHex), 'announces on hypercore-derived discoveryKey')
  t.absent(topics.includes(wrongHex), 'does NOT announce on the plain-hash (old) discoveryKey')

  await client.destroy()
})

test('seed() accepts an explicit opts.discoveryKey override', async (t) => {
  const joins = []
  const swarm = mockSwarm()
  swarm.join = (topic, opts) => { joins.push(b4a.toString(topic, 'hex')); return { destroy: () => {} } }

  const pk = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const sk = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(pk, sk)
  swarm.keyPair = { publicKey: pk, secretKey: sk }

  const client = new HiveRelayClient({ swarm, keyPair: swarm.keyPair })
  await client.start()

  const appKey = b4a.alloc(32, 0x42)
  // Pretend the caller already has the drive and knows its discoveryKey.
  const explicit = b4a.alloc(32, 0x11)
  client.seedRequests = new Map()
  await client.seed(appKey, { discoveryKey: explicit, timeout: 50, retryPersistent: false })

  t.ok(joins.includes(b4a.toString(explicit, 'hex')), 'explicit discoveryKey honoured')

  await client.destroy()
})

// ─── getDurableStatus / waitForDurable ───────────────────────────────

test('getDurableStatus: drive not open → driveOpen:false, durable:false', async (t) => {
  const client = new HiveRelayClient({ swarm: mockSwarm() })
  await client.start()
  const status = client.getDurableStatus('a'.repeat(64))
  t.is(status.driveOpen, false)
  t.is(status.durable, false)
  t.is(status.acceptances, 0)
  t.is(status.activePeers, 0)
  await client.destroy()
})

test('getDurableStatus: drive open but no peers → not durable', async (t) => {
  const client = new HiveRelayClient({ swarm: mockSwarm() })
  await client.start()
  const keyHex = 'a'.repeat(64)
  client.drives.set(keyHex, { core: { length: 10, peers: [] } })
  client.seedRequests.set(keyHex, { acceptances: [{ relayPubkey: Buffer.alloc(32) }] })

  const status = client.getDurableStatus(keyHex)
  t.is(status.driveOpen, true)
  t.is(status.acceptances, 1, 'one relay accepted')
  t.is(status.activePeers, 0, 'but nobody is actually replicating')
  t.is(status.durable, false, 'acceptance ≠ durable — this is the PearBrowser bug signature')
  await client.destroy()
})

test('getDurableStatus: at least one peer has caught up → durable', async (t) => {
  const client = new HiveRelayClient({ swarm: mockSwarm() })
  await client.start()
  const keyHex = 'b'.repeat(64)
  client.drives.set(keyHex, {
    core: {
      length: 10,
      peers: [
        { remoteLength: 10 },
        { remoteLength: 8 }
      ]
    }
  })

  const status = client.getDurableStatus(keyHex)
  t.is(status.activePeers, 2)
  t.is(status.byteLengthLocal, 10)
  t.is(status.byteLengthRemoteMax, 10)
  t.is(status.durable, true)
  await client.destroy()
})

test('getDurableStatus: peers present but behind local → not durable yet', async (t) => {
  const client = new HiveRelayClient({ swarm: mockSwarm() })
  await client.start()
  const keyHex = 'c'.repeat(64)
  client.drives.set(keyHex, {
    core: {
      length: 100,
      peers: [
        { remoteLength: 50 } // peer has only half our data
      ]
    }
  })
  const status = client.getDurableStatus(keyHex)
  t.is(status.activePeers, 1)
  t.is(status.byteLengthRemoteMax, 50)
  t.is(status.durable, false, 'peer lagging behind local length — not durable yet')
  await client.destroy()
})

test('waitForDurable: resolves as soon as durability transitions to true', async (t) => {
  const client = new HiveRelayClient({ swarm: mockSwarm() })
  await client.start()
  const keyHex = 'd'.repeat(64)
  const drive = { core: { length: 5, peers: [] } }
  client.drives.set(keyHex, drive)

  // After 50ms, simulate a peer catching up
  setTimeout(() => {
    drive.core.peers = [{ remoteLength: 5 }]
  }, 50)

  const status = await client.waitForDurable(keyHex, { timeoutMs: 2000, pollIntervalMs: 20 })
  t.is(status.durable, true, 'waited until durable')
  t.is(status.activePeers, 1)
  await client.destroy()
})

test('waitForDurable: returns last snapshot on timeout even if never durable', async (t) => {
  const client = new HiveRelayClient({ swarm: mockSwarm() })
  await client.start()
  const keyHex = 'e'.repeat(64)
  client.drives.set(keyHex, { core: { length: 10, peers: [] } }) // no peers ever

  const started = Date.now()
  const status = await client.waitForDurable(keyHex, { timeoutMs: 200, pollIntervalMs: 30 })
  const elapsed = Date.now() - started
  t.ok(elapsed >= 200, 'waited at least the timeout window')
  t.is(status.durable, false)
  t.is(status.activePeers, 0)
  await client.destroy()
})

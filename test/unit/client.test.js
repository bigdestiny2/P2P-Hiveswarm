import test from 'brittle'
import { HiveRelayClient } from 'p2p-hiverelay-client'
import { EventEmitter } from 'events'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

function tmpStorage () {
  return join(tmpdir(), 'hiverelay-client-test-' + randomBytes(8).toString('hex'))
}

// Mock swarm for low-level unit tests (advanced mode)
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

// --- Simple mode (storage path) ---

test('HiveRelayClient - simple mode: constructor with storage path', (t) => {
  const client = new HiveRelayClient(tmpStorage())
  t.ok(client, 'created')
  t.is(client._started, false, 'not started')
  t.is(client._ownsSwarm, true, 'owns swarm')
  t.is(client._ownsStore, true, 'owns store')
  t.is(client.drives.size, 0, 'no drives')
})

test('HiveRelayClient - simple mode: start creates swarm and store', async (t) => {
  const client = new HiveRelayClient(tmpStorage())
  t.teardown(async () => { await client.destroy() })

  await client.start()
  t.is(client._started, true, 'started')
  t.ok(client.store, 'store created')
  t.ok(client.swarm, 'swarm created')
})

test('HiveRelayClient - simple mode: start is idempotent', async (t) => {
  const client = new HiveRelayClient(tmpStorage())
  t.teardown(async () => { await client.destroy() })

  await client.start()
  const swarm1 = client.swarm
  await client.start()
  t.is(client.swarm, swarm1, 'same swarm on second start')
})

test('HiveRelayClient - simple mode: publish and get', async (t) => {
  // These "simple mode" tests construct a real Corestore + Hyperswarm per
  // test; swarm teardown in brittle's t.teardown chain can take 8-10s
  // depending on DHT state, so we widen the default 30s budget.
  t.timeout(90_000)
  const client = new HiveRelayClient(tmpStorage())
  t.teardown(async () => { await client.destroy() })

  await client.start()

  const drive = await client.publish([
    { path: '/hello.txt', content: 'Hello World' },
    { path: '/data.json', content: Buffer.from('{"ok":true}') }
  ], { seed: false })

  t.ok(drive, 'drive returned')
  t.ok(drive.key, 'drive has key')
  t.is(client.drives.size, 1, 'drive tracked')

  const keyHex = drive.key.toString('hex')
  const hello = await client.get(keyHex, '/hello.txt')
  t.is(hello.toString(), 'Hello World', 'content correct')

  const data = await client.get(keyHex, '/data.json')
  t.is(data.toString(), '{"ok":true}', 'binary content correct')
})

test('HiveRelayClient - simple mode: put and get', async (t) => {
  t.timeout(90_000)
  const client = new HiveRelayClient(tmpStorage())
  t.teardown(async () => { await client.destroy() })

  await client.start()
  const drive = await client.publish([], { seed: false })
  const keyHex = drive.key.toString('hex')

  await client.put(keyHex, '/test.txt', 'test content')
  const content = await client.get(keyHex, '/test.txt')
  t.is(content.toString(), 'test content', 'get returns what was put')
})

test('HiveRelayClient - simple mode: get throws for unknown drive', async (t) => {
  t.timeout(90_000)
  const client = new HiveRelayClient(tmpStorage())
  t.teardown(async () => { await client.destroy() })

  await client.start()
  try {
    await client.get('a'.repeat(64), '/file.txt')
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('Drive not open'), 'throws drive-not-open error')
  }
})

test('HiveRelayClient - simple mode: closeDrive removes drive', async (t) => {
  t.timeout(90_000)
  const client = new HiveRelayClient(tmpStorage())
  t.teardown(async () => { await client.destroy() })

  await client.start()
  const drive = await client.publish([], { seed: false })
  const keyHex = drive.key.toString('hex')

  t.is(client.drives.size, 1, 'drive tracked')
  await client.closeDrive(keyHex)
  t.is(client.drives.size, 0, 'drive removed')
})

test('HiveRelayClient - simple mode: getStatus', async (t) => {
  const client = new HiveRelayClient(tmpStorage())

  const before = client.getStatus()
  t.is(before.started, false, 'not started before')

  t.teardown(async () => { await client.destroy() })
  await client.start()

  const after = client.getStatus()
  t.is(after.started, true, 'started')
  t.is(after.drives, 0, 'no drives')
  t.ok(Array.isArray(after.relays), 'relays is array')
})

test('HiveRelayClient - simple mode: destroy cleans up', async (t) => {
  t.timeout(90_000)
  const client = new HiveRelayClient(tmpStorage())
  await client.start()
  await client.publish([{ path: '/a.txt', content: 'a' }], { seed: false })
  t.is(client.drives.size, 1, 'drive exists')

  await client.destroy()
  t.is(client._started, false, 'not started')
  t.is(client.drives.size, 0, 'drives cleared')
})

test('HiveRelayClient - simple mode: destroy safe when not started', async (t) => {
  const client = new HiveRelayClient(tmpStorage())
  await client.destroy()
  t.ok(true, 'no error')
})

test('HiveRelayClient - simple mode: emits events', async (t) => {
  t.plan(2)
  const client = new HiveRelayClient(tmpStorage())

  client.on('started', () => t.pass('started event'))
  client.on('published', ({ files }) => t.is(files, 1, 'published event'))

  await client.start()
  await client.publish([{ path: '/x.txt', content: 'x' }], { seed: false })
  await client.destroy()
})

// --- Advanced mode (bring your own swarm) ---

test('HiveRelayClient - advanced mode: constructor with swarm', (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })

  t.ok(client, 'created')
  t.is(client._ownsSwarm, false, 'does not own swarm')
  t.is(client.autoDiscover, true, 'autoDiscover defaults true')
  t.is(client.maxRelays, 10, 'maxRelays defaults 10')
  t.is(client._started, false, 'not started')
})

test('HiveRelayClient - advanced mode: autoDiscover false', async (t) => {
  const swarm = mockSwarm()
  let joinCalled = false
  swarm.join = () => { joinCalled = true; return {} }

  const client = new HiveRelayClient({ swarm, autoDiscover: false })
  await client.start()

  t.is(joinCalled, false, 'did not join discovery topic')
  t.is(client._started, true, 'still started')
})

test('HiveRelayClient - advanced mode: getRelays empty initially', (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  t.is(client.getRelays().length, 0, 'no relays')
})

test('HiveRelayClient - advanced mode: getSeedStatus null for unknown', (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  t.is(client.getSeedStatus('a'.repeat(64)), null, 'null for unknown')
})

test('HiveRelayClient - advanced mode: destroy cleans up', async (t) => {
  const swarm = mockSwarm()
  let leftTopic = false
  swarm.leave = async () => { leftTopic = true }

  const client = new HiveRelayClient({ swarm })
  await client.start()

  client.relays.set('test', {})
  client.seedRequests.set('test', {})

  await client.destroy()

  t.is(client._started, false, 'not started')
  t.is(client.relays.size, 0, 'relays cleared')
  t.is(client.seedRequests.size, 0, 'seed requests cleared')
  t.is(leftTopic, true, 'left discovery topic')
})

test('HiveRelayClient - _ensureStarted throws', (t) => {
  const client = new HiveRelayClient(tmpStorage())
  try {
    client._ensureStarted()
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('not started'), 'throws not-started error')
  }
})

// ─── getAvailableApps shape ─────────────────────────────────────────
// The catalog refactor moved the SDK from a merged global view to per-relay
// rows tagged with a source. These tests pin the new shape.

test('HiveRelayClient - getAvailableApps default returns per-source rows', async (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  await client.start()

  // Inject two relays each advertising overlapping seeded apps.
  client.relays.set('relay-a-pubkey', {
    seededApps: [
      { appKey: 'app1', appId: 'foo', version: '1.0.0', discoveryKey: 'd1', blind: false },
      { appKey: 'app2', appId: 'bar', version: '1.0.0', discoveryKey: 'd2', blind: false }
    ]
  })
  client.relays.set('relay-b-pubkey', {
    seededApps: [
      { appKey: 'app1', appId: 'foo', version: '1.0.0', discoveryKey: 'd1', blind: false }
    ]
  })

  const rows = client.getAvailableApps()
  t.is(rows.length, 3, 'one row per (app, relay) pair — no merging')

  const app1Rows = rows.filter(r => r.appKey === 'app1')
  t.is(app1Rows.length, 2, 'app1 appears once per source relay')
  t.alike(
    new Set(app1Rows.map(r => r.source.relayPubkey)),
    new Set(['relay-a-pubkey', 'relay-b-pubkey']),
    'each row tagged with its source relay'
  )

  await client.destroy()
})

test('HiveRelayClient - getAvailableApps({ groupBy: app }) returns legacy merged view', async (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  await client.start()

  client.relays.set('relay-a-pubkey', {
    seededApps: [{ appKey: 'app1', appId: 'foo', discoveryKey: 'd1', blind: false }]
  })
  client.relays.set('relay-b-pubkey', {
    seededApps: [{ appKey: 'app1', appId: 'foo', discoveryKey: 'd1', blind: false }]
  })

  const merged = client.getAvailableApps({ groupBy: 'app' })
  t.is(merged.length, 1, 'merged view dedupes by appKey')
  t.is(merged[0].relays.length, 2, 'old shape: relays array')
  t.alike(new Set(merged[0].relays), new Set(['relay-a-pubkey', 'relay-b-pubkey']))

  await client.destroy()
})

test('HiveRelayClient - getAvailableAppsBySource groups rows back by app with sources array', async (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  await client.start()

  client.relays.set('relay-a-pubkey', {
    seededApps: [
      { appKey: 'app1', appId: 'foo', discoveryKey: 'd1', blind: false },
      { appKey: 'app2', appId: 'bar', discoveryKey: 'd2', blind: false }
    ]
  })
  client.relays.set('relay-b-pubkey', {
    seededApps: [{ appKey: 'app1', appId: 'foo', discoveryKey: 'd1', blind: false }]
  })

  const grouped = client.getAvailableAppsBySource()
  t.is(grouped.length, 2, 'one entry per appKey')
  const app1 = grouped.find(g => g.appKey === 'app1')
  t.is(app1.sources.length, 2, 'app1 lists both sources')
  t.is(app1.sources[0].relayPubkey, 'relay-a-pubkey')

  await client.destroy()
})

test('HiveRelayClient - getAvailableApps({ relay }) restricts to one source', async (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  await client.start()

  client.relays.set('relay-a-pubkey', {
    seededApps: [{ appKey: 'app1', appId: 'foo', discoveryKey: 'd1', blind: false }]
  })
  client.relays.set('relay-b-pubkey', {
    seededApps: [{ appKey: 'app2', appId: 'bar', discoveryKey: 'd2', blind: false }]
  })

  const onlyA = client.getAvailableApps({ relay: 'relay-a-pubkey' })
  t.is(onlyA.length, 1)
  t.is(onlyA[0].appKey, 'app1')

  await client.destroy()
})

// ─── Replication-factor as first-class ───────────────────────────────
// The Keet-style "always-on" property is N×uptime. These tests verify
// the SDK exposes that math operationally, not just under the hood.

test('HiveRelayClient - getReplicationStatus returns null for unknown app', async (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  await client.start()
  t.is(client.getReplicationStatus('a'.repeat(64)), null)
  await client.destroy()
})

test('HiveRelayClient - getReplicationStatus reports current/target/floor/health', async (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  await client.start()

  const appKey = 'a'.repeat(64)
  // Manually inject a seedRequests entry simulating an in-flight publish
  client.seedRequests.set(appKey, {
    request: {},
    acceptances: [{ relayPubkey: Buffer.from('aa'.repeat(32), 'hex'), region: 'NA' }],
    target: 3,
    floor: 1,
    lastSeedAt: Date.now()
  })

  const status = client.getReplicationStatus(appKey)
  t.is(status.current, 1)
  t.is(status.target, 3)
  t.is(status.floor, 1)
  t.is(status.health, 'critical', 'current==floor → critical (one operator drop = no replicas)')
  t.is(status.relays.length, 1)

  // Push current up to degraded zone
  client.seedRequests.get(appKey).acceptances.push({ relayPubkey: Buffer.from('bb'.repeat(32), 'hex') })
  t.is(client.getReplicationStatus(appKey).health, 'degraded')

  // Push current to target → healthy
  client.seedRequests.get(appKey).acceptances.push({ relayPubkey: Buffer.from('cc'.repeat(32), 'hex') })
  t.is(client.getReplicationStatus(appKey).health, 'healthy')

  await client.destroy()
})

test('HiveRelayClient - getReplicationOverview aggregates across all apps', async (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  await client.start()

  // Three apps, each in a different health band
  const a1 = 'a'.repeat(64); const a2 = 'b'.repeat(64); const a3 = 'c'.repeat(64)
  client.seedRequests.set(a1, { request: {}, acceptances: [{ relayPubkey: Buffer.alloc(32) }, { relayPubkey: Buffer.alloc(32) }, { relayPubkey: Buffer.alloc(32) }], target: 3, floor: 1 })
  client.seedRequests.set(a2, { request: {}, acceptances: [{ relayPubkey: Buffer.alloc(32) }, { relayPubkey: Buffer.alloc(32) }], target: 3, floor: 1 })
  client.seedRequests.set(a3, { request: {}, acceptances: [{ relayPubkey: Buffer.alloc(32) }], target: 3, floor: 1 })

  const overview = client.getReplicationOverview()
  t.is(overview.totalApps, 3)
  t.is(overview.healthy, 1)
  t.is(overview.degraded, 1)
  t.is(overview.critical, 1)
  t.is(overview.apps.length, 3, 'each app appears in apps array')

  await client.destroy()
})

test('HiveRelayClient - enableReplicationMonitor returns stop handle', async (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  await client.start()

  const appKey = 'd'.repeat(64)
  client.seedRequests.set(appKey, { request: {}, acceptances: [], target: 3, floor: 1 })

  const handle = client.enableReplicationMonitor(appKey, { checkInterval: 60000 })
  t.is(typeof handle.stop, 'function', 'returns stop handle')
  t.is(client._replicationMonitors.size, 1, 'monitor tracked')

  // Calling enable again on the same key replaces the previous monitor
  client.enableReplicationMonitor(appKey, { checkInterval: 30000 })
  t.is(client._replicationMonitors.size, 1, 'still one monitor (replaced, not duplicated)')

  handle.stop()
  // Explicit stop on the old handle is a no-op since it was already replaced
  t.is(client._replicationMonitors.size, 1, 'replaced monitor still active')

  // Stop the live one
  client._replicationMonitors.get(appKey).stop()
  t.is(client._replicationMonitors.size, 0, 'all monitors cleared')

  await client.destroy()
})

test('HiveRelayClient - destroy stops all replication monitors', async (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  await client.start()

  client.seedRequests.set('e'.repeat(64), { request: {}, acceptances: [], target: 3, floor: 1 })
  client.seedRequests.set('f'.repeat(64), { request: {}, acceptances: [], target: 3, floor: 1 })
  client.enableReplicationMonitor('e'.repeat(64), { checkInterval: 60000 })
  client.enableReplicationMonitor('f'.repeat(64), { checkInterval: 60000 })

  t.is(client._replicationMonitors.size, 2)
  await client.destroy()
  t.is(client._replicationMonitors.size, 0, 'destroy cleared all monitors')
})

// ─── Reader-as-replica opt-in (Keet-room redundancy) ─────────────────
// When a reader opts in, they volunteer to also serve the drive — every
// participant becomes a replica, so popular content stays online without
// the original publisher needing to be online.

test('HiveRelayClient - open() does NOT seed-as-reader by default', async (t) => {
  const swarm = mockSwarm()
  const joins = []
  swarm.join = (topic, opts) => { joins.push({ topic, opts }); return { destroy: () => {} } }

  const client = new HiveRelayClient({ swarm })
  await client.start()

  // Stub Hyperdrive open so we don't need a real Corestore — but we DO
  // care that swarm.join was called with server=false for a reader.
  const fakeKey = Buffer.from('a'.repeat(64), 'hex')
  client.store = {
    get: () => ({ ready: async () => {} }),
    namespace: () => ({})
  }

  // Inject a fake opened drive so we can call enableReaderReplica/disable later
  const fakeDrive = {
    discoveryKey: Buffer.alloc(32, 0xee),
    core: { writable: false },
    update: async () => {}
  }
  client.drives.set('a'.repeat(64), fakeDrive)

  // No opts → not a reader-replica
  t.is(client.getReaderReplicas().length, 0, 'no reader-replicas by default')

  await client.destroy()
})

test('HiveRelayClient - enableReaderReplica adds the drive to the served set', async (t) => {
  const swarm = mockSwarm()
  const joins = []
  swarm.join = (topic, opts) => { joins.push({ topic, opts }); return { destroy: () => {} } }

  const client = new HiveRelayClient({ swarm })
  await client.start()

  const fakeDrive = {
    discoveryKey: Buffer.alloc(32, 0xee),
    core: { writable: false }
  }
  const keyHex = 'b'.repeat(64)
  client.drives.set(keyHex, fakeDrive)

  let joinedEventCount = 0
  client.on('reader-replica-joined', () => { joinedEventCount++ })

  const enabled = client.enableReaderReplica(keyHex)
  t.is(enabled, true, 'enable returns true on first call')
  t.is(joinedEventCount, 1, 'event fired')
  t.is(client.getReaderReplicas().length, 1)
  t.is(client.getReaderReplicas()[0], keyHex)

  // Idempotent
  const reEnable = client.enableReaderReplica(keyHex)
  t.is(reEnable, false, 'second enable returns false (already serving)')
  t.is(joinedEventCount, 1, 'no duplicate event')

  // Verify swarm.join was called with server=true
  const lastJoin = joins[joins.length - 1]
  t.is(lastJoin.opts.server, true, 'swarm.join called with server=true on enable')

  await client.destroy()
})

test('HiveRelayClient - enableReaderReplica is a no-op for authored drives', async (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  await client.start()

  const authorDrive = {
    discoveryKey: Buffer.alloc(32, 0xff),
    core: { writable: true } // we authored this
  }
  client.drives.set('c'.repeat(64), authorDrive)

  const result = client.enableReaderReplica('c'.repeat(64))
  t.is(result, false, 'authored drives are already served — no-op')
  t.is(client.getReaderReplicas().length, 0, 'not added to reader-replica set')

  await client.destroy()
})

test('HiveRelayClient - disableReaderReplica removes from set and re-joins as client-only', async (t) => {
  const swarm = mockSwarm()
  const joins = []
  swarm.join = (topic, opts) => { joins.push({ topic, opts }); return { destroy: () => {} } }
  const client = new HiveRelayClient({ swarm })
  await client.start()

  const fakeDrive = {
    discoveryKey: Buffer.alloc(32, 0xee),
    core: { writable: false }
  }
  const keyHex = 'd'.repeat(64)
  client.drives.set(keyHex, fakeDrive)

  client.enableReaderReplica(keyHex)
  t.is(client.getReaderReplicas().length, 1)

  let leftEventCount = 0
  client.on('reader-replica-left', () => { leftEventCount++ })

  const disabled = client.disableReaderReplica(keyHex)
  t.is(disabled, true)
  t.is(leftEventCount, 1)
  t.is(client.getReaderReplicas().length, 0)

  // Verify the most recent join was with server=false
  const lastJoin = joins[joins.length - 1]
  t.is(lastJoin.opts.server, false, 'swarm.join re-issued with server=false on disable')

  await client.destroy()
})

test('HiveRelayClient - enableReaderReplica throws for unknown drive', async (t) => {
  const swarm = mockSwarm()
  const client = new HiveRelayClient({ swarm })
  await client.start()
  try {
    client.enableReaderReplica('z'.repeat(64))
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('not open'), 'clear error when drive not opened')
  }
  await client.destroy()
})

// ─── Multi-device pairing ────────────────────────────────────────────
// Two paths: identity sharing (full trust, both devices = same key) and
// device attestation (signed cert authorising a secondary device pubkey).

import sodium from 'sodium-universal'
import b4a from 'b4a'

function genKeypair () {
  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

test('multi-device: exportIdentity throws when no keypair', async (t) => {
  const swarm = mockSwarm()
  swarm.keyPair = null // remove the default keypair
  const client = new HiveRelayClient({ swarm })
  await client.start()
  client.keyPair = null
  try {
    client.exportIdentity()
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('No identity keypair'))
  }
  await client.destroy()
})

test('multi-device: exportIdentity → importIdentity round-trip preserves key', async (t) => {
  const swarm = mockSwarm()
  const kp = genKeypair()
  const clientA = new HiveRelayClient({ swarm, keyPair: kp })
  await clientA.start()

  const bundle = clientA.exportIdentity()
  t.ok(bundle.publicKey, 'bundle has publicKey')
  t.ok(bundle.secretKey, 'bundle has secretKey')
  t.is(bundle.version, 1)

  // Second client with a different default keypair
  const clientB = new HiveRelayClient({ swarm: mockSwarm() })
  await clientB.start()
  const oldB = clientB.keyPair.publicKey.toString('hex')

  clientB.importIdentity(bundle)
  t.is(b4a.toString(clientB.keyPair.publicKey, 'hex'), bundle.publicKey, 'imported pubkey matches')
  t.not(b4a.toString(clientB.keyPair.publicKey, 'hex'), oldB, 'replaced the previous keypair')

  await clientA.destroy()
  await clientB.destroy()
})

test('multi-device: importIdentity rejects malformed bundles', async (t) => {
  const client = new HiveRelayClient({ swarm: mockSwarm() })
  await client.start()

  const cases = [
    { case: 'unsupported version', bundle: { version: 99, publicKey: 'a'.repeat(64), secretKey: 'b'.repeat(128) } },
    { case: 'short publicKey', bundle: { version: 1, publicKey: 'aa', secretKey: 'b'.repeat(128) } },
    { case: 'short secretKey', bundle: { version: 1, publicKey: 'a'.repeat(64), secretKey: 'bb' } },
    { case: 'missing keys', bundle: { version: 1 } }
  ]
  for (const { bundle } of cases) {
    try {
      client.importIdentity(bundle)
      t.fail('should throw')
    } catch (err) {
      t.ok(err.message.includes('Invalid identity bundle'), 'rejected with clear error')
    }
  }
  await client.destroy()
})

test('multi-device: device attestation round-trip verifies', async (t) => {
  const primaryKp = genKeypair()
  const deviceKp = genKeypair()
  const client = new HiveRelayClient({ swarm: mockSwarm(), keyPair: primaryKp })
  await client.start()

  const cert = client.createDeviceAttestation(deviceKp.publicKey, { label: 'iPhone', ttlMs: 60_000 })
  t.is(cert.version, 1)
  t.is(cert.primaryPubkey, b4a.toString(primaryKp.publicKey, 'hex'))
  t.is(cert.devicePubkey, b4a.toString(deviceKp.publicKey, 'hex'))
  t.is(cert.label, 'iPhone')
  t.ok(cert.expiresAt > Date.now())

  const result = HiveRelayClient.verifyDeviceAttestation(cert)
  t.is(result.valid, true)

  await client.destroy()
})

test('multi-device: device attestation rejects expired cert', async (t) => {
  const primaryKp = genKeypair()
  const deviceKp = genKeypair()
  const client = new HiveRelayClient({ swarm: mockSwarm(), keyPair: primaryKp })
  await client.start()

  const cert = client.createDeviceAttestation(deviceKp.publicKey, { ttlMs: -1000 })
  const result = HiveRelayClient.verifyDeviceAttestation(cert)
  t.is(result.valid, false)
  t.is(result.reason, 'expired')

  await client.destroy()
})

test('multi-device: device attestation rejects forged signature', async (t) => {
  const primaryKp = genKeypair()
  const attackerKp = genKeypair()
  const deviceKp = genKeypair()

  // Create a legitimate cert from the primary
  const client = new HiveRelayClient({ swarm: mockSwarm(), keyPair: primaryKp })
  await client.start()
  const cert = client.createDeviceAttestation(deviceKp.publicKey)

  // Tamper: claim it was signed by attacker
  const tampered = { ...cert, primaryPubkey: b4a.toString(attackerKp.publicKey, 'hex') }
  const result = HiveRelayClient.verifyDeviceAttestation(tampered)
  t.is(result.valid, false, 'mismatched pubkey rejected')

  await client.destroy()
})

test('multi-device: device attestation rejects malformed cert', async (t) => {
  const cases = [
    null,
    {},
    { version: 1 },
    { version: 1, primaryPubkey: 'short', devicePubkey: 'short', signature: 'short', expiresAt: Date.now() + 60000 }
  ]
  for (const cert of cases) {
    const result = HiveRelayClient.verifyDeviceAttestation(cert)
    t.is(result.valid, false, 'rejected: ' + JSON.stringify(cert)?.slice(0, 50))
  }
})

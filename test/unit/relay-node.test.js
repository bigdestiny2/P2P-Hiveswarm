import test from 'brittle'
import { RelayNode } from '../../core/relay-node/index.js'
import path from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'

function tmpStorage () {
  return path.join(tmpdir(), 'hiverelay-test-' + randomBytes(8).toString('hex'))
}

test('RelayNode - creates and starts', async (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false })
  t.ok(node, 'node created')
  t.is(node.running, false, 'not running initially')

  await node.start()
  t.is(node.running, true, 'running after start')

  const stats = node.getStats()
  t.ok(stats.publicKey, 'has public key')
  t.is(stats.seededApps, 0, 'no seeded apps initially')
  t.is(stats.connections, 0, 'no connections initially')

  await node.stop()
  t.is(node.running, false, 'stopped')
})

test('RelayNode - getStats returns expected shape', async (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false })
  await node.start()

  const stats = node.getStats()
  t.ok(typeof stats.publicKey === 'string')
  t.ok(typeof stats.seededApps === 'number')
  t.ok(typeof stats.connections === 'number')
  t.ok(stats.relay !== null)
  t.ok(stats.seeder !== null)
  t.ok(stats.payment && stats.payment.experimental === true)
  t.ok(stats.distributedDrive && typeof stats.distributedDrive.enabled === 'boolean')

  await node.stop()
})

test('RelayNode - _onConnection attaches distributed-drive peer bridge', async (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false })
  const remotePub = randomBytes(32)
  const fakeConn = new EventEmitter()
  fakeConn.remotePublicKey = remotePub
  fakeConn.destroy = () => {}

  const calls = []
  node.distributedDriveBridge = {
    addPeer (conn, meta) {
      calls.push({ conn, meta })
      return {}
    }
  }

  const origReplicate = node.store.replicate
  node.store.replicate = () => {}

  node._onConnection(fakeConn, { publicKey: remotePub })

  t.is(calls.length, 1, 'bridge addPeer called once')
  t.is(calls[0].meta.remotePubKey, remotePub.toString('hex'), 'remote key forwarded')
  t.is(node.connections.size, 1, 'connection tracked')

  fakeConn.emit('close')
  t.is(node.connections.size, 0, 'connection removed on close')

  node.store.replicate = origReplicate
})

test('RelayNode - emits started event with publicKey', async (t) => {
  t.plan(1)
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false })

  node.on('started', ({ publicKey }) => {
    t.ok(publicKey, 'publicKey emitted')
  })

  await node.start()
  await node.stop()
})

test('RelayNode - applyMode updates mode profile config', async (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false })
  t.is(node.mode, 'public')

  await node.applyMode('homehive')
  t.is(node.mode, 'homehive')
  t.is(node.config.access.open, false)
  t.is(node.config.pairing.enabled, true)
  t.is(node.config.maxConnections, 32)
})

test('RelayNode - replication health monitor attempts local repair', async (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false, enableServices: false })
  const appKey = 'a'.repeat(64)
  const accepted = []
  const seeded = []

  node.swarm = { keyPair: { publicKey: randomBytes(32) } }
  node.seeder = { totalBytesStored: 0 }
  node.config.enableSeeding = true
  node.config.registryAutoAccept = true
  node.config.replicationRepairEnabled = true
  node.config.targetReplicaFloor = 2

  node.seedingRegistry = {
    async getActiveRequests () {
      return [{
        appKey,
        replicationFactor: 2,
        maxStorageBytes: 0,
        publisherPubkey: 'b'.repeat(64),
        privacyTier: 'public'
      }]
    },
    async getRelaysForApp () { return [] },
    async recordAcceptance (key, relayPubkey, region) {
      accepted.push({ key, relayPubkey, region })
    }
  }

  node.seedApp = async (key, opts) => {
    seeded.push({ key, opts })
    node.seededApps.set(key, { startedAt: Date.now() })
    return { discoveryKey: 'd'.repeat(64) }
  }

  await node._checkReplicationHealth()

  t.is(seeded.length, 1, 'under-replicated app seeded locally')
  t.is(accepted.length, 1, 'acceptance recorded after repair')
  t.ok(node._replicationHealth.has(appKey), 'replication health entry recorded')
})

test('RelayNode - seedApp enforces strict replicate-user-data policy by default', async (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false })
  node.seeder = { totalBytesStored: 0 }

  let operation = null
  node.policyGuard = {
    check (_appKey, _tier, op) {
      operation = op
      return { allowed: false, reason: 'blocked by test policy' }
    }
  }

  try {
    await node.seedApp('c'.repeat(64), { privacyTier: 'local-first' })
    t.fail('expected policy violation')
  } catch (err) {
    t.ok(err.message.includes('POLICY_VIOLATION'))
  }
  t.is(operation, 'replicate-user-data')
})

test('RelayNode - seedApp can use serve-code policy when strict mode disabled', async (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false })
  node.seeder = { totalBytesStored: 0 }
  node.config.strictSeedingPrivacy = false

  let operation = null
  node.policyGuard = {
    check (_appKey, _tier, op) {
      operation = op
      return { allowed: false, reason: 'blocked by test policy' }
    }
  }

  try {
    await node.seedApp('d'.repeat(64), { privacyTier: 'local-first' })
    t.fail('expected policy violation')
  } catch (err) {
    t.ok(err.message.includes('POLICY_VIOLATION'))
  }
  t.is(operation, 'serve-code')
})

test('RelayNode - seedApp keeps replicate-user-data policy for drive type when strict mode disabled', async (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false })
  node.seeder = { totalBytesStored: 0 }
  node.config.strictSeedingPrivacy = false

  let operation = null
  node.policyGuard = {
    check (_appKey, _tier, op) {
      operation = op
      return { allowed: false, reason: 'blocked by test policy' }
    }
  }

  try {
    await node.seedApp('f'.repeat(64), { type: 'drive', privacyTier: 'local-first' })
    t.fail('expected policy violation')
  } catch (err) {
    t.ok(err.message.includes('POLICY_VIOLATION'))
  }
  t.is(operation, 'replicate-user-data')
})

test('RelayNode - replication repair skips non-public tiers in strict privacy mode', async (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false, enableServices: false })
  const appKey = 'e'.repeat(64)
  const seeded = []

  node.swarm = { keyPair: { publicKey: randomBytes(32) } }
  node.seeder = { totalBytesStored: 0 }
  node.config.enableSeeding = true
  node.config.registryAutoAccept = true
  node.config.replicationRepairEnabled = true
  node.config.strictSeedingPrivacy = true

  node.seedingRegistry = {
    async getActiveRequests () {
      return [{
        appKey,
        replicationFactor: 2,
        maxStorageBytes: 0,
        publisherPubkey: 'f'.repeat(64),
        privacyTier: 'local-first'
      }]
    },
    async getRelaysForApp () { return [] },
    async recordAcceptance () {}
  }

  node.seedApp = async (key) => {
    seeded.push(key)
    return { discoveryKey: 'a'.repeat(64) }
  }

  await node._checkReplicationHealth()

  t.is(seeded.length, 0, 'non-public tier request not auto-repaired in strict mode')
  t.ok(node._replicationHealth.has(appKey), 'health still tracked for skipped request')
})

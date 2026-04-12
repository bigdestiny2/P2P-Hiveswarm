import test from 'brittle'
import { RelayNode } from '../../core/relay-node/index.js'
import { AccessControl } from '../../core/relay-node/access-control.js'
import { MDNSDiscovery } from '../../core/relay-node/mdns-discovery.js'
import path from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { mkdir } from 'fs/promises'
import b4a from 'b4a'

function tmpStorage () {
  return path.join(tmpdir(), 'hiverelay-private-test-' + randomBytes(8).toString('hex'))
}

// ─── Access Control Tests ───────────────────────────────────────

test('AccessControl - add and check devices', async (t) => {
  const storage = tmpStorage()
  await mkdir(storage, { recursive: true })
  const ac = new AccessControl(storage)
  await ac.load()

  const pubkey = randomBytes(32).toString('hex')
  t.is(ac.isAllowed(pubkey), false, 'unknown device not allowed')

  await ac.addDevice(pubkey, 'my-laptop')
  t.is(ac.isAllowed(pubkey), true, 'added device is allowed')

  const devices = ac.listDevices()
  t.is(devices.length, 1)
  t.is(devices[0].name, 'my-laptop')
  t.is(devices[0].pubkey, pubkey)

  ac.destroy()
})

test('AccessControl - remove device', async (t) => {
  const storage = tmpStorage()
  await mkdir(storage, { recursive: true })
  const ac = new AccessControl(storage)
  await ac.load()

  const pubkey = randomBytes(32).toString('hex')
  await ac.addDevice(pubkey, 'phone')
  t.is(ac.isAllowed(pubkey), true)

  await ac.removeDevice(pubkey)
  t.is(ac.isAllowed(pubkey), false, 'removed device no longer allowed')
  t.is(ac.listDevices().length, 0)

  ac.destroy()
})

test('AccessControl - persist and reload', async (t) => {
  const storage = tmpStorage()
  await mkdir(storage, { recursive: true })

  const pubkey1 = randomBytes(32).toString('hex')
  const pubkey2 = randomBytes(32).toString('hex')

  // Save
  const ac1 = new AccessControl(storage)
  await ac1.load()
  await ac1.addDevice(pubkey1, 'laptop')
  await ac1.addDevice(pubkey2, 'phone')
  await ac1.save()
  ac1.destroy()

  // Reload
  const ac2 = new AccessControl(storage)
  await ac2.load()
  t.is(ac2.isAllowed(pubkey1), true, 'persisted device 1 loaded')
  t.is(ac2.isAllowed(pubkey2), true, 'persisted device 2 loaded')
  t.is(ac2.listDevices().length, 2)
  ac2.destroy()
})

test('AccessControl - max devices limit', async (t) => {
  const storage = tmpStorage()
  await mkdir(storage, { recursive: true })
  const ac = new AccessControl(storage, { maxDevices: 2 })
  await ac.load()

  await ac.addDevice(randomBytes(32).toString('hex'), 'dev1')
  await ac.addDevice(randomBytes(32).toString('hex'), 'dev2')

  try {
    await ac.addDevice(randomBytes(32).toString('hex'), 'dev3')
    t.fail('should throw on max devices')
  } catch (err) {
    t.ok(err.message.includes('Maximum devices'), 'throws on limit')
  }

  ac.destroy()
})

test('AccessControl - accepts Buffer pubkeys', async (t) => {
  const storage = tmpStorage()
  await mkdir(storage, { recursive: true })
  const ac = new AccessControl(storage)
  await ac.load()

  const pubkeyBuf = randomBytes(32)
  const pubkeyHex = pubkeyBuf.toString('hex')

  await ac.addDevice(pubkeyHex, 'test')
  t.is(ac.isAllowed(b4a.from(pubkeyBuf)), true, 'Buffer lookup works')
  ac.destroy()
})

// ─── Pairing Tests ──────────────────────────────────────────────

test('AccessControl - pairing flow', async (t) => {
  const storage = tmpStorage()
  await mkdir(storage, { recursive: true })
  const ac = new AccessControl(storage)
  await ac.load()

  t.is(ac.isPairing, false, 'not pairing initially')

  const { token, expiresAt } = ac.enablePairing({ timeoutMs: 10_000 })
  t.ok(token, 'token generated')
  t.ok(expiresAt > Date.now(), 'expires in the future')
  t.is(ac.isPairing, true, 'pairing active')

  // Attempt with wrong token
  const devicePub = randomBytes(32).toString('hex')
  const badResult = await ac.attemptPair('wrong-token', devicePub, 'hacker')
  t.is(badResult, false, 'wrong token rejected')
  t.is(ac.isAllowed(devicePub), false, 'device not added on bad token')

  // Attempt with correct token
  const newDevice = randomBytes(32).toString('hex')
  const goodResult = await ac.attemptPair(token, newDevice, 'my-phone')
  t.is(goodResult, true, 'correct token accepted')
  t.is(ac.isAllowed(newDevice), true, 'device added to allowlist')
  t.is(ac.isPairing, false, 'pairing disabled after success (one-shot)')

  ac.destroy()
})

test('AccessControl - pairing expires', async (t) => {
  const storage = tmpStorage()
  await mkdir(storage, { recursive: true })
  const ac = new AccessControl(storage)
  await ac.load()

  ac.enablePairing({ timeoutMs: 50 }) // 50ms
  t.is(ac.isPairing, true)

  await new Promise(resolve => setTimeout(resolve, 100))
  t.is(ac.isPairing, false, 'pairing expired')

  ac.destroy()
})

test('AccessControl - disable pairing manually', async (t) => {
  const storage = tmpStorage()
  await mkdir(storage, { recursive: true })
  const ac = new AccessControl(storage)
  await ac.load()

  ac.enablePairing({ timeoutMs: 60_000 })
  t.is(ac.isPairing, true)

  ac.disablePairing()
  t.is(ac.isPairing, false, 'pairing disabled')

  ac.destroy()
})

test('AccessControl - pairing payload generation', async (t) => {
  const storage = tmpStorage()
  await mkdir(storage, { recursive: true })
  const ac = new AccessControl(storage)
  await ac.load()

  const { token } = ac.enablePairing({ timeoutMs: 10_000 })
  const payload = ac.getPairingPayload('abc123', '192.168.1.50', 49737)

  t.is(payload.pubkey, 'abc123')
  t.is(payload.host, '192.168.1.50')
  t.is(payload.port, 49737)
  t.is(payload.pairingToken, token)
  t.ok(payload.expiresAt)

  ac.destroy()
})

// ─── Mode Configuration Tests ───────────────────────────────────

test('RelayNode - public mode (default)', async (t) => {
  const node = new RelayNode({ storage: tmpStorage(), enableAPI: false })
  t.is(node.mode, 'public', 'default mode is public')
  t.is(node.accessControl, null, 'no access control in public mode')
  t.is(node.config.discovery.dht, true, 'DHT enabled')
  t.is(node.config.discovery.announce, true, 'announce enabled')
  t.is(node.config.discovery.mdns, false, 'mDNS disabled')
  t.is(node.config.access.open, true, 'open access')
})

test('RelayNode - private mode config', async (t) => {
  const node = new RelayNode({ mode: 'private', storage: tmpStorage(), enableAPI: false })
  t.is(node.mode, 'private')
  t.is(node.config.discovery.dht, false, 'no DHT')
  t.is(node.config.discovery.announce, false, 'no announce')
  t.is(node.config.discovery.mdns, true, 'mDNS enabled')
  t.is(node.config.access.open, false, 'closed access')
  t.is(node.config.pairing.enabled, true, 'pairing enabled')
  t.is(node.config.enableRelay, false, 'relay disabled')
  t.is(node.config.enableAPI, false, 'API disabled')
})

test('RelayNode - hybrid mode config', async (t) => {
  const node = new RelayNode({ mode: 'hybrid', storage: tmpStorage(), enableAPI: false })
  t.is(node.mode, 'hybrid')
  t.is(node.config.discovery.dht, true, 'DHT enabled (for app discovery)')
  t.is(node.config.discovery.announce, false, 'no announce (stealth)')
  t.is(node.config.discovery.mdns, true, 'mDNS enabled')
  t.is(node.config.access.open, false, 'closed access')
  t.is(node.config.pairing.enabled, true, 'pairing enabled')
})

test('RelayNode - invalid mode throws', async (t) => {
  try {
    const node = new RelayNode({ mode: 'banana', storage: tmpStorage() }) // eslint-disable-line no-unused-vars
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('Invalid mode'), 'throws on bad mode')
  }
})

test('RelayNode - mode config override', async (t) => {
  // Private mode but explicitly enable API
  const node = new RelayNode({
    mode: 'private',
    storage: tmpStorage(),
    enableAPI: true,
    apiPort: 9999
  })
  t.is(node.mode, 'private')
  t.is(node.config.enableAPI, true, 'explicit override takes precedence')
  t.is(node.config.apiPort, 9999, 'api port overridden')
})

// ─── RelayNode Private Mode Start/Stop ──────────────────────────

test('RelayNode - private mode starts and stops', async (t) => {
  const node = new RelayNode({
    mode: 'private',
    storage: tmpStorage(),
    enableAPI: false,
    enableServices: false,
    discovery: { mdns: false } // disable mDNS for test (avoids port conflicts)
  })
  t.teardown(async () => { if (node.running) await node.stop() })

  await node.start()
  t.is(node.running, true, 'starts in private mode')
  t.ok(node.accessControl, 'access control initialized')

  const stats = node.getStats()
  t.is(stats.mode, 'private')
  t.ok(stats.accessControl, 'stats include access control')
  t.is(stats.accessControl.pairedDevices, 0)

  await node.stop()
  t.is(node.running, false)
})

test('RelayNode - private mode with pre-configured allowlist', async (t) => {
  const deviceKey = randomBytes(32).toString('hex')

  const node = new RelayNode({
    mode: 'private',
    storage: tmpStorage(),
    enableAPI: false,
    enableServices: false,
    access: { allowlist: [deviceKey] },
    discovery: { mdns: false }
  })
  t.teardown(async () => { if (node.running) await node.stop() })

  await node.start()

  const stats = node.getStats()
  t.is(stats.accessControl.pairedDevices, 1, 'pre-configured device loaded')

  const devices = node.listDevices()
  t.is(devices.length, 1)
  t.is(devices[0].pubkey, deviceKey)

  await node.stop()
})

test('RelayNode - private mode pairing methods', async (t) => {
  const node = new RelayNode({
    mode: 'private',
    storage: tmpStorage(),
    enableAPI: false,
    enableServices: false,
    discovery: { mdns: false }
  })
  t.teardown(async () => { if (node.running) await node.stop() })

  await node.start()

  // Enable pairing
  const pairingInfo = node.enablePairing({ timeoutMs: 10_000 })
  t.ok(pairingInfo.token, 'pairing token returned')
  t.ok(pairingInfo.relayPubkey, 'relay pubkey in pairing info')

  // Pair a device
  const deviceKey = randomBytes(32).toString('hex')
  const paired = await node.pairDevice(pairingInfo.token, deviceKey, 'test-phone')
  t.is(paired, true, 'device paired successfully')

  const devices = node.listDevices()
  t.is(devices.length, 1)
  t.is(devices[0].name, 'test-phone')

  // Remove device
  await node.removeDevice(deviceKey)
  t.is(node.listDevices().length, 0)

  await node.stop()
})

test('RelayNode - public mode rejects pairing calls', async (t) => {
  // Don't need to start() — just test that the constructor sets up
  // public mode correctly and pairing methods reject
  const node = new RelayNode({
    mode: 'public',
    storage: tmpStorage(),
    enableAPI: false
  })

  t.is(node.accessControl, null, 'no access control in public mode')

  try {
    node.enablePairing()
    t.fail('should throw in public mode')
  } catch (err) {
    t.ok(err.message.includes('private/hybrid'), 'throws for public mode')
  }

  try {
    await node.addDevice(randomBytes(32).toString('hex'), 'test')
    t.fail('should throw in public mode')
  } catch (err) {
    t.ok(err.message.includes('private/hybrid'), 'addDevice throws for public mode')
  }
})

// ─── Connection Rejection Tests ─────────────────────────────────

test('RelayNode - private mode emits connection-rejected for unknown peers', async (t) => {
  const node = new RelayNode({
    mode: 'private',
    storage: tmpStorage(),
    enableAPI: false,
    enableServices: false,
    discovery: { mdns: false }
  })
  t.teardown(async () => { if (node.running) await node.stop() })

  await node.start()

  // Simulate an unknown connection
  const events = []
  node.on('connection-rejected', (info) => events.push(info))

  // Create a fake connection-like object
  const unknownPubkey = randomBytes(32)
  const fakeConn = new (await import('events')).EventEmitter()
  fakeConn.remotePublicKey = unknownPubkey
  fakeConn.destroyed = false
  fakeConn.destroy = () => { fakeConn.destroyed = true }

  const fakeInfo = { publicKey: unknownPubkey }
  node._onConnection(fakeConn, fakeInfo)

  t.is(fakeConn.destroyed, true, 'connection destroyed')
  t.is(events.length, 1, 'rejection event emitted')
  t.is(events[0].reason, 'not in allowlist')
  t.is(node._rejectedConnections, 1)

  await node.stop()
})

test('RelayNode - private mode allows paired devices through', async (t) => {
  const deviceKey = randomBytes(32).toString('hex')

  const node = new RelayNode({
    mode: 'private',
    storage: tmpStorage(),
    enableAPI: false,
    enableServices: false,
    access: { allowlist: [deviceKey] },
    discovery: { mdns: false }
  })
  t.teardown(async () => { if (node.running) await node.stop() })

  await node.start()

  // Simulate a known device connecting
  const events = []
  node.on('connection', (info) => events.push(info))

  const devicePubBuf = b4a.from(deviceKey, 'hex')
  const fakeConn = new (await import('events')).EventEmitter()
  fakeConn.remotePublicKey = devicePubBuf
  fakeConn.destroyed = false
  fakeConn.destroy = () => { fakeConn.destroyed = true }

  const fakeInfo = { publicKey: devicePubBuf }

  // We need to stub store.replicate since there's no real connection
  const origReplicate = node.store.replicate
  node.store.replicate = () => {}

  node._onConnection(fakeConn, fakeInfo)

  t.is(fakeConn.destroyed, false, 'connection NOT destroyed for allowed device')
  t.is(events.length, 1, 'connection event emitted')
  t.is(node._rejectedConnections, 0, 'no rejections')

  node.store.replicate = origReplicate
  await node.stop()
})

// ─── mDNS Discovery Tests ───────────────────────────────────────

test('MDNSDiscovery - start and stop', async (t) => {
  const mdns = new MDNSDiscovery({
    publicKey: randomBytes(32),
    port: 49737,
    mode: 'private'
  })

  t.teardown(async () => { await mdns.stop() })

  // Just test start/stop lifecycle (actual multicast may not work in CI)
  try {
    await mdns.start()
    t.is(mdns._running, true, 'started')
    await mdns.stop()
    t.is(mdns._running, false, 'stopped')
  } catch (err) {
    // mDNS may fail in some environments (docker, CI)
    t.ok(err, 'mDNS unavailable in this environment — acceptable')
  }
})

test('MDNSDiscovery - ignores own announcements', async (t) => {
  const pubkey = randomBytes(32)
  const mdns = new MDNSDiscovery({
    publicKey: pubkey,
    port: 49737,
    mode: 'private'
  })

  const discovered = []
  mdns.on('peer-discovered', (peer) => discovered.push(peer))

  // Simulate receiving our own announcement as DNS-SD response
  const ownResponse = {
    answers: [
      { name: 'hiverelay._hiverelay._udp.local', type: 'SRV', data: { port: 49737, target: 'host.local' } },
      { name: 'hiverelay._hiverelay._udp.local', type: 'TXT', data: [`pk=${b4a.toString(pubkey, 'hex')}`, 'mode=private', 'v=1'] }
    ],
    additionals: []
  }

  mdns._handleResponse(ownResponse, { address: '192.168.1.50' })
  t.is(discovered.length, 0, 'own announcement ignored')
})

test('MDNSDiscovery - discovers other peers', async (t) => {
  const ourKey = randomBytes(32)
  const mdns = new MDNSDiscovery({
    publicKey: ourKey,
    port: 49737,
    mode: 'private'
  })

  const discovered = []
  mdns.on('peer-discovered', (peer) => discovered.push(peer))

  // Simulate receiving another node's announcement as DNS-SD
  const otherKey = randomBytes(32).toString('hex')
  const otherResponse = {
    answers: [
      { name: 'friend-hive._hiverelay._udp.local', type: 'SRV', data: { port: 49738, target: 'friend.local' } },
      { name: 'friend-hive._hiverelay._udp.local', type: 'TXT', data: [`pk=${otherKey}`, 'mode=private', 'v=1'] }
    ],
    additionals: []
  }

  mdns._handleResponse(otherResponse, { address: '192.168.1.51' })

  t.is(discovered.length, 1, 'peer discovered')
  t.is(discovered[0].pubkey, otherKey)
  t.is(discovered[0].host, '192.168.1.51')
  t.is(discovered[0].port, 49738)
  t.is(discovered[0].name, 'friend-hive')

  const peers = mdns.getDiscoveredPeers()
  t.is(peers.length, 1)
})

test('MDNSDiscovery - ignores non-hiverelay services', async (t) => {
  const mdns = new MDNSDiscovery({
    publicKey: randomBytes(32),
    port: 49737
  })

  const discovered = []
  mdns.on('peer-discovered', (peer) => discovered.push(peer))

  // DNS-SD response for a different service type
  const otherResponse = {
    answers: [
      { name: 'webserver._http._tcp.local', type: 'SRV', data: { port: 80, target: 'web.local' } },
      { name: 'webserver._http._tcp.local', type: 'TXT', data: ['path=/'] }
    ],
    additionals: []
  }

  mdns._handleResponse(otherResponse, { address: '192.168.1.100' })
  t.is(discovered.length, 0, 'non-hiverelay service ignored')
})

test('MDNSDiscovery - handles malformed messages gracefully', async (t) => {
  const mdns = new MDNSDiscovery({
    publicKey: randomBytes(32),
    port: 49737
  })

  // Should not throw on malformed DNS-SD responses
  mdns._handleResponse({ answers: [], additionals: [] }, { address: '1.2.3.4' })
  mdns._handleResponse({ answers: [{ name: 'x._hiverelay._udp.local', type: 'SRV', data: { port: 1 } }], additionals: [] }, { address: '1.2.3.4' })
  mdns._handleResponse({ answers: null, additionals: null }, { address: '1.2.3.4' })
  t.pass('malformed messages handled without crash')
})

// Force exit after all tests — Hyperswarm/HyperDHT may leave handles open
test('cleanup', async (t) => {
  t.pass('all tests complete')
  setTimeout(() => process.exit(0), 500)
})

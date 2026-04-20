/**
 * End-to-end federation tests against a real testnet.
 *
 * Verifies the full follow → /catalog.json fetch → accept-mode gate path
 * with two real RelayNodes communicating over a Hyperswarm testnet.
 */

import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
import { RelayNode } from 'p2p-hiverelay/core/relay-node/index.js'
import path from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

function tmpStorage () {
  return path.join(tmpdir(), 'hiverelay-fed-test-' + randomBytes(8).toString('hex'))
}

function pickPort () {
  return 50000 + Math.floor(Math.random() * 10000)
}

function createNode (testnet, overrides = {}) {
  return new RelayNode({
    storage: tmpStorage(),
    bootstrapNodes: testnet.bootstrap,
    enableMetrics: false,
    ...overrides
  })
}

async function waitFor (fn, timeoutMs = 10000, intervalMs = 200) {
  const start = Date.now()
  while ((Date.now() - start) < timeoutMs) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

test('e2e federation: follow real peer in review mode → app lands in pending queue', async (t) => {
  const testnet = await createTestnet(3, t.teardown)

  // Source relay: serves a /catalog.json over HTTP. Open accept mode so it
  // accepts a self-seed quickly.
  const srcPort = pickPort()
  const src = createNode(testnet, { enableAPI: true, apiPort: srcPort, acceptMode: 'open' })
  // Subscriber: in review mode, follows src.
  const sub = createNode(testnet, { acceptMode: 'review', enableAPI: false })

  t.teardown(async () => {
    await src.stop()
    await sub.stop()
    await testnet.destroy()
  })

  await src.start()
  await sub.start()

  // Have src publish a fake app entry into its catalog by adding to appRegistry
  // directly. We don't need a real Hyperdrive here — federation only reads the
  // /catalog.json shape.
  const fakeAppKey = randomBytes(32).toString('hex')
  src.appRegistry.set(fakeAppKey, {
    appId: 'federated-test-app',
    name: 'Federation Test App',
    type: 'app',
    version: '1.0.0',
    privacyTier: 'public',
    seededAt: Date.now()
  })

  // Stub seedApp on subscriber so 'review' mode purely queues (no real seed).
  sub.appRegistry.has = () => false
  sub.seededApps.has = () => false

  // sub follows src
  sub.federation.follow(`http://127.0.0.1:${srcPort}`)

  // Trigger an immediate poll instead of waiting for the 5-min interval.
  await sub.federation._pollAll()

  const queued = sub._pendingRequests.has(fakeAppKey)
  t.ok(queued, 'review mode queued the discovered app')

  const entry = sub._pendingRequests.get(fakeAppKey)
  t.is(entry.source, 'federation', 'pending entry tagged with source=federation')
  t.is(entry.sourceRelay, `http://127.0.0.1:${srcPort}`, 'source relay URL recorded')
})

test('e2e federation: follow real peer in closed mode → app rejected, never queues', async (t) => {
  const testnet = await createTestnet(3, t.teardown)

  const srcPort = pickPort()
  const src = createNode(testnet, { enableAPI: true, apiPort: srcPort, acceptMode: 'open' })
  const sub = createNode(testnet, { acceptMode: 'closed', enableAPI: false })

  t.teardown(async () => {
    await src.stop()
    await sub.stop()
    await testnet.destroy()
  })

  await src.start()
  await sub.start()

  const fakeAppKey = randomBytes(32).toString('hex')
  src.appRegistry.set(fakeAppKey, {
    appId: 'closed-mode-test-app',
    name: 'Closed Mode Test',
    type: 'app',
    version: '1.0.0',
    privacyTier: 'public',
    seededAt: Date.now()
  })

  sub.appRegistry.has = () => false
  sub.seededApps.has = () => false

  let rejectedCount = 0
  sub.federation.on('federation-rejected', () => { rejectedCount++ })

  sub.federation.follow(`http://127.0.0.1:${srcPort}`)
  await sub.federation._pollAll()

  t.is(sub._pendingRequests.size, 0, 'closed mode never queues anything')
  t.is(rejectedCount, 1, 'rejection event emitted for the discovered app')
})

test('e2e federation: /catalog.json from a real RelayNode advertises federation field', async (t) => {
  const testnet = await createTestnet(2, t.teardown)
  const port = pickPort()
  const node = createNode(testnet, { enableAPI: true, apiPort: port, acceptMode: 'review' })
  t.teardown(async () => {
    await node.stop()
    await testnet.destroy()
  })

  await node.start()
  // Prime federation state so /catalog.json has something to advertise
  node.federation.follow('http://upstream-a.example')
  node.federation.mirror('http://trusted-b.example', { pubkey: 'b'.repeat(64) })

  // Hit the real HTTP endpoint
  const ok = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/catalog.json`)
      return res.status === 200
    } catch { return false }
  }, 5000)
  t.ok(ok, 'API came up')

  const data = await fetch(`http://127.0.0.1:${port}/catalog.json`).then(r => r.json())
  t.is(data.acceptMode, 'review', 'catalog.json advertises acceptMode')
  t.ok(data.federation, 'catalog.json carries federation field')
  t.is(data.federation.followed.length, 1, 'follow shows up in catalog.json')
  t.is(data.federation.mirrored.length, 1, 'mirror shows up in catalog.json')
  t.is(data.federation.followed[0].url, 'http://upstream-a.example')
})

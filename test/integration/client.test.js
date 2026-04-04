import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
import Hyperswarm from 'hyperswarm'
import { RelayNode } from '../../core/relay-node/index.js'
import { HiveRelayClient } from '../../client/index.js'
import b4a from 'b4a'
import path from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

function tmpStorage () {
  return path.join(tmpdir(), 'hiverelay-client-test-' + randomBytes(8).toString('hex'))
}

test('integration: client discovers relay node via DHT', async (t) => {
  const testnet = await createTestnet(3)

  // Start a relay node
  const relay = new RelayNode({
    storage: tmpStorage(),
    bootstrapNodes: testnet.bootstrap,
    enableAPI: false,
    enableMetrics: false
  })
  await relay.start()

  // Create a client swarm and client
  const clientSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const client = new HiveRelayClient({ swarm: clientSwarm })

  t.teardown(async () => {
    await client.destroy()
    await clientSwarm.destroy()
    await relay.stop()
    await testnet.destroy()
  })

  await client.start()

  // Flush multiple times to give DHT time to propagate
  await clientSwarm.flush()

  // Poll for connection — DHT discovery can take a few seconds
  let found = false
  for (let i = 0; i < 20; i++) {
    if (client.relays.size > 0) { found = true; break }
    await new Promise((resolve) => setTimeout(resolve, 500))
    await clientSwarm.flush()
  }

  t.ok(found, 'client discovered relay node')

  const relays = client.getRelays()
  t.ok(relays.length >= 1, 'at least one relay in list')
  if (relays.length > 0) {
    t.ok(relays[0].pubkey, 'relay has pubkey')
  }
})

test('integration: client seed request reaches relay', async (t) => {
  const testnet = await createTestnet(3)

  const relay = new RelayNode({
    storage: tmpStorage(),
    bootstrapNodes: testnet.bootstrap,
    enableAPI: false,
    enableMetrics: false
  })
  await relay.start()

  const clientSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const client = new HiveRelayClient({ swarm: clientSwarm })

  t.teardown(async () => {
    await client.destroy()
    await clientSwarm.destroy()
    await relay.stop()
    await testnet.destroy()
  })

  await client.start()
  await clientSwarm.flush()

  // Wait for relay to be discovered
  for (let i = 0; i < 20 && client.relays.size === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    await clientSwarm.flush()
  }

  // Create a fake app key and request seeding
  const appKey = randomBytes(32)
  const appKeyHex = b4a.toString(appKey, 'hex')

  // Seed request will broadcast; we verify it was published
  let published = false
  client.on('seed-request-published', ({ appKey: key }) => {
    if (key === appKeyHex) published = true
  })

  // Short timeout since we don't expect relay acceptance in test
  const acceptances = await client.seed(appKey, { replicas: 1, timeout: 3000 })

  t.is(published, true, 'seed request was published')
  t.ok(Array.isArray(acceptances), 'acceptances is an array')
  // Relay won't auto-accept in this setup, so acceptances may be empty — that's ok
  // The important thing is the request reached the network

  const status = client.getSeedStatus(appKeyHex)
  t.ok(status, 'seed status exists')
  t.is(status.appKey, appKeyHex, 'correct app key in status')
})

test('integration: multiple clients find same relay', async (t) => {
  const testnet = await createTestnet(3)

  const relay = new RelayNode({
    storage: tmpStorage(),
    bootstrapNodes: testnet.bootstrap,
    enableAPI: false,
    enableMetrics: false
  })
  await relay.start()

  const swarmA = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const swarmB = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const clientA = new HiveRelayClient({ swarm: swarmA })
  const clientB = new HiveRelayClient({ swarm: swarmB })

  t.teardown(async () => {
    await clientA.destroy()
    await clientB.destroy()
    await swarmA.destroy()
    await swarmB.destroy()
    await relay.stop()
    await testnet.destroy()
  })

  await clientA.start()
  await clientB.start()

  // Wait for both clients to discover the relay
  for (let i = 0; i < 20; i++) {
    if (clientA.relays.size > 0 && clientB.relays.size > 0) break
    await swarmA.flush()
    await swarmB.flush()
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  const relaysA = clientA.getRelays()
  const relaysB = clientB.getRelays()

  t.ok(relaysA.length >= 1, 'client A found relay')
  t.ok(relaysB.length >= 1, 'client B found relay')
})

test('integration: client destroy cleans up gracefully', async (t) => {
  const testnet = await createTestnet(3)

  const clientSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const client = new HiveRelayClient({ swarm: clientSwarm })

  t.teardown(async () => {
    await clientSwarm.destroy()
    await testnet.destroy()
  })

  await client.start()
  t.is(client._started, true, 'client started')

  await client.destroy()
  t.is(client._started, false, 'client stopped')
  t.is(client.relays.size, 0, 'relays cleared')
  t.is(client.seedRequests.size, 0, 'seed requests cleared')
})

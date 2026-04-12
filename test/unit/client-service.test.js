import test from 'brittle'
import { HiveRelayClient } from '../../client/index.js'
import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'

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

function mockStore () {
  return {
    close: async () => {},
    get: () => ({ key: Buffer.alloc(32), ready: async () => {} })
  }
}

function makeClient () {
  const swarm = mockSwarm()
  const store = mockStore()
  const client = new HiveRelayClient({ swarm, store })
  client._started = true
  return client
}

function fakeServiceChannel () {
  const sent = []
  return {
    channel: { close: () => {} },
    msg: {
      send: (msg) => sent.push(msg)
    },
    _sent: sent
  }
}

// ─── Constructor ───

test('HiveRelayClient - service RPC state initialized', (t) => {
  const client = new HiveRelayClient({ swarm: mockSwarm(), store: mockStore() })
  t.ok(client._pendingServiceRequests instanceof Map)
  t.is(client._serviceRequestId, 1)
})

// ─── callService ───

test('callService - throws NO_RELAY when no relays', async (t) => {
  const client = makeClient()
  try {
    await client.callService('identity', 'whoami')
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('NO_RELAY'))
  }
})

test('callService - throws NO_SERVICE_CHANNEL when relay lacks service', async (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  client.relays.set(pubkey, {
    conn: {},
    channels: { seed: {}, circuit: {} },
    connectedAt: Date.now(),
    lastSeen: Date.now()
  })
  client._relayScores.set(pubkey, { successes: 1, failures: 0, latency: 10, connectedSince: Date.now() })

  try {
    await client.callService('identity', 'whoami', {}, { relay: pubkey })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('NO_SERVICE_CHANNEL'))
  }
})

test('callService - sends MSG_REQUEST with correct format', async (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()

  client.relays.set(pubkey, {
    conn: {},
    channels: { seed: {}, circuit: {}, service: svc },
    connectedAt: Date.now(),
    lastSeen: Date.now()
  })
  client._relayScores.set(pubkey, { successes: 1, failures: 0, latency: 10, connectedSince: Date.now() })

  // Start the call but don't await (it will hang waiting for response)
  const promise = client.callService('storage', 'drive-list', { foo: 'bar' }, { relay: pubkey, timeout: 500 })

  t.is(svc._sent.length, 1)
  const msg = svc._sent[0]
  t.is(msg.type, 1)
  t.is(msg.service, 'storage')
  t.is(msg.method, 'drive-list')
  t.alike(msg.params, { foo: 'bar' })
  t.ok(typeof msg.id === 'number')

  // Clean up — let it timeout
  try { await promise } catch {}
})

test('callService - resolves on MSG_RESPONSE', async (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()

  client.relays.set(pubkey, {
    conn: {},
    channels: { seed: {}, circuit: {}, service: svc },
    connectedAt: Date.now(),
    lastSeen: Date.now()
  })
  client._relayScores.set(pubkey, { successes: 1, failures: 0, latency: 10, connectedSince: Date.now() })

  const promise = client.callService('identity', 'whoami', {}, { relay: pubkey })

  // Simulate response
  const requestId = svc._sent[0].id
  client._onServiceMessage(pubkey, { type: 2, id: requestId, result: { name: 'test-relay' } })

  const result = await promise
  t.alike(result, { name: 'test-relay' })
  t.is(client._pendingServiceRequests.size, 0)
})

test('callService - rejects on MSG_ERROR', async (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()

  client.relays.set(pubkey, {
    conn: {},
    channels: { seed: {}, circuit: {}, service: svc },
    connectedAt: Date.now(),
    lastSeen: Date.now()
  })
  client._relayScores.set(pubkey, { successes: 1, failures: 0, latency: 10, connectedSince: Date.now() })

  const promise = client.callService('storage', 'drive-get', { key: 'bad' }, { relay: pubkey })

  const requestId = svc._sent[0].id
  client._onServiceMessage(pubkey, { type: 3, id: requestId, error: 'DRIVE_NOT_FOUND: bad' })

  try {
    await promise
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('DRIVE_NOT_FOUND'))
  }
  t.is(client._pendingServiceRequests.size, 0)
})

test('callService - rejects on timeout', async (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()

  client.relays.set(pubkey, {
    conn: {},
    channels: { seed: {}, circuit: {}, service: svc },
    connectedAt: Date.now(),
    lastSeen: Date.now()
  })
  client._relayScores.set(pubkey, { successes: 1, failures: 0, latency: 10, connectedSince: Date.now() })

  try {
    await client.callService('identity', 'whoami', {}, { relay: pubkey, timeout: 100 })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('SERVICE_TIMEOUT'))
  }
  t.is(client._pendingServiceRequests.size, 0)
})

// ─── _onServiceMessage ───

test('_onServiceMessage - emits service-catalog on MSG_CATALOG', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  client.relays.set(pubkey, { conn: {}, channels: {}, connectedAt: Date.now(), lastSeen: Date.now() })

  let received = null
  client.on('service-catalog', (data) => { received = data })

  client._onServiceMessage(pubkey, { type: 0, services: [{ name: 'identity' }] })

  t.ok(received)
  t.is(received.relay, pubkey)
  t.is(received.services[0].name, 'identity')
})

test('_onServiceMessage - updates relay lastSeen', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const oldTime = Date.now() - 60000
  client.relays.set(pubkey, { conn: {}, channels: {}, connectedAt: Date.now(), lastSeen: oldTime })

  client._onServiceMessage(pubkey, { type: 0, services: [] })

  const relay = client.relays.get(pubkey)
  t.ok(relay.lastSeen > oldTime)
})

// ─── getRelays ───

test('getRelays - includes hasServiceProtocol', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()

  client.relays.set(pubkey, {
    conn: {},
    channels: { seed: null, circuit: null, service: svc },
    connectedAt: Date.now(),
    lastSeen: Date.now()
  })

  const relays = client.getRelays()
  t.is(relays.length, 1)
  t.is(relays[0].hasServiceProtocol, true)
})

// ─── destroy ───

test('destroy - clears pending service requests', async (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()

  client.relays.set(pubkey, {
    conn: {},
    channels: { seed: {}, circuit: {}, service: svc },
    connectedAt: Date.now(),
    lastSeen: Date.now()
  })
  client._relayScores.set(pubkey, { successes: 1, failures: 0, latency: 10, connectedSince: Date.now() })

  const promise = client.callService('identity', 'whoami', {}, { relay: pubkey })

  t.is(client._pendingServiceRequests.size, 1)
  await client.destroy()
  t.is(client._pendingServiceRequests.size, 0)

  try {
    await promise
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('CLIENT_DESTROYED'))
  }
})

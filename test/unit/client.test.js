import test from 'brittle'
import { HiveRelayClient } from '../../client/index.js'
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

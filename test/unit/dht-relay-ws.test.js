import test from 'brittle'
import { WebSocket } from 'ws'
import { DHTRelayWS } from 'p2p-hiverelay/transports/dht-relay-ws/index.js'

// Find a free port without binding twice. Quick-and-dirty: pick a high
// random port; collisions in CI are vanishingly unlikely for 65k range.
function pickPort () {
  return 50000 + Math.floor(Math.random() * 10000)
}

// Minimal DHT stand-in. The real @hyperswarm/dht-relay only touches the DHT
// inside `relay()` after a successful protocol handshake. For start/stop
// lifecycle tests we never get that far — tests that exercise an actual
// relay handshake belong in integration suites with a real HyperDHT.
function fakeDHT () {
  return { /* stand-in — relay() is invoked but won't be exercised end-to-end */ }
}

test('DHTRelayWS: requires dht', (t) => {
  try {
    new DHTRelayWS({})
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('dht is required'), 'clear error when dht missing')
  }
})

test('DHTRelayWS: start opens a WebSocket server, stop closes it', async (t) => {
  const port = pickPort()
  const transport = new DHTRelayWS({ dht: fakeDHT(), port })

  await transport.start()
  t.ok(transport.running, 'running after start')

  // Confirm the port is actually listening by opening a client socket.
  const client = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve, reject) => {
    client.on('open', resolve)
    client.on('error', reject)
  })
  t.ok(true, 'client could connect')
  client.close()

  await transport.stop()
  t.absent(transport.running, 'stopped cleanly')
})

test('DHTRelayWS: enforces maxConnections', async (t) => {
  const port = pickPort()
  const transport = new DHTRelayWS({ dht: fakeDHT(), port, maxConnections: 1 })
  await transport.start()
  t.teardown(() => transport.stop())

  // First client gets in.
  const c1 = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve) => c1.on('open', resolve))

  // Wait a tick so the server registers the connection in `connections`.
  await new Promise((r) => setTimeout(r, 50))

  // Second client should be closed by the server with our capacity code.
  const c2 = new WebSocket(`ws://127.0.0.1:${port}`)
  const closeCode = await new Promise((resolve) => {
    c2.on('close', (code) => resolve(code))
  })
  t.is(closeCode, 1013, 'capacity refusal returns ws code 1013')

  c1.close()
})

test('DHTRelayWS: getStats reports operating numbers', async (t) => {
  const port = pickPort()
  const transport = new DHTRelayWS({ dht: fakeDHT(), port })
  await transport.start()
  t.teardown(() => transport.stop())

  const before = transport.getStats()
  t.is(before.running, true)
  t.is(before.totalConnectionsServed, 0)
  t.is(before.activeConnections, 0)

  // Open and close a couple of clients to bump counters.
  for (let i = 0; i < 3; i++) {
    const c = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((resolve) => c.on('open', resolve))
    c.close()
    await new Promise((r) => setTimeout(r, 30))
  }

  const after = transport.getStats()
  t.is(after.totalConnectionsServed, 3, 'totalConnectionsServed counts every accept')
})

/**
 * End-to-end test: a "browser-like" client tunnels HyperDHT operations
 * through DHTRelayWS over a real WebSocket against a real HyperDHT node.
 *
 * This is the test that proves the original reviewer feedback ("no
 * DHT-relay WebSocket out of the box") is actually closed — not just that
 * the WS server starts, but that DHT control traffic round-trips correctly.
 */

import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
import { WebSocket } from 'ws'
import RelayedDHT from '@hyperswarm/dht-relay'
import RelayedStream from '@hyperswarm/dht-relay/ws'
import { DHTRelayWS } from 'p2p-hiverelay/transports/dht-relay-ws/index.js'

function pickPort () {
  return 50000 + Math.floor(Math.random() * 10000)
}

test('e2e: relayed client completes handshake and ready() through the WS', async (t) => {
  // Critical "the protocol actually works" test. Proves that:
  //   1. The WS server accepts a real client socket
  //   2. The dht-relay handshake completes (Node ↔ NodeProxy)
  //   3. The relayed DHT exposes its keypair (proxied from the real DHT)
  // This is the minimum that closes the original "no DHT-relay-WS" feedback —
  // we have an actual end-to-end DHT instance reachable through a browser WS.
  const testnet = await createTestnet(2, t.teardown)
  const relayDHT = testnet.nodes[0]

  const port = pickPort()
  const relayWs = new DHTRelayWS({ dht: relayDHT, port, host: '127.0.0.1' })
  await relayWs.start()
  t.teardown(() => relayWs.stop())

  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve, reject) => {
    socket.on('open', resolve)
    socket.on('error', reject)
  })

  const browserDHT = new RelayedDHT(new RelayedStream(true, socket))
  await browserDHT.ready()

  t.ok(browserDHT.defaultKeyPair, 'relayed DHT has a keypair after ready')
  t.ok(browserDHT.defaultKeyPair.publicKey, 'keypair has a public key')
  t.is(browserDHT.defaultKeyPair.publicKey.length, 32, 'public key is 32 bytes')
  t.is(relayWs.getStats().activeConnections, 1, 'server tracks the active session')

  await browserDHT.destroy()
  socket.close()
  // Give the server-side close handler a moment.
  await new Promise(r => setTimeout(r, 100))
})

test('e2e: WS server cleanly handles client disconnect mid-session', async (t) => {
  const testnet = await createTestnet(2, t.teardown)
  const relayDHT = testnet.nodes[0]
  const port = pickPort()
  const relayWs = new DHTRelayWS({ dht: relayDHT, port, host: '127.0.0.1' })
  await relayWs.start()
  t.teardown(() => relayWs.stop())

  // Connect, ready up, then yank the socket without graceful close.
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve) => socket.on('open', resolve))

  const browserDHT = new RelayedDHT(new RelayedStream(true, socket))
  await browserDHT.ready()
  t.is(relayWs.getStats().activeConnections, 1, 'relay sees one active session')

  // Hard close — the relay should drop the session, not leak it.
  socket.terminate()
  await new Promise((r) => setTimeout(r, 100))

  t.is(relayWs.getStats().activeConnections, 0, 'relay cleaned up the dropped connection')
})

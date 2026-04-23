/**
 * Load / concurrency integration tests for DHTRelayWS.
 *
 * These exercise the transport against many concurrent WebSocket clients
 * to verify rate-limiting, capacity tracking, responsiveness, and clean
 * shutdown all hold up under realistic load. We don't run a real DHT
 * handshake here — for these scenarios, we only care that the WS server
 * accepts/rejects connections and tracks them correctly. The dht-relay
 * `relay()` call inside the transport is invoked with a stand-in DHT;
 * since the client never speaks the framed dht-relay protocol, that path
 * is effectively a no-op past the WebSocket layer.
 */

import test from 'brittle'
import { WebSocket } from 'ws'
import { DHTRelayWS } from 'p2p-hiverelay/transports/dht-relay-ws/index.js'

function pickPort () {
  return 50000 + Math.floor(Math.random() * 10000)
}

// Stand-in DHT — dht-relay's relay() reaches into this only when the client
// completes its protocol handshake. Our raw `ws` clients never do, so the
// fake never gets touched in a meaningful way.
function fakeDHT () {
  return {}
}

// Open `n` WebSocket clients in parallel. Resolves with an array of
// objects describing each client's outcome.
//
// Note on rate-limit semantics: when the server rate-limits, it rejects the
// HTTP upgrade via `verifyClient` *before* the WebSocket upgrade completes.
// The client therefore never sees an 'open' event — it sees an 'error' and a
// 'close' with code 1006 (abnormal closure). We treat any client that
// errored or closed without ever opening as rejected.
function openClients (port, n) {
  const results = []
  for (let i = 0; i < n; i++) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    const result = {
      socket,
      opened: false,
      closed: false,
      closeCode: null,
      closeReason: null,
      error: null
    }
    socket.on('open', () => { result.opened = true })
    socket.on('close', (code, reason) => {
      result.closed = true
      result.closeCode = code
      result.closeReason = reason ? reason.toString() : ''
    })
    socket.on('error', (err) => {
      result.error = err
    })
    results.push(result)
  }
  return results
}

// A client is "settled" once it has either opened-and-stayed-open (no close
// yet), been opened-then-closed (rate-limited 1008), or errored without ever
// opening. Wait for all clients to reach a stable state.
async function waitForSettled (clients, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pending = clients.filter(c => !c.opened && !c.closed && !c.error)
    if (pending.length === 0) {
      // Give the close-after-open handlers a brief moment to fire too.
      await new Promise(r => setTimeout(r, 50))
      return
    }
    await new Promise(r => setTimeout(r, 25))
  }
}

test('load: ~100 concurrent clients under a generous per-IP cap all succeed', async (t) => {
  const port = pickPort()
  const transport = new DHTRelayWS({
    dht: fakeDHT(),
    port,
    host: '127.0.0.1',
    rateLimit: { connectionsPerMinutePerIp: 1000, maxConcurrentPerIp: 200 }
  })
  await transport.start()
  t.teardown(() => transport.stop())

  const N = 100
  const clients = openClients(port, N)
  await waitForSettled(clients, 8000)

  const opened = clients.filter(c => c.opened).length
  const spuriousClosures = clients.filter(c => c.opened && c.closeCode !== null).length

  t.is(opened, N, 'all 100 clients fired open')
  t.is(spuriousClosures, 0, 'no opened clients were spuriously closed by the server')

  const stats = transport.getStats()
  t.is(stats.totalRateLimited, 0, 'no rate-limit rejections under headroom')
  t.is(stats.activeConnections, N, 'server tracks all 100 active connections')

  // Cleanly close the clients before teardown.
  for (const c of clients) {
    try { c.socket.close() } catch (_) {}
  }
  // Let close events flush.
  await new Promise(r => setTimeout(r, 200))
})

test('load: 50-burst against default 5/concurrent gets exactly 5 through, rest rejected at upgrade', async (t) => {
  const port = pickPort()
  // Use defaults: 10/min, 5 concurrent.
  const transport = new DHTRelayWS({ dht: fakeDHT(), port, host: '127.0.0.1' })
  await transport.start()
  t.teardown(() => transport.stop())

  const N = 50
  const clients = openClients(port, N)
  await waitForSettled(clients, 5000)

  // Survivors: opened and still alive (no close event).
  const survivors = clients.filter(c => c.opened && !c.closed)
  // Rejected at HTTP upgrade: never opened, errored or closed with 1006.
  const rejectedAtUpgrade = clients.filter(c => !c.opened && (c.error || c.closeCode === 1006))

  // Per-IP concurrent cap is 5 — exactly that many should remain open.
  t.is(survivors.length, 5, 'exactly 5 clients accepted (matches maxConcurrentPerIp)')
  t.is(rejectedAtUpgrade.length, N - 5, `${N - 5} clients rejected at HTTP upgrade (close 1006 / error)`)
  t.is(survivors.length + rejectedAtUpgrade.length, N, 'every client either survived or was rejected at upgrade')

  const stats = transport.getStats()
  t.is(stats.totalRateLimited, rejectedAtUpgrade.length, 'totalRateLimited matches the rejected count')
  t.is(stats.activeConnections, 5, 'activeConnections == 5 after the burst')

  // Close the survivors so teardown is clean.
  for (const c of survivors) {
    try { c.socket.close() } catch (_) {}
  }
  await new Promise(r => setTimeout(r, 200))
})

test('load: closing some connections frees concurrent slots for new ones', async (t) => {
  const port = pickPort()
  const transport = new DHTRelayWS({ dht: fakeDHT(), port, host: '127.0.0.1' })
  await transport.start()
  t.teardown(() => transport.stop())

  // Open the 5 allowed concurrent connections sequentially so the per-minute
  // tokens drain by exactly 5 (we still have 5 tokens left for the second wave).
  const first = []
  for (let i = 0; i < 5; i++) {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((resolve, reject) => {
      s.on('open', resolve)
      s.on('error', reject)
    })
    first.push(s)
  }
  // Tiny pause to let the server register everything.
  await new Promise(r => setTimeout(r, 50))
  t.is(transport.getStats().activeConnections, 5, '5 concurrent active')

  // Close 3 of them and wait for the server to release the slots.
  for (let i = 0; i < 3; i++) {
    first[i].close()
  }
  // Wait for server-side close handlers to release the bucket.
  const releasedDeadline = Date.now() + 2000
  while (transport.getStats().activeConnections > 2 && Date.now() < releasedDeadline) {
    await new Promise(r => setTimeout(r, 25))
  }
  t.is(transport.getStats().activeConnections, 2, 'down to 2 after closing 3')

  // Open 3 new ones — these should succeed because both the concurrent slot
  // and per-minute tokens are still available (2 active + 3 new = 5; tokens 5 → 2).
  const second = openClients(port, 3)
  await waitForSettled(second, 3000)

  const newlyOpened = second.filter(c => c.opened && c.closeCode === null)
  t.is(newlyOpened.length, 3, 'all 3 reopened clients succeed (slots freed)')

  // Cleanup.
  for (let i = 3; i < 5; i++) try { first[i].close() } catch (_) {}
  for (const c of second) try { c.socket.close() } catch (_) {}
  await new Promise(r => setTimeout(r, 200))
})

test('load: server stays responsive — fresh client opens quickly under load', async (t) => {
  const port = pickPort()
  const transport = new DHTRelayWS({
    dht: fakeDHT(),
    port,
    host: '127.0.0.1',
    rateLimit: { connectionsPerMinutePerIp: 1000, maxConcurrentPerIp: 200 }
  })
  await transport.start()
  t.teardown(() => transport.stop())

  // Stand up 50+ background connections.
  const background = openClients(port, 60)
  await waitForSettled(background, 8000)
  t.is(background.filter(c => c.opened).length, 60, '60 background clients opened')

  // Now time how long it takes a fresh client to get an open event.
  const start = Date.now()
  const fresh = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('fresh client open timed out')), 3000)
    fresh.on('open', () => { clearTimeout(to); resolve() })
    fresh.on('error', (e) => { clearTimeout(to); reject(e) })
  })
  const elapsed = Date.now() - start
  // Loose bound — CI is slow, but 2s is generous for a local loopback open.
  t.ok(elapsed < 2000, `fresh client opened in ${elapsed}ms (< 2000ms)`)

  fresh.close()
  for (const c of background) try { c.socket.close() } catch (_) {}
  await new Promise(r => setTimeout(r, 200))
})

test('load: stop() with 50+ open connections cleans up state and timers', async (t) => {
  const port = pickPort()
  const transport = new DHTRelayWS({
    dht: fakeDHT(),
    port,
    host: '127.0.0.1',
    rateLimit: { connectionsPerMinutePerIp: 1000, maxConcurrentPerIp: 200 }
  })
  await transport.start()

  // Server must have its cleanup interval armed after start.
  t.ok(transport._cleanupTimer, 'cleanup interval timer is set after start')

  const N = 55
  const clients = openClients(port, N)
  await waitForSettled(clients, 8000)
  t.is(clients.filter(c => c.opened).length, N, `all ${N} clients opened`)
  t.is(transport.getStats().activeConnections, N, `transport sees all ${N} connections`)

  // Wait for all clients to receive a close event after stop().
  const allClosed = Promise.all(clients.map(c =>
    new Promise(resolve => {
      if (c.closeCode !== null) return resolve(c.closeCode)
      c.socket.on('close', (code) => resolve(code))
    })
  ))

  await transport.stop()

  // Brittle's leak detector for setInterval flags any unref'd-but-still-armed
  // timers on test exit. A successful test means the interval was cleared.
  t.is(transport._cleanupTimer, null, 'cleanup interval timer cleared after stop')
  t.is(transport.getStats().activeConnections, 0, 'activeConnections == 0 after stop')

  const codes = await Promise.race([
    allClosed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('not all clients received close in time')), 3000)
    )
  ])
  t.is(codes.length, N, 'every client received a close event')
})

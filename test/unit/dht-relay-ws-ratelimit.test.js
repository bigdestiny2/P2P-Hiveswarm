import test from 'brittle'
import { WebSocket } from 'ws'
import { DHTRelayWS } from 'p2p-hiverelay/transports/dht-relay-ws/index.js'

// Match the existing dht-relay-ws.test.js helper.
function pickPort () {
  return 50000 + Math.floor(Math.random() * 10000)
}

function fakeDHT () {
  return { /* stand-in — relay() runs but is never exercised end-to-end */ }
}

// Open a single client and resolve to { code, opened, ws }. Resolves on
// either close (server rejected us — `code` is the close code, `opened`
// reflects whether we got an open event first) or stable-open (server
// accepted; `code` null, `opened` true).
function probe (port, settleMs = 80) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    let resolved = false
    let opened = false
    ws.on('open', () => {
      opened = true
      // If the server were going to reject this open client, it would do
      // so within a tick. Wait briefly to confirm it stays open.
      setTimeout(() => {
        if (resolved) return
        if (ws.readyState === WebSocket.OPEN) {
          resolved = true
          resolve({ code: null, opened: true, ws })
        }
      }, settleMs)
    })
    ws.on('close', (code) => {
      if (resolved) return
      resolved = true
      resolve({ code, opened, ws })
    })
    ws.on('error', () => { /* close handler resolves */ })
  })
}

// Open a client and wait until it reaches a stable state — either
// opened-and-still-open or closed by the server. Returns { ws, opened, code }.
function openClient (port, settleMs = 60) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    let resolved = false
    ws.on('open', () => {
      // Give the server a tick to register the connection (or close it if
      // the rate-limit fires after open). If still open after settleMs,
      // resolve as opened.
      setTimeout(() => {
        if (resolved) return
        if (ws.readyState === WebSocket.OPEN) {
          resolved = true
          resolve({ ws, opened: true, code: null })
        }
      }, settleMs)
    })
    ws.on('close', (code) => {
      if (resolved) return
      resolved = true
      resolve({ ws, opened: false, code })
    })
    ws.on('error', () => { /* close handler resolves */ })
  })
}

test('DHTRelayWS rate limit: defaults are 10/min and 5 concurrent', (t) => {
  const transport = new DHTRelayWS({ dht: fakeDHT() })
  t.is(transport.rateLimit.connectionsPerMinutePerIp, 10, 'default connections/min/ip')
  t.is(transport.rateLimit.maxConcurrentPerIp, 5, 'default concurrent/ip')
  const stats = transport.getStats()
  t.is(stats.rateLimit.connectionsPerMinutePerIp, 10, 'getStats exposes default per-min')
  t.is(stats.rateLimit.maxConcurrentPerIp, 5, 'getStats exposes default concurrent')
  t.is(stats.totalRateLimited, 0, 'totalRateLimited starts at 0')
})

test('DHTRelayWS rate limit: 11th connection within window is rejected at upgrade', async (t) => {
  const port = pickPort()
  // Generous concurrent cap so we hit the per-minute limit, not the
  // concurrent limit. Long window so refill doesn't kick in mid-test.
  const transport = new DHTRelayWS({
    dht: fakeDHT(),
    port,
    rateLimit: {
      connectionsPerMinutePerIp: 10,
      maxConcurrentPerIp: 100,
      windowMs: 60_000
    }
  })
  await transport.start()
  t.teardown(() => transport.stop())

  let rateLimitedEvents = 0
  let lastReason = null
  transport.on('rate-limited', (ev) => {
    rateLimitedEvents++
    lastReason = ev.reason
  })

  // Open + close 10 connections sequentially. Each one consumes a token
  // and then frees its concurrency slot, so we should hit the per-minute
  // limit on attempt #11 rather than the concurrent limit.
  for (let i = 0; i < 10; i++) {
    const c = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((resolve, reject) => {
      c.on('open', resolve)
      c.on('error', reject)
    })
    c.close()
    await new Promise((resolve) => c.on('close', resolve))
    // tiny breath so the server's close handler runs and decrements concurrent
    await new Promise((r) => setTimeout(r, 10))
  }

  // 11th — rejected at HTTP upgrade time. The client never sees 'open'; it
  // sees an error and then a close with code 1006 (abnormal closure) since
  // the WS upgrade never completed.
  const result = await probe(port)
  t.is(result.code, 1006, '11th connection refused at upgrade (close 1006)')
  t.absent(result.opened, 'client never saw open event')
  t.is(rateLimitedEvents, 1, 'one rate-limited event fired')
  t.is(lastReason, 'connections-per-minute', 'reason is connections-per-minute')
  t.is(transport.getStats().totalRateLimited, 1, 'totalRateLimited incremented')
})

test('DHTRelayWS rate limit: 6th simultaneous connection is rejected', async (t) => {
  const port = pickPort()
  const transport = new DHTRelayWS({
    dht: fakeDHT(),
    port,
    rateLimit: {
      // High per-minute cap so we hit the concurrent limit only.
      connectionsPerMinutePerIp: 1000,
      maxConcurrentPerIp: 5,
      windowMs: 60_000
    }
  })
  await transport.start()
  t.teardown(() => transport.stop())

  let rateLimitedReason = null
  transport.on('rate-limited', (ev) => {
    rateLimitedReason = ev.reason
  })

  // Open 5 simultaneously and keep them open.
  const opens = []
  for (let i = 0; i < 5; i++) {
    opens.push(openClient(port))
  }
  const settled = await Promise.all(opens)
  for (const r of settled) {
    t.ok(r.opened, 'first 5 simultaneous opened')
  }

  // 6th should be rate-limited at HTTP upgrade — close 1006, no open event.
  const sixth = await probe(port)
  t.is(sixth.code, 1006, '6th simultaneous refused at upgrade (close 1006)')
  t.is(rateLimitedReason, 'max-concurrent', 'reason is max-concurrent')
  t.is(transport.getStats().totalRateLimited, 1, 'totalRateLimited == 1')

  // Clean up the 5 we left open.
  for (const r of settled) {
    try { r.ws.close() } catch (_) {}
  }
})

test('DHTRelayWS rate limit: totalRateLimited increments per rejection', async (t) => {
  const port = pickPort()
  const transport = new DHTRelayWS({
    dht: fakeDHT(),
    port,
    rateLimit: {
      connectionsPerMinutePerIp: 1000,
      maxConcurrentPerIp: 2,
      windowMs: 60_000
    }
  })
  await transport.start()
  t.teardown(() => transport.stop())

  // Hold 2 open.
  const a = await openClient(port)
  const b = await openClient(port)
  t.ok(a.opened && b.opened, 'two clients held open')

  // Three subsequent attempts should each be rejected at HTTP upgrade (1006).
  for (let i = 1; i <= 3; i++) {
    const r = await probe(port)
    t.is(r.code, 1006, `rejection #${i} closes with 1006 (HTTP upgrade refused)`)
    t.is(transport.getStats().totalRateLimited, i, `totalRateLimited == ${i}`)
  }

  try { a.ws.close() } catch (_) {}
  try { b.ws.close() } catch (_) {}
})

test('DHTRelayWS rate limit: window refill restores capacity', async (t) => {
  const port = pickPort()
  // Tiny window so the bucket refills within the test.
  const transport = new DHTRelayWS({
    dht: fakeDHT(),
    port,
    rateLimit: {
      connectionsPerMinutePerIp: 2,
      maxConcurrentPerIp: 100,
      windowMs: 200 // 200ms window
    }
  })
  await transport.start()
  t.teardown(() => transport.stop())

  // Burn the bucket: open + close 2 connections, then verify #3 is rejected.
  for (let i = 0; i < 2; i++) {
    const c = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((resolve, reject) => {
      c.on('open', resolve)
      c.on('error', reject)
    })
    c.close()
    await new Promise((resolve) => c.on('close', resolve))
    await new Promise((r) => setTimeout(r, 10))
  }

  const blocked = await probe(port)
  t.is(blocked.code, 1006, '3rd within window blocked at upgrade (close 1006)')

  // Wait past the window so the bucket fully refills.
  await new Promise((r) => setTimeout(r, 250))

  // Should succeed now.
  const after = await probe(port)
  t.is(after.opened, true, 'connection succeeds after window elapses')
  t.is(after.code, null, 'no close code received from server reject')
  try { after.ws.close() } catch (_) {}
})

test('DHTRelayWS rate limit: getStats exposes totalRateLimited and config', async (t) => {
  const port = pickPort()
  const transport = new DHTRelayWS({
    dht: fakeDHT(),
    port,
    rateLimit: {
      connectionsPerMinutePerIp: 3,
      maxConcurrentPerIp: 7
    }
  })
  await transport.start()
  t.teardown(() => transport.stop())

  const stats = transport.getStats()
  t.is(stats.totalRateLimited, 0, 'starts at 0')
  t.is(stats.rateLimit.connectionsPerMinutePerIp, 3, 'custom per-min reported')
  t.is(stats.rateLimit.maxConcurrentPerIp, 7, 'custom concurrent reported')
})

test('DHTRelayWS rate limit: stop() clears the cleanup interval', async (t) => {
  const port = pickPort()
  const transport = new DHTRelayWS({
    dht: fakeDHT(),
    port,
    rateLimit: { cleanupIntervalMs: 50 }
  })
  await transport.start()
  t.ok(transport._cleanupTimer, 'cleanup timer scheduled')
  await transport.stop()
  t.is(transport._cleanupTimer, null, 'cleanup timer cleared on stop')
})

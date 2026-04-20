/**
 * Federation polling under operational scale.
 *
 * Exercises Federation._pollAll() against many followed catalogs at once:
 *   - 50 fast follows, all served from one in-process HTTP server under
 *     varying sub-paths, to confirm the poll loop fans out cleanly and
 *     queues every discovered app.
 *   - A mix of fast / slow / dead follows, to confirm that
 *     Promise.allSettled() means a single dead or slow upstream cannot
 *     starve fast ones, and the whole _pollAll() resolves within the
 *     existing FETCH_TIMEOUT (10s) upper bound.
 *   - The 'poll-complete' event payload reflects reality.
 *   - A single follow returning 500 apps in its catalog is processed
 *     without the federation choking on the large array.
 *
 * Federation is exercised in isolation — we use a fake `node` stub with the
 * surface federation actually touches (_resolveAcceptMode, _decideAcceptance,
 * appRegistry.has, seededApps.has, _pendingRequests, emit, seedApp). No real
 * RelayNode / swarm needed.
 */

import test from 'brittle'
import http from 'http'
import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'
import { Federation } from 'p2p-hiverelay/core/federation.js'

// ─── Helpers ─────────────────────────────────────────────────────────

function pickPort () {
  return 50000 + Math.floor(Math.random() * 10000)
}

// Minimal RelayNode stand-in. Federation only reaches into this surface.
function makeFakeNode (acceptMode = 'review') {
  const node = new EventEmitter()
  node.appRegistry = new Map()
  node.seededApps = new Set()
  node._pendingRequests = new Map()
  node._resolveAcceptMode = () => acceptMode
  node._decideAcceptance = (_req, mode) => {
    if (mode === 'open') return 'accept'
    if (mode === 'closed') return 'reject'
    if (mode === 'review') return 'queue'
    return 'queue'
  }
  node.seedApp = async () => { /* no-op for these tests */ }
  return node
}

// Build a catalog payload matching the shape RelayNode's API returns.
function buildCatalog (apps, { acceptMode = 'review' } = {}) {
  return JSON.stringify({
    acceptMode,
    apps,
    federation: { followed: [], mirrored: [], republished: [] }
  })
}

function fakeAppKey (i, salt = '') {
  // 64-hex-char appKey, deterministic and guaranteed unique per (salt, i).
  // We hex-encode `${salt}:${i}|` (the trailing `|` makes prefixes unambiguous —
  // 'r1:10' vs 'r1:1' both end in distinct hex), then pad/truncate to 64.
  const tag = `${salt}:${i}|`
  const hex = Buffer.from(tag, 'utf8').toString('hex')
  // Pad with hex 'a' so we never collide with the natural padding of another
  // index, and we stay in the hex alphabet.
  return (hex + 'a'.repeat(64)).slice(0, 64)
}

// Spin up an HTTP server that serves /relay-N/catalog.json for N in [0, count).
// Each catalog has `appsPerCatalog` synthetic apps with unique appKeys. The
// `keyNamespace` distinguishes apps across multiple servers in one test
// (otherwise two servers' /relay-0 endpoints would advertise the same keys
// and federation would dedupe the second one's apps).
// Returns { port, close, requests } where `requests` counts hits.
async function startMultiPathServer ({ count, appsPerCatalog, delayMs = 0, keyNamespace = 'srv' } = {}) {
  const port = pickPort()
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    const m = req.url.match(/^\/relay-(\d+)\/catalog\.json$/)
    if (!m) {
      res.statusCode = 404
      res.end()
      return
    }
    const idx = Number(m[1])
    const apps = []
    for (let i = 0; i < appsPerCatalog; i++) {
      apps.push({
        appKey: fakeAppKey(i, `${keyNamespace}-r${idx}`),
        publisherPubkey: 'p'.repeat(64),
        type: 'app'
      })
    }
    const body = buildCatalog(apps)
    const send = () => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(body)
    }
    if (delayMs > 0) setTimeout(send, delayMs)
    else send()
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
    get requests () { return requests }
  }
}

// Server that serves a single catalog with N apps at /catalog.json.
async function startSingleBigCatalogServer (numApps) {
  const port = pickPort()
  const apps = []
  for (let i = 0; i < numApps; i++) {
    apps.push({
      appKey: fakeAppKey(i, 'big'),
      publisherPubkey: 'p'.repeat(64),
      type: 'app'
    })
  }
  const body = buildCatalog(apps)
  const server = http.createServer((req, res) => {
    if (req.url !== '/catalog.json') {
      res.statusCode = 404
      res.end()
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(body)
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { port, close: () => new Promise((resolve) => server.close(resolve)) }
}

// ─── Tests ───────────────────────────────────────────────────────────

test('federation poll fans out across 50 fast follows under review mode', async (t) => {
  const N = 50
  const APPS_PER = 3
  const server = await startMultiPathServer({ count: N, appsPerCatalog: APPS_PER })
  t.teardown(() => server.close())

  const node = makeFakeNode('review')
  const fed = new Federation({ node })

  for (let i = 0; i < N; i++) {
    fed.follow(`http://127.0.0.1:${server.port}/relay-${i}`)
  }
  t.is(fed.snapshot().followed.length, N, 'all 50 follows registered')

  let pollComplete = null
  fed.on('poll-complete', (info) => { pollComplete = info })

  const start = Date.now()
  await fed._pollAll()
  const elapsed = Date.now() - start

  t.ok(elapsed < 5000, `_pollAll() finished fast for 50 fast follows (${elapsed}ms)`)
  t.is(server.requests, N, 'every follow hit the catalog endpoint exactly once')
  t.ok(pollComplete, 'poll-complete event fired')
  t.is(pollComplete.polled, N, 'poll-complete reports all 50 polled')
  t.is(pollComplete.queued, N * APPS_PER, 'poll-complete reports all apps queued')
  t.is(node._pendingRequests.size, N * APPS_PER, 'pending queue holds every discovered app')
})

test('federation poll: slow + dead follows do not starve fast follows', async (t) => {
  // Three servers: fast (no delay), slow (~250ms), dead (port with no listener).
  // We tag each fast/slow app so we can confirm fast finishes first.
  const fastSrv = await startMultiPathServer({ count: 5, appsPerCatalog: 2, delayMs: 0, keyNamespace: 'fast' })
  const slowSrv = await startMultiPathServer({ count: 3, appsPerCatalog: 2, delayMs: 250, keyNamespace: 'slow' })
  t.teardown(() => fastSrv.close())
  t.teardown(() => slowSrv.close())

  // Pick a port and don't bind anything to it. _fetchCatalog with timeout
  // 10s will eventually settle with null — Promise.allSettled means it doesn't
  // block the others.
  const deadPort = pickPort()

  const node = makeFakeNode('review')
  const fed = new Federation({ node })

  // Track per-relay completion order via federation-queued events.
  const completionOrder = []
  fed.on('federation-queued', ({ source }) => {
    if (!completionOrder.includes(source)) completionOrder.push(source)
  })

  for (let i = 0; i < 5; i++) fed.follow(`http://127.0.0.1:${fastSrv.port}/relay-${i}`)
  for (let i = 0; i < 3; i++) fed.follow(`http://127.0.0.1:${slowSrv.port}/relay-${i}`)
  // 2 dead follows on the unbound port.
  for (let i = 0; i < 2; i++) fed.follow(`http://127.0.0.1:${deadPort}/relay-${i}`)

  let pollComplete = null
  fed.on('poll-complete', (info) => { pollComplete = info })

  const start = Date.now()
  await fed._pollAll()
  const elapsed = Date.now() - start

  // The dead-follow case: on most platforms a connection to an unbound local
  // port returns ECONNREFUSED immediately, so _pollAll() comes back quickly.
  // The 10s FETCH_TIMEOUT is the absolute upper bound; we assert under it.
  t.ok(elapsed < 10_000, `_pollAll() returned within FETCH_TIMEOUT (${elapsed}ms)`)

  t.is(pollComplete.polled, 10, '10 follows polled (5 fast + 3 slow + 2 dead)')
  // Fast: 5*2=10. Slow: 3*2=6. Dead: 0. Total queued = 16.
  t.is(pollComplete.queued, 16, 'queued count reflects fast+slow successes only')
  t.is(node._pendingRequests.size, 16, 'pending queue size matches')

  // Fast follows queued before slow ones — given the 250ms delta, all 5
  // fast-source URLs should appear before any slow-source URL in the order.
  const fastSources = completionOrder.filter(u => u.includes(`:${fastSrv.port}`))
  const slowSources = completionOrder.filter(u => u.includes(`:${slowSrv.port}`))
  t.is(fastSources.length, 5, 'all fast sources contributed events')
  t.is(slowSources.length, 3, 'all slow sources contributed events')
  const lastFastIdx = completionOrder.lastIndexOf(fastSources[fastSources.length - 1])
  const firstSlowIdx = completionOrder.indexOf(slowSources[0])
  t.ok(lastFastIdx < firstSlowIdx, 'every fast follow finished before any slow follow (no head-of-line blocking)')
})

test('federation poll: poll-complete payload accurate when some follows have nothing new', async (t) => {
  // Same server, two follows. Pre-seed the node with the apps from one of
  // them so federation skips them — poll-complete.queued must reflect that.
  const APPS_PER = 4
  const server = await startMultiPathServer({ count: 2, appsPerCatalog: APPS_PER })
  t.teardown(() => server.close())

  const node = makeFakeNode('review')
  // Pretend we already seed every app the second relay would offer. Match
  // the keyNamespace default ('srv') used inside startMultiPathServer.
  for (let i = 0; i < APPS_PER; i++) {
    node.seededApps.add(fakeAppKey(i, 'srv-r1'))
  }

  const fed = new Federation({ node })
  fed.follow(`http://127.0.0.1:${server.port}/relay-0`)
  fed.follow(`http://127.0.0.1:${server.port}/relay-1`)

  let pollComplete = null
  fed.on('poll-complete', (info) => { pollComplete = info })

  await fed._pollAll()

  t.is(pollComplete.polled, 2, 'poll-complete.polled = follows polled, not queue events')
  t.is(pollComplete.queued, APPS_PER, 'queued counts only newly queued apps (skips seeded ones)')
  t.is(node._pendingRequests.size, APPS_PER, 'pending queue confirms')
})

test('federation poll: single follow with 500-app catalog processes without choking', async (t) => {
  const APPS = 500
  const server = await startSingleBigCatalogServer(APPS)
  t.teardown(() => server.close())

  const node = makeFakeNode('review')
  const fed = new Federation({ node })
  fed.follow(`http://127.0.0.1:${server.port}`)

  let pollComplete = null
  fed.on('poll-complete', (info) => { pollComplete = info })

  const memBefore = process.memoryUsage().heapUsed
  const start = Date.now()
  await fed._pollAll()
  const elapsed = Date.now() - start
  const memAfter = process.memoryUsage().heapUsed
  const grew = memAfter - memBefore

  t.ok(elapsed < 5000, `processed 500-app catalog in ${elapsed}ms`)
  t.is(pollComplete.polled, 1, 'one follow polled')
  t.is(pollComplete.queued, APPS, 'all 500 apps queued')
  t.is(node._pendingRequests.size, APPS, 'pending queue holds 500 apps')
  // Sanity check on memory — 500 small entries should not balloon the heap by
  // anything close to 50 MB. (Usually a few MB at most.)
  t.ok(grew < 50 * 1024 * 1024, `heap grew ${(grew / 1024 / 1024).toFixed(2)} MB processing 500 apps`)
})

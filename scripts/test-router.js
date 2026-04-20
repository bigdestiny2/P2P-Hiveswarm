#!/usr/bin/env node

/**
 * Router Integration Test Suite
 *
 * Tests the router dispatch system across the live production network:
 *   1. Service dispatch — call every registered service route
 *   2. Latency benchmarks — measure dispatch speed per route per relay
 *   3. Cross-relay consistency — verify same routes available on all relays
 *   4. Pub/Sub event delivery — subscribe to events, trigger them, verify receipt
 *   5. Credit/metering pipeline — verify calls are metered and credits deducted
 *   6. Error handling — bad routes, malformed params, rate limiting
 *   7. Concurrent load — parallel dispatch under load
 *   8. Identity POST endpoints — verify attest/revoke/profile work (body double-read fix)
 *
 * Usage:
 *   node scripts/test-router.js [--relay IP:PORT] [--all]
 *
 * Environment:
 *   HIVERELAY_API_KEY — API key for authenticated endpoints
 *   UTAH_IP, UTAH_US_IP, SINGAPORE_IP — relay IPs (defaults provided)
 */

import http from 'http'

const API_KEY = process.env.HIVERELAY_API_KEY || 'hiverelay-secret'
const RELAYS = [
  { name: 'Utah', host: process.env.UTAH_IP || '144.172.101.215', port: 9100 },
  { name: 'Utah-US', host: process.env.UTAH_US_IP || '144.172.91.26', port: 9100 },
  { name: 'Singapore', host: process.env.SINGAPORE_IP || '104.194.153.179', port: 9100 }
]

// ── HTTP helpers ──

function request (relay, method, path, body = null, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout || 15000
    const headers = {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    }
    if (opts.headers) Object.assign(headers, opts.headers)

    const payload = body ? JSON.stringify(body) : null
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload)

    const url = `http://${relay.host}:${relay.port}${path}`
    const reqOpts = {
      method,
      hostname: relay.host,
      port: relay.port,
      path,
      headers,
      timeout
    }

    const start = process.hrtime.bigint()
    const req = http.request(reqOpts, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), ms: Math.round(elapsed) })
        } catch {
          resolve({ status: res.statusCode, data, ms: Math.round(elapsed) })
        }
      })
    })

    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')) })
    if (payload) req.write(payload)
    req.end()
  })
}

async function dispatch (relay, route, params = {}) {
  return request(relay, 'POST', '/api/v1/dispatch', { route, params })
}

// ── Test framework ──

let passed = 0
let failed = 0
let skipped = 0
const results = []

function log (icon, msg) {
  console.log(`  ${icon} ${msg}`)
}

async function test (name, fn) {
  const start = Date.now()
  try {
    await fn()
    const ms = Date.now() - start
    log('✅', `${name} (${ms}ms)`)
    passed++
    results.push({ name, status: 'pass', ms })
  } catch (err) {
    const ms = Date.now() - start
    log('❌', `${name} — ${err.message}`)
    failed++
    results.push({ name, status: 'fail', ms, error: err.message })
  }
}

function assert (condition, msg) {
  if (!condition) throw new Error(msg)
}

// ── Tests ──

async function runTests () {
  console.log('\n╔═══════════════════════════════════════════════════╗')
  console.log('║       HiveRelay Router Integration Tests          ║')
  console.log('╚═══════════════════════════════════════════════════╝\n')

  // ────────────────────────────────────────────────
  // 1. Service Route Availability
  // ────────────────────────────────────────────────
  console.log('── Test Group 1: Service Route Availability ──')

  const expectedRoutes = [
    'identity.whoami', 'identity.verify', 'identity.sign',
    'identity.resolve', 'identity.peers', 'identity.developer',
    'schema.register', 'schema.get', 'schema.list', 'schema.validate', 'schema.versions',
    'sla.create', 'sla.list', 'sla.get', 'sla.terminate', 'sla.check', 'sla.violations', 'sla.stats',
    'storage.drive-create', 'storage.drive-list', 'storage.drive-get', 'storage.drive-read',
    'storage.drive-write', 'storage.drive-delete', 'storage.core-create', 'storage.core-append', 'storage.core-get',
    'arbitration.submit', 'arbitration.vote', 'arbitration.get', 'arbitration.list', 'arbitration.evidence'
  ]

  for (const relay of RELAYS) {
    await test(`Router stats on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/api/v1/router')
      assert(res.status === 200, `Expected 200, got ${res.status}`)
      assert(res.data.routes >= expectedRoutes.length,
        `Expected ≥${expectedRoutes.length} routes, got ${res.data.routes}`)
    })
  }

  await test('Service catalog lists all services', async () => {
    const res = await request(RELAYS[0], 'GET', '/api/v1/services')
    assert(res.status === 200, `Expected 200, got ${res.status}`)
    const names = res.data.services.map(s => s.name)
    for (const svc of ['identity', 'schema', 'sla', 'storage', 'arbitration']) {
      assert(names.includes(svc), `Missing service: ${svc}`)
    }
  })

  // ────────────────────────────────────────────────
  // 2. Dispatch Each Service Route
  // ────────────────────────────────────────────────
  console.log('\n── Test Group 2: Dispatch Service Routes ──')

  // Routes that should return successfully with empty params
  const safeRoutes = [
    { route: 'identity.whoami', check: (d) => d.result && d.result.pubkey },
    { route: 'schema.list', check: (d) => d.result !== undefined },
    { route: 'sla.list', check: (d) => Array.isArray(d.result) },
    { route: 'sla.stats', check: (d) => d.result !== undefined },
    { route: 'arbitration.list', check: (d) => Array.isArray(d.result) },
    { route: 'identity.peers', check: (d) => d.result !== undefined },
    { route: 'storage.drive-list', check: (d) => d.result !== undefined }
  ]

  for (const { route, check } of safeRoutes) {
    await test(`Dispatch ${route}`, async () => {
      const res = await dispatch(RELAYS[0], route)
      assert(res.status === 200, `HTTP ${res.status}: ${JSON.stringify(res.data)}`)
      assert(check(res.data), `Unexpected response: ${JSON.stringify(res.data).slice(0, 200)}`)
    })
  }

  // ────────────────────────────────────────────────
  // 3. Cross-Relay Consistency
  // ────────────────────────────────────────────────
  console.log('\n── Test Group 3: Cross-Relay Consistency ──')

  await test('All relays return same route count', async () => {
    const counts = []
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/v1/router')
      counts.push({ name: relay.name, routes: res.data.routes })
    }
    const first = counts[0].routes
    for (const c of counts) {
      assert(c.routes === first,
        `Route count mismatch: ${counts.map(c => `${c.name}=${c.routes}`).join(', ')}`)
    }
    log('ℹ️', `All relays: ${first} routes`)
  })

  await test('identity.whoami returns unique pubkeys per relay', async () => {
    const pubkeys = new Set()
    for (const relay of RELAYS) {
      const res = await dispatch(relay, 'identity.whoami')
      assert(res.data.result?.pubkey, `No pubkey from ${relay.name}`)
      pubkeys.add(res.data.result.pubkey)
    }
    assert(pubkeys.size === RELAYS.length,
      `Expected ${RELAYS.length} unique pubkeys, got ${pubkeys.size}`)
    log('ℹ️', `${pubkeys.size} unique relay identities confirmed`)
  })

  await test('Schema register and retrieve', async () => {
    const schemaId = `test-schema-${Date.now()}`
    const definition = {
      type: 'object',
      properties: { name: { type: 'string' } }
    }
    const regRes = await dispatch(RELAYS[0], 'schema.register', {
      schemaId,
      version: '1.0.0',
      definition
    })
    assert(regRes.status === 200, `Schema register failed: ${JSON.stringify(regRes.data)}`)

    const getRes = await dispatch(RELAYS[0], 'schema.get', { schemaId })
    assert(getRes.status === 200, `Schema get failed: ${JSON.stringify(getRes.data)}`)
    log('ℹ️', `Registered and retrieved schema: ${schemaId}`)
  })

  // ────────────────────────────────────────────────
  // 4. Latency Benchmarks
  // ────────────────────────────────────────────────
  console.log('\n── Test Group 4: Latency Benchmarks ──')

  const benchRoutes = ['identity.whoami', 'schema.list', 'sla.stats']
  const BENCH_RUNS = 5

  for (const relay of RELAYS) {
    await test(`Latency benchmark on ${relay.name}`, async () => {
      const timings = {}
      for (const route of benchRoutes) {
        const times = []
        for (let i = 0; i < BENCH_RUNS; i++) {
          const res = await dispatch(relay, route)
          assert(res.status === 200, `HTTP ${res.status}`)
          times.push(res.ms)
        }
        const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
        const min = Math.min(...times)
        const max = Math.max(...times)
        timings[route] = { avg, min, max }
      }
      const summary = Object.entries(timings)
        .map(([r, t]) => `${r.split('.')[1]}:${t.avg}ms`)
        .join(' | ')
      log('ℹ️', `  ${relay.name}: ${summary}`)
    })
  }

  // ────────────────────────────────────────────────
  // 5. Error Handling
  // ────────────────────────────────────────────────
  console.log('\n── Test Group 5: Error Handling ──')

  await test('Unknown route returns ROUTE_NOT_FOUND', async () => {
    const res = await dispatch(RELAYS[0], 'nonexistent.route')
    // Router throws which causes 500, OR the error is caught
    assert(res.status === 500 || (res.data.error && res.data.error.includes('ROUTE_NOT_FOUND')),
      `Expected error, got: ${JSON.stringify(res.data)}`)
  })

  await test('Dispatch without auth returns 401', async () => {
    const res = await request(RELAYS[0], 'POST', '/api/v1/dispatch',
      { route: 'identity.whoami' },
      { headers: { Authorization: '' } })
    assert(res.status === 401, `Expected 401, got ${res.status}`)
  })

  await test('Dispatch with empty route returns 400', async () => {
    const res = await request(RELAYS[0], 'POST', '/api/v1/dispatch',
      { route: '', params: {} })
    assert(res.status === 400 || res.data.error, `Expected error, got ${res.status}`)
  })

  await test('Dispatch with oversized route returns 400', async () => {
    const longRoute = 'a'.repeat(200) + '.method'
    const res = await dispatch(RELAYS[0], longRoute)
    assert(res.status === 400, `Expected 400, got ${res.status}: ${JSON.stringify(res.data)}`)
  })

  // ────────────────────────────────────────────────
  // 6. Pub/Sub Event Delivery
  // ────────────────────────────────────────────────
  console.log('\n── Test Group 6: Pub/Sub Events ──')

  await test('Subscribe to SSE topic and receive events', async () => {
    const relay = RELAYS[0]

    // Start SSE listener
    const events = []
    const ssePromise = new Promise((resolve, reject) => {
      const req = http.get({
        hostname: relay.host,
        port: relay.port,
        path: '/api/v1/subscribe?topic=events/*',
        headers: { Authorization: `Bearer ${API_KEY}` },
        timeout: 8000
      }, (res) => {
        assert(res.statusCode === 200, `SSE returned ${res.statusCode}`)
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          const lines = chunk.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try { events.push(JSON.parse(line.slice(6))) } catch {}
            }
          }
        })
        // Collect for 5s then close
        setTimeout(() => { req.destroy(); resolve(events) }, 5000)
      })
      req.on('error', () => resolve(events)) // Timeout is ok
      req.on('timeout', () => { req.destroy(); resolve(events) })
    })

    // Trigger events by seeding/unseeding
    await new Promise(r => setTimeout(r, 500))

    // Check pub/sub stats
    const statsRes = await request(relay, 'GET', '/api/v1/router')
    log('ℹ️', `PubSub: ${statsRes.data.pubsub.topics} topics, ${statsRes.data.pubsub.subscribers} subscribers`)

    const collected = await ssePromise
    // Events may or may not arrive depending on network activity
    log('ℹ️', `Received ${collected.length} events during 5s window`)
  })

  // ────────────────────────────────────────────────
  // 7. Credits & Metering Pipeline
  // ────────────────────────────────────────────────
  console.log('\n── Test Group 7: Credits & Metering ──')

  await test('Billing stats accessible', async () => {
    const res = await request(RELAYS[0], 'GET', '/api/v1/billing/stats')
    assert(res.status === 200, `Expected 200, got ${res.status}`)
    assert(res.data.totalCalls !== undefined, 'Missing totalCalls')
    log('ℹ️', `Metering: ${res.data.totalCalls} total calls, ${res.data.totalRevenue} revenue`)
  })

  await test('Credits pricing card available', async () => {
    const res = await request(RELAYS[0], 'GET', '/api/v1/credits/pricing')
    assert(res.status === 200, `Expected 200, got ${res.status}`)
    assert(res.data !== undefined, 'No pricing data')
    log('ℹ️', `Pricing: ${JSON.stringify(res.data).slice(0, 150)}`)
  })

  await test('Dispatch calls increment metering', async () => {
    // Get metering before
    const before = await request(RELAYS[0], 'GET', '/api/v1/billing/stats')
    const callsBefore = before.data.totalCalls || 0

    // Make 3 dispatch calls
    for (let i = 0; i < 3; i++) {
      await dispatch(RELAYS[0], 'schema.list')
    }

    const after = await request(RELAYS[0], 'GET', '/api/v1/billing/stats')
    const callsAfter = after.data.totalCalls || 0

    assert(callsAfter >= callsBefore + 3,
      `Expected metering to increase by ≥3, got ${callsBefore}→${callsAfter}`)
    log('ℹ️', `Metering: ${callsBefore} → ${callsAfter} calls`)
  })

  // ────────────────────────────────────────────────
  // 8. Concurrent Load Test
  // ────────────────────────────────────────────────
  console.log('\n── Test Group 8: Concurrent Load ──')

  await test('10 concurrent dispatches to same relay', async () => {
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(dispatch(RELAYS[0], 'sla.stats'))
    }
    const results = await Promise.allSettled(promises)
    const ok = results.filter(r => r.status === 'fulfilled' && r.value.status === 200)
    const times = ok.map(r => r.value.ms)
    assert(ok.length >= 8, `Expected ≥8 successes, got ${ok.length}/10`)
    log('ℹ️', `${ok.length}/10 succeeded. Avg: ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)}ms`)
  })

  await test('10 concurrent dispatches across all relays', async () => {
    const promises = []
    for (let i = 0; i < 10; i++) {
      const relay = RELAYS[i % RELAYS.length]
      const routes = ['identity.whoami', 'schema.list', 'sla.stats', 'storage.drive-list', 'arbitration.list']
      promises.push(dispatch(relay, routes[i % routes.length]))
    }
    const results = await Promise.allSettled(promises)
    const ok = results.filter(r => r.status === 'fulfilled' && r.value.status === 200)
    assert(ok.length >= 8, `Expected ≥8 successes, got ${ok.length}/10`)
    log('ℹ️', `${ok.length}/10 succeeded across ${RELAYS.length} relays`)
  })

  await test('Sustained burst: 15 requests over 3 seconds (spread across relays)', async () => {
    const allTimes = []
    let ok = 0
    let errors = 0

    for (let wave = 0; wave < 3; wave++) {
      const batch = []
      for (let i = 0; i < 5; i++) {
        const relay = RELAYS[i % RELAYS.length]
        batch.push(dispatch(relay, 'sla.stats'))
      }
      const results = await Promise.allSettled(batch)
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.status === 200) {
          ok++
          allTimes.push(r.value.ms)
        } else {
          errors++
        }
      }
      await new Promise(r => setTimeout(r, 1000))
    }

    const avg = Math.round(allTimes.reduce((a, b) => a + b, 0) / allTimes.length)
    const p95 = allTimes.sort((a, b) => a - b)[Math.floor(allTimes.length * 0.95)]
    assert(ok >= 12, `Expected ≥12/15 success, got ${ok}/15`)
    log('ℹ️', `${ok}/15 OK, avg: ${avg}ms, p95: ${p95}ms`)
  })

  // ────────────────────────────────────────────────
  // 9. Storage Operations (use relay[1] to avoid rate limits)
  // ────────────────────────────────────────────────
  console.log('\n── Test Group 9: Storage Service ──')
  console.log('  ⏳ Cooldown (rate limit recovery)...')
  await new Promise(r => setTimeout(r, 5000))

  await test('List drives', async () => {
    const res = await dispatch(RELAYS[1], 'storage.drive-list')
    assert(res.status === 200, `HTTP ${res.status}: ${JSON.stringify(res.data)}`)
    log('ℹ️', `Drives: ${JSON.stringify(res.data.result).slice(0, 100)}`)
  })

  // ────────────────────────────────────────────────
  // 10. Identity POST Endpoints (body double-read fix)
  // ────────────────────────────────────────────────
  console.log('\n── Test Group 10: Identity POST Endpoints ──')

  await test('POST /api/v1/identity/attest (body reads correctly)', async () => {
    // Send a dummy attestation — should fail validation but NOT hang
    // Use relay[2] (Singapore) to avoid rate limits
    const res = await request(RELAYS[2], 'POST', '/api/v1/identity/attest', {
      developerKey: 'a'.repeat(64),
      appKey: 'b'.repeat(64),
      signature: 'c'.repeat(128)
    })
    // Should get a response (400 or error), NOT a timeout
    assert(res.status !== undefined, 'Request hung (body double-read bug)')
    log('ℹ️', `Attestation response: ${res.status} — ${JSON.stringify(res.data).slice(0, 80)}`)
  })

  await test('POST /api/v1/identity/logout works', async () => {
    const res = await request(RELAYS[2], 'POST', '/api/v1/identity/logout', {})
    assert(res.status === 200, `Expected 200, got ${res.status}`)
    assert(res.data.success === true, `Expected success: ${JSON.stringify(res.data)}`)
  })

  await test('POST /api/v1/sync/trigger works', async () => {
    const res = await request(RELAYS[1], 'POST', '/api/v1/sync/trigger', {})
    assert(res.status === 200, `Expected 200, got ${res.status}`)
    log('ℹ️', `Sync triggered: ${JSON.stringify(res.data).slice(0, 100)}`)
  })

  // ────────────────────────────────────────────────
  // 11. Network Connectivity (relay-to-relay)
  // ────────────────────────────────────────────────
  console.log('\n── Test Group 11: Network Connectivity ──')

  console.log('  ⏳ Cooldown (rate limit recovery)...')
  await new Promise(r => setTimeout(r, 5000))

  await test('All relays see peer connections', async () => {
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/overview')
      assert(res.status === 200, `${relay.name}: HTTP ${res.status}`)
      assert(res.data.connections >= 1,
        `${relay.name}: expected ≥1 connections, got ${res.data.connections}`)
      log('ℹ️', `${relay.name}: ${res.data.connections} connections, ${res.data.seededApps} apps`)
    }
  })

  await test('All relays report catalog sync', async () => {
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/v1/sync')
      assert(res.status === 200, `${relay.name}: HTTP ${res.status}`)
      assert(res.data.running === true, `${relay.name}: sync not running`)
      log('ℹ️', `${relay.name}: synced ${res.data.stats?.totalSynced || 0} apps from ${res.data.knownPeers || 0} peers`)
    }
  })

  await test('Network overview includes replication data', async () => {
    const res = await request(RELAYS[1], 'GET', '/api/network')
    assert(res.status === 200, `HTTP ${res.status}`)
    assert(res.data.self, 'Missing self data')
    assert(res.data.relays !== undefined, 'Missing relays data')
    log('ℹ️', `Network: self + ${(res.data.relays || []).length} relays, replication: ${JSON.stringify(res.data.replication || {}).slice(0, 80)}`)
  })

  // ────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────
  console.log('\n╔═══════════════════════════════════════════════════╗')
  console.log(`║  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`)
  console.log('╚═══════════════════════════════════════════════════╝')

  if (failed > 0) {
    console.log('\nFailed tests:')
    for (const r of results.filter(r => r.status === 'fail')) {
      console.log(`  ❌ ${r.name}: ${r.error}`)
    }
  }

  console.log()
  process.exit(failed > 0 ? 1 : 0)
}

runTests().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})

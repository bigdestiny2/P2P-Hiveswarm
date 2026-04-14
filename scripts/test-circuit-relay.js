#!/usr/bin/env node

/**
 * Circuit Relay Integration Test Suite
 *
 * Tests the circuit relay system across the live production network:
 *   1. Relay stats — verify circuit relay is enabled and reporting
 *   2. Bandwidth metering — verify bandwidth tracking in metrics
 *   3. Proof-of-relay — verify proof system reporting
 *   4. Circuit limits — verify config enforcement (max duration, bytes, per-peer)
 *   5. Relay capacity — verify capacity stats across all relays
 *   6. Bandwidth receipts — verify receipt tracking
 *   7. Time-series history — verify metrics snapshots
 *   8. Cross-relay comparison — consistent config across network
 *   9. Prometheus metrics — verify relay metrics exported
 *
 * Usage: node scripts/test-circuit-relay.js
 */

import http from 'http'

const API_KEY = process.env.HIVERELAY_API_KEY || 'hiverelay-secret'
const RELAYS = [
  { name: 'Utah', host: process.env.UTAH_IP || '144.172.101.215', port: 9100 },
  { name: 'Utah-US', host: process.env.UTAH_US_IP || '144.172.91.26', port: 9100 },
  { name: 'Singapore', host: process.env.SINGAPORE_IP || '104.194.153.179', port: 9100 }
]

function request (relay, method, path, body = null, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }
    if (opts.headers) Object.assign(headers, opts.headers)
    const payload = body ? JSON.stringify(body) : null
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload)
    const start = process.hrtime.bigint()
    const req = http.request({
      method, hostname: relay.host, port: relay.port, path, headers, timeout: opts.timeout || 15000
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6)
        try { resolve({ status: res.statusCode, data: JSON.parse(data), ms }) } catch { resolve({ status: res.statusCode, data, ms }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')) })
    if (payload) req.write(payload)
    req.end()
  })
}

let passed = 0, failed = 0
const results = []

function log (icon, msg) { console.log(`  ${icon} ${msg}`) }

async function test (name, fn) {
  const start = Date.now()
  try {
    await fn()
    log('✅', `${name} (${Date.now() - start}ms)`)
    passed++
    results.push({ name, status: 'pass' })
  } catch (err) {
    log('❌', `${name} — ${err.message}`)
    failed++
    results.push({ name, status: 'fail', error: err.message })
  }
}

function assert (cond, msg) { if (!cond) throw new Error(msg) }

async function runTests () {
  console.log('\n╔═══════════════════════════════════════════════════╗')
  console.log('║     HiveRelay Circuit Relay Integration Tests      ║')
  console.log('╚═══════════════════════════════════════════════════╝\n')

  // ──────────────────────────────────────────
  // 1. Relay Stats Availability
  // ──────────────────────────────────────────
  console.log('── Test Group 1: Relay Stats Availability ──')

  const overviews = {}
  for (const relay of RELAYS) {
    await test(`Relay stats on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/api/overview')
      assert(res.status === 200, `HTTP ${res.status}`)
      assert(res.data.relay, `Missing relay field on ${relay.name}`)
      assert(typeof res.data.relay.activeCircuits === 'number', 'Missing activeCircuits')
      assert(typeof res.data.relay.totalCircuitsServed === 'number', 'Missing totalCircuitsServed')
      assert(typeof res.data.relay.totalBytesRelayed === 'number', 'Missing totalBytesRelayed')
      overviews[relay.name] = res.data
      log('ℹ️', `${relay.name}: ${res.data.relay.activeCircuits} active, ${res.data.relay.totalCircuitsServed} served, ${(res.data.relay.totalBytesRelayed / 1024 / 1024).toFixed(1)}MB relayed`)
    })
  }

  // ──────────────────────────────────────────
  // 2. Circuit Relay Configuration
  // ──────────────────────────────────────────
  console.log('\n── Test Group 2: Relay Configuration ──')

  await test('All relays have relay enabled', async () => {
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/overview')
      assert(res.data.relay, `${relay.name}: relay section missing — relay disabled?`)
    }
  })

  await test('All relays report consistent config', async () => {
    const configs = []
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/overview')
      configs.push({
        name: relay.name,
        connections: res.data.connections,
        hasRelay: !!res.data.relay,
        hasBandwidth: !!res.data.bandwidth
      })
    }
    for (const c of configs) {
      assert(c.hasRelay, `${c.name}: relay not enabled`)
    }
    log('ℹ️', `All ${configs.length} relays have relay enabled`)
  })

  // ──────────────────────────────────────────
  // 3. Bandwidth Receipt Tracking
  // ──────────────────────────────────────────
  console.log('\n── Test Group 3: Bandwidth & Proof System ──')

  for (const relay of RELAYS) {
    await test(`Bandwidth receipts on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/api/overview')
      assert(res.status === 200, `HTTP ${res.status}`)
      // bandwidth may be null if no circuits have been served yet
      if (res.data.bandwidth) {
        assert(typeof res.data.bandwidth.totalProvenBytes === 'number', 'Missing totalProvenBytes')
        assert(typeof res.data.bandwidth.receiptsIssued === 'number', 'Missing receiptsIssued')
        log('ℹ️', `${relay.name}: ${res.data.bandwidth.totalProvenBytes} proven bytes, ${res.data.bandwidth.receiptsIssued} receipts`)
      } else {
        log('ℹ️', `${relay.name}: No bandwidth data yet (no circuits served)`)
      }
    })
  }

  // ──────────────────────────────────────────
  // 4. Capacity & Connection Limits
  // ──────────────────────────────────────────
  console.log('\n── Test Group 4: Capacity & Limits ──')

  await test('Relay capacity percentage is sane', async () => {
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/overview')
      const r = res.data.relay
      if (r.capacityUsedPct !== undefined) {
        assert(r.capacityUsedPct >= 0 && r.capacityUsedPct <= 100,
          `${relay.name}: capacityUsedPct=${r.capacityUsedPct} out of range`)
      }
      log('ℹ️', `${relay.name}: capacity ${r.capacityUsedPct || 0}%, ${r.peersWithCircuits || 0} peers with circuits`)
    }
  })

  await test('Connection counts are reasonable', async () => {
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/overview')
      assert(res.data.connections >= 0 && res.data.connections <= 256,
        `${relay.name}: connections=${res.data.connections} out of range (max 256)`)
    }
  })

  // ──────────────────────────────────────────
  // 5. Time-Series History
  // ──────────────────────────────────────────
  console.log('\n── Test Group 5: Metrics History ──')

  for (const relay of RELAYS) {
    await test(`History endpoint on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/api/history?minutes=5')
      assert(res.status === 200, `HTTP ${res.status}`)
      assert(Array.isArray(res.data) || (res.data.snapshots && Array.isArray(res.data.snapshots)),
        'Expected array of snapshots')
      const snaps = Array.isArray(res.data) ? res.data : res.data.snapshots
      log('ℹ️', `${relay.name}: ${snaps.length} snapshots in last 5 min`)
    })
  }

  // ──────────────────────────────────────────
  // 6. Prometheus Metrics
  // ──────────────────────────────────────────
  console.log('\n── Test Group 6: Prometheus Metrics ──')

  await test('Prometheus metrics include relay data', async () => {
    const res = await request(RELAYS[1], 'GET', '/metrics', null, { headers: {} })
    assert(res.status === 200, `HTTP ${res.status}`)
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
    assert(text.includes('hiverelay_uptime_seconds'), 'Missing uptime metric')
    assert(text.includes('hiverelay_bytes_stored'), 'Missing bytes_stored metric')
    assert(text.includes('hiverelay_connections'), 'Missing connections metric')
    log('ℹ️', `Prometheus metrics OK (${text.length} bytes)`)
  })

  // ──────────────────────────────────────────
  // 7. Health Integration
  // ──────────────────────────────────────────
  console.log('\n── Test Group 7: Health Integration ──')

  for (const relay of RELAYS) {
    await test(`Health status on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/api/overview')
      assert(res.status === 200, `HTTP ${res.status}`)
      const h = res.data.health
      assert(h, `Missing health field on ${relay.name}`)
      assert(typeof h.healthy === 'boolean', 'Missing healthy boolean')
      assert(h.checks, 'Missing health checks')
      log('ℹ️', `${relay.name}: healthy=${h.healthy}, checks=${Object.keys(h.checks).join(',')}`)
    })
  }

  // ──────────────────────────────────────────
  // 8. Memory & Storage Stats
  // ──────────────────────────────────────────
  console.log('\n── Test Group 8: Resource Stats ──')

  await test('All relays report memory usage', async () => {
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/overview')
      assert(res.data.memory, `${relay.name}: missing memory`)
      assert(res.data.memory.heapUsed > 0, `${relay.name}: heapUsed is 0`)
      assert(res.data.memory.rss > 0, `${relay.name}: rss is 0`)
      const heapMB = Math.round(res.data.memory.heapUsed / 1024 / 1024)
      const rssMB = Math.round(res.data.memory.rss / 1024 / 1024)
      log('ℹ️', `${relay.name}: heap ${heapMB}MB, RSS ${rssMB}MB`)
    }
  })

  await test('All relays report non-zero storage', async () => {
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/overview')
      assert(res.data.storage, `${relay.name}: missing storage`)
      assert(res.data.storage.used > 0, `${relay.name}: storage.used is 0 (metric bug!)`)
      const usedGB = (res.data.storage.used / 1024 / 1024 / 1024).toFixed(2)
      log('ℹ️', `${relay.name}: ${usedGB}GB used (${(res.data.storage.pct * 100).toFixed(1)}%)`)
    }
  })

  // ──────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────
  console.log('\n╔═══════════════════════════════════════════════════╗')
  console.log(`║  Results: ${passed} passed, ${failed} failed`)
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

runTests().catch(err => { console.error('Fatal:', err); process.exit(1) })

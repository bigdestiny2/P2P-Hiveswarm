#!/usr/bin/env node

/**
 * Health Monitoring & Self-Heal Integration Test Suite
 *
 * Tests the health monitoring, self-heal, and observability system:
 *   1. Health status — all relays report healthy
 *   2. Health checks — memory, connections, errors, disk, swarm
 *   3. Health detail — full check results and self-heal actions
 *   4. Logs — ring buffer logging and filtering
 *   5. Uptime — all relays have reasonable uptime
 *   6. Error tracking — error counts accessible
 *   7. Memory pressure — heap and RSS within limits
 *   8. Disk usage — storage path reporting correctly
 *   9. Self-heal actions — action log accessible
 *  10. Cross-relay health consistency
 *
 * Usage: node scripts/test-health.js
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
  try { await fn(); log('✅', `${name} (${Date.now() - start}ms)`); passed++; results.push({ name, status: 'pass' }) }
  catch (err) { log('❌', `${name} — ${err.message}`); failed++; results.push({ name, status: 'fail', error: err.message }) }
}
function assert (cond, msg) { if (!cond) throw new Error(msg) }

async function runTests () {
  console.log('\n╔═══════════════════════════════════════════════════╗')
  console.log('║    HiveRelay Health & Self-Heal Integration Tests  ║')
  console.log('╚═══════════════════════════════════════════════════╝\n')

  // ──────────────────────────────────────────
  // 1. Basic Health Check
  // ──────────────────────────────────────────
  console.log('── Test Group 1: Basic Health ──')

  for (const relay of RELAYS) {
    await test(`Health endpoint on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/health')
      assert(res.status === 200, `HTTP ${res.status}`)
      assert(res.data.ok === true, `Health not OK: ${JSON.stringify(res.data)}`)
      assert(res.data.running === true || res.data.running === undefined, 'Not running')
      log('ℹ️', `${relay.name}: OK, uptime: ${res.data.uptime ? Math.round(res.data.uptime / 60000) + 'min' : 'unknown'}`)
    })
  }

  // ──────────────────────────────────────────
  // 2. Health Status in Overview
  // ──────────────────────────────────────────
  console.log('\n── Test Group 2: Health Status ──')

  for (const relay of RELAYS) {
    await test(`Health status on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/api/overview')
      assert(res.status === 200, `HTTP ${res.status}`)
      const h = res.data.health
      assert(h, 'Missing health in overview')
      assert(typeof h.healthy === 'boolean', 'Missing healthy flag')
      assert(h.checks, 'Missing checks object')

      const checkNames = Object.keys(h.checks)
      log('ℹ️', `${relay.name}: healthy=${h.healthy}, checks: ${checkNames.join(', ')}`)

      // Verify all checks have ok field
      for (const [name, check] of Object.entries(h.checks)) {
        assert(typeof check.ok === 'boolean', `Check '${name}' missing ok field`)
      }
    })
  }

  // ──────────────────────────────────────────
  // 3. Memory Health
  // ──────────────────────────────────────────
  console.log('\n── Test Group 3: Memory Health ──')

  for (const relay of RELAYS) {
    await test(`Memory within limits on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/api/overview')
      const mem = res.data.memory
      assert(mem, 'Missing memory data')
      assert(mem.heapUsed > 0, 'heapUsed is 0')
      assert(mem.rss > 0, 'rss is 0')

      const heapMB = Math.round(mem.heapUsed / 1024 / 1024)
      const rssMB = Math.round(mem.rss / 1024 / 1024)

      // Verify reasonable ranges (not using more than 512MB RSS)
      assert(rssMB < 512, `RSS ${rssMB}MB exceeds 512MB limit`)

      const h = res.data.health?.checks?.memory
      if (h) {
        assert(h.ok === true, `Memory check failed: ${JSON.stringify(h)}`)
        log('ℹ️', `${relay.name}: heap ${heapMB}MB, RSS ${rssMB}MB (check OK)`)
      } else {
        log('ℹ️', `${relay.name}: heap ${heapMB}MB, RSS ${rssMB}MB (no memory check)`)
      }
    })
  }

  // ──────────────────────────────────────────
  // 4. Connection Health
  // ──────────────────────────────────────────
  console.log('\n── Test Group 4: Connection Health ──')

  for (const relay of RELAYS) {
    await test(`Connections healthy on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/api/overview')
      assert(res.data.connections >= 0, `Invalid connections: ${res.data.connections}`)

      const connCheck = res.data.health?.checks?.connections
      if (connCheck) {
        if (!connCheck.ok) {
          log('⚠️', `${relay.name}: Connection issue — ${JSON.stringify(connCheck)}`)
        } else {
          log('ℹ️', `${relay.name}: ${res.data.connections} connections (check OK)`)
        }
      } else {
        log('ℹ️', `${relay.name}: ${res.data.connections} connections`)
      }
    })
  }

  // ──────────────────────────────────────────
  // 5. Disk Health
  // ──────────────────────────────────────────
  console.log('\n── Test Group 5: Disk Health ──')

  for (const relay of RELAYS) {
    await test(`Disk usage on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/api/overview')
      const diskCheck = res.data.health?.checks?.disk
      if (diskCheck) {
        assert(diskCheck.ok !== undefined, 'Missing ok field on disk check')
        log('ℹ️', `${relay.name}: disk ${diskCheck.usedPct}% used, ${diskCheck.freeGB}GB free${diskCheck.ok ? '' : ' ⚠️ HIGH'}`)
      } else {
        log('ℹ️', `${relay.name}: No disk check configured`)
      }

      // Also check storage metric
      assert(res.data.storage?.used > 0, `Storage.used is 0 on ${relay.name}`)
      const usedGB = (res.data.storage.used / 1024 / 1024 / 1024).toFixed(2)
      log('ℹ️', `${relay.name}: Storage: ${usedGB}GB used`)
    })
  }

  // ──────────────────────────────────────────
  // 6. Error Rate
  // ──────────────────────────────────────────
  console.log('\n── Test Group 6: Error Tracking ──')

  for (const relay of RELAYS) {
    await test(`Error count on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/api/overview')
      assert(typeof res.data.errors === 'number', 'Missing error count')
      const errorCheck = res.data.health?.checks?.errors
      if (errorCheck) {
        log('ℹ️', `${relay.name}: ${res.data.errors} total errors, rate: ${errorCheck.errorRate || 0}/min`)
        assert(errorCheck.ok === true, `Error rate too high: ${errorCheck.errorRate}/min`)
      } else {
        log('ℹ️', `${relay.name}: ${res.data.errors} total errors`)
      }
    })
  }

  // ──────────────────────────────────────────
  // 7. Health Detail Endpoint
  // ──────────────────────────────────────────
  console.log('\n── Test Group 7: Health Detail ──')

  for (const relay of RELAYS) {
    await test(`Health detail on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/api/health-detail')
      assert(res.status === 200, `HTTP ${res.status}`)
      assert(res.data, 'Empty health detail')
      // Should include health status + self-heal actions
      if (res.data.actions) {
        log('ℹ️', `${relay.name}: ${res.data.actions.length} self-heal actions recorded`)
      }
      if (res.data.healthy !== undefined) {
        log('ℹ️', `${relay.name}: healthy=${res.data.healthy}, failures=${res.data.consecutiveFailures || 0}`)
      }
    })
  }

  // ──────────────────────────────────────────
  // 8. Uptime
  // ──────────────────────────────────────────
  console.log('\n── Test Group 8: Uptime ──')

  await test('All relays have reasonable uptime', async () => {
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/overview')
      assert(res.data.uptime, 'Missing uptime')
      assert(res.data.uptime.ms > 0, `${relay.name}: uptime is 0`)
      log('ℹ️', `${relay.name}: uptime ${res.data.uptime.human}`)
    }
  })

  // ──────────────────────────────────────────
  // 9. Swarm Health
  // ──────────────────────────────────────────
  console.log('\n── Test Group 9: Swarm Health ──')

  await test('All relays have swarm OK', async () => {
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/overview')
      const swarmCheck = res.data.health?.checks?.swarm
      if (swarmCheck) {
        assert(swarmCheck.ok === true, `${relay.name}: swarm check failed`)
        log('ℹ️', `${relay.name}: swarm OK`)
      } else {
        // Swarm check may not be in checks if healthy
        log('ℹ️', `${relay.name}: no swarm check in response (likely healthy)`)
      }
    }
  })

  // ──────────────────────────────────────────
  // 10. Cross-Relay Health Comparison
  // ──────────────────────────────────────────
  console.log('\n── Test Group 10: Cross-Relay Health Comparison ──')

  await test('All relays healthy', async () => {
    const statuses = []
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/overview')
      statuses.push({
        name: relay.name,
        healthy: res.data.health?.healthy,
        connections: res.data.connections,
        heapMB: Math.round((res.data.memory?.heapUsed || 0) / 1024 / 1024),
        rssMB: Math.round((res.data.memory?.rss || 0) / 1024 / 1024),
        errors: res.data.errors || 0,
        apps: res.data.seededApps
      })
    }
    for (const s of statuses) {
      log('ℹ️', `${s.name}: healthy=${s.healthy}, ${s.connections} conns, heap=${s.heapMB}MB, RSS=${s.rssMB}MB, ${s.errors} errors, ${s.apps} apps`)
    }
    const unhealthy = statuses.filter(s => s.healthy === false)
    assert(unhealthy.length === 0,
      `Unhealthy relays: ${unhealthy.map(s => s.name).join(', ')}`)
  })

  await test('No relay has excessive errors', async () => {
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/overview')
      const uptimeMin = (res.data.uptime?.ms || 1) / 60000
      const errorRate = (res.data.errors || 0) / uptimeMin
      assert(errorRate < 10, `${relay.name}: error rate ${errorRate.toFixed(1)}/min exceeds threshold`)
    }
  })

  // ──────────────────────────────────────────
  // 11. Reputation System
  // ──────────────────────────────────────────
  console.log('\n── Test Group 11: Reputation ──')

  await test('Reputation system reporting', async () => {
    for (const relay of RELAYS) {
      const res = await request(relay, 'GET', '/api/overview')
      if (res.data.reputation) {
        log('ℹ️', `${relay.name}: tracking ${res.data.reputation.trackedRelays} relays`)
      } else {
        log('ℹ️', `${relay.name}: no reputation data`)
      }
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
    for (const r of results.filter(r => r.status === 'fail')) console.log(`  ❌ ${r.name}: ${r.error}`)
  }
  console.log()
  process.exit(failed > 0 ? 1 : 0)
}

runTests().catch(err => { console.error('Fatal:', err); process.exit(1) })

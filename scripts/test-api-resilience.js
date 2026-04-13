#!/usr/bin/env /opt/homebrew/bin/node

/**
 * HiveRelay HTTP API Resilience Test
 *
 * Tests all HTTP endpoints on both local and Cloudzy relays:
 *   1. Endpoint coverage: /health, /status, /metrics, /api/overview, /api/history, /api/apps, /api/peers, /dashboard
 *   2. Response time measurement + JSON/HTML validation
 *   3. Rapid-fire: 50 concurrent requests to /status
 *   4. Invalid routes: 404 for /nonexistent, 405 for POST /status
 *   5. CORS headers
 *   6. Dashboard HTML well-formedness
 *
 * Usage:
 *   /opt/homebrew/bin/node scripts/test-api-resilience.js
 */

// Configure relays via HIVERELAY_TEST_RELAYS env var (comma-separated name=url pairs)
// Example: HIVERELAY_TEST_RELAYS="Local=http://127.0.0.1:9100,Production=http://relay.example.com:9100"
const RELAYS = (process.env.HIVERELAY_TEST_RELAYS || 'Local=http://127.0.0.1:9100')
  .split(',').map(s => {
    const [name, base] = s.trim().split('=')
    return { name, base }
  })

const JSON_ENDPOINTS = ['/health', '/status', '/metrics', '/api/overview', '/api/history', '/api/apps', '/api/peers']
const HTML_ENDPOINTS = ['/dashboard']
const ALL_ENDPOINTS = [...JSON_ENDPOINTS, ...HTML_ENDPOINTS]

let passed = 0
let failed = 0
const results = []

function log (msg) { console.log('  ' + msg) }
function pass (name, detail) {
  passed++
  results.push({ name, ok: true })
  log(`[PASS] ${name}` + (detail ? ` (${detail})` : ''))
}
function fail (name, err) {
  failed++
  results.push({ name, ok: false, error: String(err) })
  log(`[FAIL] ${name}: ${err}`)
}

async function timedFetch (url, opts = {}) {
  const start = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    const ms = Math.round(performance.now() - start)
    const body = await res.text()
    clearTimeout(timeout)
    return { res, body, ms }
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
}

// ── Section 1 & 2: Hit every endpoint on both relays ──────────────────────

async function testEndpoints () {
  console.log('\n=== Section 1-2: Endpoint coverage + response validation ===\n')

  for (const relay of RELAYS) {
    console.log(`  --- ${relay.name} (${relay.base}) ---`)

    for (const ep of JSON_ENDPOINTS) {
      const testName = `${relay.name} GET ${ep}`
      try {
        const { res, body, ms } = await timedFetch(relay.base + ep)
        if (res.status !== 200) {
          fail(testName, `HTTP ${res.status}`)
          continue
        }
        // Validate JSON
        try {
          JSON.parse(body)
        } catch {
          fail(testName, 'Response is not valid JSON')
          continue
        }
        pass(testName, `${ms}ms`)
      } catch (err) {
        fail(testName, err.message || err)
      }
    }

    for (const ep of HTML_ENDPOINTS) {
      const testName = `${relay.name} GET ${ep}`
      try {
        const { res, body, ms } = await timedFetch(relay.base + ep)
        if (res.status !== 200) {
          fail(testName, `HTTP ${res.status}`)
          continue
        }
        if (!body.includes('<html') && !body.includes('<!DOCTYPE') && !body.includes('<!doctype')) {
          fail(testName, 'Response does not look like HTML')
          continue
        }
        pass(testName, `${ms}ms`)
      } catch (err) {
        fail(testName, err.message || err)
      }
    }
  }
}

// ── Section 3: Rapid-fire 50 requests ─────────────────────────────────────

async function testRapidFire () {
  console.log('\n=== Section 3: Rapid-fire 50 requests to /status ===\n')

  for (const relay of RELAYS) {
    const testName = `${relay.name} rapid-fire 50x /status`
    try {
      const start = performance.now()
      const promises = Array.from({ length: 50 }, () =>
        timedFetch(relay.base + '/status').then(r => ({
          ok: r.res.status === 200,
          ms: r.ms,
        })).catch(err => ({ ok: false, ms: -1, error: err.message }))
      )
      const results50 = await Promise.all(promises)
      const totalMs = Math.round(performance.now() - start)
      const successes = results50.filter(r => r.ok).length
      const failures = results50.filter(r => !r.ok).length
      const times = results50.filter(r => r.ms > 0).map(r => r.ms)
      const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0
      const max = times.length ? Math.max(...times) : 0
      const min = times.length ? Math.min(...times) : 0

      if (failures > 5) {
        fail(testName, `${failures}/50 failed (avg ${avg}ms, max ${max}ms, total ${totalMs}ms)`)
      } else {
        pass(testName, `${successes}/50 ok, avg ${avg}ms, min ${min}ms, max ${max}ms, total ${totalMs}ms` +
          (failures > 0 ? `, ${failures} failures` : ''))
      }
    } catch (err) {
      fail(testName, err.message || err)
    }
  }
}

// ── Section 4: Invalid routes ─────────────────────────────────────────────

async function testInvalidRoutes () {
  console.log('\n=== Section 4: Invalid routes (404/405) ===\n')

  for (const relay of RELAYS) {
    // GET /nonexistent -> expect 404
    {
      const testName = `${relay.name} GET /nonexistent -> 404`
      try {
        const { res, ms } = await timedFetch(relay.base + '/nonexistent')
        if (res.status === 404) {
          pass(testName, `${ms}ms`)
        } else {
          fail(testName, `Expected 404, got ${res.status}`)
        }
      } catch (err) {
        fail(testName, err.message || err)
      }
    }

    // POST /status -> expect 404 or 405
    {
      const testName = `${relay.name} POST /status -> 404 or 405`
      try {
        const { res, ms } = await timedFetch(relay.base + '/status', { method: 'POST' })
        if (res.status === 404 || res.status === 405) {
          pass(testName, `HTTP ${res.status}, ${ms}ms`)
        } else {
          // Some servers still return 200 for POST on GET-only routes; note it
          fail(testName, `Expected 404/405, got ${res.status}`)
        }
      } catch (err) {
        fail(testName, err.message || err)
      }
    }

    // DELETE /health -> expect 404 or 405
    {
      const testName = `${relay.name} DELETE /health -> 404 or 405`
      try {
        const { res, ms } = await timedFetch(relay.base + '/health', { method: 'DELETE' })
        if (res.status === 404 || res.status === 405) {
          pass(testName, `HTTP ${res.status}, ${ms}ms`)
        } else {
          fail(testName, `Expected 404/405, got ${res.status}`)
        }
      } catch (err) {
        fail(testName, err.message || err)
      }
    }

    // PUT /api/overview -> expect 404 or 405
    {
      const testName = `${relay.name} PUT /api/overview -> 404 or 405`
      try {
        const { res, ms } = await timedFetch(relay.base + '/api/overview', { method: 'PUT' })
        if (res.status === 404 || res.status === 405) {
          pass(testName, `HTTP ${res.status}, ${ms}ms`)
        } else {
          fail(testName, `Expected 404/405, got ${res.status}`)
        }
      } catch (err) {
        fail(testName, err.message || err)
      }
    }
  }
}

// ── Section 5: CORS headers ──────────────────────────────────────────────

async function testCORS () {
  console.log('\n=== Section 5: CORS headers ===\n')

  for (const relay of RELAYS) {
    const testName = `${relay.name} CORS headers on /status`
    try {
      const { res, ms } = await timedFetch(relay.base + '/status')
      const acao = res.headers.get('access-control-allow-origin')
      if (acao) {
        pass(testName, `access-control-allow-origin: ${acao}, ${ms}ms`)
      } else {
        fail(testName, 'No access-control-allow-origin header found')
      }
    } catch (err) {
      fail(testName, err.message || err)
    }

    // Also test OPTIONS preflight
    const preflightName = `${relay.name} OPTIONS preflight /status`
    try {
      const { res, ms } = await timedFetch(relay.base + '/status', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://example.com',
          'Access-Control-Request-Method': 'GET',
        },
      })
      const acao = res.headers.get('access-control-allow-origin')
      if (acao) {
        pass(preflightName, `ACAO: ${acao}, status ${res.status}, ${ms}ms`)
      } else {
        fail(preflightName, `No ACAO header, status ${res.status}`)
      }
    } catch (err) {
      fail(preflightName, err.message || err)
    }
  }
}

// ── Section 6: Dashboard HTML well-formedness ─────────────────────────────

async function testDashboardHTML () {
  console.log('\n=== Section 6: Dashboard HTML well-formedness ===\n')

  const requiredTags = ['<html', '</html>', '<head', '</head>', '<body', '</body>', '<script']

  for (const relay of RELAYS) {
    const testName = `${relay.name} dashboard HTML structure`
    try {
      const { res, body, ms } = await timedFetch(relay.base + '/dashboard')
      if (res.status !== 200) {
        fail(testName, `HTTP ${res.status}`)
        continue
      }

      const lower = body.toLowerCase()
      const missing = requiredTags.filter(tag => !lower.includes(tag.toLowerCase()))
      if (missing.length > 0) {
        fail(testName, `Missing tags: ${missing.join(', ')}`)
      } else {
        const sizeKB = (body.length / 1024).toFixed(1)
        pass(testName, `All required tags present, ${sizeKB}KB, ${ms}ms`)
      }
    } catch (err) {
      fail(testName, err.message || err)
    }

    // Check for DOCTYPE
    const doctypeName = `${relay.name} dashboard has DOCTYPE`
    try {
      const { body } = await timedFetch(relay.base + '/dashboard')
      const trimmed = body.trimStart().toLowerCase()
      if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
        pass(doctypeName)
      } else {
        fail(doctypeName, `Starts with: ${trimmed.slice(0, 40)}...`)
      }
    } catch (err) {
      fail(doctypeName, err.message || err)
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main () {
  console.log('=========================================')
  console.log('  HiveRelay HTTP API Resilience Test')
  console.log('=========================================')
  console.log(`  Relays: ${RELAYS.map(r => r.name + ' (' + r.base + ')').join(', ')}`)
  console.log(`  Date: ${new Date().toISOString()}`)

  const globalStart = performance.now()

  await testEndpoints()
  await testRapidFire()
  await testInvalidRoutes()
  await testCORS()
  await testDashboardHTML()

  const totalSec = ((performance.now() - globalStart) / 1000).toFixed(2)

  console.log('\n=========================================')
  console.log('  SUMMARY')
  console.log('=========================================')
  console.log(`  Total : ${passed + failed} tests`)
  console.log(`  Passed: ${passed}`)
  console.log(`  Failed: ${failed}`)
  console.log(`  Time  : ${totalSec}s`)
  console.log('=========================================')

  if (failed > 0) {
    console.log('\n  Failed tests:')
    for (const r of results) {
      if (!r.ok) console.log(`    - ${r.name}: ${r.error}`)
    }
  }

  console.log()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(2)
})

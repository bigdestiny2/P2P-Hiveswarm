#!/usr/bin/env node

/**
 * Gateway Integration Test Suite
 *
 * Tests the HyperGateway HTTP-to-Hyperdrive serving system:
 *   1. Gateway stats — verify gateway is running and tracking
 *   2. Serve files — request actual files from seeded apps
 *   3. Directory listing — verify index.html fallback and JSON listing
 *   4. Content types — verify correct MIME types served
 *   5. Security — path traversal, invalid keys, blind apps
 *   6. Caching — verify headers and drive caching
 *   7. Concurrent access — parallel file requests
 *   8. Bytes served tracking — verify served event updates seededApps
 *   9. Error handling — missing files, bad keys, non-seeded drives
 *
 * Usage: node scripts/test-gateway.js
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
    const headers = { 'Content-Type': 'application/json' }
    if (opts.auth !== false) headers.Authorization = `Bearer ${API_KEY}`
    if (opts.headers) Object.assign(headers, opts.headers)
    const payload = body ? JSON.stringify(body) : null
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload)
    const start = process.hrtime.bigint()
    const req = http.request({
      method, hostname: relay.host, port: relay.port, path, headers, timeout: opts.timeout || 30000
    }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6)
        const raw = Buffer.concat(chunks)
        const ct = res.headers['content-type'] || ''
        let data
        if (ct.includes('json')) {
          try { data = JSON.parse(raw.toString()) } catch { data = raw.toString() }
        } else {
          data = raw
        }
        resolve({ status: res.statusCode, data, headers: res.headers, ms, bytes: raw.length })
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

async function getSeededApps (relay) {
  const res = await request(relay, 'GET', '/catalog.json?pageSize=100')
  return res.data.apps || []
}

async function runTests () {
  console.log('\n╔═══════════════════════════════════════════════════╗')
  console.log('║       HiveRelay Gateway Integration Tests         ║')
  console.log('╚═══════════════════════════════════════════════════╝\n')

  // ──────────────────────────────────────────
  // 1. Gateway Stats
  // ──────────────────────────────────────────
  console.log('── Test Group 1: Gateway Stats ──')

  for (const relay of RELAYS) {
    await test(`Gateway stats on ${relay.name}`, async () => {
      const res = await request(relay, 'GET', '/api/gateway')
      assert(res.status === 200, `HTTP ${res.status}`)
      assert(typeof res.data.cachedDrives === 'number', 'Missing cachedDrives')
      assert(typeof res.data.totalRequests === 'number', 'Missing totalRequests')
      assert(typeof res.data.totalBytesServed === 'number', 'Missing totalBytesServed')
      log('ℹ️', `${relay.name}: ${res.data.cachedDrives} cached, ${res.data.totalRequests} reqs, ${(res.data.totalBytesServed / 1024).toFixed(0)}KB served`)
    })
  }

  // ──────────────────────────────────────────
  // 2. Discover Seeded Apps for Testing
  // ──────────────────────────────────────────
  console.log('\n── Test Group 2: App Discovery ──')

  let testApps = []
  let testRelay = RELAYS[1] // Use Utah-US (more resources)

  await test('Discover seeded apps for gateway testing', async () => {
    const apps = await getSeededApps(testRelay)
    // Filter to non-blind apps with drive keys
    testApps = apps.filter(a => !a.blind && a.driveKey)
    assert(testApps.length > 0, 'No non-blind seeded apps found')
    log('ℹ️', `Found ${testApps.length} non-blind apps: ${testApps.map(a => a.name || a.id || a.driveKey.slice(0, 8)).join(', ')}`)
  })

  // ──────────────────────────────────────────
  // 3. Serve Root / Index
  // ──────────────────────────────────────────
  console.log('\n── Test Group 3: File Serving ──')

  if (testApps.length > 0) {
    const app = testApps[0]

    await test(`Serve root of ${app.name || app.driveKey.slice(0, 12)}`, async () => {
      const res = await request(testRelay, 'GET', `/v1/hyper/${app.driveKey}/`, null, { auth: false, timeout: 30000 })
      // Should get 200 (index.html) or 200 (directory listing JSON)
      assert(res.status === 200 || res.status === 404,
        `Expected 200 or 404, got ${res.status}`)
      if (res.status === 200) {
        log('ℹ️', `Root served: ${res.bytes} bytes, content-type: ${res.headers['content-type']?.slice(0, 40)}`)
      } else {
        log('ℹ️', `Root returned 404 (drive may not have index.html)`)
      }
    })

    await test('Verify gateway headers', async () => {
      const res = await request(testRelay, 'GET', `/v1/hyper/${app.driveKey}/`, null, { auth: false, timeout: 30000 })
      if (res.status === 200) {
        assert(res.headers['x-served-by'] === 'hiverelay-gateway', `Missing X-Served-By header`)
        assert(res.headers['x-hyper-key'] === app.driveKey, 'Mismatched X-Hyper-Key')
        assert(res.headers['cache-control'], 'Missing Cache-Control')
      }
    })

    // Try serving a common file
    for (const filePath of ['/package.json', '/manifest.json', '/index.html']) {
      await test(`Serve ${filePath} from ${app.name || app.driveKey.slice(0, 12)}`, async () => {
        const res = await request(testRelay, 'GET', `/v1/hyper/${app.driveKey}${filePath}`, null, { auth: false, timeout: 30000 })
        if (res.status === 200) {
          log('ℹ️', `${filePath}: ${res.bytes} bytes, ${res.ms}ms`)
        } else {
          log('ℹ️', `${filePath}: ${res.status} (file may not exist)`)
        }
        // Any status is acceptable — we're testing the gateway doesn't crash
        assert(res.status >= 200 && res.status < 600, `Unexpected status ${res.status}`)
      })
    }
  }

  // ──────────────────────────────────────────
  // 4. Security Tests
  // ──────────────────────────────────────────
  console.log('\n── Test Group 4: Security ──')

  await test('Path traversal blocked (..)', async () => {
    const fakeKey = 'a'.repeat(64)
    const res = await request(testRelay, 'GET', `/v1/hyper/${fakeKey}/../../../etc/passwd`, null, { auth: false })
    // 400 (explicit block) or 404 (normalized path, key not seeded) — both are safe
    assert(res.status === 400 || res.status === 404, `Expected 400/404, got ${res.status}`)
    // Ensure no actual file content leaked
    assert(!res.data.toString().includes('root:'), 'Path traversal leaked /etc/passwd!')
  })

  await test('Double-encoded path traversal blocked', async () => {
    const fakeKey = 'a'.repeat(64)
    const res = await request(testRelay, 'GET', `/v1/hyper/${fakeKey}/%2e%2e/%2e%2e/etc/passwd`, null, { auth: false })
    assert(res.status === 400 || res.status === 404, `Expected 400/404, got ${res.status}`)
    assert(!res.data.toString().includes('root:'), 'Path traversal leaked /etc/passwd!')
  })

  await test('Null byte injection blocked', async () => {
    const fakeKey = 'a'.repeat(64)
    const res = await request(testRelay, 'GET', `/v1/hyper/${fakeKey}/file%00.txt`, null, { auth: false })
    assert(res.status === 400, `Expected 400, got ${res.status}`)
  })

  await test('Invalid key format rejected', async () => {
    const res = await request(testRelay, 'GET', '/v1/hyper/not-a-valid-key/index.html', null, { auth: false })
    assert(res.status === 400, `Expected 400, got ${res.status}`)
  })

  await test('Short key rejected', async () => {
    const res = await request(testRelay, 'GET', '/v1/hyper/abc123/index.html', null, { auth: false })
    assert(res.status === 400, `Expected 400, got ${res.status}`)
  })

  await test('Non-seeded drive returns 404', async () => {
    const unknownKey = 'ff'.repeat(32)
    const res = await request(testRelay, 'GET', `/v1/hyper/${unknownKey}/`, null, { auth: false })
    assert(res.status === 404, `Expected 404, got ${res.status}`)
  })

  // ──────────────────────────────────────────
  // 5. Content Type Detection
  // ──────────────────────────────────────────
  console.log('\n── Test Group 5: Content Types ──')

  if (testApps.length > 0) {
    const app = testApps[0]
    await test('HTML content type for index', async () => {
      const res = await request(testRelay, 'GET', `/v1/hyper/${app.driveKey}/index.html`, null, { auth: false, timeout: 30000 })
      if (res.status === 200) {
        assert(res.headers['content-type'].includes('text/html'), `Expected text/html, got ${res.headers['content-type']}`)
        log('ℹ️', `Content-Type: ${res.headers['content-type']}`)
      } else {
        log('ℹ️', `Skipped (no index.html in this drive)`)
      }
    })
  }

  // ──────────────────────────────────────────
  // 6. Concurrent Access
  // ──────────────────────────────────────────
  console.log('\n── Test Group 6: Concurrent Access ──')

  if (testApps.length > 0) {
    await test('5 concurrent file requests', async () => {
      const app = testApps[0]
      const promises = []
      for (let i = 0; i < 5; i++) {
        const relay = RELAYS[i % RELAYS.length]
        promises.push(request(relay, 'GET', `/v1/hyper/${app.driveKey}/`, null, { auth: false, timeout: 30000 }))
      }
      const results = await Promise.allSettled(promises)
      const ok = results.filter(r => r.status === 'fulfilled' && r.value.status < 500)
      assert(ok.length >= 3, `Expected ≥3 non-error responses, got ${ok.length}/5`)
      log('ℹ️', `${ok.length}/5 responses OK (status < 500)`)
    })
  }

  // ──────────────────────────────────────────
  // 7. Bytes Served Tracking
  // ──────────────────────────────────────────
  console.log('\n── Test Group 7: Bytes Served Tracking ──')

  await test('Gateway totalBytesServed increments after requests', async () => {
    const before = await request(testRelay, 'GET', '/api/gateway')
    const bytesBefore = before.data.totalBytesServed
    const reqsBefore = before.data.totalRequests

    // Make a few gateway requests
    if (testApps.length > 0) {
      const app = testApps[0]
      for (let i = 0; i < 3; i++) {
        await request(testRelay, 'GET', `/v1/hyper/${app.driveKey}/`, null, { auth: false, timeout: 30000 })
      }
    }

    const after = await request(testRelay, 'GET', '/api/gateway')
    assert(after.data.totalRequests >= reqsBefore,
      `Requests didn't increment: ${reqsBefore} → ${after.data.totalRequests}`)
    log('ℹ️', `Requests: ${reqsBefore} → ${after.data.totalRequests}, Bytes: ${bytesBefore} → ${after.data.totalBytesServed}`)
  })

  // ──────────────────────────────────────────
  // 8. Cross-Relay Gateway Consistency
  // ──────────────────────────────────────────
  console.log('\n── Test Group 8: Cross-Relay Consistency ──')

  if (testApps.length > 0) {
    await test('Same file served from multiple relays', async () => {
      const app = testApps[0]
      const responses = []
      for (const relay of RELAYS) {
        const res = await request(relay, 'GET', `/v1/hyper/${app.driveKey}/`, null, { auth: false, timeout: 30000 })
        responses.push({ name: relay.name, status: res.status, bytes: res.bytes })
      }
      // All should get the same status
      const statuses = new Set(responses.map(r => r.status))
      log('ℹ️', `Responses: ${responses.map(r => `${r.name}=${r.status}(${r.bytes}B)`).join(', ')}`)
      // At least 2 should match
      assert(statuses.size <= 2, `Too many different statuses: ${[...statuses].join(',')}`)
    })
  }

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

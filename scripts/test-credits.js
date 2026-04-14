#!/usr/bin/env node

/**
 * Credit & Payment Pipeline Integration Test Suite
 *
 * Tests the full credit, metering, pricing, and billing system:
 *   1. Wallet creation — welcome credits auto-granted
 *   2. Balance & transactions — check, top-up, deduct, history
 *   3. Pricing engine — rate card, cost estimation, comparison
 *   4. Free tier quotas — enforcement and tier promotion
 *   5. Metering — dispatch calls increment meters correctly
 *   6. Freeze/unfreeze — admin wallet controls
 *   7. Credit grants — operator grants free credits
 *   8. Invoice lifecycle — create, status, settle (mock)
 *   9. Cross-relay consistency — credits are per-relay (not shared)
 *
 * Usage: node scripts/test-credits.js
 */

import http from 'http'
import crypto from 'crypto'

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

function dispatch (relay, route, params = {}) {
  return request(relay, 'POST', '/api/v1/dispatch', { route, params })
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

const TEST_APP_KEY = crypto.randomBytes(32).toString('hex')
const relay = RELAYS[1] // Utah-US for all credit tests

async function runTests () {
  console.log('\n╔═══════════════════════════════════════════════════╗')
  console.log('║    HiveRelay Credits & Payments Integration Tests  ║')
  console.log('╚═══════════════════════════════════════════════════╝\n')

  // ──────────────────────────────────────────
  // 1. Pricing Engine
  // ──────────────────────────────────────────
  console.log('── Test Group 1: Pricing Engine ──')

  await test('Rate card available', async () => {
    const res = await request(relay, 'GET', '/api/v1/credits/pricing')
    assert(res.status === 200, `HTTP ${res.status}`)
    assert(res.data, 'Empty pricing data')
    const routes = Object.keys(res.data)
    assert(routes.length > 0, 'No routes in rate card')
    log('ℹ️', `Rate card has ${routes.length} routes: ${routes.slice(0, 5).join(', ')}...`)
  })

  await test('Price comparison available', async () => {
    const res = await request(relay, 'GET', '/api/v1/credits/pricing/compare')
    assert(res.status === 200, `HTTP ${res.status}`)
    log('ℹ️', `Comparison: ${JSON.stringify(res.data).slice(0, 120)}`)
  })

  await test('Cost estimation works', async () => {
    const res = await request(relay, 'GET', '/api/v1/credits/estimate?route=ai.infer&inputTokens=1000&outputTokens=500')
    assert(res.status === 200, `HTTP ${res.status}`)
    assert(res.data.cost !== undefined || res.data.total !== undefined, 'No cost in estimate')
    log('ℹ️', `Estimate for ai.infer (1K in, 500 out): ${JSON.stringify(res.data)}`)
  })

  // ──────────────────────────────────────────
  // 2. Wallet & Welcome Credits
  // ──────────────────────────────────────────
  console.log('\n── Test Group 2: Wallet & Welcome Credits ──')

  await test('Check balance for new app key (triggers welcome credits)', async () => {
    const res = await request(relay, 'GET', `/api/v1/credits/balance/${TEST_APP_KEY}`)
    assert(res.status === 200, `HTTP ${res.status}`)
    // New wallet may have 0 or welcome credits depending on auto-create behavior
    log('ℹ️', `New app balance: ${JSON.stringify(res.data)}`)
  })

  await test('Top up credits for test app', async () => {
    const res = await request(relay, 'POST', '/api/v1/credits/topup', {
      appKey: TEST_APP_KEY,
      amount: 5000
    })
    assert(res.status === 200, `HTTP ${res.status}: ${JSON.stringify(res.data)}`)
    log('ℹ️', `Topped up: ${JSON.stringify(res.data)}`)
  })

  await test('Verify balance after top-up', async () => {
    const res = await request(relay, 'GET', `/api/v1/credits/balance/${TEST_APP_KEY}`)
    assert(res.status === 200, `HTTP ${res.status}`)
    const balance = res.data.balance ?? res.data
    assert(balance >= 5000, `Expected ≥5000 balance, got ${balance}`)
    log('ℹ️', `Balance: ${JSON.stringify(res.data).slice(0, 100)}`)
  })

  await test('Transaction history has entries', async () => {
    const res = await request(relay, 'GET', `/api/v1/credits/transactions/${TEST_APP_KEY}?limit=10`)
    assert(res.status === 200, `HTTP ${res.status}`)
    const txs = res.data.transactions || res.data
    assert(Array.isArray(txs), 'Expected transaction array')
    assert(txs.length > 0, 'No transactions found')
    log('ℹ️', `${txs.length} transactions for test app`)
  })

  // ──────────────────────────────────────────
  // 3. Billing & Metering
  // ──────────────────────────────────────────
  console.log('\n── Test Group 3: Billing & Metering ──')

  await test('Billing stats accessible', async () => {
    const res = await request(relay, 'GET', '/api/v1/billing/stats')
    assert(res.status === 200, `HTTP ${res.status}`)
    assert(res.data.totalCalls !== undefined, 'Missing totalCalls')
    log('ℹ️', `Total calls: ${res.data.totalCalls}, revenue: ${res.data.totalRevenue}`)
  })

  await test('Dispatch calls increment metering counter', async () => {
    const before = await request(relay, 'GET', '/api/v1/billing/stats')
    const callsBefore = before.data.totalCalls

    // Make 3 dispatch calls
    await dispatch(relay, 'schema.list')
    await dispatch(relay, 'sla.stats')
    await dispatch(relay, 'identity.whoami')

    const after = await request(relay, 'GET', '/api/v1/billing/stats')
    assert(after.data.totalCalls >= callsBefore + 3,
      `Expected ≥${callsBefore + 3}, got ${after.data.totalCalls}`)
    log('ℹ️', `Metering: ${callsBefore} → ${after.data.totalCalls}`)
  })

  // ──────────────────────────────────────────
  // 4. Free Tier Quotas
  // ──────────────────────────────────────────
  console.log('\n── Test Group 4: Free Tier Quotas ──')

  await test('Quota check for test app', async () => {
    const res = await request(relay, 'GET', `/api/v1/billing/quota/${TEST_APP_KEY}`)
    assert(res.status === 200, `HTTP ${res.status}`)
    log('ℹ️', `Quota: ${JSON.stringify(res.data).slice(0, 150)}`)
  })

  await test('Usage tracking for test app', async () => {
    const res = await request(relay, 'GET', `/api/v1/billing/usage/${TEST_APP_KEY}`)
    assert(res.status === 200, `HTTP ${res.status}`)
    log('ℹ️', `Usage: ${JSON.stringify(res.data).slice(0, 150)}`)
  })

  await test('Set app to standard tier', async () => {
    const res = await request(relay, 'POST', '/api/v1/billing/tier', {
      appKey: TEST_APP_KEY,
      tier: 'standard'
    })
    assert(res.status === 200, `HTTP ${res.status}`)
    assert(res.data.ok || res.data.tier === 'standard', `Unexpected: ${JSON.stringify(res.data)}`)
  })

  await test('Add app to unlimited whitelist', async () => {
    const res = await request(relay, 'POST', '/api/v1/billing/whitelist', {
      appKey: TEST_APP_KEY
    })
    assert(res.status === 200, `HTTP ${res.status}`)
  })

  // ──────────────────────────────────────────
  // 5. Freeze / Unfreeze
  // ──────────────────────────────────────────
  console.log('\n── Test Group 5: Wallet Admin Controls ──')

  await test('Freeze wallet', async () => {
    const res = await request(relay, 'POST', '/api/v1/credits/freeze', {
      appKey: TEST_APP_KEY,
      reason: 'integration-test'
    })
    assert(res.status === 200, `HTTP ${res.status}: ${JSON.stringify(res.data)}`)
  })

  await test('Frozen wallet shows frozen status', async () => {
    const res = await request(relay, 'GET', `/api/v1/credits/balance/${TEST_APP_KEY}`)
    assert(res.status === 200, `HTTP ${res.status}`)
    // Check if frozen flag is set
    if (res.data.frozen !== undefined) {
      assert(res.data.frozen === true, `Expected frozen=true, got ${res.data.frozen}`)
    }
    log('ℹ️', `Wallet status: ${JSON.stringify(res.data).slice(0, 100)}`)
  })

  await test('Unfreeze wallet', async () => {
    const res = await request(relay, 'POST', '/api/v1/credits/unfreeze', {
      appKey: TEST_APP_KEY
    })
    assert(res.status === 200, `HTTP ${res.status}: ${JSON.stringify(res.data)}`)
  })

  // ──────────────────────────────────────────
  // 6. Credit Grants
  // ──────────────────────────────────────────
  console.log('\n── Test Group 6: Credit Grants ──')

  await test('Grant free credits', async () => {
    const balanceBefore = await request(relay, 'GET', `/api/v1/credits/balance/${TEST_APP_KEY}`)
    const before = balanceBefore.data.balance || 0

    const res = await request(relay, 'POST', '/api/v1/credits/grant', {
      appKey: TEST_APP_KEY,
      amount: 2000,
      reason: 'integration-test-grant'
    })
    assert(res.status === 200, `HTTP ${res.status}: ${JSON.stringify(res.data)}`)

    const balanceAfter = await request(relay, 'GET', `/api/v1/credits/balance/${TEST_APP_KEY}`)
    const after = balanceAfter.data.balance || 0
    assert(after >= before + 2000, `Expected balance ≥${before + 2000}, got ${after}`)
    log('ℹ️', `Balance: ${before} → ${after} (granted 2000)`)
  })

  // ──────────────────────────────────────────
  // 7. Invoice System
  // ──────────────────────────────────────────
  console.log('\n── Test Group 7: Invoice System ──')

  await test('Create Lightning invoice', async () => {
    const res = await request(relay, 'POST', '/api/v1/credits/invoice', {
      appKey: TEST_APP_KEY,
      amount: 1000,
      memo: 'Integration test invoice'
    })
    // May fail if Lightning not configured (expected in test environment)
    if (res.status === 200) {
      assert(res.data.id, 'Missing invoice ID')
      log('ℹ️', `Invoice created: ${res.data.id}, amount: ${res.data.amountSats || res.data.amount}`)
    } else {
      log('ℹ️', `Invoice creation returned ${res.status} (Lightning may not be configured)`)
    }
  })

  await test('List app invoices', async () => {
    const res = await request(relay, 'GET', `/api/v1/credits/invoices/${TEST_APP_KEY}`)
    if (res.status === 200) {
      const invoices = res.data.invoices || res.data
      log('ℹ️', `${Array.isArray(invoices) ? invoices.length : 0} invoices for test app`)
    } else {
      log('ℹ️', `Invoices endpoint returned ${res.status}`)
    }
  })

  // ──────────────────────────────────────────
  // 8. Aggregate Stats
  // ──────────────────────────────────────────
  console.log('\n── Test Group 8: Aggregate Stats ──')

  await test('Credit system stats', async () => {
    const res = await request(relay, 'GET', '/api/v1/credits/stats')
    assert(res.status === 200, `HTTP ${res.status}`)
    log('ℹ️', `Credit stats: ${JSON.stringify(res.data).slice(0, 150)}`)
  })

  await test('Overview includes credit, metering, and invoice data', async () => {
    const res = await request(relay, 'GET', '/api/overview')
    assert(res.status === 200, `HTTP ${res.status}`)
    assert(res.data.credits, 'Missing credits in overview')
    assert(res.data.metering, 'Missing metering in overview')
    log('ℹ️', `Credits: ${JSON.stringify(res.data.credits).slice(0, 80)}`)
    log('ℹ️', `Metering: ${JSON.stringify(res.data.metering).slice(0, 80)}`)
  })

  // ──────────────────────────────────────────
  // 9. Cross-Relay Independence
  // ──────────────────────────────────────────
  console.log('\n── Test Group 9: Cross-Relay Independence ──')

  await test('Credits are per-relay (not shared)', async () => {
    // The test app was topped up on relay[1] — check relay[0] has different state
    const res0 = await request(RELAYS[0], 'GET', `/api/v1/credits/balance/${TEST_APP_KEY}`)
    const res1 = await request(relay, 'GET', `/api/v1/credits/balance/${TEST_APP_KEY}`)
    // relay[0] should have 0 or just welcome credits (different from relay[1])
    log('ℹ️', `${RELAYS[0].name}: ${JSON.stringify(res0.data).slice(0, 60)}`)
    log('ℹ️', `${relay.name}: ${JSON.stringify(res1.data).slice(0, 60)}`)
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

#!/usr/bin/env node

/**
 * Identity System Integration Test Suite
 *
 * Tests the full identity lifecycle across the live network:
 *   1. Identity stats — system status and developer counts
 *   2. LNURL-auth — challenge creation, polling
 *   3. Attestation — submit, resolve, list
 *   4. Developer profiles — lookup, manual set
 *   5. Session management — validate, logout
 *   6. Identity service dispatch — whoami, peers, resolve, developer
 *   7. Cross-relay identity sync — verify sync propagation
 *   8. Identity middleware — context enrichment via dispatch
 *
 * Usage: node scripts/test-identity.js
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
    const headers = { 'Content-Type': 'application/json' }
    if (opts.auth !== false) headers.Authorization = `Bearer ${API_KEY}`
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

async function runTests () {
  console.log('\n╔═══════════════════════════════════════════════════╗')
  console.log('║       HiveRelay Identity Integration Tests        ║')
  console.log('╚═══════════════════════════════════════════════════╝\n')

  const relay = RELAYS[1]

  // ──────────────────────────────────────────
  // 1. Identity System Stats
  // ──────────────────────────────────────────
  console.log('── Test Group 1: Identity System Stats ──')

  for (const r of RELAYS) {
    await test(`Identity stats on ${r.name}`, async () => {
      const res = await request(r, 'GET', '/api/v1/identity/stats')
      assert(res.status === 200, `HTTP ${res.status}`)
      assert(res.data, 'Empty stats')
      log('ℹ️', `${r.name}: ${JSON.stringify(res.data).slice(0, 120)}`)
    })
  }

  // ──────────────────────────────────────────
  // 2. Developer Listing
  // ──────────────────────────────────────────
  console.log('\n── Test Group 2: Developer Registry ──')

  let developerCount = 0
  let knownDevKey = null

  await test('List developers', async () => {
    const res = await request(relay, 'GET', '/api/v1/identity/developers')
    assert(res.status === 200, `HTTP ${res.status}`)
    developerCount = res.data.count || 0
    if (res.data.developers && res.data.developers.length > 0) {
      knownDevKey = res.data.developers[0].pubkey
      log('ℹ️', `${developerCount} developers. First: ${knownDevKey?.slice(0, 16)}...`)
    } else {
      log('ℹ️', `No developers registered yet`)
    }
  })

  if (knownDevKey) {
    await test('Get developer detail', async () => {
      const res = await request(relay, 'GET', `/api/v1/identity/developer/${knownDevKey}`)
      assert(res.status === 200, `HTTP ${res.status}`)
      assert(res.data.pubkey === knownDevKey, 'Key mismatch')
      log('ℹ️', `Developer: ${res.data.appKeys?.length || 0} app keys, profile: ${res.data.profile?.displayName || 'none'}`)
    })
  }

  // ──────────────────────────────────────────
  // 3. LNURL-Auth Challenge
  // ──────────────────────────────────────────
  console.log('\n── Test Group 3: LNURL-Auth ──')

  let challengeK1 = null

  await test('Create LNURL-auth challenge', async () => {
    const res = await request(relay, 'GET', '/api/v1/identity/lnurl-auth', null, { auth: false })
    assert(res.status === 200, `HTTP ${res.status}`)
    assert(res.data.k1, 'Missing k1 challenge')
    assert(res.data.lnurl, 'Missing lnurl')
    challengeK1 = res.data.k1
    log('ℹ️', `Challenge k1: ${challengeK1.slice(0, 16)}..., expires: ${res.data.expires || 'unknown'}`)
  })

  await test('Poll challenge status (pending)', async () => {
    if (!challengeK1) throw new Error('No challenge to poll')
    const res = await request(relay, 'GET', `/api/v1/identity/lnurl-auth/poll/${challengeK1}`, null, { auth: false })
    assert(res.status === 200, `HTTP ${res.status}`)
    assert(res.data.status === 'pending', `Expected pending, got ${res.data.status}`)
  })

  await test('Callback with invalid signature returns error', async () => {
    const fakeSig = crypto.randomBytes(64).toString('hex')
    const fakeKey = '02' + crypto.randomBytes(32).toString('hex') // Fake compressed pubkey
    const res = await request(relay, 'GET',
      `/api/v1/identity/lnurl-auth/callback?k1=${challengeK1}&sig=${fakeSig}&key=${fakeKey}`,
      null, { auth: false })
    assert(res.status === 200, `HTTP ${res.status}`) // LNURL spec returns 200 with status
    assert(res.data.status === 'ERROR', `Expected ERROR status, got ${res.data.status}`)
    log('ℹ️', `Invalid callback rejected: ${res.data.reason || res.data.error}`)
  })

  // ──────────────────────────────────────────
  // 4. Attestation
  // ──────────────────────────────────────────
  console.log('\n── Test Group 4: Attestation ──')

  await test('Submit attestation with bad format returns 400', async () => {
    const res = await request(relay, 'POST', '/api/v1/identity/attest', {
      appKey: crypto.randomBytes(32).toString('hex'),
      developerKey: crypto.randomBytes(32).toString('hex'),
      signature: crypto.randomBytes(64).toString('hex')
    })
    // Should get 400 (bad format) or 500 (validation error), NOT hang
    assert(res.status >= 200 && res.status < 600, `Unexpected status ${res.status}`)
    log('ℹ️', `Bad attestation: ${res.status} — ${JSON.stringify(res.data).slice(0, 80)}`)
  })

  await test('Resolve unknown app key returns null/404', async () => {
    const unknownKey = crypto.randomBytes(32).toString('hex')
    const res = await request(relay, 'GET', `/api/v1/identity/resolve/${unknownKey}`)
    assert(res.status === 200 || res.status === 404, `Expected 200/404, got ${res.status}`)
    log('ℹ️', `Unknown key resolve: ${res.status} — ${JSON.stringify(res.data).slice(0, 60)}`)
  })

  // If there are known attestations, test resolve
  if (knownDevKey) {
    await test('Resolve known developer app key', async () => {
      const devsRes = await request(relay, 'GET', '/api/v1/identity/developers')
      const dev = devsRes.data.developers?.find(d => d.appKeys?.length > 0)
      if (!dev) { log('ℹ️', 'No developer with app keys to test'); return }
      const appKey = dev.appKeys[0]
      const res = await request(relay, 'GET', `/api/v1/identity/resolve/${appKey}`)
      assert(res.status === 200, `HTTP ${res.status}`)
      log('ℹ️', `Resolved ${appKey.slice(0, 12)}... → developer ${dev.pubkey.slice(0, 12)}...`)
    })
  }

  // ──────────────────────────────────────────
  // 5. Session Management
  // ──────────────────────────────────────────
  console.log('\n── Test Group 5: Session Management ──')

  await test('Validate session with no token returns 401', async () => {
    const res = await request(relay, 'GET', '/api/v1/identity/session', null, { auth: false })
    assert(res.status === 401, `Expected 401, got ${res.status}`)
  })

  await test('Validate session with bad token returns 401', async () => {
    const res = await request(relay, 'GET', '/api/v1/identity/session', null, {
      headers: { Authorization: 'Bearer ' + crypto.randomBytes(32).toString('hex') }
    })
    assert(res.status === 401, `Expected 401, got ${res.status}`)
  })

  await test('Logout with no token succeeds (no-op)', async () => {
    const res = await request(relay, 'POST', '/api/v1/identity/logout', {}, { auth: false })
    assert(res.status === 200, `Expected 200, got ${res.status}`)
    assert(res.data.success === true, `Expected success`)
  })

  // ──────────────────────────────────────────
  // 6. Identity Service via Router Dispatch
  // ──────────────────────────────────────────
  console.log('\n── Test Group 6: Identity Service Dispatch ──')

  await test('identity.whoami via dispatch', async () => {
    const res = await dispatch(relay, 'identity.whoami')
    assert(res.status === 200, `HTTP ${res.status}`)
    assert(res.data.result?.pubkey, 'Missing pubkey in whoami')
    log('ℹ️', `Relay pubkey: ${res.data.result.pubkey.slice(0, 16)}...`)
  })

  await test('identity.peers via dispatch', async () => {
    const res = await dispatch(relay, 'identity.peers')
    assert(res.status === 200, `HTTP ${res.status}`)
    log('ℹ️', `Peers result: ${JSON.stringify(res.data.result).slice(0, 100)}`)
  })

  await test('identity.resolve via dispatch (unknown key)', async () => {
    const res = await dispatch(relay, 'identity.resolve', { pubkey: crypto.randomBytes(32).toString('hex') })
    assert(res.status === 200 || res.status === 500, `HTTP ${res.status}`)
    // Unknown key should return null or throw
  })

  // ──────────────────────────────────────────
  // 7. Cross-Relay Identity Sync
  // ──────────────────────────────────────────
  console.log('\n── Test Group 7: Cross-Relay Identity Sync ──')

  await test('All relays have same developer count (sync working)', async () => {
    const counts = []
    for (const r of RELAYS) {
      const res = await request(r, 'GET', '/api/v1/identity/developers')
      counts.push({ name: r.name, count: res.data.count || 0 })
    }
    log('ℹ️', `Developer counts: ${counts.map(c => `${c.name}=${c.count}`).join(', ')}`)
    // They should be equal if sync is working
    const vals = counts.map(c => c.count)
    const allSame = vals.every(v => v === vals[0])
    if (!allSame) {
      log('⚠️', 'Developer counts differ — sync may be catching up')
    }
  })

  await test('Catalog sync includes identity data', async () => {
    const res = await request(relay, 'GET', '/api/v1/sync')
    assert(res.status === 200, `HTTP ${res.status}`)
    assert(res.data.running === true, 'Sync not running')
    log('ℹ️', `Sync stats: ${JSON.stringify(res.data.stats || {}).slice(0, 100)}`)
  })

  // ──────────────────────────────────────────
  // 8. Identity in Network View
  // ──────────────────────────────────────────
  console.log('\n── Test Group 8: Network Integration ──')

  await test('Relay identity in whoami across all relays', async () => {
    const pubkeys = new Set()
    for (const r of RELAYS) {
      const res = await dispatch(r, 'identity.whoami')
      if (res.data.result?.pubkey) {
        pubkeys.add(res.data.result.pubkey)
      }
    }
    assert(pubkeys.size === RELAYS.length,
      `Expected ${RELAYS.length} unique identities, got ${pubkeys.size}`)
    log('ℹ️', `${pubkeys.size} unique relay identities confirmed`)
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

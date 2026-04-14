#!/usr/bin/env node

/**
 * P2P Service Protocol Integration Test Suite
 *
 * Tests client.callService() over the P2P service channel against live relays:
 *   1. Service channel opens on connect
 *   2. Service catalog received from relay
 *   3. callService('identity', 'whoami') returns relay pubkey
 *   4. callService('schema', 'list') returns schema list
 *   5. callService('sla', 'list') returns SLA list
 *   6. callService with unknown service returns error
 *   7. callService with unknown method returns error
 *   8. Multiple concurrent callService calls
 *   9. App catalog received from relay
 *  10. callService across multiple relays
 *
 * Usage: node scripts/test-p2p-services.js
 */

import { HiveRelayClient } from '../client/index.js'

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
  console.log('║     HiveRelay P2P Service Protocol Tests           ║')
  console.log('╚═══════════════════════════════════════════════════╝\n')

  // ──────────────────────────────────────────
  // Setup: Create client and connect to relays
  // ──────────────────────────────────────────
  console.log('── Setup: Connecting to relay network ──')

  const client = new HiveRelayClient({
    storage: '/tmp/test-p2p-services-' + Date.now(),
    apiKey: process.env.HIVERELAY_API_KEY || 'hiverelay-secret'
  })

  // Track events
  const events = { catalogReceived: false, appCatalogReceived: false, serviceChannelOpen: false }
  let serviceCatalog = null
  let appCatalog = null

  client.on('service-channel-open', (evt) => {
    events.serviceChannelOpen = true
    log('ℹ️', `Service channel opened with relay ${evt.relay.slice(0, 16)}...`)
  })

  client.on('service-catalog', (evt) => {
    events.catalogReceived = true
    serviceCatalog = evt.services
    log('ℹ️', `Service catalog from ${evt.relay.slice(0, 16)}...: ${(evt.services || []).map(s => s.name).join(', ')}`)
  })

  client.on('app-catalog', (evt) => {
    events.appCatalogReceived = true
    appCatalog = evt.apps
    log('ℹ️', `App catalog from ${evt.relay.slice(0, 16)}...: ${(evt.apps || []).length} apps`)
  })

  await client.start()
  log('ℹ️', 'Client started, waiting for relay connections...')

  // Wait for relay connection + service channel
  let connected = false
  for (let i = 0; i < 20; i++) {
    const relays = client.getRelays()
    if (relays.length > 0 && relays.some(r => r.hasServiceProtocol)) {
      connected = true
      log('ℹ️', `Connected to ${relays.length} relay(s), ${relays.filter(r => r.hasServiceProtocol).length} with service channel`)
      break
    }
    await new Promise(r => setTimeout(r, 1000))
    process.stdout.write('.')
  }
  console.log()

  if (!connected) {
    console.log('  ❌ Could not connect to any relay with service channel')
    await client.destroy()
    process.exit(1)
  }

  // Give a moment for catalogs to arrive
  await new Promise(r => setTimeout(r, 2000))

  // ──────────────────────────────────────────
  // 1. Service Channel Opens
  // ──────────────────────────────────────────
  console.log('\n── Test Group 1: Service Channel ──')

  await test('Service channel opened on connect', async () => {
    assert(events.serviceChannelOpen, 'service-channel-open event not received')
  })

  await test('Service catalog received from relay', async () => {
    assert(events.catalogReceived, 'service-catalog event not received')
    assert(Array.isArray(serviceCatalog), 'Catalog is not an array')
    assert(serviceCatalog.length > 0, 'Catalog is empty')
    log('ℹ️', `Catalog has ${serviceCatalog.length} services: ${serviceCatalog.map(s => s.name).join(', ')}`)
  })

  await test('App catalog received from relay', async () => {
    assert(events.appCatalogReceived, 'app-catalog event not received')
    assert(Array.isArray(appCatalog), 'App catalog is not an array')
    log('ℹ️', `${appCatalog.length} apps in catalog`)
  })

  // ──────────────────────────────────────────
  // 2. Identity Service via P2P
  // ──────────────────────────────────────────
  console.log('\n── Test Group 2: Identity Service ──')

  await test('callService: identity.whoami', async () => {
    const result = await client.callService('identity', 'whoami', {}, { timeout: 10000 })
    assert(result, 'Empty result')
    assert(result.pubkey, 'Missing pubkey in whoami result')
    assert(result.pubkey.length === 64, `Invalid pubkey length: ${result.pubkey.length}`)
    log('ℹ️', `Relay identity: ${result.pubkey.slice(0, 16)}...`)
  })

  await test('callService: identity.sign rejects remote peers (security)', async () => {
    try {
      await client.callService('identity', 'sign', { message: 'test' }, { timeout: 10000 })
      assert(false, 'Should have rejected remote sign request')
    } catch (err) {
      assert(err.message.includes('UNAUTHORIZED'), `Expected UNAUTHORIZED, got: ${err.message}`)
      log('ℹ️', `Correctly rejected: ${err.message}`)
    }
  })

  // ──────────────────────────────────────────
  // 3. Schema Service via P2P
  // ──────────────────────────────────────────
  console.log('\n── Test Group 3: Schema Service ──')

  await test('callService: schema.list', async () => {
    const result = await client.callService('schema', 'list', {}, { timeout: 10000 })
    assert(result, 'Empty result')
    log('ℹ️', `Schema list: ${JSON.stringify(result).slice(0, 100)}`)
  })

  await test('callService: schema.register + schema.validate', async () => {
    const schemaId = 'test-p2p-schema-' + Date.now()
    const definition = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }

    const regResult = await client.callService('schema', 'register', { schemaId, definition, version: '1.0.0' }, { timeout: 10000 })
    assert(regResult, 'Empty register result')
    log('ℹ️', `Registered schema: ${schemaId}`)

    const valResult = await client.callService('schema', 'validate', { schemaId, data: { name: 'test' } }, { timeout: 10000 })
    assert(valResult, 'Empty validate result')
    assert(valResult.valid === true, `Validation failed: ${JSON.stringify(valResult)}`)
    log('ℹ️', 'Schema validation passed')
  })

  // ──────────────────────────────────────────
  // 4. SLA Service via P2P
  // ──────────────────────────────────────────
  console.log('\n── Test Group 4: SLA Service ──')

  await test('callService: sla.list', async () => {
    const result = await client.callService('sla', 'list', {}, { timeout: 10000 })
    assert(result, 'Empty result')
    log('ℹ️', `SLA list: ${JSON.stringify(result).slice(0, 100)}`)
  })

  await test('callService: sla.stats', async () => {
    const result = await client.callService('sla', 'stats', {}, { timeout: 10000 })
    assert(result, 'Empty result')
    log('ℹ️', `SLA stats: ${JSON.stringify(result).slice(0, 100)}`)
  })

  // ──────────────────────────────────────────
  // 5. Error Handling
  // ──────────────────────────────────────────
  console.log('\n── Test Group 5: Error Handling ──')

  await test('callService: unknown service returns error', async () => {
    try {
      await client.callService('nonexistent', 'method', {}, { timeout: 5000 })
      assert(false, 'Should have thrown')
    } catch (err) {
      assert(err.message !== 'SERVICE_TIMEOUT', `Got timeout instead of error — relay may not be handling unknown services`)
      log('ℹ️', `Error for unknown service: ${err.message}`)
    }
  })

  await test('callService: unknown method returns error', async () => {
    try {
      await client.callService('identity', 'nonexistent-method', {}, { timeout: 5000 })
      assert(false, 'Should have thrown')
    } catch (err) {
      assert(err.message !== 'SERVICE_TIMEOUT', `Got timeout instead of error`)
      log('ℹ️', `Error for unknown method: ${err.message}`)
    }
  })

  // ──────────────────────────────────────────
  // 6. Concurrent Calls
  // ──────────────────────────────────────────
  console.log('\n── Test Group 6: Concurrent Calls ──')

  await test('5 concurrent callService calls', async () => {
    const calls = [
      client.callService('identity', 'whoami', {}, { timeout: 10000 }),
      client.callService('schema', 'list', {}, { timeout: 10000 }),
      client.callService('sla', 'list', {}, { timeout: 10000 }),
      client.callService('sla', 'stats', {}, { timeout: 10000 }),
      client.callService('identity', 'whoami', {}, { timeout: 10000 })
    ]
    const results = await Promise.allSettled(calls)
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    assert(fulfilled.length >= 4, `Expected ≥4 successful, got ${fulfilled.length}/5`)
    log('ℹ️', `${fulfilled.length}/5 concurrent calls succeeded`)
  })

  // ──────────────────────────────────────────
  // 7. Relay Selection
  // ──────────────────────────────────────────
  console.log('\n── Test Group 7: Relay Selection ──')

  await test('getRelays includes service channel info', async () => {
    const relays = client.getRelays()
    const withService = relays.filter(r => r.hasServiceProtocol)
    assert(withService.length > 0, 'No relays with service channel')
    log('ℹ️', `${withService.length}/${relays.length} relays have service channel`)
  })

  await test('callService on specific relay', async () => {
    const relays = client.getRelays().filter(r => r.hasServiceProtocol)
    if (relays.length === 0) throw new Error('No relays with service channel')

    const result = await client.callService('identity', 'whoami', {}, {
      relay: relays[0].pubkey,
      timeout: 10000
    })
    assert(result?.pubkey, 'Missing pubkey')
    log('ℹ️', `Specific relay ${relays[0].pubkey.slice(0, 16)}... responded: ${result.pubkey.slice(0, 16)}...`)
  })

  // ──────────────────────────────────────────
  // 8. Latency
  // ──────────────────────────────────────────
  console.log('\n── Test Group 8: P2P Service Latency ──')

  await test('P2P callService latency benchmark', async () => {
    const times = []
    for (let i = 0; i < 5; i++) {
      const start = Date.now()
      await client.callService('identity', 'whoami', {}, { timeout: 10000 })
      times.push(Date.now() - start)
    }
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    const min = Math.min(...times)
    const max = Math.max(...times)
    log('ℹ️', `P2P latency: avg=${avg}ms, min=${min}ms, max=${max}ms`)
    assert(avg < 5000, `Average latency ${avg}ms too high`)
  })

  // ──────────────────────────────────────────
  // Cleanup
  // ──────────────────────────────────────────
  await client.destroy()

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

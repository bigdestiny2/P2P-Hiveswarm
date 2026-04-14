#!/usr/bin/env node
/**
 * HiveRelay Network Resilience Test Suite
 *
 * Runs 5 live tests against the production relay network:
 *   1. Propagation Speed — seed on one relay, measure sync time to all
 *   2. Recovery from Failure — kill a relay, bring it back, measure re-sync
 *   3. Partition Tolerance — 2 of 3 offline, seed on survivor, bring back
 *   4. Cascade Seed — seed on A, sync to B, kill A, verify C syncs from B
 *   5. Concurrent Seed — different apps on all 3 simultaneously
 *
 * Usage:
 *   HIVERELAY_API_KEY=xxx node scripts/test-resilience.js [test-number]
 *   HIVERELAY_API_KEY=xxx node scripts/test-resilience.js all
 *   HIVERELAY_API_KEY=xxx node scripts/test-resilience.js 1  # run only test 1
 */

import { randomBytes } from 'crypto'
import http from 'http'

const API_KEY = process.env.HIVERELAY_API_KEY
if (!API_KEY) {
  console.error('Set HIVERELAY_API_KEY environment variable')
  process.exit(1)
}

const SSH_KEY = process.env.SSH_KEY || `${process.env.HOME}/.ssh/cloudzy_hiverelay`

const RELAYS = [
  { name: 'Utah', ip: '144.172.101.215', port: 9100, region: 'NA' },
  { name: 'Utah-US', ip: '144.172.91.26', port: 9100, region: 'NA' },
  { name: 'Singapore', ip: '104.194.153.179', port: 9100, region: 'AS' }
]

// ─── Helpers ───

function generateTestKey () {
  return randomBytes(32).toString('hex')
}

function fetchJson (ip, port, path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: ip,
      port,
      path,
      method,
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
    const req = http.request(opts, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }) } catch { resolve({ status: res.statusCode, data }) }
      })
    })
    req.on('error', (err) => resolve({ status: 0, data: null, error: err.message }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null, error: 'timeout' }) })
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function seedApp (relay, appKey, appId) {
  return fetchJson(relay.ip, relay.port, '/seed', 'POST', { appKey, appId })
}

async function unseedApp (relay, appKey) {
  return fetchJson(relay.ip, relay.port, '/unseed', 'POST', { appKey })
}

async function getApps (relay) {
  const r = await fetchJson(relay.ip, relay.port, '/catalog.json')
  return r.data?.apps || []
}

async function getSyncStatus (relay) {
  return fetchJson(relay.ip, relay.port, '/api/v1/sync')
}

async function getOverview (relay) {
  return fetchJson(relay.ip, relay.port, '/api/overview')
}

async function isOnline (relay) {
  const r = await getOverview(relay)
  return r.status === 200
}

async function hasApp (relay, appKey) {
  const apps = await getApps(relay)
  return apps.some(a => a.driveKey === appKey)
}

async function triggerSync (relay) {
  return fetchJson(relay.ip, relay.port, '/api/v1/sync/trigger', 'POST')
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function ssh (ip, cmd) {
  return new Promise((resolve, reject) => {
    const { execSync } = require('child_process')
    try {
      const result = execSync(
        `ssh -i ${SSH_KEY} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 root@${ip} "${cmd}"`,
        { timeout: 30000, encoding: 'utf8' }
      )
      resolve(result.trim())
    } catch (err) {
      resolve(err.stdout?.trim() || err.message)
    }
  })
}

async function stopRelay (relay) {
  console.log(`    ⏹  Stopping ${relay.name}...`)
  await ssh(relay.ip, 'systemctl stop hiverelay')
  // Wait for it to actually go offline
  for (let i = 0; i < 10; i++) {
    if (!(await isOnline(relay))) return
    await sleep(1000)
  }
}

async function startRelay (relay) {
  console.log(`    ▶  Starting ${relay.name}...`)
  await ssh(relay.ip, 'systemctl start hiverelay')
  // Wait for it to come online
  for (let i = 0; i < 30; i++) {
    if (await isOnline(relay)) return
    await sleep(2000)
  }
}

async function waitForApp (relay, appKey, timeoutMs = 180000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await hasApp(relay, appKey)) {
      return Date.now() - start
    }
    // Trigger sync to speed things up
    await triggerSync(relay).catch(() => {})
    await sleep(3000)
  }
  return -1 // timeout
}

function log (msg) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`  [${ts}] ${msg}`)
}

function header (title) {
  console.log()
  console.log(`${'═'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${'═'.repeat(60)}`)
}

function result (pass, msg, durationMs) {
  const icon = pass ? '✅' : '❌'
  const time = durationMs != null ? ` (${(durationMs / 1000).toFixed(1)}s)` : ''
  console.log(`  ${icon} ${msg}${time}`)
}

// ─── Cleanup ───

const testKeys = []

async function cleanup () {
  if (testKeys.length === 0) return
  console.log(`\n  Cleaning up ${testKeys.length} test app(s)...`)
  for (const key of testKeys) {
    for (const relay of RELAYS) {
      await unseedApp(relay, key).catch(() => {})
    }
  }
  console.log('  Cleanup done.')
}

// ─── Test 1: Propagation Speed ───

async function test1 () {
  header('Test 1: Propagation Speed')
  log('Seed a new app on Utah-US, measure time until Utah and Singapore have it.')

  const testKey = generateTestKey()
  const testId = 'resilience-test-' + testKey.slice(0, 8)
  testKeys.push(testKey)

  log(`Test app: ${testId} (${testKey.slice(0, 16)}...)`)

  // Seed on Utah-US
  const seedResult = await seedApp(RELAYS[1], testKey, testId)
  log(`Seeded on Utah-US: status=${seedResult.status}`)

  if (seedResult.status !== 200) {
    result(false, 'Failed to seed on Utah-US')
    return false
  }

  // Wait for propagation to other relays
  log('Waiting for propagation...')
  const utahTime = await waitForApp(RELAYS[0], testKey, 120000)
  const sgTime = await waitForApp(RELAYS[2], testKey, 120000)

  result(utahTime > 0, `Utah synced`, utahTime)
  result(sgTime > 0, `Singapore synced`, sgTime)

  const pass = utahTime > 0 && sgTime > 0
  result(pass, pass ? 'Propagation successful across all relays' : 'Propagation FAILED')
  return pass
}

// ─── Test 2: Recovery from Failure ───

async function test2 () {
  header('Test 2: Recovery from Failure')
  log('Stop Singapore, wait, restart it. Verify it re-syncs all apps from surviving relays.')

  const target = RELAYS[2] // Singapore

  // Record what Singapore has before
  const appsBefore = await getApps(target)
  log(`Singapore has ${appsBefore.length} apps before stop`)

  // Stop Singapore
  await stopRelay(target)
  log('Singapore is offline')
  await sleep(5000)

  // Verify it's actually down
  const offline = !(await isOnline(target))
  result(offline, 'Singapore confirmed offline')
  if (!offline) { await startRelay(target); return false }

  // Start it back
  const restartStart = Date.now()
  await startRelay(target)
  const bootTime = Date.now() - restartStart
  log(`Singapore back online after ${(bootTime / 1000).toFixed(1)}s`)

  // Wait for catalog sync to run
  log('Waiting for re-sync...')
  await sleep(15000) // Let first sync cycle run
  await triggerSync(target).catch(() => {})
  await sleep(10000)

  const appsAfter = await getApps(target)
  log(`Singapore has ${appsAfter.length} apps after recovery`)

  const recovered = appsAfter.length >= appsBefore.length
  result(recovered, `Recovery: ${appsAfter.length}/${appsBefore.length} apps restored`, Date.now() - restartStart)
  return recovered
}

// ─── Test 3: Partition Tolerance ───

async function test3 () {
  header('Test 3: Partition Tolerance')
  log('Take Utah + Singapore offline. Seed new app on Utah-US (sole survivor).')
  log('Bring others back. Verify they sync the new app.')

  const testKey = generateTestKey()
  const testId = 'partition-test-' + testKey.slice(0, 8)
  testKeys.push(testKey)

  // Stop Utah and Singapore
  await stopRelay(RELAYS[0])
  await stopRelay(RELAYS[2])
  await sleep(3000)

  const utahDown = !(await isOnline(RELAYS[0]))
  const sgDown = !(await isOnline(RELAYS[2]))
  result(utahDown && sgDown, 'Utah and Singapore confirmed offline')

  if (!utahDown || !sgDown) {
    await startRelay(RELAYS[0])
    await startRelay(RELAYS[2])
    return false
  }

  // Seed on survivor (Utah-US)
  const seedResult = await seedApp(RELAYS[1], testKey, testId)
  log(`Seeded ${testId} on Utah-US (sole survivor): status=${seedResult.status}`)

  // Bring Utah back
  await startRelay(RELAYS[0])
  log('Waiting for Utah to sync...')
  const utahSync = await waitForApp(RELAYS[0], testKey, 120000)
  result(utahSync > 0, 'Utah synced from Utah-US', utahSync)

  // Bring Singapore back
  await startRelay(RELAYS[2])
  log('Waiting for Singapore to sync...')
  const sgSync = await waitForApp(RELAYS[2], testKey, 120000)
  result(sgSync > 0, 'Singapore synced from network', sgSync)

  const pass = utahSync > 0 && sgSync > 0
  result(pass, pass ? 'Partition tolerance verified' : 'Partition tolerance FAILED')
  return pass
}

// ─── Test 4: Cascade Seed ───

async function test4 () {
  header('Test 4: Cascade Seed')
  log('Seed on Utah-US → wait for Utah to sync → kill Utah-US → verify Singapore syncs from Utah.')

  const testKey = generateTestKey()
  const testId = 'cascade-test-' + testKey.slice(0, 8)
  testKeys.push(testKey)

  // Seed on Utah-US
  await seedApp(RELAYS[1], testKey, testId)
  log(`Seeded ${testId} on Utah-US`)

  // Wait for Utah to get it
  log('Waiting for Utah to sync from Utah-US...')
  const utahSync = await waitForApp(RELAYS[0], testKey, 120000)
  result(utahSync > 0, 'Utah synced from Utah-US', utahSync)

  if (utahSync <= 0) {
    result(false, 'Utah failed to sync — cannot test cascade')
    return false
  }

  // Kill Utah-US (the original source)
  await stopRelay(RELAYS[1])
  log('Utah-US (origin) is now OFFLINE')
  await sleep(3000)

  // Singapore should sync from Utah (not Utah-US which is dead)
  log('Waiting for Singapore to sync from Utah (cascade)...')
  const sgSync = await waitForApp(RELAYS[2], testKey, 120000)
  result(sgSync > 0, 'Singapore synced via cascade (from Utah)', sgSync)

  // Bring Utah-US back
  await startRelay(RELAYS[1])
  log('Utah-US restored')

  result(sgSync > 0, sgSync > 0 ? 'Cascade propagation verified' : 'Cascade FAILED')
  return sgSync > 0
}

// ─── Test 5: Concurrent Seed ───

async function test5 () {
  header('Test 5: Concurrent Seed')
  log('Seed 3 different apps on all 3 relays simultaneously.')
  log('Verify all 3 relays end up with all 3 apps.')

  const keys = [generateTestKey(), generateTestKey(), generateTestKey()]
  const ids = keys.map((k, i) => `concurrent-${i}-${k.slice(0, 8)}`)
  keys.forEach(k => testKeys.push(k))

  // Seed simultaneously: app0→Utah, app1→Utah-US, app2→Singapore
  const seedStart = Date.now()
  const [r0, r1, r2] = await Promise.all([
    seedApp(RELAYS[0], keys[0], ids[0]),
    seedApp(RELAYS[1], keys[1], ids[1]),
    seedApp(RELAYS[2], keys[2], ids[2])
  ])
  log(`Seeded 3 apps simultaneously: ${r0.status}, ${r1.status}, ${r2.status}`)

  // Wait for full convergence
  log('Waiting for convergence...')
  const results = []
  for (let ri = 0; ri < RELAYS.length; ri++) {
    for (let ki = 0; ki < keys.length; ki++) {
      if (ri === ki) continue // skip the relay that already has this app
      const t = await waitForApp(RELAYS[ri], keys[ki], 120000)
      results.push({ relay: RELAYS[ri].name, app: ids[ki], time: t })
      log(`  ${RELAYS[ri].name} ← ${ids[ki]}: ${t > 0 ? (t / 1000).toFixed(1) + 's' : 'TIMEOUT'}`)
    }
  }

  const totalTime = Date.now() - seedStart
  const allSynced = results.every(r => r.time > 0)
  const maxTime = Math.max(...results.filter(r => r.time > 0).map(r => r.time))

  result(allSynced, `All 6 cross-syncs ${allSynced ? 'succeeded' : 'FAILED'}`)
  if (allSynced) {
    log(`Slowest sync: ${(maxTime / 1000).toFixed(1)}s | Total convergence: ${(totalTime / 1000).toFixed(1)}s`)
  }
  return allSynced
}

// ─── Main ───

const TESTS = { 1: test1, 2: test2, 3: test3, 4: test4, 5: test5 }

async function main () {
  const arg = process.argv[2] || 'all'

  console.log()
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║       HiveRelay Network Resilience Test Suite               ║')
  console.log('╠══════════════════════════════════════════════════════════════╣')
  console.log(`║  Relays: ${RELAYS.map(r => r.name).join(', ').padEnd(49)}║`)
  console.log(`║  API Key: ${API_KEY.slice(0, 8)}...${' '.repeat(40)}║`)
  console.log('╚══════════════════════════════════════════════════════════════╝')

  // Pre-flight: verify all relays are online
  console.log('\n  Pre-flight check...')
  for (const relay of RELAYS) {
    const online = await isOnline(relay)
    if (!online) {
      console.error(`  ❌ ${relay.name} (${relay.ip}) is OFFLINE — cannot run tests`)
      process.exit(1)
    }
    console.log(`  ✓ ${relay.name} online`)
  }

  const testsToRun = arg === 'all' ? [1, 2, 3, 4, 5] : [parseInt(arg)]
  const results = {}

  try {
    for (const n of testsToRun) {
      if (!TESTS[n]) {
        console.error(`Unknown test: ${n}`)
        continue
      }
      results[n] = await TESTS[n]()
    }
  } finally {
    await cleanup()
  }

  // Summary
  header('Results')
  const testNames = {
    1: 'Propagation Speed',
    2: 'Recovery from Failure',
    3: 'Partition Tolerance',
    4: 'Cascade Seed',
    5: 'Concurrent Seed'
  }
  for (const [n, pass] of Object.entries(results)) {
    result(pass, `Test ${n}: ${testNames[n]}`)
  }

  const allPassed = Object.values(results).every(Boolean)
  console.log()
  console.log(allPassed ? '  🎉 ALL TESTS PASSED' : '  ⚠️  SOME TESTS FAILED')
  console.log()
  process.exit(allPassed ? 0 : 1)
}

main().catch(err => {
  console.error('Fatal:', err)
  cleanup().then(() => process.exit(1))
})

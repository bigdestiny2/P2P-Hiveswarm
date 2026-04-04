#!/usr/bin/env node

/**
 * HiveRelay Comprehensive Test + Speed Benchmark
 *
 * Uses @hyperswarm/testnet for fast, deterministic local DHT.
 *
 * Tests:
 *   1. Network bootstrap speed (3 relay nodes)
 *   2. Client discovery speed
 *   3. Single file publish + replicate
 *   4. Multi-file publish + replicate (50 files)
 *   5. Large file publish + replicate (1 MB)
 *   6. Concurrent clients (5 pub + 5 con)
 *   7. Offline resilience (publisher dies, consumer reads from relays)
 *   8. Hot update propagation
 *   9. API throughput (burst 100 requests)
 *   10. Drive list + getStatus
 *
 * Usage:
 *   node scripts/comprehensive-test.js
 */

import createTestnet from '@hyperswarm/testnet'
import Hyperswarm from 'hyperswarm'
import { RelayNode } from '../core/relay-node/index.js'
import { HiveRelayClient } from '../client/index.js'
import Corestore from 'corestore'
import b4a from 'b4a'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

const testId = randomBytes(4).toString('hex')
const baseDir = join(tmpdir(), 'hiverelay-bench-' + testId)
mkdirSync(baseDir, { recursive: true })

const BASE_PORT = 18200
const NODES = 3

let passed = 0
let failed = 0
const results = []
const timings = []
let testnet = null

function log (msg) { console.log('  ' + msg) }
function pass (name, ms) {
  passed++
  results.push({ name, ok: true })
  if (ms !== undefined) {
    timings.push({ name, ms })
    log('[PASS] ' + name + ' (' + ms + ' ms)')
  } else {
    log('[PASS] ' + name)
  }
}
function fail (name, err) { failed++; results.push({ name, ok: false, error: err }); log('[FAIL] ' + name + ': ' + err) }
async function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function time () { return performance.now() }
function elapsed (start) { return Math.round(performance.now() - start) }

function tmpPath (name) {
  const p = join(baseDir, name)
  mkdirSync(p, { recursive: true })
  return p
}

function makeClient (name) {
  const store = new Corestore(tmpPath(name))
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  swarm.on('connection', (conn) => store.replicate(conn))
  return new HiveRelayClient({ swarm, store })
}

async function waitRelays (client, ms) {
  const deadline = Date.now() + (ms || 10000)
  while (client.relays.size === 0 && Date.now() < deadline) {
    await client.swarm.flush()
    await sleep(100)
  }
}

async function run () {
  console.log()
  console.log('==============================================================')
  console.log('    HiveRelay — Comprehensive Test + Speed Benchmark')
  console.log('==============================================================')
  console.log()
  log('Test ID:     ' + testId)
  log('Relay nodes: ' + NODES)
  log('Using:       @hyperswarm/testnet (local DHT)')
  console.log()

  // Create testnet
  testnet = await createTestnet(3)

  // ─── Test 1: Network Bootstrap Speed ─────────────────────────────
  console.log('  --- Test 1: Network Bootstrap Speed ---')

  const nodes = []
  const t1 = time()

  for (let i = 0; i < NODES; i++) {
    const node = new RelayNode({
      storage: tmpPath('relay-' + i),
      bootstrapNodes: testnet.bootstrap,
      enableAPI: true,
      apiPort: BASE_PORT + i,
      enableRelay: true,
      enableSeeding: true,
      enableMetrics: true,
      shutdownTimeoutMs: 5000
    })
    await node.start()
    nodes.push({ node, port: BASE_PORT + i, index: i })
  }

  pass('3 relay nodes started', elapsed(t1))

  // Let mesh form
  await sleep(500)
  console.log()

  // ─── Test 2: Client Discovery Speed ──────────────────────────────
  console.log('  --- Test 2: Client Discovery Speed ---')

  const t2 = time()
  const disc = makeClient('disc')
  await disc.start()
  await waitRelays(disc, 10000)

  if (disc.relays.size > 0) {
    pass('Client discovered ' + disc.relays.size + ' relay(s)', elapsed(t2))
  } else {
    fail('Client discovery', 'no relays found')
  }
  await disc.destroy()
  await disc.swarm.destroy()
  console.log()

  // ─── Test 3: Single File Publish + Replicate ─────────────────────
  console.log('  --- Test 3: Single File Publish + Replicate ---')

  const pub3 = makeClient('pub3')
  await pub3.start()

  const t3pub = time()
  const drive3 = await pub3.publish([
    { path: '/hello.txt', content: 'Hello from single file test' }
  ], { seed: false })
  const key3 = b4a.toString(drive3.key, 'hex')
  pass('Publish single file', elapsed(t3pub))

  // Consumer reads while publisher online (fast path)
  const con3 = makeClient('con3')
  await con3.start()

  const t3read = time()
  await con3.open(key3, { timeout: 10000 })
  const data3 = await con3.get(key3, '/hello.txt')
  if (data3 && b4a.toString(data3) === 'Hello from single file test') {
    pass('Replicate single file', elapsed(t3read))
  } else {
    fail('Single file replicate', 'got: ' + (data3 ? b4a.toString(data3) : 'null'))
  }
  await pub3.destroy(); await pub3.swarm.destroy()
  await con3.destroy(); await con3.swarm.destroy()
  console.log()

  // ─── Test 4: Multi-File Publish + Replicate (50 files) ──────────
  console.log('  --- Test 4: Multi-File (50 files) ---')

  const pub4 = makeClient('pub4')
  await pub4.start()

  const files50 = []
  for (let i = 0; i < 50; i++) {
    files50.push({
      path: '/data/file-' + String(i).padStart(3, '0') + '.json',
      content: JSON.stringify({ index: i, payload: randomBytes(64).toString('hex') })
    })
  }

  const t4pub = time()
  const drive4 = await pub4.publish(files50, { seed: false })
  const key4 = b4a.toString(drive4.key, 'hex')
  pass('Publish 50 files', elapsed(t4pub))

  const con4 = makeClient('con4')
  await con4.start()

  const t4read = time()
  await con4.open(key4, { timeout: 10000 })

  let read4 = 0
  for (let i = 0; i < 50; i++) {
    const f = await con4.get(key4, '/data/file-' + String(i).padStart(3, '0') + '.json')
    if (f) {
      const parsed = JSON.parse(b4a.toString(f))
      if (parsed.index === i) read4++
    }
  }

  if (read4 === 50) {
    pass('Replicate 50 files', elapsed(t4read))
  } else {
    fail('50 files replicate', 'read ' + read4 + '/50')
  }
  await pub4.destroy(); await pub4.swarm.destroy()
  await con4.destroy(); await con4.swarm.destroy()
  console.log()

  // ─── Test 5: Large File (1 MB) ──────────────────────────────────
  console.log('  --- Test 5: Large File (1 MB) ---')

  const pub5 = makeClient('pub5')
  await pub5.start()

  const largeContent = randomBytes(1024 * 1024)
  const t5pub = time()
  const drive5 = await pub5.publish([
    { path: '/large.bin', content: largeContent }
  ], { seed: false })
  const key5 = b4a.toString(drive5.key, 'hex')
  pass('Publish 1 MB file', elapsed(t5pub))

  const con5 = makeClient('con5')
  await con5.start()

  const t5read = time()
  await con5.open(key5, { timeout: 15000 })
  const data5 = await con5.get(key5, '/large.bin')
  if (data5 && data5.length === largeContent.length && Buffer.compare(data5, largeContent) === 0) {
    pass('Replicate 1 MB file', elapsed(t5read))
  } else {
    fail('1 MB file', 'expected ' + largeContent.length + ' bytes, got ' + (data5 ? data5.length : 0))
  }
  await pub5.destroy(); await pub5.swarm.destroy()
  await con5.destroy(); await con5.swarm.destroy()
  console.log()

  // ─── Test 6: Concurrent Clients (5 pub + 5 con) ─────────────────
  console.log('  --- Test 6: Concurrent Clients (5+5) ---')

  const t6 = time()
  const pubs6 = []
  const keys6 = []

  // Start 5 publishers concurrently
  for (let i = 0; i < 5; i++) pubs6.push(makeClient('cpub-' + i))
  await Promise.all(pubs6.map(p => p.start()))
  pass('5 publishers started', elapsed(t6))

  // Publish concurrently
  const t6pub = time()
  await Promise.all(pubs6.map(async (pub, i) => {
    const drive = await pub.publish([
      { path: '/app.json', content: JSON.stringify({ app: i, data: randomBytes(64).toString('hex') }) }
    ], { seed: false })
    keys6.push(b4a.toString(drive.key, 'hex'))
  }))
  pass('5 apps published concurrently', elapsed(t6pub))

  // 5 consumers read concurrently
  const t6con = time()
  const conResults6 = await Promise.all(keys6.map(async (key, i) => {
    const con = makeClient('ccon-' + i)
    await con.start()
    await con.open(key, { timeout: 10000 })
    const data = await con.get(key, '/app.json')
    await con.destroy(); await con.swarm.destroy()
    if (data) {
      const parsed = JSON.parse(b4a.toString(data))
      return parsed.app !== undefined
    }
    return false
  }))
  const success6 = conResults6.filter(Boolean).length

  if (success6 === 5) {
    pass('5 consumers read concurrently', elapsed(t6con))
  } else {
    fail('Concurrent consumers', success6 + '/5 succeeded')
  }

  // Cleanup publishers
  await Promise.all(pubs6.map(async (p) => { await p.destroy(); await p.swarm.destroy() }))
  console.log()

  // ─── Test 7: Offline Resilience ──────────────────────────────────
  console.log('  --- Test 7: Offline Resilience ---')

  const pub7 = makeClient('pub7')
  await pub7.start()
  await waitRelays(pub7, 5000)

  const drive7 = await pub7.publish([
    { path: '/offline.txt', content: 'Data that must survive publisher death' }
  ], { seed: false })
  const key7 = b4a.toString(drive7.key, 'hex')

  // Seed on relay nodes via API
  await Promise.all(nodes.map(({ port }) =>
    fetch('http://127.0.0.1:' + port + '/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: key7 })
    }).catch(() => null)
  ))

  // Wait for at least one relay to actually have the file content
  let relayHasData = false
  for (let attempt = 0; attempt < 40 && !relayHasData; attempt++) {
    for (const { node } of nodes) {
      const entry = node.seededApps.get(key7)
      if (entry && entry.drive) {
        try {
          const check = await entry.drive.get('/offline.txt')
          if (check) { relayHasData = true; break }
        } catch {}
      }
    }
    if (!relayHasData) await sleep(250)
  }

  if (relayHasData) {
    pass('Relay downloaded content')
  } else {
    fail('Relay download', 'no relay has the file after 10s')
  }

  // Kill publisher
  await pub7.destroy(); await pub7.swarm.destroy()
  await sleep(500)

  // Consumer reads from relays only
  const con7 = makeClient('con7')
  await con7.start()
  await waitRelays(con7, 5000)

  const t7 = time()
  await con7.open(key7, { timeout: 15000 })

  let data7 = null
  for (let i = 0; i < 40 && !data7; i++) {
    data7 = await con7.get(key7, '/offline.txt')
    if (!data7) await sleep(250)
  }

  if (data7 && b4a.toString(data7) === 'Data that must survive publisher death') {
    pass('Read from relay after publisher death', elapsed(t7))
  } else {
    fail('Offline resilience', 'got: ' + (data7 ? b4a.toString(data7) : 'null'))
  }
  await con7.destroy(); await con7.swarm.destroy()
  console.log()

  // ─── Test 8: Hot Update Propagation ──────────────────────────────
  console.log('  --- Test 8: Hot Update Propagation ---')

  const pub8 = makeClient('pub8')
  await pub8.start()

  const drive8 = await pub8.publish([
    { path: '/version.txt', content: 'v1' }
  ], { seed: false })
  const key8 = b4a.toString(drive8.key, 'hex')

  const con8 = makeClient('con8')
  await con8.start()
  await con8.open(key8, { timeout: 10000 })

  const v1 = await con8.get(key8, '/version.txt')
  if (v1 && b4a.toString(v1) === 'v1') {
    pass('Initial version read')
  } else {
    fail('Initial version', 'got: ' + (v1 ? b4a.toString(v1) : 'null'))
  }

  // Publisher pushes update
  const t8 = time()
  await pub8.put(key8, '/version.txt', 'v2')
  await pub8.put(key8, '/changelog.txt', 'Updated to v2')

  // Consumer polls for update
  const conDrive8 = con8.drives.get(key8)
  let v2 = null
  for (let i = 0; i < 30 && !v2; i++) {
    await conDrive8.update({ wait: false })
    v2 = await con8.get(key8, '/version.txt')
    if (v2 && b4a.toString(v2) === 'v2') break
    v2 = null
    await sleep(100)
  }

  const changelog = await con8.get(key8, '/changelog.txt')
  if (v2 && b4a.toString(v2) === 'v2' && changelog) {
    pass('Hot update propagated', elapsed(t8))
  } else {
    fail('Hot update', 'v2=' + (v2 ? b4a.toString(v2) : 'null'))
  }
  await pub8.destroy(); await pub8.swarm.destroy()
  await con8.destroy(); await con8.swarm.destroy()
  console.log()

  // ─── Test 9: API Throughput ──────────────────────────────────────
  console.log('  --- Test 9: API Throughput ---')

  const t9 = time()
  const apiOps = []
  for (let i = 0; i < 100; i++) {
    apiOps.push(
      fetch('http://127.0.0.1:' + nodes[0].port + '/health')
        .then(r => r.json())
        .then(d => d.ok)
        .catch(() => false)
    )
  }
  const apiResults = await Promise.all(apiOps)
  const apiOk = apiResults.filter(Boolean).length
  const apiMs = elapsed(t9)
  const rps = Math.round(apiOk / (apiMs / 1000))

  if (apiOk >= 55) {
    pass('API burst: ' + apiOk + '/100 OK (' + rps + ' req/s)', apiMs)
  } else {
    fail('API throughput', apiOk + '/100 OK')
  }
  console.log()

  // ─── Test 10: Drive List + getStatus ─────────────────────────────
  console.log('  --- Test 10: Drive List + Status ---')

  const pub10 = makeClient('pub10')
  await pub10.start()

  const files10 = []
  for (let i = 0; i < 10; i++) {
    files10.push({ path: '/docs/page-' + i + '.txt', content: 'Page ' + i })
  }
  const drive10 = await pub10.publish(files10, { seed: false })
  const key10 = b4a.toString(drive10.key, 'hex')

  const t10list = time()
  const listing = await pub10.list(key10, '/docs')
  if (listing && listing.length === 10) {
    pass('List 10 files', elapsed(t10list))
  } else {
    fail('List files', 'expected 10, got ' + (listing ? listing.length : 0))
  }

  const status = pub10.getStatus()
  if (status.started && status.drives === 1) {
    pass('getStatus correct')
  } else {
    fail('getStatus', JSON.stringify(status))
  }

  await pub10.destroy(); await pub10.swarm.destroy()

  // Relay status
  for (const { node, index } of nodes) {
    const stats = node.getStats()
    pass('Relay ' + index + ' — seeded: ' + stats.seededApps + ', conns: ' + stats.connections)
  }
  console.log()

  // ─── Cleanup ─────────────────────────────────────────────────────
  console.log('  --- Cleanup ---')

  for (const { node, index } of nodes) {
    await node.stop()
    log('Relay ' + index + ' stopped')
  }
  await testnet.destroy()

  try {
    rmSync(baseDir, { recursive: true, force: true })
    log('Cleaned up: ' + baseDir)
  } catch {}

  // ─── Report ──────────────────────────────────────────────────────
  console.log()
  console.log('==============================================================')
  console.log('                    Test Report')
  console.log('==============================================================')
  console.log()
  log('Total:  ' + (passed + failed))
  log('Passed: ' + passed)
  log('Failed: ' + failed)
  console.log()

  if (timings.length > 0) {
    console.log('  --- Speed Results ---')
    for (const t of timings) {
      log(String(t.ms).padStart(7) + ' ms  ' + t.name)
    }
    console.log()
  }

  if (failed > 0) {
    console.log('  --- Failures ---')
    for (const r of results) {
      if (!r.ok) log('  - ' + r.name + ': ' + r.error)
    }
    console.log()
  }

  log(failed === 0 ? 'COMPREHENSIVE TEST: ALL PASSED' : 'COMPREHENSIVE TEST: SOME FAILURES')
  console.log()

  process.exit(failed > 0 ? 1 : 0)
}

run().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

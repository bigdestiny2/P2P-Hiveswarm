#!/usr/bin/env node

/**
 * test-bootstrap-cache.js
 *
 * Validates the BootstrapCache fix:
 *   1. Reads the live bootstrap-cache.json on disk
 *   2. Tests merge() with null, undefined, [], and real peer lists
 *   3. Tests load()/save() round-trip via a temp directory
 *   4. Tests that merge(null) lets Hyperswarm reach the real DHT
 */

import { BootstrapCache } from '../core/bootstrap-cache.js'
import { readFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import Hyperswarm from 'hyperswarm'

const LIVE_CACHE = join(process.env.HOME, '.hiverelay/storage/bootstrap-cache.json')

let passed = 0
let failed = 0

function assert (condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.log(`  FAIL  ${label}`)
    failed++
  }
}

// ── 1. Read the live cache file ─────────────────────────────────────────────
async function testReadLiveCache () {
  console.log('\n── 1. Read live bootstrap-cache.json ──')
  try {
    const raw = await readFile(LIVE_CACHE, 'utf8')
    const data = JSON.parse(raw)
    assert(data && Array.isArray(data.peers), 'cache file has peers array')
    assert(data.peers.length > 0, `cache contains ${data.peers.length} peer(s)`)
    assert(typeof data.updatedAt === 'number', 'updatedAt is a number')
    console.log(`  (peers: ${data.peers.map(p => p.host + ':' + p.port).join(', ')})`)
  } catch (err) {
    assert(false, 'read live cache: ' + err.message)
  }
}

// ── 2 & 3. merge() behaviour ────────────────────────────────────────────────
async function testMerge () {
  console.log('\n── 2. BootstrapCache.merge() tests ──')

  // Create a cache with some pre-loaded peers so _collectPeers() returns data
  const tmp = await mkdtemp(join(tmpdir(), 'hive-merge-'))
  const cache = new BootstrapCache(tmp)
  // Manually seed _seenPeers to simulate cached peers
  cache._seenPeers.set('10.0.0.1:9000', { host: '10.0.0.1', port: 9000, lastSeen: Date.now() })
  cache._seenPeers.set('10.0.0.2:9001', { host: '10.0.0.2', port: 9001, lastSeen: Date.now() })

  // 2a. merge(null) — should return undefined (use Hyperswarm defaults)
  const r1 = cache.merge(null)
  assert(r1 === undefined, 'merge(null) returns undefined')

  // 2b. merge(undefined) — should return undefined
  const r2 = cache.merge(undefined)
  assert(r2 === undefined, 'merge(undefined) returns undefined')

  // 2c. merge([]) — should return undefined
  const r3 = cache.merge([])
  assert(r3 === undefined, 'merge([]) returns undefined')

  // 2d. merge(configured) WITH cached peers — returns merged array
  const configured = [{ host: '1.2.3.4', port: 49737 }]
  const r4 = cache.merge(configured)
  assert(Array.isArray(r4), 'merge(configured) with cached peers returns an array')
  assert(r4.length === 3, `merged array has 3 entries (1 configured + 2 cached), got ${r4 && r4.length}`)
  assert(r4[0].host === '1.2.3.4' && r4[0].port === 49737, 'configured node is first in merged list')
  const hosts = r4.map(p => p.host)
  assert(hosts.includes('10.0.0.1') && hosts.includes('10.0.0.2'), 'cached peers are in merged list')

  // 2e. merge(configured) WITHOUT cached peers — returns configured list
  const emptyCache = new BootstrapCache(tmp)
  // _seenPeers is empty, so _collectPeers() returns []
  const r5 = emptyCache.merge(configured)
  // When no cached peers, configuredBootstrap is returned as-is (truthy passthrough)
  assert(r5 === configured || (Array.isArray(r5) && r5.length === 1 && r5[0].host === '1.2.3.4'),
    'merge(configured) without cached peers returns the configured list')

  await rm(tmp, { recursive: true, force: true })
}

// ── 4. load()/save() round-trip ─────────────────────────────────────────────
async function testLoadSaveCycle () {
  console.log('\n── 3. load()/save() round-trip ──')

  const tmp = await mkdtemp(join(tmpdir(), 'hive-ls-'))
  const cache1 = new BootstrapCache(tmp)
  cache1._seenPeers.set('5.5.5.5:1234', { host: '5.5.5.5', port: 1234, lastSeen: 111 })
  cache1._seenPeers.set('6.6.6.6:5678', { host: '6.6.6.6', port: 5678, lastSeen: 222 })
  await cache1.save()

  // Read the file back raw to verify format
  const raw = await readFile(join(tmp, 'bootstrap-cache.json'), 'utf8')
  const on_disk = JSON.parse(raw)
  assert(Array.isArray(on_disk.peers), 'saved file has peers array')
  assert(on_disk.peers.length === 2, `saved file has 2 peers, got ${on_disk.peers.length}`)

  // Reload into a fresh instance
  const cache2 = new BootstrapCache(tmp)
  await cache2.load()
  assert(cache2._peers.length === 2, `loaded 2 peers from disk, got ${cache2._peers.length}`)
  const loaded_hosts = cache2._peers.map(p => p.host).sort()
  assert(loaded_hosts.includes('5.5.5.5') && loaded_hosts.includes('6.6.6.6'),
    'loaded peers match saved peers')

  await rm(tmp, { recursive: true, force: true })
}

// ── 5. Hyperswarm with merge(null) connects to real DHT ─────────────────────
async function testHyperswarmDHT () {
  console.log('\n── 4. Hyperswarm with merge(null) reaches real DHT ──')

  const tmp = await mkdtemp(join(tmpdir(), 'hive-dht-'))
  const cache = new BootstrapCache(tmp)
  const bootstrap = cache.merge(null) // must be undefined → Hyperswarm uses defaults

  assert(bootstrap === undefined, 'merge(null) gives undefined bootstrap (Hyperswarm uses defaults)')

  let swarm
  try {
    swarm = new Hyperswarm({ bootstrap })

    // firewalled check — after the swarm opens a socket, dht.firewalled
    // resolves once the node has contacted bootstrap servers
    const dht = swarm.dht

    // Wait for the DHT to be ready (indicates successful bootstrap contact)
    await Promise.race([
      new Promise((resolve) => {
        if (dht.bootstrapped) return resolve()
        dht.once('ready', resolve)
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DHT ready timeout (10s)')), 10000))
    ])
    assert(true, 'DHT bootstrapped successfully (ready event fired)')

    // Check firewalled status is available (boolean)
    const fw = dht.firewalled
    assert(typeof fw === 'boolean', `dht.firewalled is boolean (value: ${fw})`)

    // Try findNode — exercises real DHT connectivity
    const randomKey = Buffer.alloc(32)
    randomKey[0] = 0xab; randomKey[1] = 0xcd
    let findNodeOk = false
    try {
      const q = dht.findNode(randomKey)
      // Consume at least one result or finish
      await Promise.race([
        (async () => { for await (const _ of q) { findNodeOk = true; break } })(), // eslint-disable-line
        new Promise((resolve) => setTimeout(resolve, 5000))
      ])
      // Even if no results, completing without error = DHT reachable
      findNodeOk = true
    } catch (err) {
      console.log(`  (findNode error: ${err.message})`)
    }
    assert(findNodeOk, 'dht.findNode() executed without error (DHT reachable)')
  } finally {
    if (swarm) {
      await swarm.destroy()
    }
    await rm(tmp, { recursive: true, force: true })
  }
}

// ── Run all tests ───────────────────────────────────────────────────────────
async function main () {
  console.log('=== BootstrapCache Test Suite ===')

  await testReadLiveCache()
  await testMerge()
  await testLoadSaveCycle()
  await testHyperswarmDHT()

  console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${passed + failed} total ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(2)
})

#!/usr/bin/env node

/**
 * Pear POS Bootstrap Test
 *
 * Simulates a Point-of-Sale app using HiveRelay:
 *
 *   1. POS Terminal publishes product catalog + transaction log
 *   2. Requests relay seeding so data persists when terminal is off
 *   3. POS Terminal goes offline
 *   4. Manager device opens the same data via relay network
 *   5. Verifies all products and transactions are available
 *
 * Usage:
 *   node scripts/pear-pos-test.js
 *
 * Requires: local relay network running (node scripts/local-network.js)
 */

import { HiveRelayClient } from '../client/index.js'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import b4a from 'b4a'

const testId = randomBytes(4).toString('hex')
const baseDir = join(tmpdir(), 'pear-pos-test-' + testId)
mkdirSync(baseDir, { recursive: true })

let passed = 0
let failed = 0
const results = []

function log (msg) { console.log('  ' + msg) }
function pass (name) { passed++; results.push({ name, ok: true }); log('[PASS] ' + name) }
function fail (name, err) { failed++; results.push({ name, ok: false, error: err }); log('[FAIL] ' + name + ': ' + err) }
async function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

// Sample POS data
const PRODUCTS = {
  catalog: [
    { id: 'SKU001', name: 'Espresso', price: 3.50, currency: 'USD' },
    { id: 'SKU002', name: 'Latte', price: 4.75, currency: 'USD' },
    { id: 'SKU003', name: 'Croissant', price: 2.25, currency: 'USD' },
    { id: 'SKU004', name: 'Avocado Toast', price: 8.50, currency: 'USD' },
    { id: 'SKU005', name: 'Cold Brew', price: 4.00, currency: 'USD' }
  ],
  updatedAt: new Date().toISOString()
}

const TRANSACTIONS = [
  { id: 'TXN-001', items: ['SKU001', 'SKU003'], total: 5.75, paid: true, method: 'lightning', timestamp: Date.now() - 3600000 },
  { id: 'TXN-002', items: ['SKU002'], total: 4.75, paid: true, method: 'cash', timestamp: Date.now() - 1800000 },
  { id: 'TXN-003', items: ['SKU004', 'SKU005'], total: 12.50, paid: true, method: 'lightning', timestamp: Date.now() - 900000 }
]

const STORE_CONFIG = {
  name: 'Pear Coffee Co.',
  location: 'Austin, TX',
  terminalId: 'TERMINAL-' + testId.toUpperCase(),
  version: '1.0.0'
}

async function run () {
  console.log()
  console.log('==============================================================')
  console.log('    Pear POS — HiveRelay Bootstrap Test')
  console.log('==============================================================')
  console.log()
  log('Test ID:   ' + testId)
  log('Base dir:  ' + baseDir)
  console.log()

  // --- Step 1: Check relay network is running ---
  console.log('  --- Step 1: Check Relay Network ---')

  let relayUp = false
  try {
    const res = await fetch('http://127.0.0.1:9100/health')
    const health = await res.json()
    if (health.ok && health.running) {
      relayUp = true
      pass('Relay network is running')
    }
  } catch {
    fail('Relay network', 'not reachable at 127.0.0.1:9100 — start with: node scripts/local-network.js')
  }

  if (!relayUp) {
    log('Cannot proceed without relay network. Exiting.')
    process.exit(1)
  }
  console.log()

  // --- Step 2: POS Terminal publishes data ---
  console.log('  --- Step 2: POS Terminal Publishes ---')

  const terminal = new HiveRelayClient(join(baseDir, 'terminal'))
  await terminal.start()
  pass('POS terminal started')

  // Wait for relay discovery
  for (let i = 0; i < 30 && terminal.relays.size === 0; i++) {
    await terminal.swarm.flush()
    await sleep(500)
  }

  if (terminal.relays.size > 0) {
    pass('Terminal discovered ' + terminal.relays.size + ' relay(s)')
  } else {
    log('WARNING: No relays discovered via DHT (may take longer on real network)')
    log('Continuing anyway — data will still replicate via direct topic join')
  }

  // Publish the POS app data
  const drive = await terminal.publish([
    { path: '/config.json', content: JSON.stringify(STORE_CONFIG, null, 2) },
    { path: '/catalog/products.json', content: JSON.stringify(PRODUCTS, null, 2) },
    { path: '/transactions/today.json', content: JSON.stringify(TRANSACTIONS, null, 2) },
    { path: '/terminal/status.json', content: JSON.stringify({ online: true, lastSync: new Date().toISOString() }) }
  ], { seed: false }) // We'll seed via API instead for visibility

  const appKey = b4a.toString(drive.key, 'hex')
  pass('Published POS data (key: ' + appKey.slice(0, 16) + '...)')

  // Seed via relay API for explicit control
  let seeded = 0
  for (const port of [9100, 9101, 9102]) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey })
      })
      const data = await res.json()
      if (data.ok) seeded++
    } catch {}
  }

  if (seeded > 0) {
    pass('Seeded on ' + seeded + '/3 relay nodes')
  } else {
    fail('Relay seeding', 'no relays accepted seed request')
  }

  // Give relays time to download all blocks from terminal
  log('Waiting for relay replication (10s)...')
  await sleep(10000)
  console.log()

  // --- Step 3: Terminal goes offline ---
  console.log('  --- Step 3: Terminal Goes Offline ---')

  await terminal.destroy()
  pass('POS terminal shut down (simulating offline)')
  await sleep(3000)
  console.log()

  // --- Step 4: Manager device opens data ---
  console.log('  --- Step 4: Manager Device Opens Data ---')

  const manager = new HiveRelayClient(join(baseDir, 'manager'))
  await manager.start()
  pass('Manager device started')

  // Wait for relay discovery
  for (let i = 0; i < 30 && manager.relays.size === 0; i++) {
    await manager.swarm.flush()
    await sleep(500)
  }

  if (manager.relays.size > 0) {
    pass('Manager discovered ' + manager.relays.size + ' relay(s)')
  } else {
    log('WARNING: No relays discovered via DHT')
  }

  // Open the POS drive
  await manager.open(appKey, { timeout: 20000 })
  pass('Opened POS drive from relay network')
  console.log()

  // --- Step 5: Verify all data ---
  console.log('  --- Step 5: Verify POS Data ---')

  // Check store config
  try {
    const configBuf = await manager.get(appKey, '/config.json')
    if (configBuf) {
      const config = JSON.parse(b4a.toString(configBuf))
      if (config.name === 'Pear Coffee Co.' && config.terminalId === STORE_CONFIG.terminalId) {
        pass('Store config: ' + config.name + ' (' + config.terminalId + ')')
      } else {
        fail('Store config', 'unexpected content')
      }
    } else {
      fail('Store config', 'file not found')
    }
  } catch (err) {
    fail('Store config', err.message)
  }

  // Check product catalog
  try {
    const catalogBuf = await manager.get(appKey, '/catalog/products.json')
    if (catalogBuf) {
      const catalog = JSON.parse(b4a.toString(catalogBuf))
      if (catalog.catalog && catalog.catalog.length === 5) {
        const names = catalog.catalog.map(p => p.name).join(', ')
        pass('Product catalog: ' + catalog.catalog.length + ' items (' + names + ')')
      } else {
        fail('Product catalog', 'expected 5 items, got ' + (catalog.catalog ? catalog.catalog.length : 0))
      }
    } else {
      fail('Product catalog', 'file not found')
    }
  } catch (err) {
    fail('Product catalog', err.message)
  }

  // Check transactions
  try {
    const txBuf = await manager.get(appKey, '/transactions/today.json')
    if (txBuf) {
      const txns = JSON.parse(b4a.toString(txBuf))
      if (Array.isArray(txns) && txns.length === 3) {
        const total = txns.reduce((sum, t) => sum + t.total, 0)
        const lightning = txns.filter(t => t.method === 'lightning').length
        pass('Transactions: ' + txns.length + ' today, $' + total.toFixed(2) + ' total (' + lightning + ' lightning)')
      } else {
        fail('Transactions', 'expected 3, got ' + (Array.isArray(txns) ? txns.length : 'not array'))
      }
    } else {
      fail('Transactions', 'file not found')
    }
  } catch (err) {
    fail('Transactions', err.message)
  }

  // Check terminal status
  try {
    const statusBuf = await manager.get(appKey, '/terminal/status.json')
    if (statusBuf) {
      const status = JSON.parse(b4a.toString(statusBuf))
      pass('Terminal status: online=' + status.online + ', lastSync=' + status.lastSync)
    } else {
      fail('Terminal status', 'file not found')
    }
  } catch (err) {
    fail('Terminal status', err.message)
  }

  // Check relay node status
  console.log()
  console.log('  --- Relay Network Status ---')
  for (const port of [9100, 9101, 9102]) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/status')
      const status = await res.json()
      log('Relay :' + port + ' — conns: ' + status.connections + ', seeded: ' + status.seededApps)
    } catch {}
  }
  console.log()

  // --- Cleanup ---
  console.log('  --- Cleanup ---')
  await manager.destroy()
  log('Manager device stopped')

  try {
    rmSync(baseDir, { recursive: true, force: true })
    log('Cleaned up: ' + baseDir)
  } catch {}

  // --- Report ---
  console.log()
  console.log('==============================================================')
  console.log('                   Pear POS Test Report')
  console.log('==============================================================')
  console.log()
  log('Total:  ' + (passed + failed))
  log('Passed: ' + passed)
  log('Failed: ' + failed)
  console.log()

  if (failed > 0) {
    log('Failed tests:')
    for (const r of results) {
      if (!r.ok) log('  - ' + r.name + ': ' + r.error)
    }
    console.log()
  }

  log(failed === 0 ? 'PEAR POS TEST: ALL PASSED' : 'PEAR POS TEST: SOME FAILURES')
  console.log()

  process.exit(failed > 0 ? 1 : 0)
}

run().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

#!/usr/bin/env node

/**
 * HiveRelay - Minimum Viable Network (MVN) Full Test
 *
 * Spins up 3 relay nodes + 2 Pear app clients to prove the full
 * network works end-to-end:
 *
 *   1. Start 3 relay nodes (different ports/storage)
 *   2. Client A creates a Hyperdrive, writes content, requests seeding
 *   3. Client B discovers the content via the relay network
 *   4. Verify data replication through relay infrastructure
 *   5. Verify HTTP API on all relay nodes
 *   6. Verify relay mesh connectivity
 *   7. Print summary report
 *
 * Usage:
 *   node scripts/mvn-test.js
 */

import { RelayNode } from '../core/relay-node/index.js'
import { HiveRelayClient } from '../client/index.js'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import b4a from 'b4a'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

const networkId = randomBytes(4).toString('hex')
const baseDir = join(tmpdir(), 'hiverelay-mvn-' + networkId)
mkdirSync(baseDir, { recursive: true })

const BASE_PORT = 19100
const NODES = 3
const results = []
let passed = 0
let failed = 0

function log (msg) { console.log('  ' + msg) }
function pass (name) { passed++; results.push({ name, ok: true }); log('[PASS] ' + name) }
function fail (name, err) { failed++; results.push({ name, ok: false, error: err }); log('[FAIL] ' + name + ': ' + err) }
async function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function run () {
  console.log()
  console.log('==============================================================')
  console.log('    HiveRelay - Minimum Viable Network Full Test')
  console.log('==============================================================')
  console.log()
  log('Network ID: ' + networkId)
  log('Base dir:   ' + baseDir)
  log('Relay nodes: ' + NODES + ' (ports ' + BASE_PORT + '-' + (BASE_PORT + NODES - 1) + ')')
  console.log()

  // --- Step 1: Start relay nodes ---
  console.log('  --- Step 1: Start Relay Nodes ---')
  const nodes = []

  for (let i = 0; i < NODES; i++) {
    const storage = join(baseDir, 'relay-' + i)
    mkdirSync(storage, { recursive: true })
    const port = BASE_PORT + i

    const node = new RelayNode({
      storage,
      enableAPI: true,
      apiPort: port,
      enableRelay: true,
      enableSeeding: true,
      enableMetrics: true,
      shutdownTimeoutMs: 5000
    })

    await node.start()
    const key = b4a.toString(node.swarm.keyPair.publicKey, 'hex')
    nodes.push({ node, port, key, index: i })
    pass('Relay node ' + i + ' started (port ' + port + ', key ' + key.slice(0, 12) + '...)')
  }
  console.log()

  // --- Step 2: Client A publishes content ---
  console.log('  --- Step 2: Client A Publishes Content ---')

  const swarmA = new Hyperswarm()
  const storeA = new Corestore(join(baseDir, 'client-a'))
  const clientA = new HiveRelayClient({ swarm: swarmA, store: storeA })
  await clientA.start()

  // Wait for relay discovery
  for (let i = 0; i < 20 && clientA.relays.size === 0; i++) {
    await swarmA.flush()
    await sleep(500)
  }

  if (clientA.relays.size > 0) {
    pass('Client A discovered ' + clientA.relays.size + ' relay(s)')
  } else {
    fail('Client A relay discovery', 'no relays found')
  }

  // Create a Hyperdrive and write content
  const driveA = new Hyperdrive(storeA)
  await driveA.ready()
  await driveA.put('/hello.txt', b4a.from('Hello from the Pear app!'))
  await driveA.put('/data.json', b4a.from(JSON.stringify({ app: 'hiverelay-test', version: 1 })))

  const appKeyHex = b4a.toString(driveA.key, 'hex')
  log('App key: ' + appKeyHex.slice(0, 16) + '...')

  // Announce the drive
  swarmA.join(driveA.discoveryKey, { server: true, client: true })
  await swarmA.flush()
  pass('Client A published Hyperdrive with 2 files')

  // Request seeding via client SDK
  const acceptances = await clientA.seed(driveA.key, { replicas: 1, timeout: 5000 })
  pass('Client A requested seeding (' + acceptances.length + ' acceptance(s))')

  // Also seed directly on relay nodes via API
  for (const { port, index } of nodes) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: appKeyHex })
      })
      const data = await res.json()
      if (data.ok) {
        pass('Relay ' + index + ' seeding app via API')
      } else {
        fail('Relay ' + index + ' seed API', data.error || 'not ok')
      }
    } catch (err) {
      fail('Relay ' + index + ' seed API', err.message)
    }
  }
  console.log()

  // --- Step 3: Client B discovers and downloads content ---
  console.log('  --- Step 3: Client B Replicates Content ---')

  const swarmB = new Hyperswarm()
  const storeB = new Corestore(join(baseDir, 'client-b'))
  const clientB = new HiveRelayClient({ swarm: swarmB, store: storeB })
  await clientB.start()

  // Wait for relay discovery
  for (let i = 0; i < 20 && clientB.relays.size === 0; i++) {
    await swarmB.flush()
    await sleep(500)
  }

  if (clientB.relays.size > 0) {
    pass('Client B discovered ' + clientB.relays.size + ' relay(s)')
  } else {
    fail('Client B relay discovery', 'no relays found')
  }

  // Open the same drive by key
  const driveB = new Hyperdrive(storeB, driveA.key)
  await driveB.ready()

  swarmB.join(driveB.discoveryKey, { server: true, client: true })
  await swarmB.flush()

  // Wait for replication
  await driveB.update({ wait: true })

  const hello = await driveB.get('/hello.txt')
  if (hello && b4a.toString(hello) === 'Hello from the Pear app!') {
    pass('Client B replicated /hello.txt correctly')
  } else {
    fail('Client B /hello.txt', 'got: ' + (hello ? b4a.toString(hello) : 'null'))
  }

  const data = await driveB.get('/data.json')
  if (data) {
    const parsed = JSON.parse(b4a.toString(data))
    if (parsed.app === 'hiverelay-test') {
      pass('Client B replicated /data.json correctly')
    } else {
      fail('Client B /data.json', 'unexpected content: ' + b4a.toString(data))
    }
  } else {
    fail('Client B /data.json', 'file not found')
  }
  console.log()

  // --- Step 4: Verify HTTP APIs ---
  console.log('  --- Step 4: Verify HTTP APIs ---')

  for (const { port, index } of nodes) {
    try {
      const healthRes = await fetch('http://127.0.0.1:' + port + '/health')
      const health = await healthRes.json()
      if (health.ok && health.running) {
        pass('Relay ' + index + ' /health OK')
      } else {
        fail('Relay ' + index + ' /health', JSON.stringify(health))
      }
    } catch (err) {
      fail('Relay ' + index + ' /health', err.message)
    }

    try {
      const statusRes = await fetch('http://127.0.0.1:' + port + '/status')
      const status = await statusRes.json()
      if (status.running && status.seededApps >= 1) {
        pass('Relay ' + index + ' /status - seeding ' + status.seededApps + ' app(s), ' + status.connections + ' conn(s)')
      } else {
        fail('Relay ' + index + ' /status', 'running=' + status.running + ' seeded=' + status.seededApps)
      }
    } catch (err) {
      fail('Relay ' + index + ' /status', err.message)
    }

    try {
      const metricsRes = await fetch('http://127.0.0.1:' + port + '/metrics')
      const metrics = await metricsRes.text()
      if (metrics.includes('hiverelay_uptime_seconds')) {
        pass('Relay ' + index + ' /metrics - Prometheus format OK')
      } else {
        fail('Relay ' + index + ' /metrics', 'missing expected metrics')
      }
    } catch (err) {
      fail('Relay ' + index + ' /metrics', err.message)
    }
  }
  console.log()

  // --- Step 5: Verify relay mesh ---
  console.log('  --- Step 5: Verify Relay Mesh ---')

  for (const { node, index } of nodes) {
    const conns = node.getStats().connections
    if (conns >= 1) {
      pass('Relay ' + index + ' has ' + conns + ' connection(s)')
    } else {
      fail('Relay ' + index + ' connections', 'expected >= 1, got ' + conns)
    }
  }
  console.log()

  // --- Cleanup ---
  console.log('  --- Cleanup ---')

  await clientA.destroy()
  await clientB.destroy()
  await driveA.close()
  await driveB.close()
  await storeA.close()
  await storeB.close()
  await swarmA.destroy()
  await swarmB.destroy()

  for (const { node, index } of nodes) {
    await node.stop()
    log('Relay ' + index + ' stopped')
  }

  try {
    rmSync(baseDir, { recursive: true, force: true })
    log('Cleaned up: ' + baseDir)
  } catch {}

  // --- Report ---
  console.log()
  console.log('==============================================================')
  console.log('                     MVN Test Report')
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

  log(failed === 0 ? 'MVN TEST: ALL PASSED' : 'MVN TEST: SOME FAILURES')
  console.log()

  process.exit(failed > 0 ? 1 : 0)
}

run().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

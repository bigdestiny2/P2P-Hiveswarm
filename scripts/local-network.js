#!/usr/bin/env node

/**
 * HiveRelay Local Network Bootstrap
 *
 * Starts 3 relay nodes on localhost to demonstrate and observe the
 * minimum viable network forming end-to-end.
 *
 * Usage:
 *   node scripts/local-network.js
 *   node scripts/local-network.js --nodes 5
 *   node scripts/local-network.js --seed <hex-key>
 *
 * Each node gets its own storage directory and API port.
 * Press Ctrl+C to shut down the entire network gracefully.
 */

import { RelayNode } from '../core/relay-node/index.js'
import b4a from 'b4a'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import minimist from 'minimist'

const args = minimist(process.argv.slice(2))
const NODE_COUNT = parseInt(args.nodes) || 3
const BASE_PORT = parseInt(args.port) || 9100
const SEED_KEYS = args.seed ? [].concat(args.seed) : []

const networkId = randomBytes(4).toString('hex')
const networkDir = join(tmpdir(), `hiverelay-network-${networkId}`)
mkdirSync(networkDir, { recursive: true })

const nodes = []
let shuttingDown = false

console.log('╔══════════════════════════════════════════════════════╗')
console.log('║         HiveRelay — Local Network Bootstrap         ║')
console.log('╚══════════════════════════════════════════════════════╝')
console.log()
console.log(`  Network ID:  ${networkId}`)
console.log(`  Nodes:       ${NODE_COUNT}`)
console.log(`  Storage:     ${networkDir}`)
console.log(`  API Ports:   ${BASE_PORT}–${BASE_PORT + NODE_COUNT - 1}`)
console.log()

async function startNetwork () {
  // Start nodes sequentially so the first node's DHT address is known
  // (In production, nodes use the default HyperDHT bootstrap.)
  for (let i = 0; i < NODE_COUNT; i++) {
    const port = BASE_PORT + i
    const storage = join(networkDir, `node-${i}`)
    mkdirSync(storage, { recursive: true })

    const node = new RelayNode({
      storage,
      enableAPI: true,
      apiPort: port,
      enableRelay: true,
      enableSeeding: true,
      enableMetrics: true,
      maxConnections: 64,
      shutdownTimeoutMs: 5000
    })

    await node.start()
    const pubKey = b4a.toString(node.swarm.keyPair.publicKey, 'hex')

    console.log(`  [node ${i}] Started`)
    console.log(`           Key:  ${pubKey.slice(0, 16)}...${pubKey.slice(-8)}`)
    console.log(`           API:  http://127.0.0.1:${port}`)
    console.log(`           Dir:  ${storage}`)
    console.log()

    nodes.push({ node, port, index: i })
  }

  // Seed any keys provided via CLI
  if (SEED_KEYS.length > 0) {
    console.log('  Seeding requested apps...')
    for (const key of SEED_KEYS) {
      // Seed on every node for redundancy
      for (const { node, index } of nodes) {
        try {
          const result = await node.seedApp(key)
          console.log(`  [node ${index}] Seeding ${key.slice(0, 12)}... (dk: ${result.discoveryKey.slice(0, 12)}...)`)
        } catch (err) {
          console.log(`  [node ${index}] Seed error: ${err.message}`)
        }
      }
    }
    console.log()
  }

  // Create a shared topic so nodes find each other
  const networkTopic = randomBytes(32)
  for (const { node } of nodes) {
    node.swarm.join(networkTopic, { server: true, client: true })
  }
  // Flush all swarms to ensure connections establish
  await Promise.all(nodes.map(({ node }) => node.swarm.flush()))

  // Wire up connection events
  for (const { node, index } of nodes) {
    node.on('connection', ({ remotePubKey }) => {
      console.log(`  [node ${index}] ← peer connected: ${remotePubKey.slice(0, 16)}...`)
    })
    node.on('connection-closed', () => {
      console.log(`  [node ${index}] ← peer disconnected`)
    })
  }

  // Give connections a moment to establish
  await new Promise(resolve => setTimeout(resolve, 2000))

  console.log('  ─── Network Status ───')
  console.log()
  for (const { node, index, port } of nodes) {
    const stats = node.getStats()
    console.log(`  [node ${index}] Connections: ${stats.connections} | Seeded: ${stats.seededApps} | API: :${port}`)
  }
  console.log()
  console.log('  Network is running. Press Ctrl+C to shut down.')
  console.log()
  console.log('  Try these:')
  for (const { port, index } of nodes) {
    if (index === 0) {
      console.log(`    curl http://127.0.0.1:${port}/health     # Health check node ${index}`)
      console.log(`    curl http://127.0.0.1:${port}/status     # Full status node ${index}`)
      console.log(`    curl http://127.0.0.1:${port}/peers      # Peer list node ${index}`)
      console.log(`    curl http://127.0.0.1:${port}/metrics    # Prometheus metrics`)
    }
  }
  console.log()

  // Periodic status
  const statusInterval = setInterval(() => {
    if (shuttingDown) return
    const summary = nodes.map(({ node, index }) => {
      const s = node.getStats()
      return `n${index}:${s.connections}p`
    }).join(' | ')
    process.stdout.write(`\r  [network] ${summary}   `)
  }, 5000)

  // Graceful shutdown
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(statusInterval)
    console.log('\n')
    console.log('  Shutting down network...')

    for (const { node, index } of nodes) {
      try {
        await node.stop()
        console.log(`  [node ${index}] Stopped`)
      } catch (err) {
        console.log(`  [node ${index}] Stop error: ${err.message}`)
      }
    }

    // Cleanup temp storage
    try {
      rmSync(networkDir, { recursive: true, force: true })
      console.log(`  Cleaned up: ${networkDir}`)
    } catch {}

    console.log('  Network stopped.')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

startNetwork().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

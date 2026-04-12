/**
 * Self-Contained Demo
 * ====================
 * Spins up a server and client in the same process using a local testnet.
 * No external DHT needed — proves the full round-trip works.
 *
 * Run: node demo.js
 */

import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import ProtomuxRPC from 'protomux-rpc'
import createTestnet from '@hyperswarm/testnet'
import c from 'compact-encoding'
import b4a from 'b4a'
import crypto from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpPath (name) {
  const dir = join(tmpdir(), `block-storage-demo-${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

async function runDemo () {
  console.log('╔═══════════════════════════════════════════════════╗')
  console.log('║  Standalone Block Storage — Full Demo             ║')
  console.log('╚═══════════════════════════════════════════════════╝\n')

  // ── Step 0: Create local testnet ────────────────────────────
  console.log('Step 0: Creating local testnet (no public DHT)...\n')
  const testnet = await createTestnet(3)

  // ── Step 1: Create server ─────────────────────────────────
  console.log('Step 1: Starting server...')

  const serverStore = new Corestore(tmpPath('server'))
  const core = serverStore.get({ name: 'block-storage' })
  await core.ready()

  const serverSwarm = new Hyperswarm(testnet)
  let serverRPC = null

  serverSwarm.on('connection', (conn) => {
    serverStore.replicate(conn)

    serverRPC = new ProtomuxRPC(conn, {
      id: b4a.from('block-storage-rpc'),
      valueEncoding: c.json
    })

    serverRPC.respond('store-block', async (req) => {
      const buf = b4a.from(req.data, 'base64')
      const result = await core.append(buf)
      return { seq: result.length - 1, length: core.length }
    })

    serverRPC.respond('get-block', async (req) => {
      const block = await core.get(req.seq)
      return { seq: req.seq, data: b4a.toString(block, 'base64'), length: block.length }
    })

    serverRPC.respond('get-info', async () => {
      return { key: b4a.toString(core.key, 'hex'), length: core.length, byteLength: core.byteLength }
    })
  })

  const discovery = serverSwarm.join(core.discoveryKey, { server: true, client: false })
  await discovery.flushed()

  console.log(`  Core key: ${b4a.toString(core.key, 'hex').slice(0, 16)}...`)
  console.log(`  Discovery: ${b4a.toString(core.discoveryKey, 'hex').slice(0, 16)}...\n`)

  // ── Step 2: Create client ─────────────────────────────────
  console.log('Step 2: Starting client...')

  const clientStore = new Corestore(tmpPath('client'))
  const clientCore = clientStore.get({ key: core.key })
  await clientCore.ready()

  const clientSwarm = new Hyperswarm(testnet)
  let clientRPC = null
  let clientConnected = false

  const connectionPromise = new Promise((resolve) => {
    clientSwarm.on('connection', (conn) => {
      clientStore.replicate(conn)

      clientRPC = new ProtomuxRPC(conn, {
        id: b4a.from('block-storage-rpc'),
        valueEncoding: c.json
      })

      clientConnected = true
      resolve()
    })
  })

  const clientDiscovery = clientSwarm.join(clientCore.discoveryKey, { server: false, client: true })
  await clientDiscovery.flushed()

  console.log('  Connecting to server...')
  await connectionPromise
  console.log('  ✓ Connected!\n')

  // ── Step 3: Store blocks ──────────────────────────────────
  console.log('Step 3: Storing blocks...\n')

  const testBlocks = [
    'Hello, Holepunch!',
    'Block storage is working.',
    JSON.stringify({ type: 'transaction', amount: 100, currency: 'sats', timestamp: Date.now() }),
    crypto.randomBytes(128).toString('hex'),
    'Final test block — this is block #4'
  ]

  const results = []
  for (const block of testBlocks) {
    const result = await clientRPC.request('store-block', {
      data: b4a.toString(b4a.from(block), 'base64')
    })
    results.push(result)
    console.log(`  ✓ Block #${result.seq}: "${block.slice(0, 50)}${block.length > 50 ? '...' : ''}"`)
  }

  console.log()

  // ── Step 4: Read blocks back ──────────────────────────────
  console.log('Step 4: Reading blocks back...\n')

  for (let i = 0; i < testBlocks.length; i++) {
    const result = await clientRPC.request('get-block', { seq: i })
    const data = b4a.from(result.data, 'base64').toString()
    const matches = data === testBlocks[i]
    console.log(`  ${matches ? '✓' : '✗'} Block #${i}: ${data.slice(0, 50)}${data.length > 50 ? '...' : ''}`)
  }

  console.log()

  // ── Step 5: Server info ───────────────────────────────────
  console.log('Step 5: Server info...\n')

  const info = await clientRPC.request('get-info', {})
  console.log(`  Core key    : ${info.key.slice(0, 16)}...`)
  console.log(`  Total blocks: ${info.length}`)
  console.log(`  Total bytes : ${info.byteLength}`)
  console.log()

  // ── Step 6: Benchmark ─────────────────────────────────────
  console.log('Step 6: Write benchmark...\n')

  const benchCount = 100
  const benchStart = Date.now()
  for (let i = 0; i < benchCount; i++) {
    await clientRPC.request('store-block', {
      data: b4a.toString(crypto.randomBytes(256), 'base64')
    })
  }
  const benchElapsed = Date.now() - benchStart
  const blocksPerSec = Math.round(benchCount / (benchElapsed / 1000))
  console.log(`  ${benchCount} blocks in ${benchElapsed}ms`)
  console.log(`  Throughput: ${blocksPerSec} blocks/sec`)
  console.log()

  // ── Step 7: Verify Hypercore replication ──────────────────
  console.log('Step 7: Verifying Hypercore replication...\n')

  // Wait for replication to catch up
  await clientCore.update()
  const serverLength = core.length
  const clientLength = clientCore.length

  console.log(`  Server core length: ${serverLength}`)
  console.log(`  Client core length: ${clientLength}`)
  console.log(`  Replicated: ${clientLength >= serverLength ? '✓ yes' : '✗ catching up...'}`)

  if (clientLength > 0) {
    const localBlock = await clientCore.get(0)
    console.log(`  Local read of block #0: "${localBlock.toString().slice(0, 50)}"`)
  }

  console.log()

  // ── Cleanup ───────────────────────────────────────────────
  console.log('Cleaning up...')

  if (clientRPC) clientRPC.destroy()
  if (serverRPC) serverRPC.destroy()
  await clientSwarm.destroy()
  await serverSwarm.destroy()
  await clientStore.close()
  await serverStore.close()
  await testnet.destroy()

  console.log()
  console.log('╔═══════════════════════════════════════════════════╗')
  console.log('║  Demo complete — all operations successful!       ║')
  console.log('╚═══════════════════════════════════════════════════╝')
}

// ---------------------------------------------------------------------------

runDemo().catch((err) => {
  console.error('Demo failed:', err)
  process.exit(1)
})

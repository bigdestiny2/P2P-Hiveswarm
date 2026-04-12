/**
 * Standalone Block Storage Server
 * ================================
 * Holepunch Technical Challenge — Clean Implementation
 *
 * Accepts blocks from peers via protomux-rpc, appends them to a Hypercore.
 * Serves block reads back on request. Uses a single Hyperswarm for both
 * discovery and data transport.
 *
 * Design decisions:
 *  1. Single networking stack (Hyperswarm only — no redundant @hyperswarm/rpc)
 *  2. protomux-rpc for RPC — multiplexes over the existing swarm connection
 *  3. Server-as-topic: the server's public key IS the discovery topic
 *  4. Append-only semantics: blocks are immutable once stored
 */

import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import ProtomuxRPC from 'protomux-rpc'
import c from 'compact-encoding'
import b4a from 'b4a'
import goodbye from 'graceful-goodbye'
import { mkdirSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STORAGE_DIR = process.env.STORAGE_DIR || './storage-server'
const PORT = process.env.PORT ? parseInt(process.env.PORT) : undefined // Let Hyperswarm choose

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let store, swarm, core
const peers = new Map() // remotePublicKey hex → { rpc, connected }
let blockCount = 0

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main () {
  console.log('┌─────────────────────────────────────────┐')
  console.log('│  Standalone Block Storage Server         │')
  console.log('└─────────────────────────────────────────┘')

  // 1. Open Corestore + Hypercore
  mkdirSync(STORAGE_DIR, { recursive: true })
  store = new Corestore(STORAGE_DIR)
  core = store.get({ name: 'block-storage' })
  await core.ready()

  blockCount = core.length
  console.log(`\n  Hypercore ready`)
  console.log(`  Public key : ${b4a.toString(core.key, 'hex')}`)
  console.log(`  Blocks     : ${blockCount}`)

  // 2. Create Hyperswarm, replicate corestore on every connection
  swarm = new Hyperswarm()
  swarm.on('connection', onConnection)

  // 3. Join the swarm as server — topic = core's discovery key
  const discovery = swarm.join(core.discoveryKey, { server: true, client: false })
  await discovery.flushed()

  console.log(`\n  Swarm listening`)
  console.log(`  Discovery  : ${b4a.toString(core.discoveryKey, 'hex')}`)
  console.log(`\n  Waiting for peers...\n`)

  // 4. Graceful shutdown
  goodbye(async () => {
    console.log('\n  Shutting down...')
    for (const p of peers.values()) {
      if (p.rpc) p.rpc.destroy()
    }
    await swarm.destroy()
    await store.close()
    console.log('  Done.')
  })
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

function onConnection (conn, info) {
  const remotePubKeyHex = b4a.toString(conn.remotePublicKey, 'hex')
  const shortKey = remotePubKeyHex.slice(0, 8)
  console.log(`  ← Peer connected: ${shortKey}...`)

  // Replicate all cores over this connection (Hypercore sync)
  store.replicate(conn)

  // Open RPC channel over the same multiplexed connection
  const rpc = new ProtomuxRPC(conn, {
    id: b4a.from('block-storage-rpc'),
    valueEncoding: c.json
  })

  // Track peer
  peers.set(remotePubKeyHex, { rpc, connected: Date.now() })

  // ── RPC: store-block ──────────────────────────────────────
  // Client sends { data } (base64-encoded block)
  // Server appends to Hypercore, returns { seq, length }
  rpc.respond('store-block', async (req) => {
    try {
      const buf = b4a.from(req.data, 'base64')
      const result = await core.append(buf)
      const seq = result.length - 1
      blockCount = core.length
      console.log(`  ✓ Block #${seq} stored (${buf.length} bytes) from ${shortKey}`)
      return { seq, length: core.length }
    } catch (err) {
      console.error(`  ✗ store-block error: ${err.message}`)
      return { error: err.message }
    }
  })

  // ── RPC: get-block ────────────────────────────────────────
  // Client sends { seq }
  // Server reads block at that index, returns { data, seq }
  rpc.respond('get-block', async (req) => {
    try {
      const seq = req.seq
      if (seq < 0 || seq >= core.length) {
        return { error: `Block ${seq} out of range (0..${core.length - 1})` }
      }
      const block = await core.get(seq)
      return { seq, data: b4a.toString(block, 'base64'), length: block.length }
    } catch (err) {
      console.error(`  ✗ get-block error: ${err.message}`)
      return { error: err.message }
    }
  })

  // ── RPC: get-info ─────────────────────────────────────────
  // Returns core metadata: key, length, byteLength
  rpc.respond('get-info', async () => {
    return {
      key: b4a.toString(core.key, 'hex'),
      length: core.length,
      byteLength: core.byteLength,
      peers: peers.size,
      uptime: Math.floor((Date.now() - startTime) / 1000)
    }
  })

  // Cleanup on disconnect
  conn.on('close', () => {
    console.log(`  → Peer disconnected: ${shortKey}...`)
    peers.delete(remotePubKeyHex)
  })

  conn.on('error', (err) => {
    console.error(`  ✗ Connection error (${shortKey}): ${err.message}`)
    peers.delete(remotePubKeyHex)
  })
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const startTime = Date.now()
main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})

export { main, core, swarm, store }

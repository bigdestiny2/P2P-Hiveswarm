/**
 * Standalone Block Storage Client
 * ================================
 * Connects to the server via Hyperswarm, sends blocks via protomux-rpc,
 * and can retrieve them by sequence number.
 *
 * Usage:
 *   node client.js <server-core-public-key>
 *
 * Design decisions:
 *  1. Single Hyperswarm instance — no @hyperswarm/rpc (avoids redundant DHT)
 *  2. Waits for server connection before sending RPC
 *  3. Interactive REPL for manual testing
 */

import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import ProtomuxRPC from 'protomux-rpc'
import c from 'compact-encoding'
import b4a from 'b4a'
import goodbye from 'graceful-goodbye'
import { createInterface } from 'readline'
import { mkdirSync } from 'fs'
import crypto from 'crypto'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SERVER_KEY = process.argv[2]
if (!SERVER_KEY) {
  console.error('Usage: node client.js <server-core-public-key>')
  process.exit(1)
}

const STORAGE_DIR = process.env.STORAGE_DIR || './storage-client'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let store, swarm, rpc, connected = false

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main () {
  console.log('┌─────────────────────────────────────────┐')
  console.log('│  Standalone Block Storage Client         │')
  console.log('└─────────────────────────────────────────┘')
  console.log(`\n  Server key: ${SERVER_KEY.slice(0, 16)}...`)

  // 1. Open Corestore (for replicating the server's Hypercore)
  mkdirSync(STORAGE_DIR, { recursive: true })
  store = new Corestore(STORAGE_DIR)

  // 2. Create Hyperswarm, join as client looking for the server
  swarm = new Hyperswarm()

  // Derive discovery key from the server's core public key
  // (same as server uses: core.discoveryKey)
  const serverPubKey = b4a.from(SERVER_KEY, 'hex')
  const serverCore = store.get({ key: serverPubKey })
  await serverCore.ready()

  swarm.on('connection', (conn, info) => onConnection(conn, info))

  const discovery = swarm.join(serverCore.discoveryKey, { server: false, client: true })
  await discovery.flushed()

  console.log('  Searching for server on DHT...\n')

  // 3. Graceful shutdown
  goodbye(async () => {
    console.log('\n  Shutting down...')
    if (rpc) rpc.destroy()
    await swarm.destroy()
    await store.close()
    console.log('  Done.')
  })
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

function onConnection (conn, info) {
  const shortKey = b4a.toString(conn.remotePublicKey, 'hex').slice(0, 8)
  console.log(`  ← Connected to server: ${shortKey}...`)

  // Replicate corestore (so we get a local copy of the Hypercore)
  store.replicate(conn)

  // Open RPC channel
  rpc = new ProtomuxRPC(conn, {
    id: b4a.from('block-storage-rpc'),
    valueEncoding: c.json
  })

  connected = true
  console.log('  ✓ RPC channel open\n')

  // Start interactive mode
  startREPL()

  conn.on('close', () => {
    console.log('\n  ✗ Server disconnected')
    connected = false
    rpc = null
  })

  conn.on('error', (err) => {
    console.error(`  ✗ Connection error: ${err.message}`)
    connected = false
    rpc = null
  })
}

// ---------------------------------------------------------------------------
// RPC Methods
// ---------------------------------------------------------------------------

async function storeBlock (data) {
  if (!connected || !rpc) {
    console.log('  ✗ Not connected to server')
    return null
  }

  const buf = b4a.isBuffer(data) ? data : b4a.from(data)
  const result = await rpc.request('store-block', {
    data: b4a.toString(buf, 'base64')
  })

  if (result.error) {
    console.log(`  ✗ Error: ${result.error}`)
    return null
  }

  console.log(`  ✓ Stored as block #${result.seq} (core length: ${result.length})`)
  return result
}

async function getBlock (seq) {
  if (!connected || !rpc) {
    console.log('  ✗ Not connected to server')
    return null
  }

  const result = await rpc.request('get-block', { seq })

  if (result.error) {
    console.log(`  ✗ Error: ${result.error}`)
    return null
  }

  const buf = b4a.from(result.data, 'base64')
  console.log(`  ✓ Block #${result.seq} (${result.length} bytes): ${buf.toString()}`)
  return buf
}

async function getInfo () {
  if (!connected || !rpc) {
    console.log('  ✗ Not connected to server')
    return null
  }

  const info = await rpc.request('get-info', {})
  console.log(`  Core key   : ${info.key.slice(0, 16)}...`)
  console.log(`  Blocks     : ${info.length}`)
  console.log(`  Size       : ${info.byteLength} bytes`)
  console.log(`  Peers      : ${info.peers}`)
  console.log(`  Uptime     : ${info.uptime}s`)
  return info
}

// ---------------------------------------------------------------------------
// Interactive REPL
// ---------------------------------------------------------------------------

function startREPL () {
  console.log('  Commands:')
  console.log('    store <text>     Store a text block')
  console.log('    get <seq>        Retrieve block by index')
  console.log('    random [n]       Store n random blocks (default 5)')
  console.log('    info             Server info')
  console.log('    bench [n]        Benchmark n writes (default 100)')
  console.log('    quit             Exit\n')

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '  > '
  })

  rl.prompt()

  rl.on('line', async (line) => {
    const parts = line.trim().split(' ')
    const cmd = parts[0]

    try {
      switch (cmd) {
        case 'store':
        case 's': {
          const text = parts.slice(1).join(' ') || `block-${Date.now()}`
          await storeBlock(text)
          break
        }

        case 'get':
        case 'g': {
          const seq = parseInt(parts[1])
          if (isNaN(seq)) {
            console.log('  Usage: get <seq>')
          } else {
            await getBlock(seq)
          }
          break
        }

        case 'random':
        case 'r': {
          const n = parseInt(parts[1]) || 5
          console.log(`  Storing ${n} random blocks...`)
          for (let i = 0; i < n; i++) {
            const data = crypto.randomBytes(64).toString('hex')
            await storeBlock(data)
          }
          break
        }

        case 'info':
        case 'i':
          await getInfo()
          break

        case 'bench':
        case 'b': {
          const n = parseInt(parts[1]) || 100
          console.log(`  Benchmarking ${n} writes...`)
          const start = Date.now()
          for (let i = 0; i < n; i++) {
            const data = crypto.randomBytes(256)
            await storeBlock(data)
          }
          const elapsed = Date.now() - start
          console.log(`  ${n} blocks in ${elapsed}ms (${Math.round(n / (elapsed / 1000))} blocks/sec)`)
          break
        }

        case 'quit':
        case 'q':
        case 'exit':
          rl.close()
          process.exit(0)
          break

        case '':
          break

        default:
          console.log(`  Unknown command: ${cmd}`)
      }
    } catch (err) {
      console.error(`  Error: ${err.message}`)
    }

    rl.prompt()
  })
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})

export { storeBlock, getBlock, getInfo }

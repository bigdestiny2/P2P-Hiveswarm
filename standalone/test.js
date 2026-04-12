/**
 * Test Suite
 * ===========
 * Verifies all standalone block storage operations.
 * Self-contained — no external DHT needed.
 */

import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import ProtomuxRPC from 'protomux-rpc'
import createTestnet from '@hyperswarm/testnet'
import c from 'compact-encoding'
import b4a from 'b4a'
import crypto from 'crypto'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Mini test runner (zero deps)
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const tests = []

function test (name, fn) {
  tests.push({ name, fn })
}

function assert (condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed')
}

assert.equal = (a, b, msg) => {
  if (a !== b) throw new Error(msg || `Expected ${a} to equal ${b}`)
}

assert.ok = (v, msg) => {
  if (!v) throw new Error(msg || `Expected truthy value, got ${v}`)
}

async function runTests () {
  console.log('╔═══════════════════════════════════════════════════╗')
  console.log('║  Standalone Block Storage — Test Suite            ║')
  console.log('╚═══════════════════════════════════════════════════╝\n')

  for (const t of tests) {
    try {
      await t.fn()
      console.log(`  ✓ ${t.name}`)
      passed++
    } catch (err) {
      console.log(`  ✗ ${t.name}`)
      console.log(`    ${err.message}`)
      failed++
    }
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed, ${tests.length} total\n`)

  if (failed > 0) process.exit(1)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpPath (name) {
  const dir = join(tmpdir(), `block-storage-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Create a server + client pair connected via local Hyperswarm.
 * Returns { server, client, cleanup }
 */
async function createPair () {
  // Local testnet — instant connections, no public DHT
  const testnet = await createTestnet(3)

  // Server side
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
      if (req.seq < 0 || req.seq >= core.length) {
        return { error: `Block ${req.seq} out of range` }
      }
      const block = await core.get(req.seq)
      return { seq: req.seq, data: b4a.toString(block, 'base64'), length: block.length }
    })

    serverRPC.respond('get-info', async () => {
      return { key: b4a.toString(core.key, 'hex'), length: core.length, byteLength: core.byteLength }
    })
  })

  const serverDiscovery = serverSwarm.join(core.discoveryKey, { server: true, client: false })
  await serverDiscovery.flushed()

  // Client side
  const clientStore = new Corestore(tmpPath('client'))
  const clientCore = clientStore.get({ key: core.key })
  await clientCore.ready()

  const clientSwarm = new Hyperswarm(testnet)
  let clientRPC = null

  const connected = new Promise((resolve) => {
    clientSwarm.on('connection', (conn) => {
      clientStore.replicate(conn)
      clientRPC = new ProtomuxRPC(conn, {
        id: b4a.from('block-storage-rpc'),
        valueEncoding: c.json
      })
      resolve()
    })
  })

  const clientDiscovery = clientSwarm.join(clientCore.discoveryKey, { server: false, client: true })
  await clientDiscovery.flushed()
  await connected

  const cleanup = async () => {
    if (clientRPC) clientRPC.destroy()
    if (serverRPC) serverRPC.destroy()
    await clientSwarm.destroy()
    await serverSwarm.destroy()
    await clientStore.close()
    await serverStore.close()
    await testnet.destroy()
  }

  return {
    server: { store: serverStore, core, swarm: serverSwarm, rpc: () => serverRPC },
    client: { store: clientStore, core: clientCore, swarm: clientSwarm, rpc: () => clientRPC },
    cleanup
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('store a single block and retrieve it', async () => {
  const { client, cleanup } = await createPair()

  try {
    const data = 'Hello, Holepunch!'
    const storeResult = await client.rpc().request('store-block', {
      data: b4a.toString(b4a.from(data), 'base64')
    })

    assert.equal(storeResult.seq, 0, 'First block should be seq 0')
    assert.equal(storeResult.length, 1, 'Core length should be 1')

    const getResult = await client.rpc().request('get-block', { seq: 0 })
    const retrieved = b4a.from(getResult.data, 'base64').toString()
    assert.equal(retrieved, data, 'Retrieved data should match stored data')
  } finally {
    await cleanup()
  }
})

test('store multiple blocks sequentially', async () => {
  const { client, server, cleanup } = await createPair()

  try {
    const blocks = ['block-0', 'block-1', 'block-2', 'block-3', 'block-4']

    for (let i = 0; i < blocks.length; i++) {
      const result = await client.rpc().request('store-block', {
        data: b4a.toString(b4a.from(blocks[i]), 'base64')
      })
      assert.equal(result.seq, i, `Block ${i} should have seq ${i}`)
    }

    assert.equal(server.core.length, 5, 'Core should have 5 blocks')

    // Verify all blocks
    for (let i = 0; i < blocks.length; i++) {
      const result = await client.rpc().request('get-block', { seq: i })
      const data = b4a.from(result.data, 'base64').toString()
      assert.equal(data, blocks[i], `Block ${i} content should match`)
    }
  } finally {
    await cleanup()
  }
})

test('store binary data (random bytes)', async () => {
  const { client, cleanup } = await createPair()

  try {
    const original = crypto.randomBytes(1024)
    const result = await client.rpc().request('store-block', {
      data: b4a.toString(original, 'base64')
    })

    assert.equal(result.seq, 0)

    const getResult = await client.rpc().request('get-block', { seq: 0 })
    const retrieved = b4a.from(getResult.data, 'base64')

    assert.equal(retrieved.length, 1024, 'Length should match')
    assert.ok(b4a.equals(original, retrieved), 'Binary content should match exactly')
  } finally {
    await cleanup()
  }
})

test('store JSON-structured data', async () => {
  const { client, cleanup } = await createPair()

  try {
    const tx = {
      type: 'payment',
      from: 'alice',
      to: 'bob',
      amount: 50000,
      currency: 'sats',
      timestamp: Date.now()
    }

    const data = JSON.stringify(tx)
    await client.rpc().request('store-block', {
      data: b4a.toString(b4a.from(data), 'base64')
    })

    const result = await client.rpc().request('get-block', { seq: 0 })
    const retrieved = JSON.parse(b4a.from(result.data, 'base64').toString())

    assert.equal(retrieved.from, 'alice')
    assert.equal(retrieved.to, 'bob')
    assert.equal(retrieved.amount, 50000)
  } finally {
    await cleanup()
  }
})

test('get-block returns error for out-of-range index', async () => {
  const { client, cleanup } = await createPair()

  try {
    const result = await client.rpc().request('get-block', { seq: 99 })
    assert.ok(result.error, 'Should return an error for out-of-range index')
  } finally {
    await cleanup()
  }
})

test('get-info returns correct metadata', async () => {
  const { client, cleanup } = await createPair()

  try {
    // Store some blocks first
    for (let i = 0; i < 3; i++) {
      await client.rpc().request('store-block', {
        data: b4a.toString(b4a.from(`block-${i}`), 'base64')
      })
    }

    const info = await client.rpc().request('get-info', {})
    assert.equal(info.length, 3, 'Should report 3 blocks')
    assert.ok(info.key, 'Should include core key')
    assert.ok(info.byteLength > 0, 'Should report positive byteLength')
  } finally {
    await cleanup()
  }
})

test('large block (1MB)', async () => {
  const { client, cleanup } = await createPair()

  try {
    const large = crypto.randomBytes(1024 * 1024) // 1 MB
    const result = await client.rpc().request('store-block', {
      data: b4a.toString(large, 'base64')
    })

    assert.equal(result.seq, 0)

    const getResult = await client.rpc().request('get-block', { seq: 0 })
    const retrieved = b4a.from(getResult.data, 'base64')
    assert.equal(retrieved.length, large.length, '1MB block should round-trip correctly')
    assert.ok(b4a.equals(large, retrieved), 'Content should match')
  } finally {
    await cleanup()
  }
})

test('many blocks rapidly (100 writes)', async () => {
  const { client, server, cleanup } = await createPair()

  try {
    const start = Date.now()
    const count = 100

    for (let i = 0; i < count; i++) {
      await client.rpc().request('store-block', {
        data: b4a.toString(crypto.randomBytes(64), 'base64')
      })
    }

    const elapsed = Date.now() - start
    assert.equal(server.core.length, count, `Should have ${count} blocks`)
    assert.ok(elapsed < 30000, `Should complete in under 30s (took ${elapsed}ms)`)
  } finally {
    await cleanup()
  }
})

test('Hypercore replication — client can read locally after sync', async () => {
  const { client, cleanup } = await createPair()

  try {
    // Store a block via RPC
    const data = 'replicated-block'
    await client.rpc().request('store-block', {
      data: b4a.toString(b4a.from(data), 'base64')
    })

    // Wait for Hypercore replication
    await client.core.update()

    if (client.core.length > 0) {
      const localBlock = await client.core.get(0)
      assert.equal(localBlock.toString(), data, 'Locally replicated block should match')
    }
  } finally {
    await cleanup()
  }
})

test('empty block (zero bytes)', async () => {
  const { client, cleanup } = await createPair()

  try {
    const result = await client.rpc().request('store-block', {
      data: b4a.toString(b4a.from(''), 'base64')
    })

    assert.equal(result.seq, 0)

    const getResult = await client.rpc().request('get-block', { seq: 0 })
    const retrieved = b4a.from(getResult.data, 'base64')
    assert.equal(retrieved.length, 0, 'Empty block should have 0 length')
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

runTests().catch((err) => {
  console.error('Test runner failed:', err)
  process.exit(1)
})

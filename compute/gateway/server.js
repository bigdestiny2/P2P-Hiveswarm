/**
 * Standalone Hyper Gateway Server
 *
 * Runs alongside a relay node or standalone. Serves seeded Hyperdrive
 * content over HTTP for mobile clients (PearBrowser fast-path).
 *
 * Usage:
 *   node compute/gateway/server.js [--port 9100] [--storage ./storage] [--cors https://example.com]
 *
 * Or programmatically:
 *   const { startGateway } = await import('./server.js')
 *   const gateway = await startGateway({ port: 9100, storage: './storage', corsOrigin: '*' })
 */

import { createServer } from 'http'
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { HyperGateway } from './hyper-gateway.js'

// Same discovery topic as HiveRelay
const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

const DEFAULT_PORT = 9100

export async function startGateway (opts = {}) {
  const port = opts.port || DEFAULT_PORT
  const storagePath = opts.storage || './gateway-storage'
  const seedKeys = opts.seedKeys || []
  const corsOrigin = opts.corsOrigin || '*'

  // Boot P2P
  const store = new Corestore(storagePath)
  await store.ready()

  const swarm = new Hyperswarm()
  swarm.on('connection', (conn) => store.replicate(conn))

  // Join relay discovery topic so clients can find us
  swarm.join(RELAY_DISCOVERY_TOPIC, { server: true, client: false })

  // Seed requested drives
  const seededDrives = new Map()
  for (const keyHex of seedKeys) {
    const drive = new Hyperdrive(store, Buffer.from(keyHex, 'hex'))
    await drive.ready()
    swarm.join(drive.discoveryKey, { server: true, client: true })
    seededDrives.set(keyHex, drive)
    console.log(`  Seeding: ${keyHex.slice(0, 16)}...`)
  }

  await swarm.flush()

  // Create gateway with a minimal relay node interface
  const nodeProxy = { store, swarm, seededDrives }
  const gateway = new HyperGateway(nodeProxy)

  // HTTP server
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin
    if (corsOrigin === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*')
    } else if (origin && origin === corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin)
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url, `http://localhost:${port}`)

    if (url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify({
        ok: true,
        type: 'hiverelay-gateway',
        drives: seededDrives.size,
        ...gateway.getStats()
      }))
      return
    }

    if (url.pathname.startsWith('/v1/hyper/')) {
      return gateway.handle(req, res)
    }

    // Seed a new drive via POST
    if (req.method === 'POST' && url.pathname === '/v1/seed') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', async () => {
        try {
          const { key } = JSON.parse(body)
          if (!key || key.length < 52) throw new Error('Invalid key')
          const drive = new Hyperdrive(store, Buffer.from(key, 'hex'))
          await drive.ready()
          swarm.join(drive.discoveryKey, { server: true, client: true })
          seededDrives.set(key, drive)
          res.setHeader('Content-Type', 'application/json')
          res.writeHead(200)
          res.end(JSON.stringify({ ok: true, seeding: key }))
        } catch (err) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: err.message }))
        }
      })
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '0.0.0.0', resolve)
  })

  console.log(`\n  HiveRelay Gateway running on http://0.0.0.0:${port}`)
  console.log(`  Seeding ${seededDrives.size} drives`)
  console.log(`  Fetch: GET http://localhost:${port}/v1/hyper/{KEY}/{path}\n`)

  return {
    server,
    gateway,
    store,
    swarm,
    seededDrives,
    async close () {
      server.close()
      await gateway.close()
      for (const [, drive] of seededDrives) {
        try { await drive.close() } catch {}
      }
      await swarm.destroy()
      await store.close()
    }
  }
}

// CLI mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const port = args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1]) : DEFAULT_PORT
  const storage = args.includes('--storage') ? args[args.indexOf('--storage') + 1] : './gateway-storage'
  const corsOrigin = args.includes('--cors') ? args[args.indexOf('--cors') + 1] : '*'
  const seedKeys = args.filter(a => /^[a-f0-9]{52,64}$/i.test(a))

  startGateway({ port, storage, seedKeys, corsOrigin }).then((gw) => {
    process.on('SIGINT', async () => {
      console.log('\n  Shutting down...')
      await gw.close()
      process.exit(0)
    })
  }).catch(err => {
    console.error('Failed:', err.message)
    process.exit(1)
  })
}

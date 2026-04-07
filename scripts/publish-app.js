#!/usr/bin/env node

/**
 * Publish a local directory to a Hyperdrive and seed it on live HiveRelay nodes.
 *
 * Usage:
 *   node scripts/publish-app.js <directory> [options]
 *
 * Options:
 *   --name <name>        App name for manifest.json
 *   --desc <description> App description
 *   --version <version>  App version (default: 1.0.0)
 *   --relays <urls>      Comma-separated relay API URLs to seed on
 *   --storage <path>     Corestore path (default: .publisher-storage)
 *   --key <hex>          Re-publish to existing drive key (for updates)
 *   --no-stay            Exit after publishing (don't stay online)
 *
 * Examples:
 *   node scripts/publish-app.js ../pear-pos/frontend/dist --name "Pear POS"
 *   node scripts/publish-app.js ./my-app/build --relays http://REDACTED_SERVER_IP:9100
 */

import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { readdir, readFile, stat } from 'fs/promises'
import { join, relative, resolve } from 'path'
import { existsSync } from 'fs'

const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

// Default relay endpoints (Utah x3 + Singapore x1)
const DEFAULT_RELAYS = [
  'http://REDACTED_SERVER_IP:9100',
  'http://REDACTED_SERVER_IP:9101',
  'http://REDACTED_SERVER_IP:9102',
  'http://REDACTED_SERVER_IP:9100'
]

function parseArgs (argv) {
  const args = argv.slice(2)
  const opts = {
    directory: null,
    name: null,
    description: null,
    version: '1.0.0',
    relays: DEFAULT_RELAYS,
    storage: '.publisher-storage',
    key: null,
    stay: true
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--name') { opts.name = args[++i]; continue }
    if (arg === '--desc') { opts.description = args[++i]; continue }
    if (arg === '--version') { opts.version = args[++i]; continue }
    if (arg === '--relays') { opts.relays = args[++i].split(',').map(s => s.trim()); continue }
    if (arg === '--storage') { opts.storage = args[++i]; continue }
    if (arg === '--key') { opts.key = args[++i]; continue }
    if (arg === '--no-stay') { opts.stay = false; continue }
    if (!arg.startsWith('-') && !opts.directory) { opts.directory = arg; continue }
  }

  return opts
}

async function walkDir (dir, base) {
  base = base || dir
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      files.push(...await walkDir(fullPath, base))
    } else if (entry.isFile()) {
      const relPath = '/' + relative(base, fullPath).replace(/\\/g, '/')
      const content = await readFile(fullPath)
      const stats = await stat(fullPath)
      files.push({ path: relPath, content, size: stats.size })
    }
  }

  return files
}

async function seedOnRelay (relayUrl, appKey) {
  try {
    const res = await fetch(relayUrl + '/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey })
    })
    const data = await res.json()
    return { url: relayUrl, ok: data.ok || false, error: data.error || null }
  } catch (err) {
    return { url: relayUrl, ok: false, error: err.message }
  }
}

async function run () {
  const opts = parseArgs(process.argv)

  if (!opts.directory) {
    console.error('Usage: node scripts/publish-app.js <directory> [options]')
    console.error('  Run with --help for more info')
    process.exit(1)
  }

  const dir = resolve(opts.directory)
  if (!existsSync(dir)) {
    console.error('Directory not found:', dir)
    process.exit(1)
  }

  console.log()
  console.log('=== HiveRelay App Publisher ===')
  console.log()
  console.log('  Directory:', dir)
  console.log('  Storage:  ', opts.storage)
  console.log('  Relays:   ', opts.relays.length)
  console.log()

  // Scan files
  console.log('  Scanning files...')
  const files = await walkDir(dir)
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)
  console.log('  Found', files.length, 'files (' + (totalSize / 1024 / 1024).toFixed(1) + ' MB)')
  console.log()

  // Boot P2P stack
  console.log('  Starting P2P stack...')
  const store = new Corestore(opts.storage)
  await store.ready()

  const swarm = new Hyperswarm()
  swarm.on('connection', (conn) => store.replicate(conn))

  // Create or open drive
  let drive
  if (opts.key) {
    console.log('  Reopening existing drive:', opts.key.slice(0, 16) + '...')
    drive = new Hyperdrive(store, Buffer.from(opts.key, 'hex'))
  } else {
    drive = new Hyperdrive(store)
  }
  await drive.ready()

  const driveKey = b4a.toString(drive.key, 'hex')
  console.log('  Drive key:', driveKey)
  console.log()

  // Write manifest.json if name provided
  if (opts.name) {
    const manifest = {
      name: opts.name,
      description: opts.description || opts.name + ' — published via HiveRelay',
      version: opts.version,
      main: '/index.html',
      files: files.length,
      totalBytes: totalSize,
      publishedAt: new Date().toISOString()
    }
    await drive.put('/manifest.json', b4a.from(JSON.stringify(manifest, null, 2)))
    console.log('  Wrote manifest.json')
  }

  // Write all files
  console.log('  Writing files to Hyperdrive...')
  let written = 0
  for (const file of files) {
    await drive.put(file.path, file.content)
    written++
    if (written % 10 === 0 || written === files.length) {
      process.stdout.write('\r  Progress: ' + written + '/' + files.length)
    }
  }
  console.log('\n  All files written.')
  console.log()

  // Join DHT
  console.log('  Joining DHT...')
  swarm.join(drive.discoveryKey, { server: true, client: true })
  swarm.join(RELAY_DISCOVERY_TOPIC, { server: true, client: false })
  await swarm.flush()
  console.log('  Announced on DHT.')
  console.log()

  // Seed on relays
  console.log('  Seeding on relays...')
  const seedResults = await Promise.all(
    opts.relays.map(url => seedOnRelay(url, driveKey))
  )

  let seeded = 0
  for (const result of seedResults) {
    const status = result.ok ? 'OK' : 'FAIL: ' + result.error
    console.log('    ' + result.url + ' — ' + status)
    if (result.ok) seeded++
  }
  console.log()
  console.log('  Seeded on', seeded + '/' + opts.relays.length, 'relays')
  console.log()

  // Monitor replication
  let peerCount = 0
  swarm.on('connection', () => {
    peerCount++
    console.log('  [' + new Date().toISOString().slice(11, 19) + '] Peer connected (total: ' + peerCount + ')')
  })
  swarm.on('connection', (conn) => {
    conn.on('close', () => {
      peerCount--
    })
  })

  // Print access URLs
  console.log('  === Access URLs ===')
  console.log()
  for (const url of opts.relays) {
    console.log('    ' + url + '/v1/hyper/' + driveKey + '/index.html')
  }
  console.log()
  console.log('    Gateway: https://relay.p2phiverelay.xyz/v1/hyper/' + driveKey + '/index.html')
  console.log()
  console.log('    Catalog: https://relay.p2phiverelay.xyz/catalog.json')
  console.log()

  if (opts.stay) {
    console.log('  Publisher staying online for replication. Ctrl+C to exit.')
    console.log()

    // Periodic status
    setInterval(() => {
      console.log('  [' + new Date().toISOString().slice(11, 19) + '] Peers: ' + swarm.connections.size + ', Drive version: ' + drive.version)
    }, 30000)

    process.on('SIGINT', async () => {
      console.log('\n  Shutting down publisher...')
      await swarm.destroy()
      await store.close()
      process.exit(0)
    })
  } else {
    console.log('  Publisher exiting (drive may not replicate without a running publisher).')
    // Give some time for initial replication
    console.log('  Waiting 30s for initial replication...')
    await new Promise(resolve => setTimeout(resolve, 30000))
    await swarm.destroy()
    await store.close()
  }
}

run().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

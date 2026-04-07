#!/usr/bin/env node

/**
 * Publish a local directory to a Hyperdrive and seed it on live HiveRelay nodes.
 *
 * Automatically reuses the same drive key for the same app (by --name/appId).
 * Subsequent publishes are version updates, not duplicates.
 *
 * Usage:
 *   node scripts/publish-app.js <directory> [options]
 *
 * Options:
 *   --name <name>        App name (also used as appId for deduplication)
 *   --id <id>            Explicit appId (overrides name-derived id)
 *   --desc <description> App description
 *   --version <version>  App version (default: 1.0.0)
 *   --relays <urls>      Comma-separated relay API URLs to seed on
 *   --storage <path>     Corestore path (default: .publisher-storage)
 *   --key <hex>          Explicit drive key (overrides appId lookup)
 *   --no-stay            Exit after publishing (don't stay online)
 *
 * Examples:
 *   # First publish — creates new drive, saves key mapping
 *   node scripts/publish-app.js ../pear-pos/frontend/dist --name "Pear POS"
 *
 *   # Update — reuses same drive key automatically (same --name + --storage)
 *   node scripts/publish-app.js ../pear-pos/frontend/dist --name "Pear POS" --version 1.1.0
 */

import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { readdir, readFile, writeFile, stat, mkdir } from 'fs/promises'
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
    id: null,
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
    if (arg === '--id') { opts.id = args[++i]; continue }
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

function deriveAppId (name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

async function loadDriveMap (storagePath) {
  try {
    const mapPath = join(storagePath, 'app-drives.json')
    return JSON.parse(await readFile(mapPath, 'utf8'))
  } catch (_) {
    return {}
  }
}

async function saveDriveMap (storagePath, map) {
  await mkdir(storagePath, { recursive: true })
  const mapPath = join(storagePath, 'app-drives.json')
  await writeFile(mapPath, JSON.stringify(map, null, 2))
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
      // Skip macOS resource fork files
      if (entry.name.startsWith('._')) continue
      const relPath = '/' + relative(base, fullPath).replace(/\\/g, '/')
      const content = await readFile(fullPath)
      const stats = await stat(fullPath)
      files.push({ path: relPath, content, size: stats.size })
    }
  }

  return files
}

async function seedOnRelay (relayUrl, appKey, appId, version) {
  try {
    const body = { appKey }
    if (appId) body.appId = appId
    if (version) body.version = version
    const res = await fetch(relayUrl + '/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    return { url: relayUrl, ok: data.ok || false, replaced: data.alreadySeeded ? 'same-key' : null, error: data.error || null }
  } catch (err) {
    return { url: relayUrl, ok: false, error: err.message }
  }
}

async function run () {
  const opts = parseArgs(process.argv)

  if (!opts.directory) {
    console.error('Usage: node scripts/publish-app.js <directory> [options]')
    console.error('')
    console.error('Options:')
    console.error('  --name <name>        App name (used for deduplication)')
    console.error('  --id <id>            Explicit appId (overrides name-derived id)')
    console.error('  --desc <description> App description')
    console.error('  --version <version>  App version (default: 1.0.0)')
    console.error('  --storage <path>     Publisher storage path')
    console.error('  --key <hex>          Explicit drive key')
    console.error('  --no-stay            Exit after publishing')
    process.exit(1)
  }

  const dir = resolve(opts.directory)
  if (!existsSync(dir)) {
    console.error('Directory not found:', dir)
    process.exit(1)
  }

  const appId = opts.id || (opts.name ? deriveAppId(opts.name) : null)

  console.log()
  console.log('=== HiveRelay App Publisher ===')
  console.log()
  console.log('  Directory:', dir)
  console.log('  Storage:  ', opts.storage)
  console.log('  Relays:   ', opts.relays.length)
  if (appId) console.log('  App ID:   ', appId)
  if (opts.version !== '1.0.0') console.log('  Version:  ', opts.version)
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

  // Resolve drive key: explicit --key > saved mapping > new drive
  let drive
  let isUpdate = false

  if (opts.key) {
    // Explicit key
    console.log('  Reopening drive:', opts.key.slice(0, 16) + '...')
    drive = new Hyperdrive(store, Buffer.from(opts.key, 'hex'))
    isUpdate = true
  } else if (appId) {
    // Check saved appId → key mapping
    const driveMap = await loadDriveMap(opts.storage)
    if (driveMap[appId]) {
      console.log('  Found existing drive for "' + appId + '": ' + driveMap[appId].slice(0, 16) + '...')
      drive = new Hyperdrive(store, Buffer.from(driveMap[appId], 'hex'))
      isUpdate = true
    }
  }

  if (!drive) {
    console.log('  Creating new Hyperdrive...')
    drive = new Hyperdrive(store)
  }

  await drive.ready()

  const driveKey = b4a.toString(drive.key, 'hex')
  console.log('  Drive key:', driveKey)
  console.log('  Mode:     ', isUpdate ? 'UPDATE (same key, new version)' : 'NEW DRIVE')
  console.log()

  // Save the appId → key mapping for future publishes
  if (appId) {
    const driveMap = await loadDriveMap(opts.storage)
    driveMap[appId] = driveKey
    await saveDriveMap(opts.storage, driveMap)
  }

  // Build manifest.json
  const manifest = {
    id: appId || driveKey.slice(0, 12),
    name: opts.name || 'Unknown App',
    description: opts.description || (opts.name ? opts.name + ' — published via HiveRelay' : ''),
    version: opts.version,
    main: '/index.html',
    files: files.length,
    totalBytes: totalSize,
    publishedAt: new Date().toISOString()
  }

  // Check if manifest.json already exists in the dist (user-provided)
  const hasUserManifest = files.some(f => f.path === '/manifest.json')
  if (hasUserManifest) {
    // Merge user's manifest with our fields (user fields take priority)
    try {
      const userManifest = JSON.parse(files.find(f => f.path === '/manifest.json').content.toString())
      Object.assign(manifest, userManifest)
      // But always ensure id is set
      if (!manifest.id) manifest.id = appId || driveKey.slice(0, 12)
      console.log('  Using user-provided manifest.json (merged with publisher metadata)')
    } catch (_) {
      console.log('  Warning: could not parse user manifest.json, using generated one')
    }
  }

  await drive.put('/manifest.json', b4a.from(JSON.stringify(manifest, null, 2)))
  console.log('  Wrote manifest.json (id: ' + manifest.id + ', version: ' + manifest.version + ')')

  // Write all files
  console.log('  Writing files to Hyperdrive...')
  let written = 0
  for (const file of files) {
    if (file.path === '/manifest.json') { written++; continue } // already written
    await drive.put(file.path, file.content)
    written++
    if (written % 10 === 0 || written === files.length) {
      process.stdout.write('\r  Progress: ' + written + '/' + files.length)
    }
  }
  console.log('\n  All files written. Drive version:', drive.version)
  console.log()

  // Join DHT
  console.log('  Joining DHT...')
  swarm.join(drive.discoveryKey, { server: true, client: true })
  swarm.join(RELAY_DISCOVERY_TOPIC, { server: true, client: false })
  await swarm.flush()
  console.log('  Announced on DHT.')
  console.log()

  // Seed on relays (pass appId + version for deduplication)
  console.log('  Seeding on relays...')
  const seedResults = await Promise.all(
    opts.relays.map(url => seedOnRelay(url, driveKey, manifest.id, manifest.version))
  )

  let seeded = 0
  for (const result of seedResults) {
    let status = result.ok ? 'OK' : 'FAIL: ' + result.error
    if (result.replaced) status += ' (already seeded)'
    console.log('    ' + result.url + ' — ' + status)
    if (result.ok) seeded++
  }
  console.log()
  console.log('  Seeded on', seeded + '/' + opts.relays.length, 'relays')
  console.log()

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

  // Monitor replication
  let peerCount = 0
  swarm.on('connection', () => {
    peerCount++
    console.log('  [' + new Date().toISOString().slice(11, 19) + '] Peer connected (total: ' + peerCount + ')')
  })
  swarm.on('connection', (conn) => {
    conn.on('close', () => { peerCount-- })
  })

  if (opts.stay) {
    console.log('  Publisher staying online for replication. Ctrl+C to exit.')
    console.log()

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

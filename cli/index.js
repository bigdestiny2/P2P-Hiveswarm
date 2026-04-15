#!/usr/bin/env node

/**
 * HiveRelay CLI
 *
 * Usage:
 *   hiverelay setup               Interactive setup wizard (TUI)
 *   hiverelay init                Initialize HiveRelay + install agent skills
 *   hiverelay start [options]     Start a relay node
 *   hiverelay seed <key>          Request seeding for a Pear app
 *   hiverelay ghostdrive ...      Ghost Drive relay workflows
 *   hiverelay status              Show node status
 *   hiverelay help                Show this help
 */

import minimist from 'minimist'
import goodbye from 'graceful-goodbye'
import { RelayNode } from '../core/relay-node/index.js'
import { createLogger } from '../core/logger.js'
import { loadConfig, saveConfig, ensureDirs } from '../config/loader.js'
import b4a from 'b4a'
import { existsSync, mkdirSync, cpSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
const VERSION = pkg.version
const SKILL_SRC = join(__dirname, '..', 'skills', 'SKILL.md')

const args = minimist(process.argv.slice(2))
const command = args._[0]

const log = createLogger({ name: 'hiverelay-cli' })

// ─── Process crash protection ──────────────────────────────────────

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception — shutting down')
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled rejection — shutting down')
  process.exit(1)
})

// ─── Commands ──────────────────────────────────────────────────────

const COMMANDS = {
  setup,
  manage,
  init,
  start,
  testnet: startTestnet,
  seed,
  ghostdrive,
  status,
  help
}

async function main () {
  const handler = COMMANDS[command]
  if (!handler) {
    help()
    process.exit(command ? 1 : 0)
  }
  await handler()
}

// ─── setup (interactive TUI) ────────────────────────────────────────

async function setup () {
  const { runSetup } = await import('./setup.js')
  const result = await runSetup()
  if (result && result.startNow) {
    await start()
  }
}

// ─── manage (live management console) ──────────────────────────────

async function manage () {
  const { runManage } = await import('./manage.js')
  const host = args.host || '127.0.0.1'
  const port = args.port ? parseInt(args.port) : 9100
  await runManage(host, port)
}

// ─── init ───────────────────────────────────────────────────────────

async function init () {
  console.log('HiveRelay v' + VERSION + ' — Init')
  console.log()

  // 1. Create directories and config
  ensureDirs()
  const config = loadConfig({
    region: args.region || undefined,
    maxStorageBytes: args['max-storage'] ? parseBytes(args['max-storage']) : undefined
  })
  const configPath = saveConfig(config)
  console.log(`  [ok] Config:  ${configPath}`)
  console.log(`  [ok] Storage: ${config.storage}`)

  // 2. Detect agent frameworks
  const home = homedir()
  const hermes = existsSync(join(home, '.hermes'))
  const openclaw = existsSync('/opt/homebrew/lib/node_modules/openclaw') ||
                   existsSync(join(home, '.openclaw'))

  const installed = []

  // 3. Install skill for Hermes
  if (hermes && existsSync(SKILL_SRC)) {
    const dest = join(home, '.hermes', 'skills', 'hiverelay')
    mkdirSync(dest, { recursive: true })
    cpSync(SKILL_SRC, join(dest, 'SKILL.md'))
    installed.push('Hermes')
    console.log(`  [ok] Hermes skill installed: ${dest}/SKILL.md`)
  }

  // 4. Install skill for OpenClaw
  if (openclaw && existsSync(SKILL_SRC)) {
    const ocSkillDir = existsSync(join(home, '.openclaw'))
      ? join(home, '.openclaw', 'skills', 'hiverelay')
      : join('/opt/homebrew/lib/node_modules/openclaw/extensions', 'hiverelay')
    mkdirSync(ocSkillDir, { recursive: true })
    cpSync(SKILL_SRC, join(ocSkillDir, 'SKILL.md'))
    installed.push('OpenClaw')
    console.log(`  [ok] OpenClaw skill installed: ${ocSkillDir}/SKILL.md`)

    const pluginSrc = join(__dirname, '..', 'plugins', 'openclaw')
    if (existsSync(pluginSrc)) {
      const pluginDest = join(ocSkillDir, 'plugin')
      mkdirSync(pluginDest, { recursive: true })
      for (const f of ['index.ts', 'package.json']) {
        if (existsSync(join(pluginSrc, f))) {
          cpSync(join(pluginSrc, f), join(pluginDest, f))
        }
      }
      console.log(`  [ok] OpenClaw plugin installed: ${pluginDest}/`)
    }
  }

  if (!hermes && !openclaw) {
    console.log('  [--] No agent framework detected (Hermes or OpenClaw)')
    console.log('       Skill file is at: skills/SKILL.md — install it manually')
  }

  // 5. Summary
  console.log()
  console.log('  Setup complete.')
  console.log()
  console.log('  Quick start:')
  console.log('    hiverelay start                  # Start relay node')
  console.log('    curl localhost:9100/health        # Health check')
  console.log('    curl localhost:9100/status        # Live stats')
  if (installed.length > 0) {
    console.log()
    console.log(`  Agent integration (${installed.join(' + ')}):`)
    console.log('    /hiverelay start                 # Start via agent skill')
    console.log('    /hiverelay status                # Check status via agent')
    console.log('    /hiverelay seed <key>            # Seed an app via agent')
  }
  console.log()
}

// ─── start ──────────────────────────────────────────────────────────

async function start () {
  const cliOverrides = {}
  if (args.storage) cliOverrides.storage = args.storage
  if (args['max-storage']) cliOverrides.maxStorageBytes = parseBytes(args['max-storage'])
  if (args['max-connections']) cliOverrides.maxConnections = parseInt(args['max-connections'])
  if (args['max-bandwidth']) cliOverrides.maxRelayBandwidthMbps = parseInt(args['max-bandwidth'])
  if (args.relay === false) cliOverrides.enableRelay = false
  if (args.seeding === false) cliOverrides.enableSeeding = false
  if (args.metrics === false) cliOverrides.enableMetrics = false
  if (args.api === false) cliOverrides.enableAPI = false
  if (args.port) cliOverrides.apiPort = parseInt(args.port)
  if (args.region) cliOverrides.regions = [].concat(args.region)
  if (args.tor) {
    if (!cliOverrides.transports) cliOverrides.transports = {}
    cliOverrides.transports.tor = true
    if (typeof args.tor === 'string') {
      if (!cliOverrides.tor) cliOverrides.tor = {}
      cliOverrides.tor.controlPassword = args.tor
    }
  }
  if (args['tor-socks-port']) {
    if (!cliOverrides.tor) cliOverrides.tor = {}
    cliOverrides.tor.socksPort = parseInt(args['tor-socks-port'])
  }
  if (args['tor-control-port']) {
    if (!cliOverrides.tor) cliOverrides.tor = {}
    cliOverrides.tor.controlPort = parseInt(args['tor-control-port'])
  }
  if (args.holesail) {
    if (!cliOverrides.transports) cliOverrides.transports = {}
    cliOverrides.transports.holesail = true
  }

  const config = loadConfig(cliOverrides)

  console.log('HiveRelay v' + VERSION)
  console.log('Starting relay node...')
  console.log()

  const node = new RelayNode(config)

  node.on('started', ({ publicKey }) => {
    const pubHex = b4a.toString(publicKey, 'hex')
    log.info({ publicKey: pubHex, port: config.apiPort }, 'relay node started')
    console.log(`  Public Key: ${pubHex}`)
    console.log(`  Storage:    ${config.storage}`)
    console.log(`  Max Store:  ${formatBytes(config.maxStorageBytes)}`)
    console.log(`  Relay:      ${config.enableRelay ? 'enabled' : 'disabled'}`)
    console.log(`  Seeding:    ${config.enableSeeding ? 'enabled' : 'disabled'}`)
    console.log(`  API:        ${config.enableAPI ? 'http://127.0.0.1:' + config.apiPort : 'disabled'}`)
    console.log(`  Regions:    ${config.regions && config.regions.length ? config.regions.join(', ') : 'all'}`)
    if (config.transports && config.transports.tor) {
      console.log(`  Tor:        enabled (SOCKS ${config.tor ? config.tor.socksPort || 9050 : 9050})`)
    }
    console.log()
    console.log('  Node is running. Press Ctrl+C to stop.')
    console.log()
  })

  node.on('tor-ready', ({ onionAddress }) => {
    log.info({ onionAddress }, 'tor hidden service active')
    console.log(`  Onion:      ${onionAddress}`)
  })

  node.on('holesail-ready', ({ connectionKey }) => {
    log.info({ connectionKey }, 'holesail tunnel active')
    console.log(`  Holesail:   ${connectionKey}`)
  })

  node.on('nat-check', ({ publicIp, reachable, action }) => {
    if (reachable) {
      log.info({ publicIp }, 'API publicly reachable — holesail not needed')
    } else {
      log.info({ publicIp, action }, 'API behind NAT — auto-enabling holesail')
      console.log(`  NAT detected (${publicIp}) — enabling holesail tunnel...`)
    }
  })

  node.on('connection', ({ remotePubKey }) => {
    log.info({ peer: remotePubKey.slice(0, 12) }, 'peer connected')
  })

  node.on('connection-closed', () => {
    log.debug('peer disconnected')
  })

  node.on('connection-error', ({ error }) => {
    log.warn({ err: error }, 'connection error')
  })

  node.on('seeding', ({ appKey, discoveryKey }) => {
    log.info({ appKey: appKey.slice(0, 12), discoveryKey: discoveryKey.slice(0, 12) }, 'seeding app')
  })

  node.on('settlement-error', ({ error }) => {
    log.error({ err: error }, 'settlement error')
  })

  node.on('health-warning', (details) => {
    log.warn({ health: details }, `health warning: ${details.check} — ${details.reason || 'threshold exceeded'}`)
  })

  node.on('health-critical', (details) => {
    log.error({ health: details }, `health CRITICAL: ${details.check} — ${details.reason}`)
  })

  node.on('self-heal-action', (action) => {
    log.info({ action }, `self-heal: ${action.type} (trigger: ${action.check})`)
  })

  node.on('registry-seed-accepted', ({ appKey, publisher, currentRelays }) => {
    log.info({ appKey: appKey.slice(0, 12), publisher: publisher.slice(0, 12), currentRelays }, 'registry: auto-accepted seed request')
  })

  node.on('registry-pending', ({ appKey }) => {
    log.info({ appKey: appKey.slice(0, 12) }, 'registry: new pending request (approval mode)')
  })

  node.on('registry-error', (details) => {
    log.warn({ err: details.error || details }, 'registry error')
  })

  node.on('reseeded', ({ appKey, source }) => {
    log.info({ appKey: appKey.slice(0, 12), source: source || 'log' }, 'reseeded app from persistent log')
  })

  node.on('reseed-error', ({ appKey, error }) => {
    log.debug({ appKey: appKey ? appKey.slice(0, 12) : 'unknown', err: error }, 'reseed attempt failed (normal for catalog-synced apps without peers)')
  })

  let statusInterval = null

  goodbye(async () => {
    if (statusInterval) clearInterval(statusInterval)
    log.info('shutting down')
    console.log('\n  Shutting down...')
    await node.stop()
    log.info('stopped')
    console.log('  Stopped.')
  })

  await node.start()

  // If seed keys provided via CLI, seed them immediately
  const seedKeys = args.seed ? [].concat(args.seed) : []
  for (const key of seedKeys) {
    await node.seedApp(key)
  }

  // Print status periodically
  if (!args.quiet) {
    statusInterval = setInterval(() => {
      const stats = node.getStats()
      const seeder = stats.seeder || {}
      const relay = stats.relay || {}
      process.stdout.write(
        `\r  [status] Apps: ${stats.seededApps} | Conns: ${stats.connections}` +
        ` | Stored: ${formatBytes(seeder.totalBytesStored || 0)}` +
        ` | Served: ${formatBytes(seeder.totalBytesServed || 0)}` +
        ` | Circuits: ${relay.activeCircuits || 0}` +
        '   '
      )
    }, 5000)
  }
}

// ─── testnet ────────────────────────────────────────────────────────

async function startTestnet () {
  const createTestnet = (await import('@hyperswarm/testnet')).default
  const { HiveRelayClient } = await import('../client/index.js')
  const Hyperswarm = (await import('hyperswarm')).default
  const { mkdirSync, rmSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { randomBytes } = await import('crypto')

  const nodeCount = parseInt(args.nodes) || 3
  const basePort = parseInt(args.port) || 19100
  const runClient = args.client !== false
  const testId = randomBytes(4).toString('hex')
  const baseDir = join(tmpdir(), `hiverelay-testnet-${testId}`)
  mkdirSync(baseDir, { recursive: true })

  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║           HiveRelay — Local Testnet                 ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  console.log()
  console.log(`  Testnet ID:   ${testId}`)
  console.log(`  Relay nodes:  ${nodeCount}`)
  console.log(`  API ports:    ${basePort}–${basePort + nodeCount - 1}`)
  console.log(`  Test client:  ${runClient ? 'yes' : 'no'}`)
  console.log(`  Storage:      ${baseDir}`)
  console.log()
  console.log('  Starting local DHT...')

  const testnet = await createTestnet(3)
  console.log(`  DHT bootstrap: ${testnet.bootstrap.map(b => b.host + ':' + b.port).join(', ')}`)
  console.log()

  const nodes = []

  for (let i = 0; i < nodeCount; i++) {
    const port = basePort + i
    const storage = join(baseDir, `relay-${i}`)
    mkdirSync(storage, { recursive: true })

    const node = new RelayNode({
      storage,
      enableAPI: true,
      apiPort: port,
      enableRelay: true,
      enableSeeding: true,
      enableMetrics: true,
      maxConnections: 64,
      bootstrapNodes: testnet.bootstrap,
      shutdownTimeoutMs: 5000
    })

    await node.start()
    const pubKey = b4a.toString(node.swarm.keyPair.publicKey, 'hex')

    console.log(`  [relay ${i}] ${pubKey.slice(0, 16)}...`)
    console.log(`            API: http://127.0.0.1:${port}`)
    console.log(`            Dashboard: http://127.0.0.1:${port}/dashboard`)

    node.on('seeding', ({ appKey }) => {
      console.log(`  [relay ${i}] seeding ${appKey.slice(0, 16)}...`)
    })
    node.on('seed-accepted', ({ appKey }) => {
      console.log(`  [relay ${i}] accepted seed: ${appKey.slice(0, 16)}...`)
    })

    nodes.push({ node, port, pubKey })
  }

  // Flush all swarms
  await Promise.all(nodes.map(({ node }) => node.swarm.flush()))
  console.log()

  let client = null
  let clientSwarm = null

  if (runClient) {
    console.log('  Starting test client...')
    const clientStorage = join(baseDir, 'client')
    mkdirSync(clientStorage, { recursive: true })

    clientSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
    client = new HiveRelayClient(clientStorage, {
      swarm: clientSwarm,
      maxRelays: nodeCount,
      seedReplicas: nodeCount,
      autoSeed: true
    })

    client.on('relay-connected', (evt) => {
      console.log(`  [client] relay connected: ${evt.pubkey.slice(0, 16)}...`)
    })
    client.on('seeded', (evt) => {
      console.log(`  [client] seeded! ${evt.acceptances} relay(s) accepted`)
    })

    await client.start()
    await clientSwarm.flush()

    // Wait for relay discovery
    let found = false
    for (let i = 0; i < 30; i++) {
      if (client.relays.size > 0) { found = true; break }
      await new Promise(resolve => setTimeout(resolve, 500))
      await clientSwarm.flush()
    }

    if (found) {
      console.log(`  [client] discovered ${client.relays.size} relay(s)`)
    } else {
      console.log('  [client] no relays discovered (DHT may need more time)')
    }

    console.log()
    console.log('  ─── Test: Publish + Seed ───')
    console.log()

    try {
      const drive = await client.publish([
        { path: '/hello.txt', content: 'Hello from HiveRelay testnet!' },
        { path: '/test.json', content: JSON.stringify({ ts: Date.now(), testnet: testId }) }
      ], { timeout: 10000 })

      const driveKey = b4a.toString(drive.key, 'hex')
      console.log(`  [client] published drive: ${driveKey.slice(0, 16)}...`)

      // Seed the drive
      try {
        await client.seed(driveKey, { replicas: nodeCount, timeout: 15000 })
      } catch (e) {
        console.log(`  [client] seed broadcast sent (${e.message})`)
      }

      // Wait briefly for seed accepts
      await new Promise(resolve => setTimeout(resolve, 3000))

      // Read back
      const hello = await client.get(driveKey, '/hello.txt')
      if (hello) {
        console.log(`  [client] read back /hello.txt: "${b4a.toString(hello)}"`)
      }

      const files = await client.list(driveKey, '/')
      console.log(`  [client] files in drive: ${files.join(', ')}`)

      // Relay scores
      const scores = client.getRelayScores()
      if (scores.length > 0) {
        console.log()
        console.log('  ─── Relay Scores ───')
        for (const s of scores) {
          console.log(`    ${s.relay.slice(0, 16)}... latency=${s.latencyMs}ms reliability=${s.reliability} successes=${s.successes}`)
        }
      }
    } catch (err) {
      console.log(`  [client] publish test: ${err.message}`)
    }
  }

  console.log()
  console.log('  ─── Network Ready ───')
  console.log()
  for (const { port } of nodes) {
    console.log(`    http://127.0.0.1:${port}/api/overview`)
  }
  console.log()
  console.log('  SDK connect example:')
  console.log()
  console.log("    import Hyperswarm from 'hyperswarm'")
  console.log("    import { HiveRelayClient } from 'p2p-hiverelay/client'")
  console.log()
  console.log(`    const swarm = new Hyperswarm({ bootstrap: [${testnet.bootstrap.map(b => `{ host: '${b.host}', port: ${b.port} }`).join(', ')}] })`)
  console.log("    const client = new HiveRelayClient('./my-storage', { swarm })")
  console.log('    await client.start()')
  console.log()
  console.log('  Press Ctrl+C to shut down the testnet.')
  console.log()

  // Status ticker
  const statusInterval = setInterval(() => {
    const parts = nodes.map(({ node }, i) => {
      const s = node.getStats()
      return `r${i}:${s.connections}p/${s.seededApps}a`
    })
    const clientPart = client ? ` | client:${client.relays.size}r` : ''
    process.stdout.write(`\r  [testnet] ${parts.join(' | ')}${clientPart}   `)
  }, 5000)

  goodbye(async () => {
    clearInterval(statusInterval)
    console.log('\n\n  Shutting down testnet...')

    if (client) {
      try { await client.destroy() } catch {}
    }
    if (clientSwarm) {
      try { await clientSwarm.destroy() } catch {}
    }

    for (const { node } of nodes) {
      try { await node.stop() } catch {}
    }

    try { await testnet.destroy() } catch {}

    try {
      rmSync(baseDir, { recursive: true, force: true })
      console.log(`  Cleaned up: ${baseDir}`)
    } catch {}

    console.log('  Testnet stopped.')
  })
}

// ─── seed ───────────────────────────────────────────────────────────

const VALID_PRIVACY_TIERS = new Set(['public', 'local-first', 'p2p-only'])
const GHOSTDRIVE_DEFAULT_CATEGORIES = ['ghost-drive', 'files']

async function seed () {
  const appKey = args._[1]
  if (!isValidHexKey(appKey, 64)) {
    console.error('Usage: hiverelay seed <app-key> [options]')
    console.error('  app-key must be 64 hex characters')
    process.exit(1)
  }

  const seedMetadata = collectSeedMetadata(args)
  const relay = getRelayBaseUrl(args)
  const apiKey = getApiKey(args)

  try {
    console.log(`Seeding app on relay ${relay}...`)
    const seedResult = await seedAppViaApi({
      relay,
      apiKey,
      appKey,
      metadata: seedMetadata
    })

    console.log(`  Seeded: ${appKey.slice(0, 16)}...`)
    if (seedResult.alreadySeeded) console.log('  Note: already seeded on this relay.')
    if (seedResult.discoveryKey) console.log(`  Discovery key: ${seedResult.discoveryKey}`)

    if (shouldPublishRegistry(args)) {
      const publishBody = collectRegistryOptions(args, appKey, seedMetadata.privacyTier || 'public')
      const publishResult = await publishSeedRequestViaApi({ relay, apiKey, body: publishBody })
      console.log(`  Registry publish: replicas=${publishResult.replicationFactor || publishBody.replicas}`)
      if (publishResult.requestId) console.log(`  Request ID: ${publishResult.requestId}`)
    }
  } catch (err) {
    console.error('Seeding failed: ' + err.message)
    process.exit(1)
  }
}

// ─── ghostdrive ─────────────────────────────────────────────────────

async function ghostdrive () {
  const action = args._[1]

  if (!action || action === 'help') {
    printGhostDriveHelp()
    return
  }

  if (action === 'discover') {
    await ghostDriveDiscover()
    return
  }

  const driveKey = args._[2]
  if (!isValidHexKey(driveKey, 64)) {
    console.error('Usage: hiverelay ghostdrive <pin|publish> <drive-key> [options]')
    console.error('  drive-key must be 64 hex characters')
    process.exit(1)
  }

  const relay = getRelayBaseUrl(args)
  const apiKey = getApiKey(args)
  const metadata = collectGhostDriveMetadata(args, driveKey)

  try {
    console.log(`Ghost Drive ${action} via relay ${relay}...`)
    const seedResult = await seedAppViaApi({
      relay,
      apiKey,
      appKey: driveKey,
      metadata
    })

    console.log(`  Pinned drive: ${driveKey.slice(0, 16)}...`)
    if (seedResult.alreadySeeded) console.log('  Note: already pinned on this relay.')
    if (seedResult.discoveryKey) console.log(`  Discovery key: ${seedResult.discoveryKey}`)
    console.log(`  Catalog tags: ${(metadata.categories || []).join(', ') || 'none'}`)

    if (action === 'publish') {
      const publishBody = collectRegistryOptions(args, driveKey, metadata.privacyTier || 'public')
      const publishResult = await publishSeedRequestViaApi({ relay, apiKey, body: publishBody })
      console.log(`  Published to registry (replicas=${publishResult.replicationFactor || publishBody.replicas})`)
    }
  } catch (err) {
    console.error(`Ghost Drive ${action} failed: ` + err.message)
    process.exit(1)
  }
}

async function ghostDriveDiscover () {
  const relays = parseRelayList(args)
  const discovered = []

  try {
    for (const relay of relays) {
      const catalog = await relayRequestJson(relay, '/catalog.json?page=1&pageSize=500')
      const apps = Array.isArray(catalog.apps) ? catalog.apps : []
      const ghostApps = apps.filter(isGhostDriveCatalogEntry)
      for (const app of ghostApps) {
        discovered.push({ relay, app })
      }
      console.log(`  ${relay} → ${ghostApps.length} Ghost Drive entries`)
    }
  } catch (err) {
    console.error('Discovery failed: ' + err.message)
    process.exit(1)
  }

  console.log()
  if (discovered.length === 0) {
    console.log('No Ghost Drive entries found in the queried catalogs.')
    return
  }

  console.log(`Discovered ${discovered.length} Ghost Drive entries:`)
  for (const { relay, app } of discovered) {
    const label = app.name || app.id || app.appKey
    const author = app.author || 'unknown'
    const key = app.appKey || app.driveKey || 'n/a'
    console.log(`  - ${label} (${author})`)
    console.log(`    key: ${key}`)
    console.log(`    relay: ${relay}`)
    if (app.description) console.log(`    ${app.description}`)
  }
}

function printGhostDriveHelp () {
  console.log(`
Ghost Drive Workflow

Usage:
  hiverelay ghostdrive pin <drive-key> [options]
  hiverelay ghostdrive publish <drive-key> [options]
  hiverelay ghostdrive discover [options]

Subcommands:
  pin       Seed/pin a Ghost Drive key on a relay and add discovery metadata
  publish   Pin + publish replication request to the distributed registry
  discover  Query relay catalog(s) for Ghost Drive entries

Options:
  --relay <url>                Relay URL (repeat for discover; default: http://127.0.0.1:9100)
  --host <ip> --port <n>       Alternative to --relay
  --api-key <key>              API key (or use HIVERELAY_API_KEY env)
  --name <text>                Catalog name
  --description <text>         Catalog description
  --author <text>              Catalog author
  --categories <a,b,c>         Catalog categories (default: ghost-drive,files)
  --privacy-tier <tier>        public | local-first | p2p-only (default: public)
  --replicas <n>               Publish target replication factor (default: 3)
  --geo <region>               Publish geo preference (e.g. NA,EU,AS)
  --ttl <days>                 Publish TTL days (default: 30)
  --max-storage <size>         Publish max bytes for storage matching
`)
}

async function seedAppViaApi ({ relay, apiKey, appKey, metadata }) {
  const body = { appKey }
  if (metadata.appId) body.appId = metadata.appId
  if (metadata.version) body.version = metadata.version
  if (metadata.name) body.name = metadata.name
  if (metadata.description !== undefined) body.description = metadata.description
  if (metadata.author) body.author = metadata.author
  if (metadata.categories && metadata.categories.length > 0) body.categories = metadata.categories
  if (metadata.privacyTier) body.privacyTier = metadata.privacyTier
  return relayRequestJson(relay, '/seed', {
    method: 'POST',
    body,
    apiKey
  })
}

async function publishSeedRequestViaApi ({ relay, apiKey, body }) {
  return relayRequestJson(relay, '/registry/publish', {
    method: 'POST',
    body,
    apiKey
  })
}

async function relayRequestJson (relay, path, opts = {}) {
  const method = opts.method || 'GET'
  const headers = { Accept: 'application/json' }
  if (opts.apiKey) headers.Authorization = 'Bearer ' + opts.apiKey
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await fetch(relay + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    })
  } catch (err) {
    throw new Error(`cannot reach relay ${relay}: ${err.message}`)
  }

  const payload = await parseResponseBody(res)
  if (!res.ok) {
    const reason = payload && payload.error ? payload.error : `${res.status} ${res.statusText}`
    throw new Error(reason)
  }
  return payload
}

async function parseResponseBody (res) {
  const text = await res.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch (_) {
    return { raw: text }
  }
}

function collectSeedMetadata (argv) {
  const metadata = {}
  if (typeof argv['app-id'] === 'string' && argv['app-id'].trim()) metadata.appId = argv['app-id'].trim()
  if (typeof argv.version === 'string' && argv.version.trim()) metadata.version = argv.version.trim()
  if (typeof argv.name === 'string' && argv.name.trim()) metadata.name = argv.name.trim()
  if (typeof argv.description === 'string') metadata.description = argv.description
  if (typeof argv.author === 'string' && argv.author.trim()) metadata.author = argv.author.trim()
  const categories = parseCategories(argv.categories, null)
  if (categories) metadata.categories = categories
  if (argv['privacy-tier'] !== undefined) {
    metadata.privacyTier = parsePrivacyTierOrExit(argv['privacy-tier'])
  }
  return metadata
}

function collectGhostDriveMetadata (argv, driveKey) {
  const metadata = collectSeedMetadata(argv)
  if (!metadata.appId) metadata.appId = `ghost-drive-${driveKey.slice(0, 16)}`
  if (!metadata.name) metadata.name = `Ghost Drive ${driveKey.slice(0, 8)}`
  if (metadata.description === undefined) {
    metadata.description = 'Ghost Drive content pinned on HiveRelay for always-on availability and discovery.'
  }
  if (!metadata.author) metadata.author = 'ghost-drive-user'
  metadata.categories = parseCategories(argv.categories, GHOSTDRIVE_DEFAULT_CATEGORIES)
  if (!metadata.privacyTier) metadata.privacyTier = 'public'
  return metadata
}

function collectRegistryOptions (argv, appKey, defaultPrivacyTier = 'public') {
  const body = {
    appKey,
    replicas: argv.replicas ? parseInt(argv.replicas) : 3,
    ttlDays: argv.ttl ? parseInt(argv.ttl) : 30,
    privacyTier: argv['privacy-tier'] !== undefined
      ? parsePrivacyTierOrExit(argv['privacy-tier'])
      : defaultPrivacyTier
  }

  if (argv.geo !== undefined) {
    const geo = parseCsvValues(argv.geo)
    body.geo = geo.length > 1 ? geo : geo[0]
  }
  if (argv['max-storage'] !== undefined) body.maxStorageBytes = parseBytes(String(argv['max-storage']))
  if (argv['discovery-key'] !== undefined) {
    const discoveryKeys = parseCsvValues(argv['discovery-key']).map(v => v.toLowerCase())
    for (const key of discoveryKeys) {
      if (!isValidHexKey(key, 64)) {
        throw new Error('discovery-key entries must be 64 hex characters')
      }
    }
    body.discoveryKeys = discoveryKeys
  }
  return body
}

function shouldPublishRegistry (argv) {
  return argv.publish === true ||
    argv.registry === true ||
    argv.replicas !== undefined ||
    argv.geo !== undefined ||
    argv.ttl !== undefined ||
    argv['max-storage'] !== undefined ||
    argv['discovery-key'] !== undefined
}

function getApiKey (argv) {
  const key = typeof argv['api-key'] === 'string' ? argv['api-key'].trim() : ''
  return key || process.env.HIVERELAY_API_KEY || null
}

function getRelayBaseUrl (argv) {
  if (typeof argv.relay === 'string' && argv.relay.trim()) {
    return normalizeRelayUrl(argv.relay)
  }
  const host = argv.host || '127.0.0.1'
  const port = argv.port ? parseInt(argv.port) : 9100
  return `http://${host}:${port}`
}

function parseRelayList (argv) {
  if (argv.relay === undefined) return [getRelayBaseUrl(argv)]
  const values = [].concat(argv.relay)
    .map(v => normalizeRelayUrl(v))
    .filter(Boolean)
  return [...new Set(values)]
}

function normalizeRelayUrl (value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw.replace(/\/+$/, '')
  }
  return `http://${raw.replace(/\/+$/, '')}`
}

function isGhostDriveCatalogEntry (app) {
  if (!app || typeof app !== 'object') return false
  const categories = Array.isArray(app.categories)
    ? app.categories.map(c => String(c).toLowerCase())
    : []
  if (categories.includes('ghost-drive')) return true
  const id = String(app.id || '').toLowerCase()
  if (id.startsWith('ghost-drive')) return true
  const name = String(app.name || '').toLowerCase()
  return name.includes('ghost drive')
}

function parseCategories (input, fallback = null) {
  const values = parseCsvValues(input)
  if (values.length === 0) return fallback
  return [...new Set(values)]
}

function parseCsvValues (input) {
  if (input === undefined || input === null) return []
  return []
    .concat(input)
    .flatMap(v => String(v).split(','))
    .map(v => v.trim())
    .filter(Boolean)
}

function parsePrivacyTierOrExit (value) {
  const tier = String(value || '').trim().toLowerCase()
  if (!VALID_PRIVACY_TIERS.has(tier)) {
    console.error('Invalid privacy tier: ' + value)
    console.error('Valid tiers: public, local-first, p2p-only')
    process.exit(1)
  }
  return tier
}

function isValidHexKey (value, length = 64) {
  return typeof value === 'string' && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)
}

// ─── status ─────────────────────────────────────────────────────────

async function status () {
  const port = args.port || 9100
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`)
    const stats = await res.json()
    console.log('HiveRelay Status')
    console.log()
    console.log(`  Running:     ${stats.running}`)
    console.log(`  Public Key:  ${stats.publicKey || 'N/A'}`)
    console.log(`  Seeded Apps: ${stats.seededApps}`)
    console.log(`  Connections: ${stats.connections}`)
    if (stats.seeder) {
      console.log(`  Stored:      ${formatBytes(stats.seeder.totalBytesStored || 0)}`)
      console.log(`  Served:      ${formatBytes(stats.seeder.totalBytesServed || 0)}`)
    }
    if (stats.relay) {
      console.log(`  Circuits:    ${stats.relay.activeCircuits} active (${stats.relay.totalCircuitsServed} total)`)
      console.log(`  Relayed:     ${formatBytes(stats.relay.totalBytesRelayed || 0)}`)
    }
  } catch {
    console.log('HiveRelay Status')
    console.log()
    console.log(`  Cannot reach relay node at http://127.0.0.1:${port}`)
    console.log('  Is the node running? Start it with: hiverelay start')
  }
}

// ─── help ───────────────────────────────────────────────────────────

function help () {
  console.log(`
HiveRelay v${VERSION} — Shared P2P Relay Backbone

Usage:
  hiverelay setup               Interactive setup wizard (first-time config)
  hiverelay manage [options]    Live management console (connect to running node)
  hiverelay init [options]      Initialize config + install agent skills
  hiverelay start [options]     Start a relay node
  hiverelay testnet [options]   Spin up a local testnet (DHT + relays + client)
  hiverelay seed <key>          Seed a key on a relay (optional registry publish)
  hiverelay ghostdrive ...      Ghost Drive pin/publish/discover workflows
  hiverelay status              Show node status (queries running node)
  hiverelay help                Show this help

Init Options:
  --region <code>               Set default region (NA, EU, AS, SA, AF, OC)
  --max-storage <size>          Set default max storage

Start Options:
  --storage <path>              Storage directory
  --max-storage <size>          Max storage (e.g., 50GB, 100GB)
  --max-connections <n>         Max peer connections (default: 256)
  --max-bandwidth <mbps>        Max relay bandwidth in Mbps (default: 100)
  --region <code>               Region code
  --port <n>                    API port (default: 9100)
  --seed <key>                  Seed a Pear app key on startup
  --no-relay                    Disable circuit relay
  --no-seeding                  Disable app seeding
  --no-api                      Disable HTTP API
  --tor [password]               Enable Tor hidden service transport
  --tor-socks-port <n>           Tor SOCKS5 port (default: 9050)
  --tor-control-port <n>         Tor control port (default: 9051)
  --holesail                     Enable Holesail API tunnel (NAT traversal)
  --quiet                       Suppress periodic status output

Manage Options:
  --host <ip>                   Relay host (default: 127.0.0.1)
  --port <n>                    Relay API port (default: 9100)

Seed / Ghost Drive Options:
  --relay <url>                 Relay URL (default: http://127.0.0.1:9100)
  --api-key <key>               API key (or use HIVERELAY_API_KEY env)
  --app-id <id>                 Optional app id for catalog dedup
  --name <text>                 Catalog name
  --description <text>          Catalog description
  --author <text>               Catalog author
  --categories <a,b,c>          Catalog categories
  --privacy-tier <tier>         public | local-first | p2p-only
  --publish                     Also publish /registry/publish request
  --replicas <n>                Replication target (default: 3)
  --geo <region>                Geo preference (e.g. NA,EU,AS)
  --ttl <days>                  Registry TTL days (default: 30)
  --discovery-key <hex>         Extra discovery keys for registry publish (repeatable)

Testnet Options:
  --nodes <n>                   Number of relay nodes (default: 3)
  --port <n>                    Base API port (default: 19100)
  --no-client                   Skip launching a test client

Environment:
  HIVERELAY_LOG_LEVEL           Log level: fatal, error, warn, info, debug, trace

Examples:
  npx hiverelay setup                              # Interactive setup wizard
  hiverelay start --region NA --max-storage 100GB   # Start relay
  hiverelay manage                                  # Live management console
  hiverelay manage --port 9200                      # Manage node on custom port
  hiverelay testnet                                 # Local testnet (3 relays + client)
  hiverelay seed <key> --publish --replicas 3       # Seed + publish registry request
  hiverelay ghostdrive pin <driveKey>               # Pin Ghost Drive key on relay
  hiverelay ghostdrive publish <driveKey>           # Pin + registry publish
  hiverelay ghostdrive discover --relay http://...  # Query catalog for Ghost Drive entries
  hiverelay status                                  # Check running node
`)
}

// ─── utils ──────────────────────────────────────────────────────────

function parseBytes (str) {
  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|B)?$/i)
  if (!match) return parseInt(str)
  const num = parseFloat(match[1])
  const unit = (match[2] || 'B').toUpperCase()
  return Math.floor(num * (units[unit] || 1))
}

function formatBytes (bytes) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

main().catch((err) => {
  log.fatal({ err }, 'fatal startup error')
  process.exit(1)
})

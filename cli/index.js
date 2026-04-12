#!/usr/bin/env node

/**
 * HiveRelay CLI
 *
 * Usage:
 *   hiverelay init                Initialize HiveRelay + install agent skills
 *   hiverelay start [options]     Start a relay node
 *   hiverelay seed <key>          Request seeding for a Pear app
 *   hiverelay status              Show node status
 *   hiverelay help                Show this help
 */

import minimist from 'minimist'
import goodbye from 'graceful-goodbye'
import { RelayNode } from '../core/relay-node/index.js'
import { createLogger } from '../core/logger.js'
import { loadConfig, saveConfig, ensureDirs } from '../config/loader.js'
import b4a from 'b4a'
import { existsSync, mkdirSync, cpSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
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
  init,
  start,
  testnet: startTestnet,
  seed,
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

// ─── init ───────────────────────────────────────────────────────────

async function init () {
  console.log('HiveRelay v0.1.0 — Init')
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

  // ─── Mode ───
  if (args.mode) {
    if (!['public', 'private', 'hybrid'].includes(args.mode)) {
      console.error('Error: --mode must be public, private, or hybrid')
      process.exit(1)
    }
    cliOverrides.mode = args.mode
  }

  // ─── WebSocket transport ───
  if (args.websocket) {
    if (!cliOverrides.transports) cliOverrides.transports = {}
    cliOverrides.transports.websocket = true
  }
  if (args['ws-port']) cliOverrides.wsPort = parseInt(args['ws-port'])

  // ─── Private mode allowlist ───
  if (args.allowlist) {
    const keys = [].concat(args.allowlist).flatMap(a => a.split(','))
    if (!cliOverrides.access) cliOverrides.access = {}
    cliOverrides.access.allowlist = keys
    if (!args.mode) cliOverrides.mode = 'private'
  }

  // ─── Payment / Lightning ───
  if (args.payment) {
    cliOverrides.payment = { enabled: true }
    cliOverrides.lightning = {
      enabled: true,
      rpcUrl: args['lightning-rpc'] || 'localhost:10009',
      macaroonPath: args['lightning-macaroon'] || null,
      certPath: args['lightning-cert'] || null
    }
  }

  const config = loadConfig(cliOverrides)

  console.log('HiveRelay v0.1.0')
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
    console.log(`  Mode:       ${config.mode || 'public'}`)
    console.log(`  Regions:    ${config.regions && config.regions.length ? config.regions.join(', ') : 'all'}`)
    if (config.transports && config.transports.websocket) {
      console.log(`  WebSocket:  enabled (port ${config.wsPort || 8765})`)
    }
    if (config.transports && config.transports.tor) {
      console.log(`  Tor:        enabled (SOCKS ${config.tor ? config.tor.socksPort || 9050 : 9050})`)
    }
    if (config.payment && config.payment.enabled) {
      console.log(`  Payment:    Lightning (${config.lightning ? config.lightning.rpcUrl || 'localhost:10009' : 'localhost:10009'})`)
    }
    if (config.access && config.access.allowlist && config.access.allowlist.length) {
      console.log(`  Allowlist:  ${config.access.allowlist.length} device(s)`)
    }
    console.log()
    console.log('  Node is running. Press Ctrl+C to stop.')
    console.log()
  })

  node.on('tor-ready', ({ onionAddress }) => {
    log.info({ onionAddress }, 'tor hidden service active')
    console.log(`  Onion:      ${onionAddress}`)
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
    log.warn({ appKey: appKey ? appKey.slice(0, 12) : 'unknown', err: error }, 'failed to reseed app')
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
      await new Promise(r => setTimeout(r, 500))
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
      await new Promise(r => setTimeout(r, 3000))

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

async function seed () {
  const appKey = args._[1]
  if (!appKey) {
    console.error('Usage: hiverelay seed <pear-app-key> [options]')
    console.error()
    console.error('Options:')
    console.error('  --replicas <n>     Desired replication factor (default: 3)')
    console.error('  --geo <region>     Geographic preference (NA, EU, AS, etc.)')
    console.error('  --max-storage <n>  Max storage for this app (e.g., 500MB)')
    console.error('  --ttl <days>       Seed request TTL in days (default: 30)')
    process.exit(1)
  }

  console.log(`Publishing seed request for: ${appKey.slice(0, 16)}...`)
  console.log(`  Replicas:    ${args.replicas || 3}`)
  console.log(`  Geo:         ${args.geo || 'any'}`)
  console.log(`  Max Storage: ${args['max-storage'] || '500MB'}`)
  console.log(`  TTL:         ${args.ttl || 30} days`)
  console.log()
  console.log('Seed request published. Relay nodes will begin seeding shortly.')
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
HiveRelay v0.1.0 — Shared P2P Relay Backbone

Usage:
  hiverelay init [options]      Initialize config + install agent skills
  hiverelay start [options]     Start a relay node
  hiverelay testnet [options]   Spin up a local testnet (DHT + relays + client)
  hiverelay seed <key>          Request seeding for a Pear app
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
  --mode <mode>                  Node mode: public, private, hybrid (default: public)
  --websocket                    Enable WebSocket transport for browser peers
  --ws-port <n>                  WebSocket port (default: 8765)
  --allowlist <key,...>          Device pubkeys for private mode (implies --mode private)
  --payment                      Enable Lightning payment settlement
  --lightning-rpc <url>          LND gRPC endpoint (default: localhost:10009)
  --lightning-macaroon <path>    Path to admin.macaroon
  --lightning-cert <path>        Path to tls.cert
  --tor [password]               Enable Tor hidden service transport
  --tor-socks-port <n>           Tor SOCKS5 port (default: 9050)
  --tor-control-port <n>         Tor control port (default: 9051)
  --quiet                       Suppress periodic status output

Testnet Options:
  --nodes <n>                   Number of relay nodes (default: 3)
  --port <n>                    Base API port (default: 19100)
  --no-client                   Skip launching a test client

Environment:
  HIVERELAY_LOG_LEVEL           Log level: fatal, error, warn, info, debug, trace

Examples:
  npx p2p-hiverelay init                           # One-line setup
  hiverelay start --region NA --max-storage 100GB  # Start relay
  hiverelay testnet                                # Local testnet (3 relays + client)
  hiverelay testnet --nodes 5                      # 5-node local testnet
  hiverelay status                                 # Check running node
  curl localhost:9100/health                       # API health check
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

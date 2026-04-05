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
  --tor [password]               Enable Tor hidden service transport
  --tor-socks-port <n>           Tor SOCKS5 port (default: 9050)
  --tor-control-port <n>         Tor control port (default: 9051)
  --quiet                       Suppress periodic status output

Environment:
  HIVERELAY_LOG_LEVEL           Log level: fatal, error, warn, info, debug, trace

Examples:
  npx hiverelay init                              # One-line setup
  hiverelay start --region NA --max-storage 100GB  # Start relay
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

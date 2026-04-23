/**
 * HiveRelay Interactive Setup Wizard (TUI)
 *
 * Guides the operator through configuring a relay node:
 *   - Node profile (light / standard / heavy)
 *   - Resource limits (memory, storage, bandwidth, connections)
 *   - Services (enable/disable individual services)
 *   - Transports (holesail, tor, websocket)
 *   - Network (API port, regions, bootstrap)
 *   - Seeding & registry settings
 *
 * Writes to ~/.hiverelay/config.json and prints a summary.
 */

import {
  select, confirm, input, checkbox, number
} from '@inquirer/prompts'
import { saveConfig, ensureDirs } from '../config/loader.js'
import { homedir } from 'os'
import { join } from 'path'

// ─── Node Profiles ──────────────────────────────────────────────────

const PROFILES = {
  light: {
    label: 'Light  — Low resource usage (Raspberry Pi, old laptop)',
    maxStorageBytes: 10 * 1024 * 1024 * 1024, // 10 GB
    maxConnections: 64,
    maxRelayBandwidthMbps: 25,
    services: ['identity', 'schema', 'sla']
  },
  standard: {
    label: 'Standard — Balanced for VPS or desktop (recommended)',
    maxStorageBytes: 50 * 1024 * 1024 * 1024, // 50 GB
    maxConnections: 256,
    maxRelayBandwidthMbps: 100,
    services: ['identity', 'schema', 'sla', 'storage', 'arbitration']
  },
  heavy: {
    label: 'Heavy  — Maximum capacity (dedicated server)',
    maxStorageBytes: 200 * 1024 * 1024 * 1024, // 200 GB
    maxConnections: 1024,
    maxRelayBandwidthMbps: 500,
    services: ['identity', 'schema', 'sla', 'storage', 'arbitration', 'ai', 'zk']
  },
  custom: {
    label: 'Custom — Configure everything manually'
  }
}

// All available services with descriptions
const ALL_SERVICES = [
  { name: 'identity  — Identity & key management (core)', value: 'identity' },
  { name: 'schema    — Data schema validation (core)', value: 'schema' },
  { name: 'sla       — Service-level agreements (core)', value: 'sla' },
  { name: 'storage   — Persistent data storage', value: 'storage' },
  { name: 'arbitration — Dispute resolution', value: 'arbitration' },
  { name: 'ai        — AI/ML inference', value: 'ai' },
  { name: 'zk        — Zero-knowledge proofs', value: 'zk' }
]

// ─── Helpers ────────────────────────────────────────────────────────

function formatBytes (bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(0)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / (1024 ** 2)).toFixed(0)} MB`
  return `${bytes} bytes`
}

function parseStorageInput (val) {
  const str = val.toString().trim().toUpperCase()
  const num = parseFloat(str)
  if (str.endsWith('TB')) return num * 1024 * 1024 * 1024 * 1024
  if (str.endsWith('GB')) return num * 1024 * 1024 * 1024
  if (str.endsWith('MB')) return num * 1024 * 1024
  return num * 1024 * 1024 * 1024 // Default to GB
}

// ─── Main Setup Flow ────────────────────────────────────────────────

export async function runSetup () {
  console.log()
  console.log('  ╔════════════════════════════════════════╗')
  console.log('  ║     HiveRelay Node Setup Wizard        ║')
  console.log('  ║     Configure your relay node          ║')
  console.log('  ╚════════════════════════════════════════╝')
  console.log()

  const config = {}

  // ─── Step 1: Node Profile ────────────────────────────────────────

  const profile = await select({
    message: 'Select a node profile:',
    choices: Object.entries(PROFILES).map(([key, p]) => ({
      name: p.label,
      value: key
    }))
  })

  if (profile !== 'custom') {
    const p = PROFILES[profile]
    config.maxStorageBytes = p.maxStorageBytes
    config.maxConnections = p.maxConnections
    config.maxRelayBandwidthMbps = p.maxRelayBandwidthMbps
    config._selectedServices = p.services
  }

  // ─── Step 2: Storage Path ────────────────────────────────────────

  const defaultStorage = join(homedir(), '.hiverelay', 'storage')
  const storagePath = await input({
    message: 'Storage directory:',
    default: defaultStorage
  })
  config.storage = storagePath

  // ─── Step 3: Resource Limits (custom or confirm) ─────────────────

  if (profile === 'custom') {
    const storageStr = await input({
      message: 'Max storage (e.g. 50GB, 200GB, 1TB):',
      default: '50GB',
      validate: (v) => {
        const n = parseStorageInput(v)
        return n > 0 ? true : 'Enter a valid size (e.g. 50GB)'
      }
    })
    config.maxStorageBytes = parseStorageInput(storageStr)

    config.maxConnections = await number({
      message: 'Max peer connections:',
      default: 256,
      min: 16,
      max: 4096
    })

    config.maxRelayBandwidthMbps = await number({
      message: 'Max relay bandwidth (Mbps):',
      default: 100,
      min: 10,
      max: 10000
    })
  } else {
    console.log()
    console.log(`  Profile: ${profile}`)
    console.log(`  Storage: ${formatBytes(config.maxStorageBytes)}`)
    console.log(`  Connections: ${config.maxConnections}`)
    console.log(`  Bandwidth: ${config.maxRelayBandwidthMbps} Mbps`)
    console.log()

    const tweakResources = await confirm({
      message: 'Adjust resource limits?',
      default: false
    })

    if (tweakResources) {
      const storageStr = await input({
        message: 'Max storage (e.g. 50GB, 200GB, 1TB):',
        default: formatBytes(config.maxStorageBytes),
        validate: (v) => {
          const n = parseStorageInput(v)
          return n > 0 ? true : 'Enter a valid size (e.g. 50GB)'
        }
      })
      config.maxStorageBytes = parseStorageInput(storageStr)

      config.maxConnections = await number({
        message: 'Max peer connections:',
        default: config.maxConnections,
        min: 16,
        max: 4096
      })

      config.maxRelayBandwidthMbps = await number({
        message: 'Max relay bandwidth (Mbps):',
        default: config.maxRelayBandwidthMbps,
        min: 10,
        max: 10000
      })
    }
  }

  // ─── Step 4: Services ────────────────────────────────────────────

  console.log()
  const profileServices = config._selectedServices || ['identity', 'schema', 'sla', 'storage', 'arbitration']

  const services = await checkbox({
    message: 'Enable services:',
    choices: ALL_SERVICES.map(s => ({
      ...s,
      checked: profileServices.includes(s.value)
    }))
  })
  config.services = services
  delete config._selectedServices

  // ─── Step 5: Core Features ───────────────────────────────────────

  console.log()
  config.enableRelay = await confirm({
    message: 'Enable circuit relay (forward traffic for peers)?',
    default: true
  })

  config.enableSeeding = await confirm({
    message: 'Enable app seeding (store and serve Pear apps)?',
    default: true
  })

  if (config.enableSeeding) {
    config.registryAutoAccept = await confirm({
      message: 'Auto-accept seed requests from the registry?',
      default: true
    })
  }

  // ─── Step 6: API & Network ───────────────────────────────────────

  console.log()
  config.enableAPI = await confirm({
    message: 'Enable HTTP API?',
    default: true
  })

  if (config.enableAPI) {
    config.apiPort = await number({
      message: 'API port:',
      default: 9100,
      min: 1024,
      max: 65535
    })
  }

  const setRegion = await confirm({
    message: 'Set a geographic region filter?',
    default: false
  })
  if (setRegion) {
    const regionInput = await input({
      message: 'Region codes (comma-separated, e.g. US,EU,ASIA):',
      default: ''
    })
    config.regions = regionInput.split(',').map(r => r.trim()).filter(Boolean)
  }

  // ─── Step 7: Transports ──────────────────────────────────────────

  console.log()
  const transports = { udp: true }

  transports.holesail = await confirm({
    message: 'Enable Holesail tunnel (required if behind NAT)?',
    default: true
  })

  transports.tor = await confirm({
    message: 'Enable Tor hidden service?',
    default: false
  })

  if (transports.tor) {
    config.tor = {}
    config.tor.socksPort = await number({
      message: 'Tor SOCKS port:',
      default: 9050,
      min: 1024,
      max: 65535
    })
    config.tor.controlPort = await number({
      message: 'Tor control port:',
      default: 9051,
      min: 1024,
      max: 65535
    })
    const torPassword = await input({
      message: 'Tor control password (leave empty for cookie auth):',
      default: ''
    })
    if (torPassword) config.tor.controlPassword = torPassword
  }

  transports.websocket = await confirm({
    message: 'Enable WebSocket transport?',
    default: false
  })

  if (transports.websocket) {
    config.wsPort = await number({
      message: 'WebSocket port:',
      default: 8765,
      min: 1024,
      max: 65535
    })
  }

  config.transports = transports

  // ─── Step 8: Lightning Payments ──────────────────────────────────

  console.log()
  const enableLightning = await confirm({
    message: 'Enable Lightning Network payments?',
    default: false
  })

  if (enableLightning) {
    config.lightning = { enabled: true }
    config.lightning.rpcUrl = await input({
      message: 'LND gRPC URL:',
      default: 'localhost:10009'
    })
    config.lightning.network = await select({
      message: 'Lightning network:',
      choices: [
        { name: 'Mainnet', value: 'mainnet' },
        { name: 'Testnet', value: 'testnet' },
        { name: 'Regtest', value: 'regtest' }
      ]
    })
    config.payment = {
      enabled: true,
      settlementInterval: 24 * 60 * 60 * 1000,
      minSettlementSats: 1000
    }
  }

  // ─── Step 9: Advanced ────────────────────────────────────────────

  const showAdvanced = await confirm({
    message: 'Configure advanced settings?',
    default: false
  })

  if (showAdvanced) {
    console.log()

    config.maxCircuitDuration = (await number({
      message: 'Max circuit duration (minutes):',
      default: 10,
      min: 1,
      max: 60
    })) * 60 * 1000

    config.maxCircuitBytes = (await number({
      message: 'Max circuit size (MB):',
      default: 64,
      min: 1,
      max: 1024
    })) * 1024 * 1024

    config.maxCircuitsPerPeer = await number({
      message: 'Max circuits per peer:',
      default: 5,
      min: 1,
      max: 50
    })

    config.proofMaxLatencyMs = await number({
      message: 'Proof-of-relay max latency (ms):',
      default: 5000,
      min: 500,
      max: 30000
    })

    config.shutdownTimeoutMs = (await number({
      message: 'Graceful shutdown timeout (seconds):',
      default: 10,
      min: 1,
      max: 60
    })) * 1000

    const customBootstrap = await confirm({
      message: 'Use custom DHT bootstrap nodes?',
      default: false
    })
    if (customBootstrap) {
      const bsInput = await input({
        message: 'Bootstrap nodes (host:port, comma-separated):',
        default: ''
      })
      config.bootstrapNodes = bsInput.split(',').map(s => {
        const [host, port] = s.trim().split(':')
        return { host, port: parseInt(port) || 49737 }
      }).filter(b => b.host)
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────

  console.log()
  console.log('  ╔════════════════════════════════════════╗')
  console.log('  ║         Configuration Summary          ║')
  console.log('  ╚════════════════════════════════════════╝')
  console.log()
  console.log(`  Profile:       ${profile}`)
  console.log(`  Storage path:  ${config.storage}`)
  console.log(`  Max storage:   ${formatBytes(config.maxStorageBytes)}`)
  console.log(`  Connections:   ${config.maxConnections}`)
  console.log(`  Bandwidth:     ${config.maxRelayBandwidthMbps} Mbps`)
  console.log(`  Services:      ${services.join(', ')}`)
  console.log(`  Relay:         ${config.enableRelay ? 'enabled' : 'disabled'}`)
  console.log(`  Seeding:       ${config.enableSeeding ? 'enabled' : 'disabled'}`)
  console.log(`  API:           ${config.enableAPI ? 'http://127.0.0.1:' + (config.apiPort || 9100) : 'disabled'}`)
  console.log(`  Transports:    ${Object.keys(transports).filter(t => transports[t]).join(', ')}`)
  if (config.regions && config.regions.length) {
    console.log(`  Regions:       ${config.regions.join(', ')}`)
  }
  if (enableLightning) {
    console.log(`  Lightning:     enabled (${config.lightning.network})`)
  }
  console.log()

  const doSave = await confirm({
    message: 'Save this configuration?',
    default: true
  })

  if (!doSave) {
    console.log('  Setup cancelled. No changes saved.')
    return null
  }

  // ─── Save ────────────────────────────────────────────────────────

  ensureDirs()
  const configPath = saveConfig(config)

  console.log()
  console.log(`  Config saved to: ${configPath}`)
  console.log()
  console.log('  Start your node:')
  console.log('    hiverelay start')
  console.log()

  const startNow = await confirm({
    message: 'Start the relay node now?',
    default: true
  })

  return { config, startNow }
}

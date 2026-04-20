/**
 * HiveRelay Live Management Console (TUI)
 *
 * Connects to a running relay node via HTTP API and provides
 * interactive management of all node settings, services, transports,
 * seeded apps, operating mode, and software updates.
 *
 * Usage:  hiverelay manage [--port 9100] [--host 127.0.0.1]
 */

import {
  select, confirm, input, number
} from '@inquirer/prompts'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { manageBanner, sectionHeader, shutdownBanner, paint, C, OK } from './banner.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MANAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version
  } catch {
    return '0.0.0'
  }
})()

// ─── API Client ─────────────────────────────────────────────────────

class RelayClient {
  constructor (host, port) {
    this.base = `http://${host}:${port}`
  }

  async get (path) {
    const res = await fetch(`${this.base}${path}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return res.json()
  }

  async post (path, body = {}) {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return res.json()
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatBytes (bytes) {
  if (!bytes || bytes === 0) return '0 B'
  if (bytes >= 1024 ** 4) return `${(bytes / (1024 ** 4)).toFixed(1)} TB`
  if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function formatUptime (ms) {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function parseStorageInput (val) {
  const str = val.toString().trim().toUpperCase()
  const num = parseFloat(str)
  if (str.endsWith('TB')) return num * 1024 * 1024 * 1024 * 1024
  if (str.endsWith('GB')) return num * 1024 * 1024 * 1024
  if (str.endsWith('MB')) return num * 1024 * 1024
  return num * 1024 * 1024 * 1024
}

function header (title, subtitle = '') {
  console.log(sectionHeader(title, subtitle))
}

// ─── Main Menu ──────────────────────────────────────────────────────

export async function runManage (host = '127.0.0.1', port = 9100) {
  const api = new RelayClient(host, port)

  // Verify connection
  try {
    await api.get('/health')
  } catch (err) {
    console.error(`\n  Cannot connect to relay at ${host}:${port}`)
    console.error('  Is the node running? Try: hiverelay start\n')
    console.error(`  Error: ${err.message}`)
    return
  }

  console.log(manageBanner(host, port, MANAGE_VERSION))

  let running = true
  while (running) {
    console.log()
    const action = await select({
      message: 'What do you want to manage?',
      choices: [
        { name: '\u{1f4ca} Dashboard        — Live node status & metrics', value: 'dashboard' },
        { name: '\u{1f527} Services         — Enable, disable, restart services', value: 'services' },
        { name: '\u{1f4e6} Resources        — Storage, connections, bandwidth limits', value: 'resources' },
        { name: '\u{1f310} Transports       — Holesail, Tor, WebSocket', value: 'transports' },
        { name: '\u{1f331} Seeding & Apps   — Manage seeded apps & catalog', value: 'seeding' },
        { name: '\u{1f3af} Operating Mode   — Standard, HomeHive, Stealth, etc.', value: 'mode' },
        { name: '\u{1f30d} Network          — Regions, peers, bootstrap', value: 'network' },
        { name: '\u{1f6e1}\ufe0f  Security        — Access control, rate limits', value: 'security' },
        { name: '\u26a1 Payments         — Lightning, credits, settlement', value: 'payments' },
        { name: '\u{1f504} Relay Settings   — Circuit limits, proof-of-relay', value: 'relay' },
        { name: '\u2699\ufe0f  Advanced         — Shutdown timeout, intervals, bootstrap', value: 'advanced' },
        { name: '\u{1f4e5} Update Software  — Check & apply updates', value: 'update' },
        { name: '\u{1f501} Restart Node     — Graceful restart', value: 'restart' },
        { name: '\u274c Exit', value: 'exit' }
      ]
    })

    try {
      switch (action) {
        case 'dashboard': await showDashboard(api); break
        case 'services': await manageServices(api); break
        case 'resources': await manageResources(api); break
        case 'transports': await manageTransports(api); break
        case 'seeding': await manageSeeding(api); break
        case 'mode': await manageMode(api); break
        case 'network': await manageNetwork(api); break
        case 'security': await manageSecurity(api); break
        case 'payments': await managePayments(api); break
        case 'relay': await manageRelay(api); break
        case 'advanced': await manageAdvanced(api); break
        case 'update': await manageSoftwareUpdate(api); break
        case 'restart': await restartNode(api); break
        case 'exit': running = false; break
      }
    } catch (err) {
      console.error(`\n  Error: ${err.message}`)
    }
  }

  console.log(shutdownBanner())
  console.log('  ' + OK + ' ' + paint(C.dim, 'management console closed. swarm persists.'))
  console.log()
}

// ─── Dashboard ──────────────────────────────────────────────────────

async function showDashboard (api) {
  const [status, health, overview] = await Promise.all([
    api.get('/status'),
    api.get('/health'),
    api.get('/api/overview').catch(() => null)
  ])

  header('Node Dashboard')
  console.log(`  Status:       ${health.ok ? '\u2705 Running' : '\u274c Down'}`)
  console.log(`  Public Key:   ${status.publicKey ? status.publicKey.slice(0, 16) + '...' : 'n/a'}`)
  console.log(`  Uptime:       ${overview ? formatUptime(overview.uptime * 1000) : 'n/a'}`)
  console.log(`  Connections:  ${status.connections || 0}`)
  console.log(`  Seeded Apps:  ${status.seededApps || 0}`)

  if (overview) {
    console.log(`  Storage:      ${formatBytes(overview.storage?.used || 0)} / ${formatBytes(overview.storage?.max || 0)}`)
    console.log(`  Memory:       ${formatBytes(overview.memory?.heapUsed || 0)} heap, ${formatBytes(overview.memory?.rss || 0)} RSS`)
    console.log(`  Relay:        ${overview.relay?.activeCircuits || 0} active circuits, ${formatBytes(overview.relay?.totalBytesRelayed || 0)} relayed`)
    console.log(`  Seeder:       ${overview.seeder?.coresSeeded || 0} cores, ${formatBytes(overview.seeder?.totalBytesServed || 0)} served`)
    console.log(`  Errors:       ${overview.errors || 0}`)
    if (overview.holesailKey) {
      console.log(`  Holesail:     ${overview.holesailKey}`)
    }
    if (overview.health) {
      console.log(`  Health:       ${overview.health.status || 'unknown'}`)
    }
  }

  // Peers summary
  try {
    const peers = await api.get('/peers')
    console.log(`  Peers:        ${peers.count || 0} connected`)
  } catch (_) {}

  // Services summary
  try {
    const svc = await api.get('/api/manage/services')
    const running = svc.services.filter(s => s.running).length
    console.log(`  Services:     ${running}/${svc.count} running`)
  } catch (_) {}
}

// ─── Services ───────────────────────────────────────────────────────

async function manageServices (api) {
  const svc = await api.get('/api/manage/services')

  header('Services Management')
  for (const s of svc.services) {
    const status = s.running ? '\u2705' : '\u274c'
    const methods = s.methods.length ? ` [${s.methods.join(', ')}]` : ''
    console.log(`  ${status} ${s.name}${methods}`)
  }
  console.log()

  const action = await select({
    message: 'Action:',
    choices: [
      { name: 'Disable a service', value: 'disable' },
      { name: 'Restart a service', value: 'restart' },
      { name: 'View service details', value: 'details' },
      { name: 'Back', value: 'back' }
    ]
  })

  if (action === 'back') return

  if (action === 'details') {
    const name = await select({
      message: 'Select service:',
      choices: svc.services.map(s => ({
        name: `${s.running ? '\u2705' : '\u274c'} ${s.name}`,
        value: s.name
      }))
    })
    const service = svc.services.find(s => s.name === name)
    header(`Service: ${name}`)
    console.log(`  Running:  ${service.running ? 'yes' : 'no'}`)
    console.log(`  Methods:  ${service.methods.join(', ') || 'none'}`)
    if (service.stats) {
      console.log(`  Stats:    ${JSON.stringify(service.stats, null, 2)}`)
    }
    return
  }

  const serviceName = await select({
    message: `Select service to ${action}:`,
    choices: svc.services
      .filter(s => action === 'disable' ? s.running : true)
      .map(s => ({ name: s.name, value: s.name }))
  })

  const ok = await confirm({
    message: `${action} '${serviceName}'?`,
    default: false
  })

  if (ok) {
    const result = await api.post('/api/manage/services', {
      action,
      service: serviceName
    })
    console.log(`  ${result.ok ? '\u2705' : '\u274c'} ${action}: ${serviceName}`)
  }
}

// ─── Resources ──────────────────────────────────────────────────────

async function manageResources (api) {
  const { config } = await api.get('/api/manage/config')

  header('Resource Limits')
  console.log(`  Max Storage:      ${formatBytes(config.maxStorageBytes)}`)
  console.log(`  Max Connections:  ${config.maxConnections}`)
  console.log(`  Max Bandwidth:    ${config.maxRelayBandwidthMbps} Mbps`)
  console.log()

  const field = await select({
    message: 'Adjust:',
    choices: [
      { name: `Storage limit (${formatBytes(config.maxStorageBytes)})`, value: 'storage' },
      { name: `Max connections (${config.maxConnections})`, value: 'connections' },
      { name: `Max bandwidth (${config.maxRelayBandwidthMbps} Mbps)`, value: 'bandwidth' },
      { name: 'Back', value: 'back' }
    ]
  })

  if (field === 'back') return

  const updates = {}

  if (field === 'storage') {
    const val = await input({
      message: 'New max storage (e.g. 50GB, 200GB, 1TB):',
      default: formatBytes(config.maxStorageBytes),
      validate: v => parseStorageInput(v) > 0 ? true : 'Enter a valid size'
    })
    updates.maxStorageBytes = parseStorageInput(val)
  }

  if (field === 'connections') {
    updates.maxConnections = await number({
      message: 'New max connections:',
      default: config.maxConnections,
      min: 16,
      max: 4096
    })
  }

  if (field === 'bandwidth') {
    updates.maxRelayBandwidthMbps = await number({
      message: 'New max bandwidth (Mbps):',
      default: config.maxRelayBandwidthMbps,
      min: 10,
      max: 10000
    })
  }

  const result = await api.post('/api/manage/config', updates)
  console.log(`  \u2705 Updated: ${result.applied.join(', ')}`)
}

// ─── Transports ─────────────────────────────────────────────────────

async function manageTransports (api) {
  const t = await api.get('/api/manage/transports')

  header('Transport Status')
  console.log('  UDP:        \u2705 Always on')
  console.log(`  Holesail:   ${t.holesail.enabled ? '\u2705 ' + (t.holesail.connectionKey || 'enabled') : '\u274c Disabled'}`)
  console.log(`  Tor:        ${t.tor.enabled ? '\u2705 ' + (t.tor.onionAddress || 'enabled') : '\u274c Disabled'}`)
  console.log(`  WebSocket:  ${t.websocket.enabled ? '\u2705 Port ' + t.websocket.port : '\u274c Disabled'}`)
  console.log()

  const action = await select({
    message: 'Toggle transport:',
    choices: [
      {
        name: `${t.holesail.enabled ? 'Disable' : 'Enable'} Holesail (NAT traversal)`,
        value: 'holesail'
      },
      {
        name: `${t.tor.enabled ? 'Disable' : 'Enable'} Tor (hidden service)`,
        value: 'tor'
      },
      {
        name: `${t.websocket.enabled ? 'Disable' : 'Enable'} WebSocket`,
        value: 'websocket'
      },
      { name: 'Back', value: 'back' }
    ]
  })

  if (action === 'back') return

  const currentlyEnabled = action === 'holesail'
    ? t.holesail.enabled
    : action === 'tor'
      ? t.tor.enabled
      : t.websocket.enabled

  const result = await api.post('/api/manage/transport', {
    transport: action,
    enabled: !currentlyEnabled
  })

  console.log(`  \u2705 ${action}: ${result.enabled ? 'enabled' : 'disabled'}`)
  if (result.note) console.log(`  Note: ${result.note}`)
}

// ─── Seeding & Apps ─────────────────────────────────────────────────

async function manageSeeding (api) {
  header('Seeded Apps')

  const apps = await api.get('/api/apps')
  if (apps.apps && apps.apps.length > 0) {
    for (const app of apps.apps) {
      const name = app.appId || app.appKey.slice(0, 12) + '...'
      const uptime = app.uptimeMinutes ? `${app.uptimeMinutes}m` : 'n/a'
      console.log(`  \u{1f331} ${name}  v${app.version || '?'}  up:${uptime}  served:${formatBytes(app.bytesServed || 0)}`)
    }
  } else {
    console.log('  No apps seeded.')
  }
  console.log()

  const action = await select({
    message: 'Action:',
    choices: [
      { name: 'Seed a new app', value: 'seed' },
      { name: 'Unseed an app', value: 'unseed' },
      { name: 'View catalog', value: 'catalog' },
      { name: 'Toggle auto-accept', value: 'auto-accept' },
      { name: 'Back', value: 'back' }
    ]
  })

  if (action === 'back') return

  if (action === 'seed') {
    const appKey = await input({
      message: 'App key (64 hex chars):',
      validate: v => /^[0-9a-f]{64}$/i.test(v.trim()) ? true : 'Must be 64 hex chars'
    })
    const appId = await input({
      message: 'App ID (optional):',
      default: ''
    })
    const version = await input({
      message: 'Version (optional):',
      default: ''
    })
    const opts = {}
    if (appId) opts.appId = appId
    if (version) opts.version = version
    const result = await api.post('/seed', { appKey: appKey.trim(), ...opts })
    console.log(`  \u2705 Seeded! Discovery key: ${result.discoveryKey || 'n/a'}`)
  }

  if (action === 'unseed') {
    if (!apps.apps || apps.apps.length === 0) {
      console.log('  No apps to unseed.')
      return
    }
    const appKey = await select({
      message: 'Select app to unseed:',
      choices: apps.apps.map(a => ({
        name: `${a.appId || a.appKey.slice(0, 12) + '...'} (v${a.version || '?'})`,
        value: a.appKey
      }))
    })
    const ok = await confirm({ message: 'Unseed this app?', default: false })
    if (ok) {
      await api.post('/unseed', { appKey })
      console.log('  \u2705 Unseeded.')
    }
  }

  if (action === 'catalog') {
    const catalog = await api.get('/catalog.json')
    header('App Catalog')
    if (catalog.apps && catalog.apps.length > 0) {
      for (const app of catalog.apps) {
        console.log(`  ${app.name || app.id} v${app.version} by ${app.author}`)
        if (app.description) console.log(`    ${app.description}`)
      }
    } else {
      console.log('  Catalog is empty.')
    }
  }

  if (action === 'auto-accept') {
    const { config } = await api.get('/api/manage/config')
    const newVal = !config.registryAutoAccept
    await api.post('/registry/auto-accept', { enabled: newVal })
    console.log(`  \u2705 Auto-accept: ${newVal ? 'enabled' : 'disabled'}`)
  }
}

// ─── Operating Mode ─────────────────────────────────────────────────

async function manageMode (api) {
  const modes = await api.get('/api/manage/modes')

  header('Operating Mode')
  console.log(`  Current: ${modes.current}`)
  console.log()

  const mode = await select({
    message: 'Switch to:',
    choices: [
      ...modes.available.map(m => ({
        name: `${m.id === modes.current ? '\u2713 ' : '  '}${m.name} — ${m.description}`,
        value: m.id
      })),
      { name: 'Back', value: 'back' }
    ]
  })

  if (mode === 'back') return

  if (mode === modes.current) {
    console.log('  Already in this mode.')
    return
  }

  const ok = await confirm({
    message: `Switch to ${mode} mode? This will adjust resource limits and features.`,
    default: true
  })

  if (ok) {
    const result = await api.post('/api/manage/mode', { mode })
    console.log(`  \u2705 Mode: ${result.mode}`)
    if (result.note) console.log(`  Note: ${result.note}`)
    console.log(`  Applied: ${result.applied.join(', ')}`)
  }
}

// ─── Network ────────────────────────────────────────────────────────

async function manageNetwork (api) {
  const [{ config }, peers, network] = await Promise.all([
    api.get('/api/manage/config'),
    api.get('/peers').catch(() => ({ count: 0, peers: [] })),
    api.get('/api/network').catch(() => null)
  ])

  header('Network')
  console.log(`  API Port:     ${config.apiPort}`)
  console.log(`  Regions:      ${config.regions.length ? config.regions.join(', ') : 'all (no filter)'}`)
  console.log(`  Peers:        ${peers.count} connected`)
  if (network && network.mdns) {
    console.log(`  LAN Relays:   ${network.mdns.discovered || 0} discovered via mDNS`)
  }
  console.log()

  const action = await select({
    message: 'Action:',
    choices: [
      { name: 'Update regions', value: 'regions' },
      { name: 'View peers', value: 'peers' },
      { name: 'View network discovery', value: 'discovery' },
      { name: 'Back', value: 'back' }
    ]
  })

  if (action === 'back') return

  if (action === 'regions') {
    const regionInput = await input({
      message: 'Region codes (comma-separated, empty for all):',
      default: config.regions.join(', ')
    })
    const regions = regionInput.split(',').map(r => r.trim()).filter(Boolean)
    await api.post('/api/manage/config', { regions })
    console.log(`  \u2705 Regions: ${regions.length ? regions.join(', ') : 'all'}`)
  }

  if (action === 'peers') {
    const detailed = await api.get('/api/peers').catch(() => null)
    if (detailed && detailed.peers) {
      for (const p of detailed.peers.slice(0, 20)) {
        const rep = p.reputation ? ` rep:${p.reputation.score?.toFixed(2) || '?'}` : ''
        console.log(`  ${p.publicKey.slice(0, 16)}...${rep}`)
      }
      if (detailed.peers.length > 20) {
        console.log(`  ... and ${detailed.peers.length - 20} more`)
      }
    }
  }

  if (action === 'discovery') {
    if (network) {
      console.log(`  ${JSON.stringify(network, null, 2)}`)
    } else {
      console.log('  Network discovery data unavailable.')
    }
  }
}

// ─── Security ───────────────────────────────────────────────────────

async function manageSecurity (api) {
  header('Security')

  const status = await api.get('/status')
  console.log(`  Public Key:       ${status.publicKey || 'n/a'}`)
  console.log(`  Auto-Accept:      ${status.registry?.autoAccept !== false ? 'yes' : 'no (approval mode)'}`)
  console.log()

  const action = await select({
    message: 'Action:',
    choices: [
      { name: 'Toggle approval mode (require manual seed approval)', value: 'approval' },
      { name: 'View pending approvals', value: 'pending' },
      { name: 'Approve a pending request', value: 'approve' },
      { name: 'Reject a pending request', value: 'reject' },
      { name: 'Back', value: 'back' }
    ]
  })

  if (action === 'back') return

  if (action === 'approval') {
    const { config } = await api.get('/api/manage/config')
    const newVal = !config.registryAutoAccept
    await api.post('/registry/auto-accept', { enabled: newVal })
    console.log(`  \u2705 Auto-accept: ${newVal ? 'enabled (auto-seed)' : 'disabled (manual approval)'}`)
  }

  if (action === 'pending' || action === 'approve' || action === 'reject') {
    const pending = await api.get('/api/registry/pending').catch(() => ({ requests: [] }))
    if (!pending.requests || pending.requests.length === 0) {
      console.log('  No pending requests.')
      return
    }

    for (const req of pending.requests) {
      console.log(`  ${req.appKey.slice(0, 16)}... from ${req.publisher?.slice(0, 12) || 'unknown'}`)
    }

    if (action === 'approve' || action === 'reject') {
      const appKey = await select({
        message: `Select request to ${action}:`,
        choices: pending.requests.map(r => ({
          name: r.appKey.slice(0, 16) + '...',
          value: r.appKey
        }))
      })
      const endpoint = action === 'approve' ? '/registry/approve' : '/registry/reject'
      await api.post(endpoint, { appKey })
      console.log(`  \u2705 ${action === 'approve' ? 'Approved' : 'Rejected'}: ${appKey.slice(0, 16)}...`)
    }
  }
}

// ─── Payments ───────────────────────────────────────────────────────

async function managePayments (api) {
  header('Payments')

  const overview = await api.get('/api/overview').catch(() => null)
  if (overview && overview.bandwidth) {
    console.log(`  Total Proven Bytes:  ${formatBytes(overview.bandwidth.totalProvenBytes || 0)}`)
    console.log(`  Receipts Issued:     ${overview.bandwidth.receiptsIssued || 0}`)
  }
  console.log()

  const { config } = await api.get('/api/manage/config')
  const lightningEnabled = config.lightning?.enabled || false
  console.log(`  Lightning: ${lightningEnabled ? '\u2705 Enabled' : '\u274c Disabled'}`)
  console.log()
  console.log('  Payment settings require a node restart to change.')
  console.log('  Edit ~/.hiverelay/config.json to configure Lightning.')
}

// ─── Relay Settings ─────────────────────────────────────────────────

async function manageRelay (api) {
  const { config } = await api.get('/api/manage/config')

  header('Relay Settings')
  console.log(`  Relay Enabled:        ${config.enableRelay ? 'yes' : 'no'}`)
  console.log(`  Max Circuits/Peer:    ${config.maxCircuitsPerPeer}`)
  console.log(`  Max Circuit Duration: ${(config.maxCircuitDuration / 60000).toFixed(0)} minutes`)
  console.log(`  Max Circuit Size:     ${formatBytes(config.maxCircuitBytes)}`)
  console.log()

  const action = await select({
    message: 'Adjust:',
    choices: [
      { name: `Circuits per peer (${config.maxCircuitsPerPeer})`, value: 'circuitsPerPeer' },
      { name: `Circuit duration (${(config.maxCircuitDuration / 60000).toFixed(0)}m)`, value: 'circuitDuration' },
      { name: `Circuit size (${formatBytes(config.maxCircuitBytes)})`, value: 'circuitBytes' },
      { name: 'Toggle relay on/off', value: 'toggle' },
      { name: 'Back', value: 'back' }
    ]
  })

  if (action === 'back') return

  if (action === 'circuitsPerPeer') {
    const val = await number({
      message: 'Max circuits per peer:',
      default: config.maxCircuitsPerPeer,
      min: 1,
      max: 50
    })
    await api.post('/api/manage/config', { maxCircuitsPerPeer: val })
    console.log('  \u2705 Updated.')
  }

  if (action === 'circuitDuration') {
    const minutes = await number({
      message: 'Max circuit duration (minutes):',
      default: config.maxCircuitDuration / 60000,
      min: 1,
      max: 60
    })
    await api.post('/api/manage/config', { maxCircuitDuration: minutes * 60000 })
    console.log('  \u2705 Updated.')
  }

  if (action === 'circuitBytes') {
    const mb = await number({
      message: 'Max circuit size (MB):',
      default: config.maxCircuitBytes / (1024 * 1024),
      min: 1,
      max: 1024
    })
    await api.post('/api/manage/config', { maxCircuitBytes: mb * 1024 * 1024 })
    console.log('  \u2705 Updated.')
  }

  if (action === 'toggle') {
    const { config: cfg } = await api.get('/api/manage/config')
    await api.post('/api/manage/config', { enableRelay: !cfg.enableRelay })
    console.log(`  \u2705 Relay: ${cfg.enableRelay ? 'disabled' : 'enabled'}`)
    console.log('  Note: Restart required for full effect.')
  }
}

// ─── Advanced ───────────────────────────────────────────────────────

async function manageAdvanced (api) {
  const { config } = await api.get('/api/manage/config')

  header('Advanced Settings')
  console.log(`  Shutdown Timeout:   ${(config.shutdownTimeoutMs / 1000).toFixed(0)}s`)
  console.log(`  Announce Interval:  ${(config.announceInterval / 60000).toFixed(0)} min`)
  console.log(`  Mode:               ${config.mode}`)
  console.log()

  const action = await select({
    message: 'Adjust:',
    choices: [
      { name: `Shutdown timeout (${(config.shutdownTimeoutMs / 1000).toFixed(0)}s)`, value: 'shutdown' },
      { name: `Announce interval (${(config.announceInterval / 60000).toFixed(0)} min)`, value: 'announce' },
      { name: 'Export config to console', value: 'export' },
      { name: 'Back', value: 'back' }
    ]
  })

  if (action === 'back') return

  if (action === 'shutdown') {
    const val = await number({
      message: 'Shutdown timeout (seconds):',
      default: config.shutdownTimeoutMs / 1000,
      min: 1,
      max: 60
    })
    await api.post('/api/manage/config', { shutdownTimeoutMs: val * 1000 })
    console.log('  \u2705 Updated.')
  }

  if (action === 'announce') {
    const val = await number({
      message: 'Announce interval (minutes):',
      default: config.announceInterval / 60000,
      min: 1,
      max: 120
    })
    await api.post('/api/manage/config', { announceInterval: val * 60000 })
    console.log('  \u2705 Updated.')
  }

  if (action === 'export') {
    console.log()
    console.log(JSON.stringify(config, null, 2))
  }
}

// ─── Software Update ────────────────────────────────────────────────

async function manageSoftwareUpdate (api) {
  header('Software Update')

  // Check current version from package.json
  console.log('  Checking for updates...')
  console.log()

  try {
    // Check npm registry for latest version
    const npmRes = await fetch('https://registry.npmjs.org/p2p-hiverelay/latest')
    const npmData = await npmRes.json()
    const latestVersion = npmData.version

    const status = await api.get('/status')
    const currentVersion = status.version || 'unknown'

    console.log(`  Current:  v${currentVersion}`)
    console.log(`  Latest:   v${latestVersion}`)
    console.log()

    if (currentVersion === latestVersion) {
      console.log('  \u2705 Already up to date!')
      return
    }

    console.log('  \u2b06\ufe0f  Update available!')
    console.log()
    console.log('  To update:')
    console.log('    npm install -g p2p-hiverelay@latest')
    console.log()
    console.log('  Or if running from git:')
    console.log('    git pull && npm install')
    console.log()

    const doRestart = await confirm({
      message: 'Restart node after update? (run update command first)',
      default: false
    })

    if (doRestart) {
      await restartNode(api)
    }
  } catch (err) {
    console.log(`  Could not check npm registry: ${err.message}`)
    console.log()
    console.log('  Manual update:')
    console.log('    npm install -g p2p-hiverelay@latest')
    console.log('    # or: git pull && npm install')
  }
}

// ─── Restart ────────────────────────────────────────────────────────

async function restartNode (api) {
  const ok = await confirm({
    message: 'Restart the relay node? Active connections will be dropped.',
    default: false
  })

  if (ok) {
    console.log('  Restarting...')
    try {
      await api.post('/api/manage/restart')
      console.log('  \u2705 Restart initiated. The node will be back shortly.')
      console.log('  Waiting for node to come back...')
      // Poll until node is back
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        try {
          await api.get('/health')
          console.log('  \u2705 Node is back online!')
          return
        } catch (_) {}
      }
      console.log('  \u26a0\ufe0f  Node not responding after 20s. Check manually.')
    } catch (err) {
      console.log(`  \u2705 Restart signal sent. (Connection closed: ${err.message})`)
    }
  }
}

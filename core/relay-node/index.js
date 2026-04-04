import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { EventEmitter } from 'events'
import { Seeder } from './seeder.js'
import { Relay } from './relay.js'
import { Metrics } from './metrics.js'
import { RelayAPI } from './api.js'
import { WebSocketTransport } from '../../transports/websocket/index.js'

// Well-known discovery topic — clients join this to find relay nodes
const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

const DEFAULT_CONFIG = {
  storage: './storage',
  maxStorageBytes: 50 * 1024 * 1024 * 1024, // 50 GB
  maxConnections: 256,
  maxRelayBandwidthMbps: 100,
  announceInterval: 15 * 60 * 1000, // 15 minutes
  regions: [],
  enableRelay: true,
  enableSeeding: true,
  enableMetrics: true,
  enableAPI: true,
  apiPort: 9100,
  bootstrapNodes: null, // null = use HyperDHT defaults
  shutdownTimeoutMs: 10_000
}

function isValidHexKey (hex) {
  return typeof hex === 'string' && hex.length === 64 && /^[0-9a-f]+$/i.test(hex)
}

function withTimeout (promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ])
}

export class RelayNode extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...opts }
    this.store = new Corestore(this.config.storage)
    this.swarm = null
    this.seeder = null
    this.relay = null
    this.metrics = null
    this.api = null
    this.wsTransport = null
    this.paymentManager = null
    this.settlementInterval = null
    this.seededApps = new Map() // appKey hex -> { drive, discovery keys }
    this.running = false
  }

  async start () {
    if (this.running) return

    try {
      await this.store.ready()

      this.swarm = new Hyperswarm({
        bootstrap: this.config.bootstrapNodes,
        maxConnections: this.config.maxConnections
      })

      this.swarm.on('connection', (conn, info) => this._onConnection(conn, info))

      // Announce on well-known discovery topic so clients can find us
      this.swarm.join(RELAY_DISCOVERY_TOPIC, { server: true, client: false })

      // Initialize subsystems in parallel where possible
      const startups = []

      if (this.config.enableSeeding) {
        this.seeder = new Seeder(this.store, this.swarm, {
          maxStorageBytes: this.config.maxStorageBytes,
          announceInterval: this.config.announceInterval
        })
        startups.push(this.seeder.start())
      }

      if (this.config.enableRelay) {
        this.relay = new Relay(this.swarm, {
          maxBandwidthMbps: this.config.maxRelayBandwidthMbps,
          maxConnections: this.config.maxConnections
        })
        startups.push(this.relay.start())
      }

      if (this.config.enableMetrics) {
        this.metrics = new Metrics(this)
      }

      if (this.config.enableAPI) {
        this.api = new RelayAPI(this, { apiPort: this.config.apiPort })
        startups.push(this.api.start())
      }

      // Flush DHT + start subsystems concurrently
      startups.push(this.swarm.flush())
      await Promise.all(startups)

      if (this.config.transports && this.config.transports.websocket) {
        this.wsTransport = new WebSocketTransport({
          port: this.config.wsPort || 8765,
          maxConnections: this.config.maxConnections
        })
        this.wsTransport.on('connection', (stream, info) => this._onConnection(stream, info))
        await this.wsTransport.start()
      }

      if (this.config.payment && this.config.payment.enabled && this.config.paymentManager) {
        this.paymentManager = this.config.paymentManager
        const interval = this.config.payment.settlementInterval || 24 * 60 * 60 * 1000
        this.settlementInterval = setInterval(() => {
          this._runSettlements().catch((err) => {
            this.emit('settlement-error', { error: err })
          })
        }, interval)
      }

      this.running = true
      this.emit('started', { publicKey: this.swarm.keyPair.publicKey })
    } catch (err) {
      // Rollback in reverse order
      if (this.settlementInterval) { clearInterval(this.settlementInterval); this.settlementInterval = null }
      if (this.wsTransport) { try { await this.wsTransport.stop() } catch {} this.wsTransport = null }
      if (this.api) { try { await this.api.stop() } catch {} this.api = null }
      if (this.metrics) { this.metrics.stop(); this.metrics = null }
      if (this.relay) { try { await this.relay.stop() } catch {} this.relay = null }
      if (this.seeder) { try { await this.seeder.stop() } catch {} this.seeder = null }
      if (this.swarm) { try { await this.swarm.destroy() } catch {} this.swarm = null }
      this.running = false
      throw err
    }

    return this
  }

  async seedApp (appKeyHex, opts = {}) {
    if (!this.seeder) throw new Error('Seeding not enabled')
    if (!isValidHexKey(appKeyHex)) throw new Error('Invalid app key: must be 64 hex characters')

    const appKey = b4a.from(appKeyHex, 'hex')
    const drive = new Hyperdrive(this.store, appKey)

    try {
      await drive.ready()

      const discoveryKey = drive.discoveryKey
      this.swarm.join(discoveryKey, { server: true, client: true })

      // Flush DHT + eagerly download drive content in parallel
      const eager = Promise.all([
        this.swarm.flush(),
        drive.update({ wait: true }).catch(() => {}),
        drive.download('/').catch(() => {})
      ])
      eager.catch(() => {})

      this.seededApps.set(appKeyHex, {
        drive,
        discoveryKey,
        startedAt: Date.now(),
        bytesServed: 0
      })

      this.emit('seeding', { appKey: appKeyHex, discoveryKey: b4a.toString(discoveryKey, 'hex') })
      return { discoveryKey: b4a.toString(discoveryKey, 'hex') }
    } catch (err) {
      try { await drive.close() } catch {}
      throw err
    }
  }

  async unseedApp (appKeyHex) {
    const entry = this.seededApps.get(appKeyHex)
    if (!entry) return

    try { await this.swarm.leave(entry.discoveryKey) } catch {}
    try { await entry.drive.close() } catch {}
    this.seededApps.delete(appKeyHex)

    this.emit('unseeded', { appKey: appKeyHex })
  }

  getStats () {
    return {
      running: this.running,
      publicKey: this.swarm ? b4a.toString(this.swarm.keyPair.publicKey, 'hex') : null,
      seededApps: this.seededApps.size,
      connections: this.swarm ? this.swarm.connections.size : 0,
      relay: this.relay ? this.relay.getStats() : null,
      seeder: this.seeder ? this.seeder.getStats() : null
    }
  }

  _onConnection (conn, info) {
    // Replicate all cores in our store over this connection
    this.store.replicate(conn)

    conn.on('error', (err) => {
      this.emit('connection-error', { error: err, info })
    })

    conn.on('close', () => {
      this.emit('connection-closed', { info })
    })

    this.emit('connection', { info, remotePubKey: b4a.toString(info.publicKey, 'hex') })
  }

  async _runSettlements () {
    if (!this.paymentManager) return
    const minSats = (this.config.payment && this.config.payment.minSettlementSats) || 1000
    for (const [pubkey] of this.paymentManager.accounts) {
      const summary = this.paymentManager.getAccountSummary(pubkey)
      if (summary && summary.pendingPayout >= minSats) {
        try {
          await this.paymentManager.settle(pubkey)
        } catch (err) {
          this.emit('settlement-error', { relay: pubkey, error: err })
        }
      }
    }
  }

  async stop () {
    if (!this.running) return

    const timeout = this.config.shutdownTimeoutMs

    // Stop settlement, WebSocket, API, and metrics first
    if (this.settlementInterval) { clearInterval(this.settlementInterval); this.settlementInterval = null }
    if (this.wsTransport) {
      try { await withTimeout(this.wsTransport.stop(), timeout, 'wsTransport.stop') } catch {}
      this.wsTransport = null
    }
    if (this.api) {
      try { await withTimeout(this.api.stop(), timeout, 'api.stop') } catch {}
      this.api = null
    }
    if (this.metrics) { this.metrics.stop(); this.metrics = null }

    // Unseed all apps
    for (const appKeyHex of this.seededApps.keys()) {
      try {
        await withTimeout(this.unseedApp(appKeyHex), timeout, `unseedApp(${appKeyHex.slice(0, 8)})`)
      } catch {}
    }

    if (this.relay) {
      try { await withTimeout(this.relay.stop(), timeout, 'relay.stop') } catch {}
    }
    if (this.seeder) {
      try { await withTimeout(this.seeder.stop(), timeout, 'seeder.stop') } catch {}
    }
    if (this.swarm) {
      try { await withTimeout(this.swarm.destroy(), timeout, 'swarm.destroy') } catch {}
    }
    if (this.store) {
      try { await withTimeout(this.store.close(), timeout, 'store.close') } catch {}
    }

    this.running = false
    this.emit('stopped')
  }
}

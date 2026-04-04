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
import { BootstrapCache } from '../bootstrap-cache.js'
import { SeedProtocol } from '../protocol/seed-request.js'
import { CircuitRelay } from '../protocol/relay-circuit.js'

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
    this.connections = new Map() // conn -> { lastActivity }
    this._healthCheckInterval = null
    this.bootstrapCache = new BootstrapCache(this.config.storage, {
      enabled: this.config.bootstrapCacheEnabled !== false,
      maxPeers: this.config.bootstrapCachePeers || 50
    })
    this.running = false
  }

  async start () {
    if (this.running) return

    try {
      await this.store.ready()

      await this.bootstrapCache.load()
      const bootstrap = this.bootstrapCache.merge(this.config.bootstrapNodes)

      this.swarm = new Hyperswarm({
        bootstrap,
        maxConnections: this.config.maxConnections
      })

      this.bootstrapCache.start(this.swarm)
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

      // Initialize protocol handlers for seed requests and circuit relay
      this._seedProtocol = new SeedProtocol(this.swarm, {
        keyPair: this.swarm.keyPair
      })
      this._seedProtocol.on('seed-request', (msg) => this._onSeedRequest(msg))

      if (this.relay) {
        this._circuitRelay = new CircuitRelay(this.swarm, this.relay, {
          maxCircuitsPerPeer: this.config.maxCircuitsPerPeer || 5
        })
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

      this._startHealthChecks()
      this.running = true
      this.emit('started', { publicKey: this.swarm.keyPair.publicKey })
    } catch (err) {
      // Rollback in reverse order
      this.bootstrapCache.stop()
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

    // Attach protocol handlers so clients can negotiate seed/circuit channels
    if (this._seedProtocol) {
      try { this._seedProtocol.attach(conn) } catch (err) {
        this.emit('protocol-error', { protocol: 'seed', error: err })
      }
    }
    if (this._circuitRelay) {
      try { this._circuitRelay.attach(conn) } catch (err) {
        this.emit('protocol-error', { protocol: 'circuit', error: err })
      }
    }

    const entry = { lastActivity: Date.now() }
    this.connections.set(conn, entry)

    conn.on('data', () => {
      entry.lastActivity = Date.now()
    })

    conn.on('error', (err) => {
      this.emit('connection-error', { error: err, info })
    })

    conn.on('close', () => {
      this.connections.delete(conn)
      this.emit('connection-closed', { info })
    })

    this.emit('connection', { info, remotePubKey: b4a.toString(info.publicKey, 'hex') })
  }

  _onSeedRequest (msg) {
    if (!this.seeder) return

    const appKeyHex = b4a.toString(msg.appKey, 'hex')
    const availableBytes = this.config.maxStorageBytes - this.seeder.totalBytesStored

    // Check capacity
    if (availableBytes < msg.maxStorageBytes) {
      this.emit('seed-rejected', { appKey: appKeyHex, reason: 'insufficient storage' })
      return
    }

    // Accept and start seeding
    this._seedProtocol.acceptSeedRequest(
      msg.appKey,
      this.swarm.keyPair.publicKey,
      this.config.region || 'unknown',
      availableBytes
    )

    // Actually seed the core(s)
    for (const dk of (msg.discoveryKeys || [])) {
      const keyHex = b4a.toString(dk, 'hex')
      this.seeder.seedCore(keyHex).catch((err) => {
        this.emit('seed-error', { appKey: appKeyHex, core: keyHex, error: err })
      })
    }

    // Also seed the app key itself
    this.seeder.seedCore(appKeyHex).catch((err) => {
      this.emit('seed-error', { appKey: appKeyHex, error: err })
    })

    this.emit('seed-accepted', { appKey: appKeyHex })
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

  _startHealthChecks () {
    const HEALTH_CHECK_INTERVAL = 60_000
    const STALE_THRESHOLD = 5 * 60 * 1000

    this._healthCheckInterval = setInterval(() => {
      const now = Date.now()
      for (const [conn, entry] of this.connections) {
        if (now - entry.lastActivity > STALE_THRESHOLD) {
          this.emit('connection-stale', { conn, lastActivity: entry.lastActivity })
        }
      }
    }, HEALTH_CHECK_INTERVAL)
    if (this._healthCheckInterval.unref) this._healthCheckInterval.unref()
  }

  async stop () {
    if (!this.running) return

    const timeout = this.config.shutdownTimeoutMs

    // Stop bootstrap cache and persist peers
    this.bootstrapCache.stop()
    try { await this.bootstrapCache.save() } catch {}

    // Stop health checks, settlement, WebSocket, API, and metrics first
    if (this._healthCheckInterval) { clearInterval(this._healthCheckInterval); this._healthCheckInterval = null }
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

    // Destroy protocol handlers
    if (this._seedProtocol) { this._seedProtocol.destroy(); this._seedProtocol = null }
    if (this._circuitRelay) {
      if (this._circuitRelay.destroy) this._circuitRelay.destroy()
      this._circuitRelay = null
    }

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

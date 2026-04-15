import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { EventEmitter } from 'events'
import { readFile, writeFile, mkdir, chmod } from 'fs/promises'
import { join } from 'path'
import { Seeder } from './seeder.js'
import { Relay } from './relay.js'
import { Metrics } from './metrics.js'
import { RelayAPI } from './api.js'
import { WebSocketTransport } from '../../transports/websocket/index.js'
import { TorTransport } from '../../transports/tor/index.js'
import { HolesailTransport } from '../../transports/holesail/index.js'
import http from 'http'
import { BootstrapCache } from '../bootstrap-cache.js'
import { SeedProtocol } from '../protocol/seed-request.js'
import { CircuitRelay } from '../protocol/relay-circuit.js'
import { ProofOfRelay } from '../protocol/proof-of-relay.js'
import { BandwidthReceipt } from '../protocol/bandwidth-receipt.js'
import { ReputationSystem } from '../../incentive/reputation/index.js'
import { NetworkDiscovery } from '../network-discovery.js'
import { HealthMonitor } from './health-monitor.js'
import { SelfHeal } from './self-heal.js'
import { SeedingRegistry } from '../registry/index.js'
import {
  ServiceRegistry, ServiceProtocol,
  StorageService, IdentityService, ComputeService,
  AIService, SLAService, SchemaService, ArbitrationService, ZKService
} from '../services/index.js'
import { Router } from '../router/index.js'
import { AppRegistry } from '../app-registry.js'

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
  shutdownTimeoutMs: 10_000,
  enableEviction: true
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
    this.torTransport = null
    this.paymentManager = null
    this.settlementInterval = null
    this.appRegistry = new AppRegistry(this.config.storage)
    // Backwards compat: this.seededApps is the same Map instance
    this.seededApps = this.appRegistry.apps
    this.connections = new Map() // conn -> { lastActivity }
    this._healthCheckInterval = null
    this.bootstrapCache = new BootstrapCache(this.config.storage, {
      enabled: this.config.bootstrapCacheEnabled !== false,
      maxPeers: this.config.bootstrapCachePeers || 50
    })
    this.reputation = new ReputationSystem()
    this._proofOfRelay = null
    this._bandwidthReceipt = null
    this._reputationDecayInterval = null
    this._reputationSaveInterval = null
    this.networkDiscovery = null
    this.healthMonitor = null
    this.selfHeal = null
    this.seedingRegistry = null
    this._registryScanInterval = null
    this.serviceRegistry = null
    this.serviceProtocol = null
    this.router = null
    this._pendingRequests = new Map() // appKey -> registry entry (approval mode queue)
    this.running = false
  }

  async start () {
    if (this.running) return

    try {
      // Re-create store if it was closed (e.g. after self-heal restart)
      if (this.store.closed) {
        this.store = new Corestore(this.config.storage)
      }
      await this.store.ready()

      await this.bootstrapCache.load()
      const bootstrap = this.bootstrapCache.merge(this.config.bootstrapNodes)

      const keyPair = await this._loadOrCreateKeyPair()
      this.keyPair = keyPair
      this.publicKey = keyPair.publicKey

      this.swarm = new Hyperswarm({
        bootstrap,
        keyPair,
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
      this._seedProtocol.on('unseed-request', (msg) => this._onUnseedRequest(msg))

      if (this.relay) {
        this._circuitRelay = new CircuitRelay(this.swarm, this.relay, {
          maxCircuitsPerPeer: this.config.maxCircuitsPerPeer || 5
        })
      }

      // Initialize proof-of-relay challenge system
      this._proofOfRelay = new ProofOfRelay({
        maxLatencyMs: this.config.proofMaxLatencyMs || 5000,
        challengeInterval: this.config.proofChallengeInterval || 300000
      })

      // Feed proof results into reputation scoring
      this._proofOfRelay.on('proof-result', (result) => {
        this.reputation.recordChallenge(result.relayPubkey, result.passed, result.latencyMs)
      })

      // Load persisted reputation data
      const reputationPath = join(this.config.storage, 'reputation.json')
      try {
        this.reputation = await ReputationSystem.load(reputationPath)
      } catch (_) {
        this.reputation = new ReputationSystem()
      }

      // Daily reputation decay (run hourly, decay is multiplicative)
      this._reputationDecayInterval = setInterval(() => {
        this.reputation.applyDecay()
      }, 60 * 60 * 1000)
      if (this._reputationDecayInterval.unref) this._reputationDecayInterval.unref()

      // Periodic reputation save every 5 minutes
      this._reputationSaveInterval = setInterval(() => {
        this.reputation.save(reputationPath).catch(() => {})
      }, 5 * 60 * 1000)
      if (this._reputationSaveInterval.unref) this._reputationSaveInterval.unref()

      // Initialize bandwidth receipt tracking
      this._bandwidthReceipt = new BandwidthReceipt(this.swarm.keyPair, {
        maxReceipts: 10000,
        aggregateThresholdBytes: this.config.aggregateThresholdBytes || 10 * 1024 * 1024,
        aggregateWindowMs: this.config.aggregateWindowMs || 10000
      })

      // When a circuit closes, record the bandwidth in reputation
      if (this.relay) {
        this.relay.on('circuit-closed', ({ circuitId, bytesRelayed, durationMs }) => {
          if (bytesRelayed > 0 && this.reputation) {
            this.reputation.recordBandwidth(
              b4a.toString(this.swarm.keyPair.publicKey, 'hex'),
              bytesRelayed
            )
          }
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

      if (this.config.transports && this.config.transports.tor) {
        const torOpts = this.config.tor || {}
        this.torTransport = new TorTransport({
          socksHost: torOpts.socksHost,
          socksPort: torOpts.socksPort,
          controlHost: torOpts.controlHost,
          controlPort: torOpts.controlPort,
          controlPassword: torOpts.controlPassword,
          cookieAuthFile: torOpts.cookieAuthFile,
          localPort: this.config.apiPort || 9100
        })

        this.torTransport.on('connection', (stream, info) => this._onConnection(stream, info))
        this.torTransport.on('hidden-service', ({ onionAddress }) => {
          this.emit('tor-ready', { onionAddress })
        })
        await this.torTransport.start()
      }

      if (this.config.transports && this.config.transports.holesail) {
        const holesailOpts = this.config.holesail || {}
        const seedBuf = b4a.alloc(32)
        sodium.crypto_generichash(seedBuf, b4a.concat([
          this.swarm.keyPair.secretKey,
          b4a.from('holesail-api-tunnel')
        ]))
        this.holesailTransport = new HolesailTransport({
          apiPort: this.config.apiPort || 9100,
          seed: b4a.toString(seedBuf, 'hex'),
          host: holesailOpts.host || '127.0.0.1'
        })
        this.holesailTransport.on('started', ({ connectionKey }) => {
          this.emit('holesail-ready', { connectionKey })
          if (this.networkDiscovery) {
            this.networkDiscovery.setLocalHolesailKey(connectionKey)
          }
        })
        await this.holesailTransport.start()
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

      // ─── Services Layer ─────────────────────────────────────────────
      if (this.config.enableServices !== false) {
        this.serviceRegistry = new ServiceRegistry()
        this.serviceProtocol = new ServiceProtocol(this.serviceRegistry)

        // Register built-in services
        const storageService = new StorageService({
          policyGuard: this.policyGuard || null,
          getAppTier: (keyHex) => this.seededApps.get(keyHex)?.privacyTier || null
        })
        const identityService = new IdentityService()
        const computeService = new ComputeService()
        const aiService = new AIService()
        const zkService = new ZKService()

        this.serviceRegistry.register(storageService)
        this.serviceRegistry.register(identityService)
        this.serviceRegistry.register(computeService)
        this.serviceRegistry.register(aiService)
        this.serviceRegistry.register(zkService)
        this.serviceRegistry.register(new SLAService())
        this.serviceRegistry.register(new SchemaService())
        this.serviceRegistry.register(new ArbitrationService())

        // Start all services (passes { node: this } as context)
        await this.serviceRegistry.startAll({ node: this, store: this.store, config: this.config })

        // Set up seeded apps callback for catalog broadcast
        this.serviceProtocol._getSeededApps = () => this.appRegistry.catalogForBroadcast()

        this.emit('services-started', { count: this.serviceRegistry.services.size })

        // ─── Application-Layer Router ─────────────────────────────────
        if (this.config.enableRouter !== false) {
          this.router = new Router()
          this.router.registerFromRegistry(this.serviceRegistry)
          await this.router.start()

          // Wire router into service protocol for P2P dispatch
          this.serviceProtocol.router = this.router

          // Bridge relay events to pub/sub
          for (const evt of ['connection', 'connection-closed', 'seeding', 'unseeded', 'circuit-closed', 'seed-accepted']) {
            this.on(evt, (data) => this.router?.pubsub?.publish(`events/${evt}`, data))
          }

          // Broadcast app catalog to clients when apps change
          this.on('seeding', () => this.serviceProtocol?.broadcastAppCatalog())
          this.on('unseeded', () => this.serviceProtocol?.broadcastAppCatalog())

          // Handle incoming app catalogs from other relays — seed missing apps
          this.serviceProtocol.on('app-catalog', ({ apps }) => {
            if (!this.config.enableSeeding || !apps || !Array.isArray(apps)) return
            for (const app of apps) {
              const appKey = app.appKey || app.driveKey
              if (!appKey || this.appRegistry.has(appKey)) continue
              this.seedApp(appKey, {
                appId: app.id || app.appId || null,
                name: app.name || null,
                version: app.version || null,
                blind: app.blind || false,
                author: app.author || null,
                description: app.description || ''
              }).then(() => {
                this.emit('catalog-sync', { appKey, source: 'remote-catalog' })
              }).catch((err) => {
                this.emit('catalog-sync-error', { appKey, error: err.message })
              })
            }
          })

          this.emit('router-started', { routes: this.router.routes().length })
        }
      }

      this._startHealthChecks()

      // Start seeding registry
      if (this.config.enableSeeding) {
        try {
          // Registry uses its own Corestore namespace to avoid conflicts
          const registryStore = this.store.namespace('seeding-registry')
          this.seedingRegistry = new SeedingRegistry(registryStore, this.swarm, {
            registryKey: this.config.registryKey || null
          })
          await this.seedingRegistry.start()

          // Periodic scan for matching seed requests
          const scanInterval = this.config.registryScanInterval || 60_000 // 1 min default
          this._registryScanInterval = setInterval(() => {
            this._scanRegistry().catch((err) => {
              this.emit('registry-error', { error: err })
            })
          }, scanInterval)
          if (this._registryScanInterval.unref) this._registryScanInterval.unref()

          // Run initial scan after a short delay to let the registry sync
          setTimeout(() => {
            this._scanRegistry().catch(() => {})
          }, 5000)
        } catch (err) {
          this.emit('registry-error', { error: err })
          this.seedingRegistry = null
        }
      }

      // Load app registry from disk and reseed all persisted apps
      this._reseedFromRegistry().catch((err) => {
        this.emit('reseed-error', { error: err })
      })

      // Start network discovery — shares this node's swarm to discover other relays
      this.networkDiscovery = new NetworkDiscovery({ swarm: this.swarm })
      this.networkDiscovery.start().catch(() => {})

      this.running = true

      // Start health monitoring and self-healing
      this.healthMonitor = new HealthMonitor(this, this.config.healthMonitor)
      this.selfHeal = new SelfHeal(this, this.config.selfHeal)
      this.selfHeal.start(this.healthMonitor)
      this.healthMonitor.on('health-warning', (details) => this.emit('health-warning', details))
      this.healthMonitor.on('health-critical', (details) => this.emit('health-critical', details))
      this.selfHeal.on('self-heal-action', (action) => this.emit('self-heal-action', action))
      this.healthMonitor.start()

      this.emit('started', { publicKey: this.swarm.keyPair.publicKey })

      // Auto-enable holesail if API is not publicly reachable
      if (!this.holesailTransport && this.config.enableAPI) {
        this._autoEnableHolesail().catch(() => {})
      }
    } catch (err) {
      // Rollback in reverse order
      this.bootstrapCache.stop()
      if (this._reputationSaveInterval) { clearInterval(this._reputationSaveInterval); this._reputationSaveInterval = null }
      if (this._reputationDecayInterval) { clearInterval(this._reputationDecayInterval); this._reputationDecayInterval = null }
      if (this._registryScanInterval) { clearInterval(this._registryScanInterval); this._registryScanInterval = null }
      if (this.seedingRegistry) { try { await this.seedingRegistry.stop() } catch (_) {} this.seedingRegistry = null }
      if (this.settlementInterval) { clearInterval(this.settlementInterval); this.settlementInterval = null }
      if (this.holesailTransport) { try { await this.holesailTransport.stop() } catch (_) {} this.holesailTransport = null }
      if (this.torTransport) { try { await this.torTransport.stop() } catch (_) {} this.torTransport = null }
      if (this.wsTransport) { try { await this.wsTransport.stop() } catch (_) {} this.wsTransport = null }
      if (this.api) { try { await this.api.stop() } catch (_) {} this.api = null }
      if (this.metrics) { this.metrics.stop(); this.metrics = null }
      if (this.relay) { try { await this.relay.stop() } catch (_) {} this.relay = null }
      if (this.seeder) { try { await this.seeder.stop() } catch (_) {} this.seeder = null }
      if (this.swarm) { try { await this.swarm.destroy() } catch (_) {} this.swarm = null }
      this.running = false
      throw err
    }

    return this
  }

  async _reseedFromRegistry () {
    // Load persisted entries — also migrates old seeded-apps.json format
    const entries = await this.appRegistry.load()
    if (!entries.length) {
      // Try migrating from old seeded-apps.json if app-registry.json doesn't exist
      await this._migrateOldSeededApps()
      return
    }

    for (const entry of entries) {
      if (!entry.appKey) continue
      try {
        await this.seedApp(entry.appKey, {
          appId: entry.appId || null,
          version: entry.version || null
        })
        this.emit('reseeded', { appKey: entry.appKey })
      } catch (err) {
        this.emit('reseed-error', { appKey: entry.appKey, error: err })
      }
    }
  }

  /**
   * One-time migration from old seeded-apps.json → unified app-registry.json
   */
  async _migrateOldSeededApps () {
    try {
      const oldPath = join(this.config.storage, 'seeded-apps.json')
      const data = JSON.parse(await readFile(oldPath, 'utf8'))
      const entries = Array.isArray(data) ? data : []
      if (!entries.length) return

      for (const entry of entries) {
        const appKey = entry.appKey
        if (!appKey) continue
        try {
          await this.seedApp(appKey, {
            appId: entry.appId || null,
            version: entry.version || null
          })
          this.emit('reseeded', { appKey, source: 'migration' })
        } catch (err) {
          this.emit('reseed-error', { appKey, error: err })
        }
      }
      // Migration done — registry is now saved in new format
    } catch (_) {
      // No old file — fresh install
    }
  }

  async seedApp (appKeyHex, opts = {}) {
    if (!this.seeder) throw new Error('Seeding not enabled')
    if (!isValidHexKey(appKeyHex)) throw new Error('Invalid app key: must be 64 hex characters')

    // Already seeding this exact key — no-op
    if (this.seededApps.has(appKeyHex)) {
      const existing = this.seededApps.get(appKeyHex)
      return { discoveryKey: b4a.toString(existing.discoveryKey, 'hex'), alreadySeeded: true }
    }

    // Evict oldest app if storage capacity would be exceeded
    if (this.config.enableEviction !== false && this.seeder.totalBytesStored >= this.config.maxStorageBytes && this.seededApps.size > 0) {
      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000
      let oldestKey = null
      let oldestTime = Infinity

      for (const [appKey, entry] of this.seededApps) {
        if (entry.startedAt < oldestTime) {
          oldestTime = entry.startedAt
          oldestKey = appKey
        }
      }

      const shouldEvict = oldestKey && (
        (opts.replicationFactor && opts.replicationFactor > (this.seededApps.get(oldestKey)?.replicationFactor || 1)) ||
        (Date.now() - oldestTime > TWENTY_FOUR_HOURS)
      )

      if (shouldEvict) {
        await this._evictOldestApp()
      } else {
        throw new Error('Storage capacity exceeded and no eligible app to evict')
      }
    }

    const appKey = b4a.from(appKeyHex, 'hex')
    const drive = new Hyperdrive(this.store, appKey)

    try {
      await drive.ready()

      const discoveryKey = drive.discoveryKey

      // Signal that we're looking for peers for this drive's cores
      const done = drive.findingPeers ? drive.findingPeers() : null
      this.swarm.join(discoveryKey, { server: true, client: true })
      this.swarm.flush().then(() => { if (done) done() }).catch(() => { if (done) done() })

      // Eagerly replicate drive content with retry loop
      const eagerReplicate = async () => {
        const MAX_RETRIES = 6
        const RETRY_DELAYS = [5000, 10000, 15000, 30000, 60000, 120000]

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          // Bail out if the drive was closed (e.g. by unseedApp)
          if (drive.closed || drive.closing) return

          try {
            this.swarm.join(discoveryKey, { server: true, client: true })
            await this.swarm.flush()

            if (drive.closed || drive.closing) return

            await Promise.race([
              drive.update({ wait: true }),
              new Promise((_resolve, reject) => setTimeout(() => reject(new Error('update timeout')), 30000))
            ])

            if (drive.version > 0 && !drive.closed && !drive.closing) {
              let dl
              try {
                dl = drive.download('/')
              } catch (_dlErr) {
                // Drive closed between check and download call
                return
              }
              await Promise.race([
                dl.done(),
                new Promise((_resolve, reject) => setTimeout(() => reject(new Error('download timeout')), 120000))
              ]).catch(() => {}) // Swallow download errors (drive may close mid-download)

              if (drive.closed || drive.closing) return

              // After content is downloaded, read manifest and deduplicate
              await this._indexAppManifest(appKeyHex, drive)

              this.emit('reseeded', { appKey: appKeyHex, version: drive.version })
              return
            }
          } catch (_) {
            // SESSION_CLOSED, timeout, or drive closed during replication
            if (drive.closed || drive.closing) return
          }

          if (attempt < MAX_RETRIES - 1) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]))
          }
        }
        this.emit('reseed-error', { appKey: appKeyHex, error: 'max retries exceeded' })
      }
      eagerReplicate().catch(() => {})

      this.appRegistry.set(appKeyHex, {
        drive,
        discoveryKey,
        startedAt: Date.now(),
        bytesServed: 0,
        appId: opts.appId || null,
        version: opts.version || null,
        name: opts.name || opts.appId || null,
        description: opts.description || '',
        author: opts.author || null,
        blind: opts.blind || false,
        publisherPubkey: opts.publisherPubkey || null
      })

      this.emit('seeding', { appKey: appKeyHex, discoveryKey: b4a.toString(discoveryKey, 'hex') })
      return { discoveryKey: b4a.toString(discoveryKey, 'hex') }
    } catch (err) {
      try { await drive.close() } catch (_) {}
      throw err
    }
  }

  /**
   * Read manifest.json from a drive and deduplicate by appId.
   * If an older version of the same app is already seeded, unseed it.
   */
  async _indexAppManifest (appKeyHex, drive) {
    try {
      const manifestBuf = await Promise.race([
        drive.get('/manifest.json'),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('manifest timeout')), 5000))
      ])
      if (!manifestBuf) return

      const manifest = JSON.parse(manifestBuf.toString())
      const appId = manifest.id || (manifest.name ? manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : null)
      if (!appId) return

      const version = manifest.version || '0.0.0'

      // Update this entry's metadata via the registry
      this.appRegistry.update(appKeyHex, {
        appId,
        version,
        name: manifest.name || appId,
        description: manifest.description || '',
        author: manifest.author || null,
        categories: manifest.categories || null
      })

      // Check for version conflicts with existing apps
      const conflict = this.appRegistry.checkConflict(appId, appKeyHex, version)
      if (conflict.conflict) {
        if (conflict.shouldReplace) {
          this.emit('app-replaced', {
            appId,
            oldKey: conflict.existingKey,
            oldVersion: conflict.existingVersion,
            newKey: appKeyHex,
            newVersion: version
          })
          await this.unseedApp(conflict.existingKey)
        } else {
          this.emit('app-version-rejected', {
            appId,
            rejectedKey: appKeyHex,
            rejectedVersion: version,
            currentKey: conflict.existingKey,
            currentVersion: conflict.existingVersion
          })
          await this.unseedApp(appKeyHex)
        }
      }
    } catch (_) {
      // No manifest or parse error — skip deduplication silently
    }
  }

  async unseedApp (appKeyHex) {
    const entry = this.appRegistry.get(appKeyHex)
    if (!entry) return

    try { await this.swarm.leave(entry.discoveryKey) } catch (_) {}
    try { await entry.drive.close() } catch (_) {}
    this.appRegistry.delete(appKeyHex) // auto-cleans dedup index + persists

    this.emit('unseeded', { appKey: appKeyHex })
  }

  /**
   * Authenticated unseed: verify the publisher signature before unseeding.
   * The publisher must sign (appKey + 'unseed' + timestamp) with the key
   * that originally published the app (stored in appRegistry.publisherPubkey).
   *
   * @param {string} appKeyHex - 64-char hex app key
   * @param {string} publisherPubkeyHex - 64-char hex publisher public key
   * @param {string} signatureHex - 128-char hex Ed25519 signature
   * @param {number} timestamp - Unix timestamp (ms) included in the signed payload
   * @returns {{ ok: boolean, error?: string }}
   */
  verifyUnseedRequest (appKeyHex, publisherPubkeyHex, signatureHex, timestamp) {
    const entry = this.appRegistry.get(appKeyHex)
    if (!entry) return { ok: false, error: 'APP_NOT_FOUND' }

    // Verify the publisher key matches the one that seeded the app
    if (entry.publisherPubkey && entry.publisherPubkey !== publisherPubkeyHex) {
      return { ok: false, error: 'PUBLISHER_MISMATCH' }
    }

    // If no publisher was stored (legacy app), accept any valid signature
    // but log a warning — operators can tighten this later
    if (!entry.publisherPubkey) {
      this.emit('unseed-warning', {
        appKey: appKeyHex,
        reason: 'No publisher pubkey on record — accepting any valid signature'
      })
    }

    // Check timestamp freshness (reject if older than 5 minutes)
    const age = Date.now() - timestamp
    if (age > 5 * 60 * 1000 || age < -60_000) {
      return { ok: false, error: 'STALE_TIMESTAMP' }
    }

    // Verify Ed25519 signature over (appKey + 'unseed' + timestamp)
    const appKeyBuf = b4a.from(appKeyHex, 'hex')
    const pubkeyBuf = b4a.from(publisherPubkeyHex, 'hex')
    const sigBuf = b4a.from(signatureHex, 'hex')

    const tsBuf = b4a.alloc(8)
    const tsView = new DataView(tsBuf.buffer, tsBuf.byteOffset)
    tsView.setBigUint64(0, BigInt(timestamp))

    const payload = b4a.concat([appKeyBuf, b4a.from('unseed'), tsBuf])
    const valid = sodium.crypto_sign_verify_detached(sigBuf, payload, pubkeyBuf)

    if (!valid) return { ok: false, error: 'INVALID_SIGNATURE' }
    return { ok: true }
  }

  /**
   * Broadcast an unseed request to all connected peers via P2P.
   */
  broadcastUnseed (appKeyHex, publisherPubkeyHex, signatureHex, timestamp) {
    if (!this._seedProtocol) return
    this._seedProtocol.publishUnseedRequest(
      b4a.from(appKeyHex, 'hex'),
      b4a.from(publisherPubkeyHex, 'hex'),
      b4a.from(signatureHex, 'hex'),
      timestamp
    )
  }

  getStats () {
    return {
      running: this.running,
      publicKey: this.swarm ? b4a.toString(this.swarm.keyPair.publicKey, 'hex') : null,
      seededApps: this.seededApps.size,
      connections: this.swarm ? this.swarm.connections.size : 0,
      relay: this.relay ? this.relay.getStats() : null,
      seeder: this.seeder ? this.seeder.getStats() : null,
      tor: this.torTransport ? this.torTransport.getInfo() : null,
      holesail: this.holesailTransport ? this.holesailTransport.getInfo() : null,
      reputation: {
        trackedRelays: this.reputation ? Object.keys(this.reputation.export()).length : 0
      },
      registry: {
        running: this.seedingRegistry ? this.seedingRegistry.running : false,
        key: this.seedingRegistry && this.seedingRegistry.key
          ? b4a.toString(this.seedingRegistry.key, 'hex')
          : null
      }
    }
  }

  getLeaderboard (limit = 50) {
    return this.reputation ? this.reputation.getLeaderboard(limit) : []
  }

  getHealthStatus () {
    return this.healthMonitor ? this.healthMonitor.getStatus() : null
  }

  /**
   * Auto-enable holesail if the API port is not publicly reachable.
   * Waits for the first peer connection to learn our public IP, then
   * probes our own API. If unreachable, starts the holesail transport.
   */
  async _autoEnableHolesail () {
    // Wait a bit for connections and public IP discovery
    await new Promise(resolve => setTimeout(resolve, 15000))

    if (!this.running || this.holesailTransport) return

    // Find our public IP from a connected peer's perspective
    let publicIp = null
    for (const conn of this.swarm.connections) {
      if (conn.rawStream && conn.rawStream.remoteHost) {
        // Our public IP is what the DHT sees — check via swarm
        break
      }
    }

    // Use the swarm's remoteAddress if available
    if (this.swarm.keyPair) {
      try {
        const node = this.swarm.dht || this.swarm._discovery
        if (node && node.host) publicIp = node.host
      } catch {}
    }

    // Fallback: try a quick external IP check
    if (!publicIp) {
      try {
        const data = await new Promise((resolve, reject) => {
          const req = http.get('http://ifconfig.me/ip', { timeout: 5000 }, (res) => {
            let body = ''
            res.on('data', (c) => { body += c })
            res.on('end', () => resolve(body.trim()))
          })
          req.on('error', reject)
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
        })
        if (data && /^\d+\.\d+\.\d+\.\d+$/.test(data)) publicIp = data
      } catch {}
    }

    if (!publicIp) return // can't determine, skip auto-detect

    // Try to reach our own API from the public IP
    const apiPort = this.config.apiPort || 9100
    const reachable = await new Promise((resolve) => {
      const req = http.get(`http://${publicIp}:${apiPort}/health`, { timeout: 5000 }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          try {
            const d = JSON.parse(body)
            resolve(d.ok === true)
          } catch { resolve(false) }
        })
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => { req.destroy(); resolve(false) })
    })

    if (reachable) {
      this.emit('nat-check', { publicIp, reachable: true })
      return // API is publicly reachable, no need for holesail
    }

    // API is behind NAT — auto-enable holesail
    this.emit('nat-check', { publicIp, reachable: false, action: 'enabling holesail' })

    const holesailOpts = this.config.holesail || {}
    const seedBuf = b4a.alloc(32)
    sodium.crypto_generichash(seedBuf, b4a.concat([
      this.swarm.keyPair.secretKey,
      b4a.from('holesail-api-tunnel')
    ]))
    this.holesailTransport = new HolesailTransport({
      apiPort,
      seed: b4a.toString(seedBuf, 'hex'),
      host: holesailOpts.host || '127.0.0.1'
    })
    this.holesailTransport.on('started', ({ connectionKey }) => {
      this.emit('holesail-ready', { connectionKey })
      if (this.networkDiscovery) {
        this.networkDiscovery.setLocalHolesailKey(connectionKey)
      }
    })
    await this.holesailTransport.start()
  }

  async _loadOrCreateKeyPair () {
    const keyPath = join(this.config.storage, 'relay-identity.json')
    try {
      const data = JSON.parse(await readFile(keyPath, 'utf8'))
      return {
        publicKey: b4a.from(data.publicKey, 'hex'),
        secretKey: b4a.from(data.secretKey, 'hex')
      }
    } catch (_) {
      // First run — generate and persist a new keypair
      const publicKey = b4a.alloc(32)
      const secretKey = b4a.alloc(64)
      sodium.crypto_sign_keypair(publicKey, secretKey)
      await mkdir(this.config.storage, { recursive: true })
      await writeFile(keyPath, JSON.stringify({
        publicKey: b4a.toString(publicKey, 'hex'),
        secretKey: b4a.toString(secretKey, 'hex')
      }, null, 2))
      await chmod(keyPath, 0o600)
      return { publicKey, secretKey }
    }
  }

  async _evictOldestApp () {
    let oldestKey = null
    let oldestTime = Infinity

    for (const [appKey, entry] of this.seededApps) {
      if (entry.startedAt < oldestTime) {
        oldestTime = entry.startedAt
        oldestKey = appKey
      }
    }

    if (!oldestKey) return null

    await this.unseedApp(oldestKey)
    this.emit('evicted', { appKey: oldestKey, reason: 'storage full' })
    return oldestKey
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
    if (this._proofOfRelay) {
      try { this._proofOfRelay.attach(conn) } catch (err) {
        this.emit('protocol-error', { protocol: 'proof', error: err })
      }
    }
    if (this.serviceProtocol) {
      try {
        const remotePubKeyHex = conn.remotePublicKey
          ? b4a.toString(conn.remotePublicKey, 'hex')
          : null
        if (remotePubKeyHex) {
          this.serviceProtocol.attach(conn, remotePubKeyHex)
        }
      } catch (err) {
        this.emit('protocol-error', { protocol: 'services', error: err })
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

  async _scanRegistry () {
    if (!this.seedingRegistry || !this.seeder) return

    const region = (this.config.regions && this.config.regions[0]) || null
    const availableBytes = this.config.maxStorageBytes - (this.seeder.totalBytesStored || 0)
    const autoAccept = this.config.registryAutoAccept !== false

    const requests = await this.seedingRegistry.getActiveRequests({
      region,
      maxStorageBytes: availableBytes
    })

    const myPubkey = this.swarm ? b4a.toString(this.swarm.keyPair.publicKey, 'hex') : null

    for (const req of requests) {
      // Skip if we already seed this app
      if (this.seededApps.has(req.appKey)) continue

      // Check if we already accepted this one
      const relays = await this.seedingRegistry.getRelaysForApp(req.appKey)
      const alreadyAccepted = relays.some(r => r.relayPubkey === myPubkey)
      if (alreadyAccepted) {
        // If we accepted before but aren't currently seeding (e.g. after restart), re-seed
        if (!this.seededApps.has(req.appKey)) {
          try {
            await this.seedApp(req.appKey)
            this.emit('reseeded', { appKey: req.appKey, source: 'registry' })
          } catch (err) {
            this.emit('registry-error', { appKey: req.appKey, error: err })
          }
        }
        continue
      }

      // Check if replication factor is already met
      if (relays.length >= req.replicationFactor) continue

      // Check storage capacity
      if (req.maxStorageBytes > 0 && req.maxStorageBytes > availableBytes) continue

      if (autoAccept) {
        // Auto-accept: seed immediately
        try {
          const publisherHex = req.publisherPubkey ? b4a.toString(req.publisherPubkey, 'hex') : null
          await this.seedApp(req.appKey, { publisherPubkey: publisherHex })
          await this.seedingRegistry.recordAcceptance(
            req.appKey,
            myPubkey,
            region || 'unknown'
          )
          this.emit('registry-seed-accepted', {
            appKey: req.appKey,
            publisher: req.publisherPubkey,
            replicationFactor: req.replicationFactor,
            currentRelays: relays.length + 1
          })
        } catch (err) {
          this.emit('registry-error', { appKey: req.appKey, error: err })
        }
      } else {
        // Approval mode: queue for operator review
        if (!this._pendingRequests.has(req.appKey)) {
          this._pendingRequests.set(req.appKey, {
            ...req,
            currentRelays: relays.length,
            discoveredAt: Date.now()
          })
          this.emit('registry-pending', { appKey: req.appKey, publisher: req.publisherPubkey })
        }
      }
    }
  }

  async approveRequest (appKeyHex) {
    const req = this._pendingRequests.get(appKeyHex)
    if (!req) throw new Error('No pending request for this app key')

    const region = (this.config.regions && this.config.regions[0]) || null
    const myPubkey = this.swarm ? b4a.toString(this.swarm.keyPair.publicKey, 'hex') : null

    await this.seedApp(appKeyHex)
    if (this.seedingRegistry) {
      await this.seedingRegistry.recordAcceptance(appKeyHex, myPubkey, region || 'unknown')
    }
    this._pendingRequests.delete(appKeyHex)
    this.emit('registry-seed-accepted', { appKey: appKeyHex, publisher: req.publisherPubkey })
  }

  rejectRequest (appKeyHex) {
    this._pendingRequests.delete(appKeyHex)
  }

  _onUnseedRequest (msg) {
    const appKeyHex = b4a.toString(msg.appKey, 'hex')
    const publisherHex = b4a.toString(msg.publisherPubkey, 'hex')
    const sigHex = b4a.toString(msg.publisherSignature, 'hex')

    const result = this.verifyUnseedRequest(appKeyHex, publisherHex, sigHex, msg.timestamp)
    if (!result.ok) {
      this.emit('unseed-rejected', { appKey: appKeyHex, reason: result.error })
      return
    }

    this.unseedApp(appKeyHex).then(() => {
      this.emit('unseed-accepted', { appKey: appKeyHex, publisher: publisherHex })
    }).catch((err) => {
      this.emit('unseed-error', { appKey: appKeyHex, error: err })
    })
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
      (this.config.regions && this.config.regions[0]) || 'unknown',
      availableBytes
    )

    // Seed the app via AppRegistry (creates Hyperdrive + registers properly)
    const publisherHex = msg.publisherPubkey ? b4a.toString(msg.publisherPubkey, 'hex') : null
    this.seedApp(appKeyHex, { publisherPubkey: publisherHex }).catch((err) => {
      this.emit('seed-error', { appKey: appKeyHex, error: err })
    })

    // Also seed any additional discovery keys
    for (const dk of (msg.discoveryKeys || [])) {
      const keyHex = b4a.toString(dk, 'hex')
      if (keyHex !== appKeyHex) {
        this.seeder.seedCore(keyHex).catch((err) => {
          this.emit('seed-error', { appKey: appKeyHex, core: keyHex, error: err })
        })
      }
    }

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
    try { await this.bootstrapCache.save() } catch (_) {}

    // Stop health checks, settlement, WebSocket, API, and metrics first
    if (this.selfHeal) { this.selfHeal.stop(); this.selfHeal = null }
    if (this.healthMonitor) { this.healthMonitor.stop(); this.healthMonitor = null }
    if (this._healthCheckInterval) { clearInterval(this._healthCheckInterval); this._healthCheckInterval = null }
    if (this.settlementInterval) { clearInterval(this.settlementInterval); this.settlementInterval = null }
    if (this.holesailTransport) {
      try { await withTimeout(this.holesailTransport.stop(), timeout, 'holesailTransport.stop') } catch (_) {}
      this.holesailTransport = null
    }
    if (this.torTransport) {
      try { await withTimeout(this.torTransport.stop(), timeout, 'torTransport.stop') } catch (_) {}
      this.torTransport = null
    }
    if (this.wsTransport) {
      try { await withTimeout(this.wsTransport.stop(), timeout, 'wsTransport.stop') } catch (_) {}
      this.wsTransport = null
    }
    if (this.api) {
      try { await withTimeout(this.api.stop(), timeout, 'api.stop') } catch (_) {}
      this.api = null
    }
    if (this.metrics) { this.metrics.stop(); this.metrics = null }

    // Stop services layer
    if (this.router) {
      try { await withTimeout(this.router.stop(), timeout, 'router.stop') } catch (_) {}
      this.router = null
    }
    if (this.serviceProtocol) {
      try { this.serviceProtocol.destroy() } catch (_) {}
      this.serviceProtocol = null
    }
    if (this.serviceRegistry) {
      try { await this.serviceRegistry.stopAll() } catch (_) {}
      this.serviceRegistry = null
    }

    // Destroy protocol handlers
    if (this._seedProtocol) { this._seedProtocol.destroy(); this._seedProtocol = null }
    if (this._circuitRelay) {
      if (this._circuitRelay.destroy) this._circuitRelay.destroy()
      this._circuitRelay = null
    }
    if (this._registryScanInterval) { clearInterval(this._registryScanInterval); this._registryScanInterval = null }
    if (this.seedingRegistry) { try { await this.seedingRegistry.stop() } catch (_) {} this.seedingRegistry = null }
    if (this.networkDiscovery) { try { await this.networkDiscovery.stop() } catch (_) {} this.networkDiscovery = null }
    if (this._proofOfRelay) { if (this._proofOfRelay.destroy) this._proofOfRelay.destroy(); this._proofOfRelay = null }
    if (this._bandwidthReceipt) { this._bandwidthReceipt.stop(); this._bandwidthReceipt = null }
    if (this._reputationSaveInterval) { clearInterval(this._reputationSaveInterval); this._reputationSaveInterval = null }
    if (this._reputationDecayInterval) { clearInterval(this._reputationDecayInterval); this._reputationDecayInterval = null }
    // Persist reputation before shutdown
    if (this.reputation) {
      try { await this.reputation.save(join(this.config.storage, 'reputation.json')) } catch (_) {}
    }

    // Unseed all apps
    for (const appKeyHex of this.seededApps.keys()) {
      try {
        await withTimeout(this.unseedApp(appKeyHex), timeout, `unseedApp(${appKeyHex.slice(0, 8)})`)
      } catch (_) {}
    }

    if (this.relay) {
      try { await withTimeout(this.relay.stop(), timeout, 'relay.stop') } catch (_) {}
    }
    if (this.seeder) {
      try { await withTimeout(this.seeder.stop(), timeout, 'seeder.stop') } catch (_) {}
    }
    if (this.swarm) {
      try { await withTimeout(this.swarm.destroy(), timeout, 'swarm.destroy') } catch (_) {}
    }
    if (this.store) {
      try { await withTimeout(this.store.close(), timeout, 'store.close') } catch (_) {}
    }

    this.running = false
    this.emit('stopped')
  }
}

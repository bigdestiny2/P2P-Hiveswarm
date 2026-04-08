import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { EventEmitter } from 'events'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { Seeder } from './seeder.js'
import { Relay } from './relay.js'
import { Metrics } from './metrics.js'
import { RelayAPI } from './api.js'
import { WebSocketTransport } from '../../transports/websocket/index.js'
import { TorTransport } from '../../transports/tor/index.js'
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
    this.seededApps = new Map() // appKey hex -> { drive, discoveryKey, startedAt, bytesServed, appId, version, blind }
    this.appIndex = new Map() // appId string -> appKey hex (deduplication index)
    this.appRegistry = new Map() // appId string -> { driveKey, version, name, blind, updatedAt }
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

      // Start seeding registry — distributed Autobase registry for seed requests
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

      // Load persistent app registry (appId → driveKey mapping)
      await this._loadAppRegistry()

      // Re-seed apps from persistent log (survives restarts)
      this._reseedFromLog().catch((err) => {
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
    } catch (err) {
      // Rollback in reverse order
      this.bootstrapCache.stop()
      if (this._reputationSaveInterval) { clearInterval(this._reputationSaveInterval); this._reputationSaveInterval = null }
      if (this._reputationDecayInterval) { clearInterval(this._reputationDecayInterval); this._reputationDecayInterval = null }
      if (this._registryScanInterval) { clearInterval(this._registryScanInterval); this._registryScanInterval = null }
      if (this.seedingRegistry) { try { await this.seedingRegistry.stop() } catch (_) {} this.seedingRegistry = null }
      if (this.settlementInterval) { clearInterval(this.settlementInterval); this.settlementInterval = null }
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

  // ─── Persistent app registry (appId → driveKey, survives publisher storage loss) ───

  async _loadAppRegistry () {
    const regPath = join(this.config.storage, 'app-registry.json')
    try {
      const data = JSON.parse(await readFile(regPath, 'utf8'))
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [appId, entry] of Object.entries(data)) {
          this.appRegistry.set(appId, entry)
        }
      }
    } catch (_) {}
  }

  async _saveAppRegistry () {
    const regPath = join(this.config.storage, 'app-registry.json')
    const obj = {}
    for (const [appId, entry] of this.appRegistry) {
      obj[appId] = entry
    }
    try {
      await writeFile(regPath, JSON.stringify(obj, null, 2))
    } catch (err) {
      this.emit('error', { context: 'app-registry-save', error: err })
    }
  }

  /**
   * Resolve an appId to its canonical driveKey.
   * Returns { driveKey, version, name } or null if unknown.
   */
  resolveApp (appId) {
    return this.appRegistry.get(appId) || null
  }

  async _loadSeededAppsLog () {
    const logPath = join(this.config.storage, 'seeded-apps.json')
    try {
      const data = JSON.parse(await readFile(logPath, 'utf8'))
      return Array.isArray(data) ? data : []
    } catch (_) {
      return []
    }
  }

  async _saveSeededAppsLog () {
    const logPath = join(this.config.storage, 'seeded-apps.json')
    const entries = []
    for (const [appKey, entry] of this.seededApps) {
      entries.push({
        appKey,
        startedAt: entry.startedAt,
        appId: entry.appId || null,
        version: entry.version || null,
        blind: entry.blind || false
      })
    }
    try {
      await writeFile(logPath, JSON.stringify(entries, null, 2))
    } catch (err) {
      this.emit('error', { context: 'seeded-apps-log', error: err })
    }
  }

  async _reseedFromLog () {
    const saved = await this._loadSeededAppsLog()
    if (!saved.length) return

    for (const entry of saved) {
      if (this.seededApps.has(entry.appKey)) continue
      try {
        await this.seedApp(entry.appKey, {
          appId: entry.appId || null,
          version: entry.version || null,
          blind: entry.blind || false
        })
        // Rebuild appIndex from saved metadata
        if (entry.appId) {
          this.appIndex.set(entry.appId, entry.appKey)
        }
        this.emit('reseeded', { appKey: entry.appKey })
      } catch (err) {
        this.emit('reseed-error', { appKey: entry.appKey, error: err })
      }
    }
  }

  async seedApp (appKeyHex, opts = {}) {
    if (!this.seeder) throw new Error('Seeding not enabled')
    if (!isValidHexKey(appKeyHex)) throw new Error('Invalid app key: must be 64 hex characters')

    // If publisher provides an appId, check if we already have a canonical key for it.
    // This handles the case where publisher lost storage and created a new drive key —
    // the relay knows the real key and tells the publisher to use it instead.
    if (opts.appId && this.appRegistry.has(opts.appId)) {
      const registered = this.appRegistry.get(opts.appId)
      if (registered.driveKey !== appKeyHex) {
        // Return the canonical key so publisher can switch to it
        const canonical = registered.driveKey
        if (this.seededApps.has(canonical)) {
          const existing = this.seededApps.get(canonical)
          return {
            discoveryKey: b4a.toString(existing.discoveryKey, 'hex'),
            alreadySeeded: true,
            canonicalKey: canonical,
            message: `App "${opts.appId}" already registered with key ${canonical.slice(0, 12)}... — use this key instead`
          }
        }
      }
    }

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

    const isBlind = opts.blind === true
    const appKey = b4a.from(appKeyHex, 'hex')

    // For blind apps, the relay does NOT have the encryption key.
    // It replicates encrypted ciphertext blocks and serves them over P2P,
    // but cannot read the content. No HTTP gateway access for blind apps.
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
          try {
            this.swarm.join(discoveryKey, { server: true, client: true })
            await this.swarm.flush()

            await Promise.race([
              drive.update({ wait: true }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('update timeout')), 30000))
            ])

            if (drive.version > 0) {
              const dl = drive.download('/')
              await Promise.race([
                dl.done(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('download timeout')), 120000))
              ])

              // Blind apps: relay has ciphertext, skip manifest indexing (can't read it)
              // Public apps: read manifest and deduplicate
              if (!isBlind) {
                await this._indexAppManifest(appKeyHex, drive)
              }

              this.emit('reseeded', { appKey: appKeyHex, version: drive.version, blind: isBlind })
              return
            }
          } catch (_) {}

          if (attempt < MAX_RETRIES - 1) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]))
          }
        }
        this.emit('reseed-error', { appKey: appKeyHex, error: 'max retries exceeded' })
      }
      eagerReplicate().catch(() => {})

      this.seededApps.set(appKeyHex, {
        drive,
        discoveryKey,
        startedAt: Date.now(),
        bytesServed: 0,
        appId: opts.appId || null,
        version: opts.version || null,
        blind: isBlind
      })

      // For blind apps with appId, register them so resolve works (without content data)
      if (isBlind && opts.appId) {
        this.appRegistry.set(opts.appId, {
          driveKey: appKeyHex,
          version: opts.version || null,
          name: opts.appId,
          blind: true,
          updatedAt: Date.now()
        })
        this.appIndex.set(opts.appId, appKeyHex)
        this._saveAppRegistry().catch(() => {})
      }

      this.emit('seeding', { appKey: appKeyHex, discoveryKey: b4a.toString(discoveryKey, 'hex'), blind: isBlind })
      this._saveSeededAppsLog().catch(() => {})
      return { discoveryKey: b4a.toString(discoveryKey, 'hex'), blind: isBlind }
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('manifest timeout')), 5000))
      ])
      if (!manifestBuf) return

      const manifest = JSON.parse(manifestBuf.toString())
      const appId = manifest.id || (manifest.name ? manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : null)
      if (!appId) return

      const version = manifest.version || '0.0.0'

      // Update this entry's metadata
      const entry = this.seededApps.get(appKeyHex)
      if (entry) {
        entry.appId = appId
        entry.version = version
      }

      // Check if we already have a different drive for the same appId
      const existingKey = this.appIndex.get(appId)
      if (existingKey && existingKey !== appKeyHex) {
        const existingEntry = this.seededApps.get(existingKey)
        const existingVersion = existingEntry?.version || '0.0.0'

        // Only replace if new version is >= existing
        if (this._compareVersions(version, existingVersion) >= 0) {
          this.emit('app-replaced', {
            appId,
            oldKey: existingKey,
            oldVersion: existingVersion,
            newKey: appKeyHex,
            newVersion: version
          })

          // Unseed the old version
          await this.unseedApp(existingKey)
        } else {
          // Old version is newer — unseed the one we just added
          this.emit('app-version-rejected', {
            appId,
            rejectedKey: appKeyHex,
            rejectedVersion: version,
            currentKey: existingKey,
            currentVersion: existingVersion
          })
          await this.unseedApp(appKeyHex)
          return
        }
      }

      // Update the appId → key index
      this.appIndex.set(appId, appKeyHex)

      // Persist to app registry (survives publisher storage loss)
      const existingReg = this.appRegistry.get(appId)
      this.appRegistry.set(appId, {
        driveKey: appKeyHex,
        version,
        name: manifest.name || appId,
        blind: existingReg?.blind || false,
        updatedAt: Date.now()
      })
      this._saveAppRegistry().catch(() => {})
      this._saveSeededAppsLog().catch(() => {})
    } catch (_) {
      // No manifest or parse error — skip deduplication silently
    }
  }

  /**
   * Compare semver-like version strings. Returns:
   *   1  if a > b
   *   0  if a == b
   *  -1  if a < b
   */
  _compareVersions (a, b) {
    const pa = (a || '0.0.0').split('.').map(Number)
    const pb = (b || '0.0.0').split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      const na = pa[i] || 0
      const nb = pb[i] || 0
      if (na > nb) return 1
      if (na < nb) return -1
    }
    return 0
  }

  async unseedApp (appKeyHex) {
    const entry = this.seededApps.get(appKeyHex)
    if (!entry) return

    // Clean up the appId → key index
    if (entry.appId && this.appIndex.get(entry.appId) === appKeyHex) {
      this.appIndex.delete(entry.appId)
    }

    try { await this.swarm.leave(entry.discoveryKey) } catch (_) {}
    try { await entry.drive.close() } catch (_) {}
    this.seededApps.delete(appKeyHex)
    this._saveSeededAppsLog().catch(() => {})

    this.emit('unseeded', { appKey: appKeyHex })
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
          await this.seedApp(req.appKey)
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
    try { await this.bootstrapCache.save() } catch (_) {}

    // Stop health checks, settlement, WebSocket, API, and metrics first
    if (this.selfHeal) { this.selfHeal.stop(); this.selfHeal = null }
    if (this.healthMonitor) { this.healthMonitor.stop(); this.healthMonitor = null }
    if (this._healthCheckInterval) { clearInterval(this._healthCheckInterval); this._healthCheckInterval = null }
    if (this.settlementInterval) { clearInterval(this.settlementInterval); this.settlementInterval = null }
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

    // Destroy protocol handlers
    if (this._seedProtocol) { this._seedProtocol.destroy(); this._seedProtocol = null }
    if (this._circuitRelay) {
      if (this._circuitRelay.destroy) this._circuitRelay.destroy()
      this._circuitRelay = null
    }
    if (this._registryScanInterval) { clearInterval(this._registryScanInterval); this._registryScanInterval = null }
    if (this.seedingRegistry) { try { await this.seedingRegistry.stop() } catch (_) {} this.seedingRegistry = null }
    if (this.networkDiscovery) { try { await this.networkDiscovery.stop() } catch (_) {} this.networkDiscovery = null }
    if (this._proofOfRelay) { this._proofOfRelay = null }
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

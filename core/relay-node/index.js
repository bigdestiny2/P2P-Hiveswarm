import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { EventEmitter } from 'events'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { join } from 'path'
import { Seeder } from './seeder.js'
import { Relay } from './relay.js'
import { Metrics } from './metrics.js'
import { RelayAPI } from './api.js'
import { WebSocketTransport } from '../../transports/websocket/index.js'
import { TorTransport } from '../../transports/tor/index.js'
import { HolesailTransport } from '../../transports/holesail/index.js'
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
import { AccessControl } from './access-control.js'
import { MDNSDiscovery } from './mdns-discovery.js'
import { RelayTunnel } from './relay-tunnel.js'
import { ServiceRegistry, ServiceProtocol, StorageService, IdentityService, ComputeService, AIService, SLAService, SchemaService, ArbitrationService } from '../services/index.js'
import { Router } from '../router/index.js'
import { PolicyGuard } from '../policy-guard.js'
import { PaymentManager } from '../../incentive/payment/index.js'
import { MockProvider } from '../../incentive/payment/mock-provider.js'
import { ServiceMeter } from '../../incentive/metering/index.js'
import { FreeTierManager } from '../../incentive/free-tier/index.js'
import { CreditManager } from '../../incentive/credits/index.js'
import { PricingEngine } from '../../incentive/credits/pricing.js'
import { InvoiceManager } from '../../incentive/credits/invoice.js'
import vm from 'node:vm'

// Well-known discovery topic — clients join this to find relay nodes
const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

const VALID_MODES = ['public', 'private', 'hybrid']

const DEFAULT_CONFIG = {
  mode: 'public', // 'public' | 'private' | 'hybrid'
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
  enableEviction: true,
  // Private/hybrid mode settings
  discovery: {
    dht: true, // Join public DHT (public/hybrid: true, private: false)
    announce: true, // Announce on DHT topics (public: true, private/hybrid: false)
    mdns: false, // Broadcast on LAN (private/hybrid: true, public: false)
    explicit: false // Connect to explicit peers only (private: true)
  },
  access: {
    open: true, // Accept connections from anyone (public: true, private/hybrid: false)
    allowlist: [] // Pubkey hex strings of allowed devices (private/hybrid mode)
  },
  pairing: {
    enabled: false, // Enable pairing protocol (private/hybrid mode)
    timeoutMs: 5 * 60 * 1000 // Pairing window duration
  },
  timeouts: {
    driveReady: 15_000,
    driveUpdate: 30_000,
    driveDownload: 120_000,
    manifestRead: 5_000,
    eagerReplicationRetry: 5_000, // Initial retry delay
    eagerReplicationMaxRetry: 120_000 // Max retry delay
  }
}

/**
 * Resolve mode-aware defaults. Mode sets sensible defaults
 * that can still be overridden by explicit config.
 */
function resolveModeConfig (opts) {
  const mode = opts.mode || 'public'
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid mode "${mode}" — must be one of: ${VALID_MODES.join(', ')}`)
  }

  const modeDefaults = {
    public: {
      discovery: { dht: true, announce: true, mdns: false, explicit: false },
      access: { open: true },
      pairing: { enabled: false },
      enableRelay: true,
      enableSeeding: true,
      enableAPI: true
    },
    private: {
      discovery: { dht: false, announce: false, mdns: true, explicit: true },
      access: { open: false },
      pairing: { enabled: true },
      enableRelay: false,
      enableSeeding: true,
      enableAPI: false,
      enableMetrics: false
    },
    hybrid: {
      discovery: { dht: true, announce: false, mdns: true, explicit: true },
      access: { open: false },
      pairing: { enabled: true },
      enableRelay: false,
      enableSeeding: true,
      enableAPI: true
    }
  }

  const defaults = modeDefaults[mode]

  // Merge: DEFAULT_CONFIG < mode defaults < explicit opts
  const config = { ...DEFAULT_CONFIG, ...defaults, ...opts }

  // Deep merge nested objects
  config.discovery = { ...DEFAULT_CONFIG.discovery, ...defaults.discovery, ...(opts.discovery || {}) }
  config.access = { ...DEFAULT_CONFIG.access, ...defaults.access, ...(opts.access || {}) }
  config.pairing = { ...DEFAULT_CONFIG.pairing, ...defaults.pairing, ...(opts.pairing || {}) }
  config.timeouts = { ...DEFAULT_CONFIG.timeouts, ...(opts.timeouts || {}) }

  return config
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

function getTimeout (config, key) {
  return config.timeouts?.[key] ?? DEFAULT_CONFIG.timeouts[key]
}

function exponentialBackoffDelay (attempt, baseDelay, maxDelay) {
  return Math.min(baseDelay * Math.pow(2, attempt), maxDelay)
}

export class RelayNode extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.config = resolveModeConfig(opts)
    this.mode = this.config.mode
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
    this.router = null
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
    this._seedLocks = new Map() // appKey hex -> Promise (per-key locking for seedApp)

    // Policy enforcement (fail-safe guardrail)
    this.policyGuard = new PolicyGuard()
    this.policyGuard.on('violation', (v) => this.emit('policy-violation', v))

    // Services layer
    this.serviceRegistry = null
    this.serviceProtocol = null

    // Relay tunnel (private/hybrid remote access)
    this.relayTunnel = null

    // Private/hybrid mode: access control + local discovery
    this.accessControl = null
    this.mdnsDiscovery = null
    this._rejectedConnections = 0

    this.running = false
  }

  /**
   * Acquire a per-key lock for seedApp operations
   * Prevents race conditions when multiple concurrent calls target the same appKey
   */
  async _acquireSeedLock (appKeyHex) {
    // Wait for any existing lock on this key
    while (this._seedLocks.has(appKeyHex)) {
      try {
        await this._seedLocks.get(appKeyHex)
      } catch {
        // Previous operation failed, we can try to acquire
      }
    }

    // Create a new lock
    let release
    const lock = new Promise((resolve) => {
      release = resolve
    })
    this._seedLocks.set(appKeyHex, lock)
    return release
  }

  async start () {
    if (this.running) return

    try {
      // Re-create store if it was closed (e.g. after self-heal restart)
      if (this.store.closed) {
        this.store = new Corestore(this.config.storage)
      }
      await this.store.ready()

      // ─── Access Control (private/hybrid mode) ───
      if (!this.config.access.open) {
        this.accessControl = new AccessControl(this.config.storage, {
          maxDevices: this.config.access.maxDevices || 50
        })
        await this.accessControl.load()

        // Pre-load allowlist from config
        if (Array.isArray(this.config.access.allowlist)) {
          for (const pubkey of this.config.access.allowlist) {
            if (!this.accessControl.isAllowed(pubkey)) {
              await this.accessControl.addDevice(pubkey, 'config-preset')
            }
          }
        }

        this.accessControl.on('device-added', (info) => this.emit('device-paired', info))
        this.accessControl.on('device-removed', (info) => this.emit('device-removed', info))
        this.accessControl.on('pairing-success', (info) => this.emit('pairing-success', info))
        this.accessControl.on('pairing-rejected', (info) => this.emit('pairing-rejected', info))
      }

      await this.bootstrapCache.load()

      // In private mode, use empty bootstrap to avoid contacting public DHT
      const useDHT = this.config.discovery.dht
      const bootstrap = useDHT
        ? this.bootstrapCache.merge(this.config.bootstrapNodes)
        : []

      const keyPair = await this._loadOrCreateKeyPair()

      this.swarm = new Hyperswarm({
        bootstrap,
        keyPair,
        maxConnections: this.config.maxConnections
      })

      if (useDHT) {
        this.bootstrapCache.start(this.swarm)
      }
      this.swarm.on('connection', (conn, info) => this._onConnection(conn, info))

      // Only announce on discovery topic in public mode
      if (this.config.discovery.announce) {
        this.swarm.join(RELAY_DISCOVERY_TOPIC, { server: true, client: false })
      }

      // ─── mDNS LAN Discovery (private/hybrid mode) ───
      if (this.config.discovery.mdns) {
        this.mdnsDiscovery = new MDNSDiscovery({
          publicKey: keyPair.publicKey,
          port: 0, // Updated after swarm.listen() completes
          mode: this.mode,
          name: this.config.name || 'hiverelay'
        })
        this.mdnsDiscovery.on('peer-discovered', (peer) => {
          this.emit('lan-peer-discovered', peer)
        })
        this.mdnsDiscovery.on('error', (err) => {
          this.emit('mdns-error', { error: err.message })
        })
        // Start mDNS after swarm is listening so we have the correct port
        this.swarm.listen().then(() => {
          if (this.mdnsDiscovery && this.swarm) {
            const addr = this.swarm.dht ? this.swarm.dht.address() : null
            if (addr) this.mdnsDiscovery.port = addr.port
            this.mdnsDiscovery.start().catch(err => {
              this.emit('mdns-error', { error: err.message })
            })
          }
        }).catch(() => {})
      }

      // ─── Relay Tunnel (private/hybrid remote access) ───
      if (this.config.tunnel && this.config.tunnel.relayPubkey) {
        this.relayTunnel = new RelayTunnel({
          relayPubkey: this.config.tunnel.relayPubkey,
          keyPair,
          reconnectInterval: this.config.tunnel.reconnectInterval || 30_000
        })
        this.relayTunnel.on('connected', (info) => this.emit('tunnel-connected', info))
        this.relayTunnel.on('disconnected', (info) => this.emit('tunnel-disconnected', info))
        this.relayTunnel.on('error', (info) => this.emit('tunnel-error', info))
        this.relayTunnel.on('reconnecting', (info) => this.emit('tunnel-reconnecting', info))
        this.relayTunnel.start().catch(err => {
          this.emit('tunnel-error', { error: err.message })
        })
      }

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
      } catch (err) {
        this.emit('reputation-load-error', { error: err.message, path: reputationPath })
        this.reputation = new ReputationSystem()
      }

      // Daily reputation decay (run hourly, decay is multiplicative)
      this._reputationDecayInterval = setInterval(() => {
        this.reputation.applyDecay()
      }, 60 * 60 * 1000)
      if (this._reputationDecayInterval.unref) this._reputationDecayInterval.unref()

      // Periodic reputation save every 5 minutes
      this._reputationSaveInterval = setInterval(() => {
        this.reputation.save(reputationPath).catch(err => {
          this.emit('reputation-save-error', { error: err.message })
        })
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
        this.holesailTransport = new HolesailTransport({
          port: holesailOpts.port || this.config.apiPort || 9100,
          host: holesailOpts.host || '127.0.0.1',
          seed: holesailOpts.seed || null,
          secure: holesailOpts.secure || false,
          udp: holesailOpts.udp || false,
          connectorMode: holesailOpts.connectorMode || false,
          maxConnections: this.config.maxConnections
        })

        if (holesailOpts.connectorMode) {
          this.holesailTransport.on('connection', (stream, info) => this._onConnection(stream, info))
        }

        this.holesailTransport.on('started', (info) => {
          this.emit('holesail-ready', info)
        })

        await this.holesailTransport.start()
      }

      if (this.config.payment && this.config.payment.enabled) {
        // Use injected manager, or create one with appropriate provider
        if (this.config.paymentManager) {
          this.paymentManager = this.config.paymentManager
        } else {
          let provider
          if (this.config.lightning && this.config.lightning.enabled) {
            try {
              const { LightningProvider } = await import('../../incentive/payment/lightning-provider.js')
              provider = new LightningProvider({
                rpcUrl: this.config.lightning.rpcUrl,
                macaroonPath: this.config.lightning.macaroonPath,
                certPath: this.config.lightning.certPath,
                network: this.config.lightning.network || 'mainnet'
              })
              await provider.connect()
              this.emit('lightning-connected', await provider.getInfo())
            } catch (err) {
              this.emit('lightning-error', { error: err.message })
              provider = new MockProvider()
              await provider.connect()
              this.emit('payment-fallback', { reason: 'Lightning unavailable, using mock provider' })
            }
          } else {
            provider = new MockProvider()
            await provider.connect()
          }
          this.paymentManager = new PaymentManager({ paymentProvider: provider })
        }

        // Register this relay as an account
        const selfPubkey = this.keyPair ? b4a.toString(this.keyPair.publicKey, 'hex') : 'self'
        this.paymentManager.registerRelay(selfPubkey, selfPubkey)

        // Settlement interval
        const interval = this.config.payment.settlementInterval || 24 * 60 * 60 * 1000
        this.settlementInterval = setInterval(() => {
          this._runSettlements().catch((err) => {
            this.emit('settlement-error', { error: err })
          })
        }, interval)

        this.emit('payment-ready', {
          provider: this.paymentManager.paymentProvider?.constructor.name || 'injected',
          selfAccount: selfPubkey
        })
      }

      // ─── Services Layer ───
      if (this.config.enableServices !== false) {
        this.serviceRegistry = new ServiceRegistry()
        this.serviceProtocol = new ServiceProtocol(this.serviceRegistry)

        // Register built-in services (core only — zk, ai are opt-in via config.services)
        const storageService = new StorageService({
          policyGuard: this.policyGuard,
          getAppTier: (keyHex) => this.seededApps.get(keyHex)?.privacyTier || null
        })
        const identityService = new IdentityService()
        const computeService = new ComputeService()
        computeService.registerHandler('js', (input) => {
          const ctx = vm.createContext({ input: input.data })
          return vm.runInContext(input.code, ctx, { timeout: input.timeout || 5000 })
        })

        this.serviceRegistry.register(storageService)
        this.serviceRegistry.register(identityService)
        this.serviceRegistry.register(computeService)
        this.serviceRegistry.register(new SLAService())
        this.serviceRegistry.register(new SchemaService())
        this.serviceRegistry.register(new ArbitrationService())

        // ─── AI Service (opt-in via config or CLI) ───
        if (this.config.ai?.enabled) {
          const aiService = new AIService({
            maxConcurrent: this.config.ai.maxConcurrent || 2,
            maxQueue: this.config.ai.maxQueue || 100
          })
          this.serviceRegistry.register(aiService)

          // Auto-register Ollama models if endpoint configured
          const ollamaUrl = this.config.ai.ollamaUrl || 'http://localhost:11434'
          if (this.config.ai.models?.length) {
            for (const modelId of this.config.ai.models) {
              await aiService['register-model']({
                modelId,
                type: 'llm',
                endpoint: ollamaUrl,
                config: { format: 'ollama', timeout: this.config.ai.timeout || 120_000 }
              })
            }
            this.emit('ai-ready', { models: this.config.ai.models, endpoint: ollamaUrl })
          }
        }

        // Register any custom services from config
        if (Array.isArray(this.config.services)) {
          for (const svc of this.config.services) {
            this.serviceRegistry.register(svc)
          }
        }

        await this.serviceRegistry.startAll({ node: this, store: this.store, config: this.config })
        this.emit('services-started', { count: this.serviceRegistry.services.size })

        // ─── Credit System + Metering + Free Tier ───
        this.pricingEngine = new PricingEngine(this.config.pricing || {})
        this.serviceMeter = new ServiceMeter(this.config.metering || {})

        const creditsStoragePath = this.config.credits?.storagePath ||
          (this.config.storage ? join(this.config.storage, 'credits.json') : null)
        this.creditManager = new CreditManager({
          storagePath: creditsStoragePath,
          ...(this.config.credits || {})
        })
        await this.creditManager.load()

        this.freeTier = new FreeTierManager({
          freeLimits: this.config.freeTier?.limits,
          whitelist: this.config.freeTier?.whitelist,
          creditManager: this.creditManager
        })

        // Invoice manager for Lightning credit purchases
        const invoiceProvider = this.paymentManager?.paymentProvider || null
        this.invoiceManager = new InvoiceManager({
          provider: invoiceProvider,
          creditManager: this.creditManager,
          expiryMs: this.config.credits?.invoiceExpiryMs
        })
        this.invoiceManager.start()

        // Grant relay operator welcome credits if this is a fresh node
        if (this.publicKey) {
          const opKey = this.publicKey.toString('hex')
          const existing = this.creditManager.wallets.get(opKey)
          if (!existing) {
            this.creditManager.getOrCreateWallet(opKey)
            this.emit('operator-credits', {
              publicKey: opKey,
              credits: this.creditManager.welcomeCredits
            })
          }
        }

        this.emit('credits-ready', {
          wallets: this.creditManager.wallets.size,
          welcomeCredits: this.creditManager.welcomeCredits,
          rateCard: Object.keys(this.pricingEngine.rates).length
        })

        // ─── Application-Layer Router ───
        if (this.config.enableRouter !== false) {
          this.router = new Router({
            registry: this.serviceRegistry,
            workers: this.config.routerWorkers ?? 0
          })
          this.router.registerFromRegistry(this.serviceRegistry)

          // Metering + quota + credit deduction middleware
          const meter = this.serviceMeter
          const freeTier = this.freeTier
          const credits = this.creditManager
          const pricing = this.pricingEngine
          this.router.addMiddleware((route, params, context) => {
            const appKey = context.remotePubkey || context.appKey || 'anonymous'

            // Check free-tier quota (auto-promotes apps with credits to standard)
            const quota = freeTier.check(appKey, route, meter)
            if (!quota.allowed) {
              throw new Error(quota.reason)
            }

            // Calculate cost for this call
            const price = pricing.calculate(route, params)

            // Deduct credits if the app has a wallet and the route costs something
            if (price.cost > 0 && credits.getBalance(appKey) > 0) {
              const result = credits.deduct(appKey, price.cost, route, {
                inputTokens: params.inputTokens,
                outputTokens: params.outputTokens
              })
              if (!result.success) {
                // Fall through to free tier — don't block, just don't charge
              }
            }

            // Record usage (metering always runs — for analytics + relay earnings)
            meter.record(appKey, route)
            return true
          })

          await this.router.start()

          // Wire router into service protocol for P2P dispatch
          this.serviceProtocol.router = this.router

          // Bridge relay events to pub/sub
          for (const evt of ['connection', 'connection-closed', 'seeding', 'unseeded', 'circuit-closed', 'seed-accepted', 'seed-rejected']) {
            this.on(evt, (data) => this.router.pubsub.publish(`events/${evt}`, data))
          }

          this.emit('router-started', { routes: this.router.routes().length })
        }
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
            this._scanRegistry().catch(err => {
              this.emit('registry-scan-error', { error: err.message })
            })
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
      this.networkDiscovery.start().catch(err => {
        this.emit('network-discovery-error', { error: err.message })
      })

      this.running = true

      // Start health monitoring and self-healing
      this.healthMonitor = new HealthMonitor(this, {
        diskCheckPath: this.config.storage,
        alertWebhookUrl: this.config.alertWebhookUrl || null,
        ...this.config.healthMonitor
      })
      this.selfHeal = new SelfHeal(this, this.config.selfHeal)
      this.selfHeal.start(this.healthMonitor)
      this.healthMonitor.on('health-warning', (details) => this.emit('health-warning', details))
      this.healthMonitor.on('health-critical', (details) => this.emit('health-critical', details))
      this.healthMonitor.on('alert', (alert) => this.emit('alert', alert))
      this.selfHeal.on('self-heal-action', (action) => this.emit('self-heal-action', action))
      this.healthMonitor.start()

      this.emit('started', { publicKey: this.swarm.keyPair.publicKey })
    } catch (err) {
      // Rollback in reverse order
      this.bootstrapCache.stop()
      if (this._reputationSaveInterval) { clearInterval(this._reputationSaveInterval); this._reputationSaveInterval = null }
      if (this._reputationDecayInterval) { clearInterval(this._reputationDecayInterval); this._reputationDecayInterval = null }
      if (this._registryScanInterval) { clearInterval(this._registryScanInterval); this._registryScanInterval = null }
      if (this.router) { try { await this.router.stop() } catch (err) { this.emit('stop-error', { component: 'router', error: err.message }) } this.router = null }
      if (this.serviceProtocol) { try { this.serviceProtocol.destroy() } catch (err) { this.emit('stop-error', { component: 'serviceProtocol', error: err.message }) } this.serviceProtocol = null }
      if (this.serviceRegistry) { try { await this.serviceRegistry.stopAll() } catch (err) { this.emit('stop-error', { component: 'serviceRegistry', error: err.message }) } this.serviceRegistry = null }
      if (this.seedingRegistry) { try { await this.seedingRegistry.stop() } catch (err) { this.emit('stop-error', { component: 'seedingRegistry', error: err.message }) } this.seedingRegistry = null }
      if (this.settlementInterval) { clearInterval(this.settlementInterval); this.settlementInterval = null }
      if (this.torTransport) { try { await this.torTransport.stop() } catch (err) { this.emit('stop-error', { component: 'torTransport', error: err.message }) } this.torTransport = null }
      if (this.wsTransport) { try { await this.wsTransport.stop() } catch (err) { this.emit('stop-error', { component: 'wsTransport', error: err.message }) } this.wsTransport = null }
      if (this.api) { try { await this.api.stop() } catch (err) { this.emit('stop-error', { component: 'api', error: err.message }) } this.api = null }
      if (this.metrics) { this.metrics.stop(); this.metrics = null }
      if (this.relay) { try { await this.relay.stop() } catch (err) { this.emit('stop-error', { component: 'relay', error: err.message }) } this.relay = null }
      if (this.seeder) { try { await this.seeder.stop() } catch (err) { this.emit('stop-error', { component: 'seeder', error: err.message }) } this.seeder = null }
      if (this.swarm) { try { await this.swarm.destroy() } catch (err) { this.emit('stop-error', { component: 'swarm', error: err.message }) } this.swarm = null }
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
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.emit('registry-load-error', { error: err.message, path: regPath })
      }
    }
  }

  async _saveAppRegistry () {
    const regPath = join(this.config.storage, 'app-registry.json')
    const tmpPath = regPath + '.tmp'
    const obj = {}
    for (const [appId, entry] of this.appRegistry) {
      obj[appId] = entry
    }
    try {
      await writeFile(tmpPath, JSON.stringify(obj, null, 2))
      await rename(tmpPath, regPath)
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
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.emit('seeded-log-load-error', { error: err.message, path: logPath })
      }
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
      const tmpPath = logPath + '.tmp'
      await writeFile(tmpPath, JSON.stringify(entries, null, 2))
      await rename(tmpPath, logPath)
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
    appKeyHex = appKeyHex.toLowerCase()

    // Acquire per-key lock to prevent race conditions
    const releaseLock = await this._acquireSeedLock(appKeyHex)

    try {
      return await this._seedAppInternal(appKeyHex, opts)
    } finally {
      this._seedLocks.delete(appKeyHex)
      releaseLock()
    }
  }

  async _seedAppInternal (appKeyHex, opts = {}) {
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
            discoveryKey: existing.discoveryKey ? b4a.toString(existing.discoveryKey, 'hex') : null,
            alreadySeeded: true,
            canonicalKey: canonical,
            blind: existing.blind || false,
            message: `App "${opts.appId}" already registered with key ${canonical.slice(0, 12)}... — use this key instead`
          }
        }
      }
    }

    // Already seeding this exact key — no-op
    if (this.seededApps.has(appKeyHex)) {
      const existing = this.seededApps.get(appKeyHex)
      return {
        discoveryKey: existing.discoveryKey ? b4a.toString(existing.discoveryKey, 'hex') : null,
        alreadySeeded: true,
        blind: existing.blind || false
      }
    }

    // Cap blind registrations to prevent registry flooding
    if (opts.blind) {
      const maxBlind = this.config.maxBlindApps || 500
      let blindCount = 0
      for (const entry of this.seededApps.values()) {
        if (entry.blind) blindCount++
      }
      if (blindCount >= maxBlind) {
        throw new Error(`Maximum blind app registrations reached (${maxBlind})`)
      }
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

    // ─── PolicyGuard: pre-storage check ───
    // Before storing ANY data (blind or public), verify the app's tier
    // allows relay storage. This prevents p2p-only and local-first apps
    // from having user data written to the relay in the first place.
    const tier = opts.privacyTier || 'public'
    const storageCheck = this.policyGuard.check(appKeyHex, tier, 'store-on-relay')
    if (!storageCheck.allowed) {
      this.emit('policy-violation', {
        appKey: appKeyHex,
        tier,
        reason: storageCheck.reason,
        action: 'seed-denied'
      })
      throw new Error(`POLICY_VIOLATION: ${storageCheck.reason}`)
    }

    // ─── Blind mode: encrypted replication ───
    // The relay replicates encrypted Hypercore blocks it CANNOT decrypt.
    // It joins the swarm, downloads opaque ciphertext, and re-serves it to
    // peers who request it. The relay gains availability (always-online seeding)
    // while the publisher retains privacy (relay never sees plaintext).
    //
    // Two sub-modes:
    //   blind + replicate (default): relay stores + serves encrypted blocks
    //   blind + discovery-only: relay only registers in catalog, no storage
    if (isBlind) {
      const discoveryOnly = opts.discoveryOnly === true

      let core = null
      let discoveryKey = null

      if (!discoveryOnly) {
        // Replicate the Hypercore as opaque encrypted blocks
        core = this.store.get({ key: appKey })
        await withTimeout(core.ready(), getTimeout(this.config, 'driveReady'), 'blind core.ready()')
        discoveryKey = core.discoveryKey

        // Join swarm to find the publisher and download encrypted blocks
        const done = core.findingPeers ? core.findingPeers() : null
        this.swarm.join(discoveryKey, { server: true, client: true })
        this.swarm.flush().then(() => { if (done) done() }).catch((err) => {
          if (done) done()
          this.emit('swarm-flush-error', { appKey: appKeyHex, error: err.message })
        })

        // Eager download — get all encrypted blocks
        const eagerBlindReplicate = async () => {
          const MAX_RETRIES = 6
          const baseRetryDelay = getTimeout(this.config, 'eagerReplicationRetry')
          const maxRetryDelay = getTimeout(this.config, 'eagerReplicationMaxRetry')

          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (core.closed) return
            try {
              await Promise.race([
                core.update({ wait: true }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('blind update timeout')), getTimeout(this.config, 'driveUpdate')))
              ])

              if (core.closed) return

              if (core.length > 0) {
                // Download all blocks (they're encrypted — relay sees ciphertext only)
                const dl = core.download({ start: 0, end: core.length })
                await Promise.race([
                  dl.done(),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('blind download timeout')), getTimeout(this.config, 'driveDownload')))
                ])
                this.emit('blind-replication-complete', {
                  appKey: appKeyHex,
                  blocks: core.length,
                  byteLength: core.byteLength
                })
                return
              }
            } catch (err) {
              this.emit('blind-replicate-attempt-failed', {
                appKey: appKeyHex,
                attempt: attempt + 1,
                error: err.message
              })
            }

            if (attempt < MAX_RETRIES - 1) {
              const delay = exponentialBackoffDelay(attempt, baseRetryDelay, maxRetryDelay)
              await new Promise(resolve => setTimeout(resolve, delay))
            }
          }
          this.emit('blind-reseed-error', { appKey: appKeyHex, error: 'max retries exceeded' })
        }
        eagerBlindReplicate().catch(err => {
          this.emit('blind-replicate-error', { appKey: appKeyHex, error: err.message })
        })
      }

      this.seededApps.set(appKeyHex, {
        drive: null,
        core,
        discoveryKey,
        startedAt: Date.now(),
        bytesServed: 0,
        appId: opts.appId || null,
        version: opts.version || null,
        blind: true,
        discoveryOnly,
        blindBlocks: core ? core.length : 0,
        blindBytes: core ? core.byteLength : 0
      })

      if (opts.appId) {
        this.appRegistry.set(opts.appId, {
          driveKey: appKeyHex,
          version: opts.version || null,
          name: opts.appId,
          blind: true,
          discoveryOnly,
          updatedAt: Date.now()
        })
        this.appIndex.set(opts.appId, appKeyHex)
        this._saveAppRegistry().catch(err => {
          this.emit('save-registry-error', { error: err.message })
        })
      }

      this.emit('seeding', {
        appKey: appKeyHex,
        blind: true,
        discoveryOnly,
        discoveryKey: discoveryKey ? b4a.toString(discoveryKey, 'hex') : null
      })
      this._saveSeededAppsLog().catch(err => {
        this.emit('save-seeded-log-error', { error: err.message })
      })
      return {
        blind: true,
        discoveryOnly,
        discoveryKey: discoveryKey ? b4a.toString(discoveryKey, 'hex') : null,
        blocks: core ? core.length : 0
      }
    }

    // ─── Public mode: full Hyperdrive replication + HTTP gateway serving ───
    const drive = new Hyperdrive(this.store, appKey)

    try {
      await withTimeout(drive.ready(), getTimeout(this.config, 'driveReady'), 'drive.ready()')

      const discoveryKey = drive.discoveryKey

      // Signal that we're looking for peers for this drive's cores
      const done = drive.findingPeers ? drive.findingPeers() : null
      this.swarm.join(discoveryKey, { server: true, client: true })
      this.swarm.flush().then(() => { if (done) done() }).catch((err) => {
        if (done) done()
        this.emit('swarm-flush-error', { appKey: appKeyHex, error: err.message })
      })

      // Eagerly replicate drive content with retry loop
      const eagerReplicate = async () => {
        const MAX_RETRIES = 6
        const baseRetryDelay = getTimeout(this.config, 'eagerReplicationRetry')
        const maxRetryDelay = getTimeout(this.config, 'eagerReplicationMaxRetry')

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          if (drive.closed) return

          try {
            this.swarm.join(discoveryKey, { server: true, client: true })
            await this.swarm.flush()

            if (drive.closed) return

            await Promise.race([
              drive.update({ wait: true }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('update timeout')), getTimeout(this.config, 'driveUpdate')))
            ])

            if (drive.closed || drive.closing) return

            if (drive.version > 0) {
              if (drive.closed || drive.closing) return
              let dl
              try {
                dl = drive.download('/')
              } catch (err) {
                this.emit('replicate-error', { appKey: appKeyHex, error: err.message, phase: 'download-init' })
                return
              }
              await Promise.race([
                dl.done(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('download timeout')), getTimeout(this.config, 'driveDownload')))
              ])

              if (drive.closed || drive.closing) return

              await this._indexAppManifest(appKeyHex, drive)

              this.emit('reseeded', { appKey: appKeyHex, version: drive.version })
              return
            }
          } catch (err) {
            this.emit('replicate-attempt-failed', { appKey: appKeyHex, attempt: attempt + 1, error: err.message })
          }

          if (attempt < MAX_RETRIES - 1) {
            const delay = exponentialBackoffDelay(attempt, baseRetryDelay, maxRetryDelay)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }
        this.emit('reseed-error', { appKey: appKeyHex, error: 'max retries exceeded' })
      }
      eagerReplicate().catch(err => {
        this.emit('replicate-error', { appKey: appKeyHex, error: err.message, phase: 'eager-replicate' })
      })

      this.seededApps.set(appKeyHex, {
        drive,
        discoveryKey,
        startedAt: Date.now(),
        bytesServed: 0,
        appId: opts.appId || null,
        version: opts.version || null,
        blind: false
      })

      this.emit('seeding', { appKey: appKeyHex, discoveryKey: b4a.toString(discoveryKey, 'hex') })
      this._saveSeededAppsLog().catch(err => {
        this.emit('save-seeded-log-error', { error: err.message })
      })
      return { discoveryKey: b4a.toString(discoveryKey, 'hex') }
    } catch (err) {
      try { await drive.close() } catch (closeErr) {
        this.emit('drive-close-error', { appKey: appKeyHex, error: closeErr.message })
      }
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('manifest timeout')), getTimeout(this.config, 'manifestRead')))
      ])
      if (!manifestBuf) return

      const manifest = JSON.parse(manifestBuf.toString())
      const appId = manifest.id || (manifest.name ? manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : null)
      if (!appId) return

      const version = manifest.version || '0.0.0'
      const tier = manifest.privacyTier || 'public'

      // ─── PolicyGuard enforcement ───
      // Check if this relay is allowed to serve this app's code.
      // A p2p-only app should never be served by a relay at all.
      const check = this.policyGuard.check(appKeyHex, tier, 'serve-code')
      if (!check.allowed) {
        this.emit('policy-violation', {
          appKey: appKeyHex,
          appId,
          tier,
          reason: check.reason,
          action: 'unseed'
        })
        await this.unseedApp(appKeyHex)
        return
      }

      // Update this entry's metadata
      const entry = this.seededApps.get(appKeyHex)
      if (entry) {
        entry.appId = appId
        entry.version = version
        entry.privacyTier = tier
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
      this._saveAppRegistry().catch(err => {
        this.emit('save-registry-error', { error: err.message })
      })
      this._saveSeededAppsLog().catch(err => {
        this.emit('save-seeded-log-error', { error: err.message })
      })
    } catch (err) {
      // No manifest or parse error — skip deduplication silently
      if (err instanceof SyntaxError) {
        this.emit('manifest-parse-error', { appKey: appKeyHex, error: err.message })
      }
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

    if (entry.discoveryKey) {
      try { await this.swarm.leave(entry.discoveryKey) } catch (err) {
        this.emit('unseed-error', { appKey: appKeyHex, operation: 'swarm.leave', error: err.message })
      }
    }
    if (entry.drive) {
      try { await entry.drive.close() } catch (err) {
        this.emit('unseed-error', { appKey: appKeyHex, operation: 'drive.close', error: err.message })
      }
    }
    this.seededApps.delete(appKeyHex)
    this._saveSeededAppsLog().catch(err => {
      this.emit('save-seeded-log-error', { appKey: appKeyHex, error: err.message })
    })

    this.emit('unseeded', { appKey: appKeyHex })
  }

  getStats () {
    return {
      running: this.running,
      mode: this.mode,
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
      },
      accessControl: this.accessControl
        ? {
            pairedDevices: this.accessControl.allowedDevices.size,
            pairingActive: this.accessControl.isPairing,
            rejectedConnections: this._rejectedConnections
          }
        : null,
      mdns: this.mdnsDiscovery
        ? { running: this.mdnsDiscovery._running, discoveredPeers: this.mdnsDiscovery.getDiscoveredPeers().length }
        : null,
      services: this.serviceRegistry
        ? { registered: this.serviceRegistry.services.size, catalog: this.serviceRegistry.catalog(), stats: this.serviceRegistry.stats() }
        : null
    }
  }

  /**
   * Get the service registry for programmatic access.
   */
  getServiceRegistry () {
    return this.serviceRegistry
  }

  /**
   * Call a local service method.
   */
  async callService (serviceName, method, params = {}) {
    if (this.router) {
      return this.router.dispatch(`${serviceName}.${method}`, params, { caller: 'local', transport: 'local' })
    }
    if (!this.serviceRegistry) throw new Error('Services not enabled')
    return this.serviceRegistry.handleRequest(serviceName, method, params, { caller: 'local' })
  }

  /**
   * Call a remote service on a connected peer.
   */
  async callRemoteService (remotePubkey, serviceName, method, params = {}) {
    if (!this.serviceProtocol) throw new Error('Services not enabled')
    return this.serviceProtocol.request(remotePubkey, serviceName, method, params)
  }

  getLeaderboard (limit = 50) {
    return this.reputation ? this.reputation.getLeaderboard(limit) : []
  }

  getHealthStatus () {
    return this.healthMonitor ? this.healthMonitor.getStatus() : null
  }

  // ─── Private/Hybrid Mode: Device Management ───────────────────

  /**
   * Enable pairing mode (private/hybrid only).
   * Returns pairing payload for QR code display.
   */
  enablePairing (opts = {}) {
    if (!this.accessControl) {
      throw new Error('Pairing only available in private/hybrid mode')
    }
    const result = this.accessControl.enablePairing(opts)
    const pubkey = this.swarm ? b4a.toString(this.swarm.keyPair.publicKey, 'hex') : null
    const addr = (this.swarm && this.swarm.dht) ? this.swarm.dht.address() : null
    return {
      ...result,
      relayPubkey: pubkey,
      host: addr ? addr.host : null,
      port: addr ? addr.port : null
    }
  }

  /**
   * Disable pairing mode.
   */
  disablePairing () {
    if (this.accessControl) {
      this.accessControl.disablePairing()
    }
  }

  /**
   * Attempt to pair a device (called when device presents token).
   */
  async pairDevice (token, devicePubkeyHex, deviceName) {
    if (!this.accessControl) {
      throw new Error('Pairing only available in private/hybrid mode')
    }
    return this.accessControl.attemptPair(token, devicePubkeyHex, deviceName)
  }

  /**
   * Manually add a device to the allowlist.
   */
  async addDevice (pubkeyHex, name) {
    if (!this.accessControl) {
      throw new Error('Device management only available in private/hybrid mode')
    }
    return this.accessControl.addDevice(pubkeyHex, name)
  }

  /**
   * Remove a device from the allowlist.
   */
  async removeDevice (pubkeyHex) {
    if (!this.accessControl) {
      throw new Error('Device management only available in private/hybrid mode')
    }
    return this.accessControl.removeDevice(pubkeyHex)
  }

  /**
   * List all paired devices.
   */
  listDevices () {
    if (!this.accessControl) return []
    return this.accessControl.listDevices()
  }

  /**
   * Get pairing payload for QR code generation.
   */
  getPairingQR () {
    if (!this.accessControl || !this.accessControl.isPairing) return null
    const pubkey = this.swarm ? b4a.toString(this.swarm.keyPair.publicKey, 'hex') : null
    const addr = (this.swarm && this.swarm.dht) ? this.swarm.dht.address() : null
    return this.accessControl.getPairingPayload(
      pubkey,
      addr ? addr.host : null,
      addr ? addr.port : null
    )
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
    const remotePubKeyHex = info.publicKey ? b4a.toString(info.publicKey, 'hex') : null

    // ─── Access Control Gate (private/hybrid mode) ───
    // In non-public modes, silently drop connections from unknown devices.
    // This is the first check — no protocol, no RPC, no replication happens
    // for unauthorized peers. Minimal attack surface.
    if (this.accessControl && remotePubKeyHex) {
      if (!this.accessControl.isAllowed(remotePubKeyHex)) {
        // Check if this is a pairing attempt (connection during active pairing window)
        // Pairing is handled via the RPC layer below — but the device must
        // first be let through during the pairing window
        if (!this.accessControl.isPairing) {
          this._rejectedConnections++
          conn.destroy()
          this.emit('connection-rejected', { remotePubKey: remotePubKeyHex, reason: 'not in allowlist' })
          return
        }
        // During pairing window: allow connection temporarily for pairing handshake
        this.emit('pairing-connection', { remotePubKey: remotePubKeyHex })
      } else {
        // Known device — record activity
        this.accessControl.recordActivity(remotePubKeyHex)
      }
    }

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
    if (this.serviceProtocol && remotePubKeyHex) {
      try { this.serviceProtocol.attach(conn, remotePubKeyHex) } catch (err) {
        this.emit('protocol-error', { protocol: 'services', error: err })
      }
    }

    const entry = { lastActivity: Date.now() }
    this.connections.set(conn, entry)

    conn.on('data', () => {
      entry.lastActivity = Date.now()
    })

    conn.on('error', (err) => {
      this.connections.delete(conn)
      this.emit('connection-error', { error: err, info })
    })

    conn.on('close', () => {
      this.connections.delete(conn)
      this.emit('connection-closed', { info })
    })

    this.emit('connection', { info, remotePubKey: remotePubKeyHex })
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
    // Flush metered usage into payment earnings
    if (this.serviceMeter && this.paymentManager) {
      this.serviceMeter.flush(this.paymentManager)
    }

    // Persist credit wallets
    if (this.creditManager) {
      try { await this.creditManager.save() } catch {}
    }

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
    try { await this.bootstrapCache.save() } catch (err) {
      this.emit('stop-error', { component: 'bootstrapCache.save', error: err.message })
    }

    // Stop health checks, settlement, WebSocket, API, and metrics first
    if (this.selfHeal) { this.selfHeal.stop(); this.selfHeal = null }
    if (this.healthMonitor) { this.healthMonitor.stop(); this.healthMonitor = null }
    if (this._healthCheckInterval) { clearInterval(this._healthCheckInterval); this._healthCheckInterval = null }
    if (this.settlementInterval) { clearInterval(this.settlementInterval); this.settlementInterval = null }
    if (this.torTransport) {
      try { await withTimeout(this.torTransport.stop(), timeout, 'torTransport.stop') } catch (err) {
        this.emit('stop-error', { component: 'torTransport', error: err.message })
      }
      this.torTransport = null
    }
    if (this.wsTransport) {
      try { await withTimeout(this.wsTransport.stop(), timeout, 'wsTransport.stop') } catch (err) {
        this.emit('stop-error', { component: 'wsTransport', error: err.message })
      }
      this.wsTransport = null
    }
    if (this.holesailTransport) {
      try { await withTimeout(this.holesailTransport.stop(), timeout, 'holesailTransport.stop') } catch (err) {
        this.emit('stop-error', { component: 'holesailTransport', error: err.message })
      }
      this.holesailTransport = null
    }
    if (this.api) {
      try { await withTimeout(this.api.stop(), timeout, 'api.stop') } catch (err) {
        this.emit('stop-error', { component: 'api', error: err.message })
      }
      this.api = null
    }
    if (this.metrics) { this.metrics.stop(); this.metrics = null }

    // Save credit wallets and stop invoice manager
    if (this.invoiceManager) { this.invoiceManager.stop(); this.invoiceManager = null }
    if (this.creditManager) {
      try { await this.creditManager.save() } catch (err) {
        this.emit('stop-error', { component: 'creditManager.save', error: err.message })
      }
    }

    // Destroy router, services, and protocol handlers
    if (this.router) { try { await this.router.stop() } catch (err) { this.emit('stop-error', { component: 'router', error: err.message }) } this.router = null }
    if (this.serviceProtocol) { this.serviceProtocol.destroy(); this.serviceProtocol = null }
    if (this.serviceRegistry) { try { await this.serviceRegistry.stopAll() } catch (err) { this.emit('stop-error', { component: 'serviceRegistry', error: err.message }) } this.serviceRegistry = null }
    if (this._seedProtocol) { this._seedProtocol.destroy(); this._seedProtocol = null }
    if (this._circuitRelay) {
      if (this._circuitRelay.destroy) this._circuitRelay.destroy()
      this._circuitRelay = null
    }
    if (this._registryScanInterval) { clearInterval(this._registryScanInterval); this._registryScanInterval = null }
    if (this.seedingRegistry) { try { await this.seedingRegistry.stop() } catch (err) { this.emit('stop-error', { component: 'seedingRegistry', error: err.message }) } this.seedingRegistry = null }
    if (this.networkDiscovery) { try { await this.networkDiscovery.stop() } catch (err) { this.emit('stop-error', { component: 'networkDiscovery', error: err.message }) } this.networkDiscovery = null }
    if (this.relayTunnel) { try { await this.relayTunnel.stop() } catch (err) { this.emit('stop-error', { component: 'relayTunnel', error: err.message }) } this.relayTunnel = null }
    if (this.mdnsDiscovery) { try { await this.mdnsDiscovery.stop() } catch (err) { this.emit('stop-error', { component: 'mdnsDiscovery', error: err.message }) } this.mdnsDiscovery = null }
    if (this.accessControl) { try { await this.accessControl.save() } catch (err) { this.emit('stop-error', { component: 'accessControl', error: err.message }) } this.accessControl.destroy(); this.accessControl = null }
    if (this._proofOfRelay) { this._proofOfRelay = null }
    if (this._bandwidthReceipt) { this._bandwidthReceipt.stop(); this._bandwidthReceipt = null }
    if (this._reputationSaveInterval) { clearInterval(this._reputationSaveInterval); this._reputationSaveInterval = null }
    if (this._reputationDecayInterval) { clearInterval(this._reputationDecayInterval); this._reputationDecayInterval = null }
    // Persist reputation before shutdown
    if (this.reputation) {
      try { await this.reputation.save(join(this.config.storage, 'reputation.json')) } catch (err) {
        this.emit('stop-error', { component: 'reputation.save', error: err.message })
      }
    }

    // Unseed all apps
    for (const appKeyHex of this.seededApps.keys()) {
      try {
        await withTimeout(this.unseedApp(appKeyHex), timeout, `unseedApp(${appKeyHex.slice(0, 8)})`)
      } catch (err) {
        this.emit('stop-error', { component: 'unseedApp', appKey: appKeyHex.slice(0, 16), error: err.message })
      }
    }

    if (this.relay) {
      try { await withTimeout(this.relay.stop(), timeout, 'relay.stop') } catch (err) {
        this.emit('stop-error', { component: 'relay', error: err.message })
      }
    }
    if (this.seeder) {
      try { await withTimeout(this.seeder.stop(), timeout, 'seeder.stop') } catch (err) {
        this.emit('stop-error', { component: 'seeder', error: err.message })
      }
    }
    if (this.swarm) {
      try { await withTimeout(this.swarm.destroy(), timeout, 'swarm.destroy') } catch (err) {
        this.emit('stop-error', { component: 'swarm', error: err.message })
      }
    }
    if (this.store) {
      try { await withTimeout(this.store.close(), timeout, 'store.close') } catch (err) {
        this.emit('stop-error', { component: 'store', error: err.message })
      }
    }

    this.running = false
    this.emit('stopped')
  }
}

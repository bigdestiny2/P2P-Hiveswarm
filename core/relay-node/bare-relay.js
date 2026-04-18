/**
 * BareRelay — Minimal Pear/Bare-native relay node
 *
 * This is a reduced RelayNode that runs under the Bare runtime (the JS
 * runtime behind Pear). It deliberately omits features that require
 * Node-only APIs:
 *
 *   - HTTP management API (node:http → would need bare-http1)
 *   - HTTP gateway (/v1/hyper/)
 *   - Compute service JS sandbox (node:vm, node:worker_threads)
 *   - AIService DNS-based SSRF check (node:dns)
 *   - Lightning payment provider (@grpc/grpc-js)
 *   - Interactive setup / manage TUI (@inquirer/prompts)
 *   - Tor transport (socks proxy lib is Node-only)
 *   - Pino logger (uses worker_threads)
 *
 * What it DOES provide:
 *
 *   - Hyperswarm DHT discovery + relay mesh
 *   - Corestore / Hyperdrive hosting
 *   - Seed protocol (accept, replicate, persist)
 *   - Circuit relay protocol (NAT traversal)
 *   - Service protocol channel (for RPC from clients)
 *   - Distributed-drive peer bridge (Ghost Drive compatibility)
 *   - App registry with typed content catalog
 *   - Catalog sync with other relays
 *
 * This is the minimum viable surface to participate in the HiveRelay mesh
 * as a seeding/relaying peer. Operators who want the management TUI and
 * HTTP dashboard run the Node version; operators who want auto-updates via
 * Pear and mobile/embedded support run this.
 *
 * Node and Bare relays interoperate over the DHT — they speak the same
 * Protomux protocols. A Pear-native relay and a Node relay can replicate
 * the same Hyperdrives and sync the same catalog without knowing (or
 * caring) which runtime the other one uses.
 */

import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { EventEmitter } from 'bare-events'
import { readFile, writeFile, mkdir } from 'bare-fs/promises'
import { join } from 'bare-path'

import { Seeder } from './seeder.js'
import { Relay } from './relay.js'
import { AppLifecycle } from './app-lifecycle.js'
import { SeedProtocol } from '../protocol/seed-request.js'
import { CircuitRelay } from '../protocol/relay-circuit.js'
import { ProofOfRelay } from '../protocol/proof-of-relay.js'
import { AppRegistry } from '../app-registry.js'
import { RELAY_DISCOVERY_TOPIC } from '../constants.js'

// Services layer — Bare-safe subset (no Compute vm, no AI DNS, no Lightning)
import { ServiceRegistry } from '../services/registry.js'
import { ServiceProtocol } from '../services/protocol.js'
import { IdentityService } from '../services/builtin/identity-service.js'
import { SchemaService } from '../services/builtin/schema-service.js'
import { StorageService } from '../services/builtin/storage-service.js'
import { SLAService } from '../services/builtin/sla-service.js'
import { ArbitrationService } from '../services/builtin/arbitration-service.js'
import { ZKService } from '../services/builtin/zk-service.js'

// Minimal HTTP surface — bare-http1
import { BareHttpServer } from './bare-http-server.js'

// Simple log helper — Bare has no pino, use plain console.
// Bare doesn't expose `process` as a global; guard env lookup.
const env = (typeof globalThis.process !== 'undefined' && globalThis.process.env) ||
            (typeof globalThis.Bare !== 'undefined' && globalThis.Bare.env) ||
            {}
const log = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
  debug: (...a) => env.HIVERELAY_DEBUG ? console.log('[debug]', ...a) : null
}

const DEFAULT_CONFIG = {
  storage: './storage',
  enableRelay: true,
  enableSeeding: true,
  maxStorageBytes: 50 * 1024 * 1024 * 1024, // 50 GB
  maxConnections: 256,
  regions: ['NA'],
  httpPort: 9100,
  enableHttp: true,
  catalogSync: true,
  catalogMaxAppAgeMs: 7 * 24 * 60 * 60 * 1000 // 7 days
}

export class BareRelay extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...opts }
    this.store = null
    this.swarm = null
    this.seeder = null
    this.relay = null
    this.appRegistry = null
    this.appLifecycle = null
    this._seedProtocol = null
    this._circuitRelay = null
    this._proofOfRelay = null
    this._discovery = null
    this.connections = new Map() // Map<conn, { lastActivity }>
    this.running = false
    this.startedAt = null
  }

  get publicKey () { return this.swarm ? this.swarm.keyPair.publicKey : null }

  async start () {
    if (this.running) throw new Error('already running')

    log.info('BareRelay starting…')
    log.info('  storage:', this.config.storage)

    // 1. Corestore — persistent hypercore storage
    this.store = new Corestore(this.config.storage)
    await this.store.ready()

    // 2. App registry — tracks what we're seeding.
    // AppRegistry takes a storage *directory*, not a full file path.
    this.appRegistry = new AppRegistry(this.config.storage)
    await this.appRegistry.load()

    // 3. Hyperswarm — DHT + peer connections
    this.swarm = new Hyperswarm({
      maxPeers: this.config.maxConnections,
      keyPair: await this._deriveKeypair()
    })

    this.swarm.on('connection', (conn, info) => this._onConnection(conn, info))

    // 4. Seeder — pulls and keeps hypercores replicating
    this.seeder = new Seeder(this.store, {
      maxStorageBytes: this.config.maxStorageBytes
    })

    // 5. Relay for circuit traversal (optional)
    if (this.config.enableRelay) {
      this.relay = new Relay(this.swarm, {
        maxCircuits: 256,
        maxBandwidthMbps: 100
      })
    }

    // 6. Protocol handlers — these attach to every incoming connection.
    // SeedProtocol has signature (swarm, opts); event-driven API.
    this._seedProtocol = new SeedProtocol(this.swarm, { keyPair: this.swarm.keyPair })
    this._seedProtocol.on('seed-request', (msg) => this._onSeedRequest(msg))
    this._seedProtocol.on('unseed-request', (msg) => this._onUnseedRequest(msg))

    this._circuitRelay = this.relay
      ? new CircuitRelay(this.relay)
      : null
    this._proofOfRelay = new ProofOfRelay(this.swarm.keyPair)

    // 7. App lifecycle — seed/unseed/index operations
    this.appLifecycle = new AppLifecycle(this)

    // 8. Services layer — Bare-safe subset (no Compute vm, no AI DNS)
    if (this.config.enableServices !== false) {
      this.serviceRegistry = new ServiceRegistry()
      const providers = [
        new IdentityService({ keyPair: this.swarm.keyPair }),
        new StorageService({ store: this.store }),
        new SchemaService(),
        new SLAService({ maxContracts: 1000 }),
        new ArbitrationService(),
        new ZKService()
      ]
      for (const p of providers) {
        try {
          this.serviceRegistry.register(p)
          if (typeof p.start === 'function') await p.start({ node: this, store: this.store })
        } catch (err) {
          log.warn('  service start failed:', p.manifest?.().name || '?', '-', err.message)
        }
      }
      // ServiceProtocol signature is (registry, opts)
      this._serviceProtocol = new ServiceProtocol(this.serviceRegistry, {
        defaultPeerRole: 'authenticated-user'
      })
      log.info('  services:', providers.length, 'registered')
    }

    // 9. Optional minimal HTTP server (bare-http1) — read-only endpoints
    if (this.config.enableHttp !== false) {
      this.httpServer = new BareHttpServer(this, {
        port: this.config.httpPort,
        host: this.config.httpHost || '0.0.0.0'
      })
      try {
        const { port } = await this.httpServer.start()
        log.info('  http: http://127.0.0.1:' + port + '/status')
      } catch (err) {
        log.warn('  http start failed (continuing without):', err.message)
        this.httpServer = null
      }
    }

    // 10. Announce on the well-known discovery topic
    this._discovery = this.swarm.join(RELAY_DISCOVERY_TOPIC, { server: true, client: true })

    // Bound flush — don't hang indefinitely if no peers
    await Promise.race([
      this.swarm.flush().catch(() => {}),
      new Promise(r => {
        const t = setTimeout(r, 2000)
        if (t.unref) t.unref()
      })
    ])

    // 9. Replay any previously-seeded apps from the registry
    if (this.config.enableSeeding) {
      await this.appLifecycle.reseedFromRegistry()
    }

    this.running = true
    this.startedAt = Date.now()

    const pkHex = b4a.toString(this.swarm.keyPair.publicKey, 'hex')
    log.info('  pubkey:', pkHex)
    log.info('  topic:', b4a.toString(RELAY_DISCOVERY_TOPIC, 'hex').slice(0, 16) + '…')
    log.info('  seeded apps:', this.appRegistry.apps.size)
    log.info('BareRelay running. Press Ctrl+C to stop.')

    this.emit('started', { publicKey: this.swarm.keyPair.publicKey })
    return this
  }

  async stop () {
    if (!this.running) return
    log.info('BareRelay stopping…')

    if (this._discovery) { try { await this._discovery.destroy() } catch (_) {} }
    if (this.httpServer) { try { await this.httpServer.stop() } catch (_) {} this.httpServer = null }
    if (this.serviceRegistry) { try { await this.serviceRegistry.stopAll() } catch (_) {} }
    if (this.relay) { try { await this.relay.stop() } catch (_) {} }
    if (this.seeder) { try { await this.seeder.stop() } catch (_) {} }
    if (this.swarm) { try { await this.swarm.destroy() } catch (_) {} }
    if (this.appRegistry) { try { await this.appRegistry.save() } catch (_) {} }
    if (this.store) { try { await this.store.close() } catch (_) {} }

    this.running = false
    this.emit('stopped')
    log.info('BareRelay stopped.')
  }

  // ─── Keypair persistence ─────────────────────────────────────────

  async _deriveKeypair () {
    const keyPath = join(this.config.storage, 'identity.key')
    try {
      const hex = await readFile(keyPath, 'utf-8')
      const seed = b4a.from(hex.trim(), 'hex')
      const pk = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
      const sk = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
      sodium.crypto_sign_seed_keypair(pk, sk, seed)
      return { publicKey: pk, secretKey: sk }
    } catch {
      // Generate a new keypair and persist the seed
      const seed = b4a.alloc(sodium.crypto_sign_SEEDBYTES)
      sodium.randombytes_buf(seed)
      const pk = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
      const sk = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
      sodium.crypto_sign_seed_keypair(pk, sk, seed)
      await mkdir(this.config.storage, { recursive: true }).catch(() => {})
      await writeFile(keyPath, b4a.toString(seed, 'hex'))
      return { publicKey: pk, secretKey: sk }
    }
  }

  // ─── Connection handling ─────────────────────────────────────────

  _onConnection (conn, info) {
    const remoteHex = info.publicKey ? b4a.toString(info.publicKey, 'hex') : 'anon'
    log.info('  + peer:', remoteHex.slice(0, 16))
    this.connections.set(conn, { lastActivity: Date.now() })

    // Attach our Protomux protocols to this connection
    try {
      if (this._seedProtocol) this._seedProtocol.attach(conn, info)
      if (this._circuitRelay) this._circuitRelay.attach(conn, info)
      if (this._proofOfRelay) this._proofOfRelay.attach(conn, info)
      if (this._serviceProtocol) this._serviceProtocol.attach(conn, info)
    } catch (err) {
      log.warn('  protocol attach error:', err.message)
    }

    // Always replicate the corestore — this is how we serve seeded content
    this.store.replicate(conn)

    conn.on('error', (err) => {
      // Classify: normal P2P drops (ECONNRESET / ETIMEDOUT / duplicate conn
      // races) are noise on the public DHT and should not alarm. Emit a
      // low-severity event for observability without logging every one.
      const code = err && (err.code || err.message || '')
      const benign = /ECONNRESET|ETIMEDOUT|EPIPE|Duplicate connection|channel destroyed/i.test(code)
      if (benign) {
        this.emit('connection-drop', { reason: err.code || err.message, info })
      } else {
        log.warn('  connection error:', code)
        this.emit('connection-error', { error: err, info })
      }
    })

    conn.on('close', () => {
      this.connections.delete(conn)
    })

    this.emit('connection', { info, remotePubKey: remoteHex })
  }

  // ─── Seed/unseed handlers ────────────────────────────────────────

  _onSeedRequest (msg) {
    if (!this.config.enableSeeding || !this.seeder) return
    const appKeyHex = b4a.toString(msg.appKey, 'hex')
    const availableBytes = this.config.maxStorageBytes - (this.seeder.totalBytesStored || 0)

    if (availableBytes < (msg.maxStorageBytes || 0)) {
      log.warn('  seed rejected (insufficient storage):', appKeyHex.slice(0, 16))
      this.emit('seed-rejected', { appKey: appKeyHex, reason: 'insufficient storage' })
      return
    }

    // Send signed acceptance back to requester
    this._seedProtocol.acceptSeedRequest(
      msg.appKey,
      this.swarm.keyPair.publicKey,
      (this.config.regions && this.config.regions[0]) || 'unknown',
      availableBytes
    )

    const publisherHex = msg.publisherPubkey ? b4a.toString(msg.publisherPubkey, 'hex') : null
    this.appLifecycle.seedApp(appKeyHex, { publisherPubkey: publisherHex }).then(() => {
      log.info('  ✓ seeded:', appKeyHex.slice(0, 16))
    }).catch((err) => {
      log.warn('  seed error:', err.message)
      this.emit('seed-error', { appKey: appKeyHex, error: err })
    })

    this.emit('seed-accepted', { appKey: appKeyHex })
  }

  _onUnseedRequest (msg) {
    const appKeyHex = b4a.toString(msg.appKey, 'hex')
    const publisherHex = b4a.toString(msg.publisherPubkey, 'hex')
    const signatureHex = b4a.toString(msg.signature, 'hex')
    const result = this.appLifecycle.verifyUnseedRequest(
      appKeyHex, publisherHex, signatureHex, msg.timestamp
    )
    if (!result.ok) {
      log.warn('  unseed rejected:', result.error)
      this.emit('unseed-rejected', { appKey: appKeyHex, reason: result.error })
      return
    }
    this.appLifecycle.unseedApp(appKeyHex).then(() => {
      log.info('  ✓ unseeded:', appKeyHex.slice(0, 16))
    }).catch((err) => {
      log.warn('  unseed error:', err.message)
    })
  }

  // ─── Eviction (called by AppLifecycle when storage is full) ──────

  async _evictOldestApp () {
    let oldest = null
    for (const [key, entry] of this.appRegistry.apps) {
      if (!oldest || entry.startedAt < oldest.entry.startedAt) {
        oldest = { key, entry }
      }
    }
    if (oldest) {
      log.info('  evicting oldest app:', oldest.key.slice(0, 16))
      await this.appLifecycle.unseedApp(oldest.key)
      return true
    }
    return false
  }

  // Used by AppLifecycle for parent drive lookup (distributed-drive compat).
  // In Bare mode we don't bridge distributed-drive, so return null.
  get distributedDriveBridge () { return null }
}

// Re-export so pear-entry.js can do:
//   import { BareRelay } from './core/relay-node/bare-relay.js'
export default BareRelay

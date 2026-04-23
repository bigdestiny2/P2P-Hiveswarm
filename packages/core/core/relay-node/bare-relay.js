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
// Use Node-shaped names. Under Bare/Pear they get remapped via the
// package.json `imports` map to bare-events / bare-fs/promises / bare-path.
// Under Node they resolve to the built-ins. This lets the same source file
// import cleanly in both runtimes.
import { EventEmitter } from 'events'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'

import { Seeder } from './seeder.js'
import { Relay } from './relay.js'
import { AppLifecycle } from './app-lifecycle.js'
import { SeedProtocol } from '../protocol/seed-request.js'
import { CircuitRelay } from '../protocol/relay-circuit.js'
import { ProofOfRelay } from '../protocol/proof-of-relay.js'
import { AppRegistry } from '../app-registry.js'
import { RELAY_DISCOVERY_TOPIC } from '../constants.js'

// Services framework lives in Core (p2p-hiverelay). Builtin service
// implementations live in p2p-hiveservices and are loaded dynamically below
// so a Bare operator who hasn't installed p2p-hiveservices still gets a
// working seeding/relaying node — just without service RPC.
import { ServiceRegistry } from '../services/registry.js'
import { ServiceProtocol } from '../services/protocol.js'

// Shared accept-mode helpers (also used by RelayNode).
import { resolveAcceptMode, decideAcceptance } from '../accept-mode.js'

// Device-attestation chain verification — same primitive the Node RelayNode
// uses in _scanRegistry. Lets a delegated device publish on behalf of its
// primary identity over the P2P seed-request protocol too, not just via the
// distributed registry path.
import { verifyDelegationCert, verifyRevocation } from '../delegation.js'

// Federation — opt-in cross-relay catalog sharing. Same module used by
// RelayNode; works under Bare via the package.json imports map remapping
// http → bare-http1 and fs/promises → bare-fs/promises.
import { Federation } from '../federation.js'

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
  catalogMaxAppAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  // Bare runtimes have no operator TUI, so the 'review' default would block
  // every inbound seed indefinitely. Default to 'open' here — Pear operators
  // who want a tighter posture can pass acceptMode: 'allowlist' or 'closed'.
  acceptMode: 'open',
  acceptAllowlist: []
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
    this.federation = null
    // BareRelay has no operator TUI for the review queue; we still expose
    // the same `_pendingRequests` map for symmetry with RelayNode so any
    // Federation poll that produces 'queue' decisions has somewhere to put
    // them. In practice Bare operators run with acceptMode 'open' or 'allowlist'.
    this._pendingRequests = new Map()
    // Revoked delegation certs — same shape as RelayNode's. Index by cert
    // signature for O(1) lookup in _checkDelegation.
    this._revokedCertSignatures = new Map()
    this.connections = new Map() // Map<conn, { lastActivity }>
    this.running = false
    this.startedAt = null
  }

  // Symmetry with RelayNode so Federation can call it.
  _resolveAcceptMode () { return resolveAcceptMode(this.config) }
  _decideAcceptance (req, mode) { return decideAcceptance(req, mode, this.config.acceptAllowlist || []) }

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

    // 8. Services layer — Bare-safe subset.
    //
    // We dynamic-import each builtin from p2p-hiveservices so that:
    //   - operators who only install Core get a clean "no services" mode
    //   - Compute and AI builtins, which need Node-only deps (vm / dns), are
    //     simply not in the list below
    if (this.config.enableServices !== false) {
      this.serviceRegistry = new ServiceRegistry()
      const bareSafeServices = [
        { name: 'identity', module: 'p2p-hiveservices/builtin/identity-service.js', className: 'IdentityService', opts: { keyPair: this.swarm.keyPair } },
        { name: 'storage', module: 'p2p-hiveservices/builtin/storage-service.js', className: 'StorageService', opts: { store: this.store } },
        { name: 'schema', module: 'p2p-hiveservices/builtin/schema-service.js', className: 'SchemaService' },
        { name: 'sla', module: 'p2p-hiveservices/builtin/sla-service.js', className: 'SLAService', opts: { maxContracts: 1000 } },
        { name: 'arbitration', module: 'p2p-hiveservices/builtin/arbitration-service.js', className: 'ArbitrationService' },
        { name: 'zk', module: 'p2p-hiveservices/builtin/zk-service.js', className: 'ZKService' }
      ]

      let registered = 0
      let servicesPackageMissing = false
      for (const spec of bareSafeServices) {
        try {
          const mod = await import(spec.module)
          const Ctor = mod[spec.className]
          if (!Ctor) {
            log.warn('  service skipped (missing export):', spec.name)
            continue
          }
          const provider = new Ctor(spec.opts || {})
          this.serviceRegistry.register(provider)
          if (typeof provider.start === 'function') await provider.start({ node: this, store: this.store })
          registered++
        } catch (err) {
          // First-time MODULE_NOT_FOUND on the whole package → skip rest quietly.
          if (err.code === 'ERR_MODULE_NOT_FOUND' && err.message.includes('p2p-hiveservices')) {
            servicesPackageMissing = true
            break
          }
          log.warn('  service start failed:', spec.name, '-', err.message)
        }
      }

      if (servicesPackageMissing) {
        log.info('  services: p2p-hiveservices not installed — running Core-only')
      } else {
        // ServiceProtocol signature is (registry, opts)
        this._serviceProtocol = new ServiceProtocol(this.serviceRegistry, {
          defaultPeerRole: 'authenticated-user'
        })
        log.info('  services:', registered, 'registered')
      }
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

    // 11. Federation — opt-in cross-relay catalog sharing. Always-on as a
    // manager so a Pear app could expose follow/mirror controls in its UI;
    // the polling loop only runs if the operator has actually followed
    // any relays. Storage co-located with the rest of the Bare relay state.
    this.federation = new Federation({
      node: this,
      followInterval: this.config.federation?.followInterval,
      followed: this.config.federation?.followed || [],
      mirrored: this.config.federation?.mirrored || [],
      republished: this.config.federation?.republished || [],
      storagePath: join(this.config.storage, 'federation.json')
    })
    try { await this.federation.load() } catch (err) { log.warn('  federation load failed:', err.message) }
    if (this.config.federation?.enabled !== false) {
      this.federation.start()
    }

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
    if (this.federation) { try { await this.federation.stop() } catch (_) {} this.federation = null }
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

  /**
   * Verify a delegation cert chain on a seed request. Mirrors the Node
   * RelayNode's `_checkDelegation` so the two runtimes give identical
   * answers for identical input.
   *
   * @returns {{ok: true, primaryPubkey: string} | {ok: false, reason: string}}
   */
  /**
   * Accept a signed revocation. Same semantics as RelayNode.submitRevocation.
   */
  submitRevocation (rev, opts = {}) {
    const result = verifyRevocation(rev)
    if (!result.valid) return { ok: false, reason: result.reason || 'invalid revocation' }
    const expiresAt = typeof opts.certExpiresAt === 'number' && opts.certExpiresAt > 0
      ? opts.certExpiresAt
      : Date.now() + 30 * 24 * 60 * 60 * 1000
    this._revokedCertSignatures.set(rev.revokedCertSignature, {
      revokedAt: rev.revokedAt,
      expiresAt,
      reason: rev.reason || '',
      primaryPubkey: rev.primaryPubkey
    })
    this.emit('delegation-revoked', {
      revokedCertSignature: rev.revokedCertSignature,
      primaryPubkey: rev.primaryPubkey,
      reason: rev.reason || ''
    })
    return { ok: true, revokedCertSignature: rev.revokedCertSignature }
  }

  listRevocations () {
    const out = []
    for (const [sig, entry] of this._revokedCertSignatures) {
      out.push({ revokedCertSignature: sig, ...entry })
    }
    return out
  }

  _checkDelegation (msg) {
    const cert = msg.delegationCert
    const result = verifyDelegationCert(cert)
    if (!result.valid) return { ok: false, reason: result.reason || 'invalid cert' }

    // Revocation check — if the primary has invalidated this cert early,
    // reject regardless of other checks passing.
    if (cert.signature && this._revokedCertSignatures.has(cert.signature)) {
      return { ok: false, reason: 'revoked' }
    }

    // Whose signature is on the seed request?
    const reqPublisher = msg.publisherPubkey
      ? b4a.toString(msg.publisherPubkey, 'hex').toLowerCase()
      : null
    if (!reqPublisher) return { ok: false, reason: 'missing request publisher' }

    if (reqPublisher !== cert.devicePubkey.toLowerCase()) {
      return { ok: false, reason: 'cert.devicePubkey mismatch' }
    }

    // Verify the seed-request's own signature was produced by the device key
    // named in the cert. Without this check the cert is a stamp attached to a
    // request nobody can prove the device actually made.
    if (!msg.publisherSignature) return { ok: false, reason: 'missing request signature' }
    const sigBuf = typeof msg.publisherSignature === 'string'
      ? b4a.from(msg.publisherSignature, 'hex')
      : msg.publisherSignature
    if (!sigBuf || sigBuf.length !== 64) {
      return { ok: false, reason: 'malformed request signature' }
    }

    const devicePk = b4a.from(cert.devicePubkey, 'hex')
    // Reconstruct the same payload SeedProtocol signs: appKey || hash(discoveryKeys) || meta(28)
    const appKeyBuf = typeof msg.appKey === 'string' ? b4a.from(msg.appKey, 'hex') : msg.appKey
    if (!appKeyBuf || appKeyBuf.length !== 32) {
      return { ok: false, reason: 'malformed appKey' }
    }

    const dkHash = b4a.alloc(32)
    const dks = Array.isArray(msg.discoveryKeys) ? msg.discoveryKeys : []
    if (dks.length > 0) {
      const dkBufs = dks.map(dk => typeof dk === 'string' ? b4a.from(dk, 'hex') : dk)
      sodium.crypto_generichash(dkHash, b4a.concat(dkBufs))
    }
    const meta = b4a.alloc(28)
    const view = new DataView(meta.buffer, meta.byteOffset)
    view.setUint8(0, msg.replicationFactor || 0)
    view.setBigUint64(8, BigInt(msg.maxStorageBytes || 0))
    view.setBigUint64(16, BigInt(msg.ttlSeconds || 0))
    view.setUint32(24, msg.bountyRate || 0)

    const payload = b4a.concat([appKeyBuf, dkHash, meta])
    const ok = sodium.crypto_sign_verify_detached(sigBuf, payload, devicePk)
    if (!ok) return { ok: false, reason: 'request signature mismatch' }

    return { ok: true, primaryPubkey: result.primaryPubkey }
  }

  _onSeedRequest (msg) {
    if (!this.config.enableSeeding || !this.seeder) return
    const appKeyHex = b4a.toString(msg.appKey, 'hex')
    const availableBytes = this.config.maxStorageBytes - (this.seeder.totalBytesStored || 0)

    if (availableBytes < (msg.maxStorageBytes || 0)) {
      log.warn('  seed rejected (insufficient storage):', appKeyHex.slice(0, 16))
      this.emit('seed-rejected', { appKey: appKeyHex, reason: 'insufficient storage' })
      return
    }

    // Apply the same accept-mode gate as the Node RelayNode. Bare has no
    // operator TUI, so 'review' isn't actionable in this runtime — coerce
    // it to 'closed' (operator must explicitly opt into 'open' or
    // 'allowlist' to accept anything in Bare).
    let mode = resolveAcceptMode(this.config)
    if (mode === 'review') mode = 'closed'
    const decision = decideAcceptance(msg, mode, this.config.acceptAllowlist || [])
    if (decision === 'reject') {
      log.warn('  seed rejected (acceptMode=' + mode + '):', appKeyHex.slice(0, 16))
      this.emit('seed-rejected', { appKey: appKeyHex, reason: 'acceptMode:' + mode })
      return
    }

    // Device-attestation path: if a delegation cert is attached, verify the
    // chain. On success we attribute the seed to the primary identity (not
    // the device that signed the request). On failure we reject and emit.
    let effectivePublisher = msg.publisherPubkey ? b4a.toString(msg.publisherPubkey, 'hex') : null
    if (msg.delegationCert) {
      const delegationCheck = this._checkDelegation(msg)
      if (!delegationCheck.ok) {
        log.warn('  seed rejected (delegation):', appKeyHex.slice(0, 16), '-', delegationCheck.reason)
        this.emit('delegation-rejected', {
          appKey: appKeyHex,
          publisher: effectivePublisher,
          reason: delegationCheck.reason
        })
        this.emit('seed-rejected', { appKey: appKeyHex, reason: 'delegation:' + delegationCheck.reason })
        return
      }
      effectivePublisher = delegationCheck.primaryPubkey
    }

    // Send signed acceptance back to requester
    this._seedProtocol.acceptSeedRequest(
      msg.appKey,
      this.swarm.keyPair.publicKey,
      (this.config.regions && this.config.regions[0]) || 'unknown',
      availableBytes
    )

    this.appLifecycle.seedApp(appKeyHex, { publisherPubkey: effectivePublisher }).then(() => {
      log.info('  ✓ seeded:', appKeyHex.slice(0, 16))
    }).catch((err) => {
      log.warn('  seed error:', err.message)
      this.emit('seed-error', { appKey: appKeyHex, error: err })
    })

    this.emit('seed-accepted', { appKey: appKeyHex, mode, publisherPubkey: effectivePublisher })
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

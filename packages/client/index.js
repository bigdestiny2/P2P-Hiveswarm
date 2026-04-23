/**
 * HiveRelay Client SDK
 *
 * Drop-in module for Pear apps. Handles relay discovery, content
 * publishing, replication, seeding, and NAT traversal — all behind
 * the scenes. The developer gets a simple publish/open/get API.
 * The end user never sees relay infrastructure.
 *
 * Simple usage (auto-creates everything):
 *
 *   import { HiveRelayClient } from 'p2p-hiverelay/client'
 *
 *   const app = new HiveRelayClient('./my-app-storage')
 *   await app.start()
 *
 *   const drive = await app.publish([
 *     { path: '/index.html', content: '<h1>Hello</h1>' }
 *   ])
 *   console.log('Share this key:', drive.key.toString('hex'))
 *
 *   // On another device:
 *   const remote = await app.open(key)
 *   const html = await app.get(key, '/index.html')
 *
 * Advanced usage (bring your own swarm):
 *
 *   const app = new HiveRelayClient({ swarm, store })
 *   await app.start()
 */

import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import Protomux from 'protomux'
import c from 'compact-encoding'
import sodium from 'sodium-universal'
import hypercoreCrypto from 'hypercore-crypto'
import { createRevocation } from 'p2p-hiverelay/core/delegation.js'
import { createSeedingManifest, verifySeedingManifest } from 'p2p-hiverelay/core/seeding-manifest.js'
import { selectQuorum, describeQuorum } from 'p2p-hiverelay/core/quorum-selector.js'
import { ForkDetector } from 'p2p-hiverelay/core/fork-detector.js'
import { verifyCapabilityDoc } from 'p2p-hiverelay/core/capability-doc.js'
import { signForkProof } from 'p2p-hiverelay/core/fork-proof-signing.js'
import { EventEmitter } from 'events'
import { readdir, readFile, writeFile, lstat, mkdir, rename } from 'fs/promises'
import { join, relative, resolve, dirname } from 'path'
import { BootstrapCache } from 'p2p-hiverelay/core/bootstrap-cache.js'
import {
  seedRequestEncoding,
  seedAcceptEncoding,
  unseedRequestEncoding,
  relayReserveEncoding
} from 'p2p-hiverelay/core/protocol/messages.js'
import { SeedingRegistry } from 'p2p-hiverelay/core/registry/index.js'
import { RELAY_DISCOVERY_TOPIC } from 'p2p-hiverelay/core/constants.js'
import { attachPairing, deriveTopic as _deriveTopic, generateCode as _generateCode, proofFor as _proofFor } from './pairing.js'

// Re-exports for test/inspection use. Not part of the stable public surface.
export const _pairing = {
  deriveTopic: _deriveTopic,
  generateCode: _generateCode,
  proofFor: _proofFor
}

const SEED_PROTOCOL = 'hiverelay-seed'
const CIRCUIT_PROTOCOL = 'hiverelay-circuit'

export class HiveRelayClient extends EventEmitter {
  /**
   * @param {string|object} storageOrOpts - Storage path string, or options object
   * @param {object} opts - Options (when first arg is a string)
   *
   * When storageOrOpts is a string:
   *   Creates its own Corestore + Hyperswarm automatically.
   *
   * When storageOrOpts is an object:
   *   { swarm, store, keyPair, autoDiscover, maxRelays, ... }
   *   Uses the provided swarm/store (advanced mode).
   */
  constructor (storageOrOpts, opts = {}) {
    super()

    let config = opts
    if (typeof storageOrOpts === 'string') {
      // Simple mode: just a storage path
      config = { storage: storageOrOpts, ...opts }
    } else if (storageOrOpts && typeof storageOrOpts === 'object') {
      // Advanced mode: options object (may include swarm/store)
      config = { ...storageOrOpts, ...opts }
    }

    this._ownsSwarm = !config.swarm
    this._ownsStore = !config.store
    this._storagePath = config.storage || null

    this.store = config.store || null
    this.swarm = config.swarm || null
    this.keyPair = config.keyPair || (this.swarm && this.swarm.keyPair) || null
    this.autoDiscover = config.autoDiscover !== false
    this.maxRelays = config.maxRelays || 10
    this.connectionTimeout = config.connectionTimeout || 10_000
    this.bootstrap = config.bootstrap || null

    // Relay tracking
    this.relays = new Map() // pubkey hex -> { conn, info, channels, connectedAt }
    this.seedRequests = new Map() // appKey hex -> { request, acceptances }
    this.reservations = new Map() // relay pubkey hex -> { reservation }

    // Drive management
    this.drives = new Map() // key hex -> Hyperdrive
    this._appDrives = new Map() // appId string -> key hex (persistent app→drive mapping)

    // Seed defaults
    this.autoSeed = config.autoSeed !== false
    this.seedReplicas = config.seedReplicas || 3
    this.seedTimeout = config.seedTimeout || 10_000

    this._started = false
    this._discoveryTopic = null
    this._reconnect = { timer: null, delay: 5000, attempt: 0 }
    this._relayHealthInterval = null
    this._relayScores = new Map() // pubkeyHex -> { latency: number, successes: number, failures: number, bytesServed: number, connectedSince: number }
    this._registry = null

    // Service RPC state
    this._pendingServiceRequests = new Map() // requestId -> { resolve, reject, timer }
    this._serviceRequestId = 1

    // Persistent seed retry queue
    // Stored at {storagePath}/pending-seeds.json; survives process restart.
    this._pendingSeeds = new Map() // appKey hex -> { appKey, opts, enqueuedAt, attempts, lastAttempt, nextRetryAt, reason }
    this._pendingSeedTimers = new Map() // appKey hex -> setTimeout handle
    this._pendingSeedsLoaded = false
    this._pendingSeedConfig = {
      baseDelay: 30_000, // 30s
      maxDelay: 3_600_000, // 1h
      maxAttempts: 50
    }

    // ─── Quorum + fork-detection state (v0.6.0 security additions) ───
    //
    // Implements docs/THREAT-MODEL.md defense mechanisms #1 (replica
    // diversity) and #2 (fork detection). All state below is additive;
    // legacy code paths that don't call queryQuorum() / open() with the
    // new options keep working unchanged.
    //
    // Capability cache stores the last-fetched capability doc per relay
    // URL with a TTL — keeps quorum selection fast without repeated
    // network round-trips. Values: { doc, fetchedAt }
    this._capabilityCache = new Map()
    this._capabilityCacheTtl = config.capabilityCacheTtl || 5 * 60 * 1000
    // Foundation pubkeys — when supplied, the 'foundation' quorum
    // strategy uses this list as its trusted floor. Operators of-last-
    // resort live here. See docs/OPERATOR-INCENTIVES-Y1.md.
    this._foundationPubkeys = Array.isArray(config.foundationPubkeys)
      ? config.foundationPubkeys.map(s => String(s).toLowerCase())
      : []
    // Known-relay registry: URL → pinned pubkey. When the operator has
    // out-of-band knowledge of a relay's identity, pinning here means
    // the client auto-rejects fetched capability docs whose pubkey
    // doesn't match — the strongest defense against relay impersonation.
    // Foundation pubkeys are auto-registered if their URLs are known
    // via knownRelays config.
    this._knownRelays = new Map()
    if (config.knownRelays && typeof config.knownRelays === 'object') {
      for (const [url, pubkey] of Object.entries(config.knownRelays)) {
        if (typeof pubkey === 'string') {
          this._knownRelays.set(url.replace(/\/+$/, ''), pubkey.toLowerCase())
        }
      }
    }
    // ForkDetector is loaded lazily on start() so the class is usable
    // in test environments that don't call start().
    this.forkDetector = null
  }

  /**
   * Initialize everything and start discovering relay nodes.
   */
  async start () {
    if (this._started) return this

    // Create store if we own it (only when storage path was given)
    if (this._ownsStore && !this.store && this._storagePath) {
      this.store = new Corestore(this._storagePath)
      await this.store.ready()
    }

    // Create swarm if we own it
    if (this._ownsSwarm && !this.swarm) {
      let bootstrap = this.bootstrap
      if (this._storagePath) {
        this._bootstrapCache = new BootstrapCache(this._storagePath)
        await this._bootstrapCache.load()
        bootstrap = this._bootstrapCache.merge(bootstrap)
      }
      this.swarm = new Hyperswarm({
        bootstrap
      })
      if (this._bootstrapCache) {
        this._bootstrapCache.start(this.swarm)
      }
    }

    if (!this.keyPair && this.swarm.keyPair) {
      this.keyPair = this.swarm.keyPair
    }

    // Wire replication for all connections
    this._connectionHandler = (conn, info) => {
      if (this.store) this.store.replicate(conn)
      this._onConnection(conn, info)
    }
    this.swarm.on('connection', this._connectionHandler)

    // Join discovery topic to find relay nodes
    if (this.autoDiscover) {
      this._discoveryTopic = this.swarm.join(RELAY_DISCOVERY_TOPIC, {
        server: false,
        client: true
      })
      // Bound the flush — in test environments or offline startup there may
      // be no peers to flush to. Proceed after a short wait; the reconnect
      // loop will keep trying to connect in the background.
      const flushTimeout = new Promise(resolve => {
        const t = setTimeout(resolve, 500)
        if (t.unref) t.unref()
      })
      await Promise.race([this.swarm.flush().catch(() => {}), flushTimeout])
    }

    // Start seeding registry for persistent seed request discovery
    if (this.store) {
      try {
        const registryStore = this.store.namespace('seeding-registry')
        this._registry = new SeedingRegistry(registryStore, this.swarm)
        await this._registry.start()
      } catch (err) {
        this.emit('registry-error', { context: 'registry-start', error: err })
        this._registry = null
      }
    }

    this._started = true
    this._startReconnectLoop()
    this._startRelayHealthChecks()

    // Load persistent seed retry queue and schedule retries
    await this._loadPendingSeeds()
    this._schedulePendingSeeds()

    // ─── ForkDetector — load any persisted equivocation evidence ────
    // Storage path may be null in advanced-mode (caller-supplied
    // store with no `storage` config); in that case the detector runs
    // in-memory only and forgets across restarts. Operators who care
    // about persistence will configure a storage path.
    if (this._storagePath) {
      this.forkDetector = new ForkDetector({
        storagePath: join(this._storagePath, 'forks.json')
      })
      try { await this.forkDetector.load() } catch (err) {
        this.emit('fork-detector-error', { context: 'load', error: err })
      }
      // Re-emit fork events on the client so applications can react.
      this.forkDetector.on('fork-detected', (info) => this.emit('fork-detected', info))
      this.forkDetector.on('fork-resolved', (info) => this.emit('fork-resolved', info))
    } else {
      this.forkDetector = new ForkDetector({})
    }

    this.emit('ready')
    this.emit('started')
    return this
  }

  // ─── Content API ─────────────────────────────────────────────────

  /**
   * Publish content to a Hyperdrive and request relay seeding.
   *
   * If opts.appId is provided, reuses an existing drive for that app
   * (version update) instead of creating a new one. This prevents
   * duplicate app entries on the relay network.
   *
   * @param {Array<{path: string, content: Buffer|string}>} files - Files to write
   * @param {object} opts
   * @param {string} opts.appId - Stable app identifier (e.g. 'pear-pos'). Reuses drive if one exists.
   * @param {string} opts.key - Explicit drive key hex to update (overrides appId lookup)
   * @param {boolean} opts.seed - Request seeding (default: this.autoSeed)
   * @param {number} opts.replicas - Number of relay replicas
   * @param {number} opts.timeout - Seed request timeout in ms
   * @returns {Promise<Hyperdrive>} The published drive
   */
  async publish (filesOrDir, opts = {}) {
    this._ensureStarted()

    // Support directory path: client.publish('./my-app') reads all files from disk
    let files
    if (typeof filesOrDir === 'string') {
      const dirPath = resolve(filesOrDir)
      files = await this._readDirectory(dirPath)
      if (files.length === 0) throw new Error('No files found in ' + dirPath)
      // Auto-derive appId from directory name if not set
      if (!opts.appId) {
        const dirName = dirPath.split('/').pop() || dirPath.split('\\').pop()
        opts.appId = dirName
      }
    } else {
      files = filesOrDir
    }

    let drive
    let isUpdate = false

    // Encryption key for blind mode (relay stores ciphertext, can't read content)
    const driveOpts = opts.encryptionKey ? { encryptionKey: opts.encryptionKey } : {}

    // Priority 1: explicit key (resume publishing to a known drive)
    if (opts.key) {
      const keyBuf = typeof opts.key === 'string' ? b4a.from(opts.key, 'hex') : opts.key
      drive = new Hyperdrive(this.store, keyBuf, driveOpts)
      isUpdate = true
    // Priority 2: appId lookup (reuse drive for same app)
    } else if (opts.appId && this._appDrives.has(opts.appId)) {
      const existingKey = this._appDrives.get(opts.appId)
      drive = new Hyperdrive(this.store, b4a.from(existingKey, 'hex'), driveOpts)
      isUpdate = true
    // Priority 3: check persisted app→drive mapping from storage
    } else if (opts.appId && this._storagePath) {
      const savedKey = await this._loadAppDriveMapping(opts.appId)
      if (savedKey) {
        drive = new Hyperdrive(this.store, b4a.from(savedKey, 'hex'), driveOpts)
        isUpdate = true
      }
    }

    // No existing drive found — create new with unique namespace
    // (avoids Corestore contention under active replication in Pear/Bare runtime)
    if (!drive) {
      const ns = this.store.namespace('drive-' + Date.now() + '-' + Math.random().toString(36).slice(2))
      drive = new Hyperdrive(ns, null, driveOpts)
    }

    await drive.ready()

    // Write all files to the drive
    for (const file of files) {
      const content = typeof file.content === 'string'
        ? b4a.from(file.content)
        : file.content
      await drive.put(file.path, content)
    }

    this.swarm.join(drive.discoveryKey, { server: true, client: true })
    // Flush in background — don't block publish on DHT propagation
    this.swarm.flush().catch(() => {})

    const keyHex = b4a.toString(drive.key, 'hex')
    this.drives.set(keyHex, drive)

    // Persist the appId→driveKey mapping for future publishes
    if (opts.appId) {
      this._appDrives.set(opts.appId, keyHex)
      this._saveAppDriveMapping(opts.appId, keyHex).catch(() => {})
    }

    const shouldSeed = opts.seed !== undefined ? opts.seed : this.autoSeed
    if (shouldSeed) {
      const target = opts.replicas || this.seedReplicas
      const timeout = opts.timeout || this.seedTimeout
      try {
        const acceptances = await this.seed(drive.key, { replicas: target, timeout })
        // Attach the outcome directly to the drive so callers have a one-shot
        // view of "did my publish actually reach the target?" without a
        // follow-up call to getReplicationStatus().
        drive.replicas = {
          target,
          accepted: acceptances.length,
          healthy: acceptances.length >= target,
          relays: acceptances.map((a) => ({
            pubkey: a.relayPubkey ? b4a.toString(a.relayPubkey, 'hex') : null,
            region: a.region || null
          }))
        }
        this.emit('seeded', { key: keyHex, acceptances: acceptances.length, target })
      } catch (err) {
        drive.replicas = { target, accepted: 0, healthy: false, relays: [], error: err.message }
        this.emit('seed-error', { key: keyHex, error: err })
      }
    } else {
      drive.replicas = null // explicitly signal: caller opted out of seeding
    }

    this.emit('published', { key: keyHex, files: files.length, isUpdate, replicas: drive.replicas })
    return drive
  }

  /**
   * Open an existing Hyperdrive by key and replicate it.
   *
   * @param {string|Buffer} key - 64-char hex string or 32-byte Buffer
   * @param {object} opts
   * @param {boolean} opts.wait - Wait for initial update (default true)
   * @param {number} opts.timeout - How long to wait for first update in ms (default 15000)
   * @param {boolean} opts.seedAsReader - Volunteer to also serve this drive
   *   to other peers after opening it. Adds redundancy by making *every reader*
   *   a potential replica (Keet-style room redundancy applied to broadcast
   *   content). Defaults to false — opt-in because it has privacy and
   *   bandwidth implications: other peers will see this client's pubkey as a
   *   source for the drive, and this client will spend bandwidth serving the
   *   bytes onward.
   * @returns {Promise<Hyperdrive>} The opened drive
   */
  async open (key, opts = {}) {
    this._ensureStarted()

    const keyBuf = typeof key === 'string' ? b4a.from(key, 'hex') : key
    const keyHex = b4a.toString(keyBuf, 'hex')

    // Quarantine check (v0.6.0 security): if the ForkDetector has
    // recorded an unresolved fork for this drive, refuse to open it
    // unless the caller explicitly passes { force: true }. Forks are
    // cryptographic equivocation evidence — opening a forked drive
    // means committing to ONE of the two divergent histories without
    // knowing which is canonical. Operators must resolve the fork
    // first (rotate keys / revoke / mark false-alarm).
    if (!opts.force && this.isDriveQuarantined(keyHex)) {
      const err = new Error(
        'Drive ' + keyHex + ' is quarantined: an unresolved fork is on record. ' +
        'Pass { force: true } to open anyway, or call client.forkDetector.resolve() first.'
      )
      err.code = 'DRIVE_QUARANTINED'
      err.driveKey = keyHex
      throw err
    }
    // Audit trail: if the operator bypassed quarantine via force:true,
    // record the event so an incident-response investigation later has
    // a chronological trail of overrides. The fork-detector persists
    // the log alongside fork records.
    if (opts.force && this.forkDetector && this.forkDetector.isQuarantined(keyHex)) {
      this.forkDetector.recordBypass({
        hypercoreKey: keyHex,
        caller: opts.caller || 'client.open',
        note: typeof opts.bypassReason === 'string' ? opts.bypassReason : null
      })
    }

    if (this.drives.has(keyHex)) {
      return this.drives.get(keyHex)
    }

    const driveOpts = opts.encryptionKey ? { encryptionKey: opts.encryptionKey } : {}
    const drive = new Hyperdrive(this.store, keyBuf, driveOpts)
    await drive.ready()

    // ─── Auto-detect forks during replication (Defect 2 fix) ────────
    //
    // Hypercore emits 'truncate' when the local view is rolled back
    // due to fork detection during replication — i.e. a peer served
    // blocks that conflict with what we already have. This is the
    // smoking gun for an equivocating publisher.
    //
    // We register the listener BEFORE the swarm.join below so we
    // catch the very first replication round that might trigger it.
    // The handler records evidence to the ForkDetector and emits the
    // event upward so callers can react (drop the drive, alert the
    // operator, etc.).
    if (drive.core && this.forkDetector && typeof drive.core.on === 'function') {
      const onTruncate = (newLength, fork) => {
        // The hypercore 'truncate' event fires with (newLength, fork).
        // 'fork' is the new fork id; if it changed, that's a fork.
        try {
          this.forkDetector.report({
            hypercoreKey: keyHex,
            blockIndex: typeof newLength === 'number' ? newLength : 0,
            evidenceA: { fromRelay: 'local', block: 'truncate-event-pre', signature: 'auto-detected-pre-' + Date.now() },
            evidenceB: { fromRelay: 'replication', block: 'truncate-event-post-fork-' + fork, signature: 'auto-detected-post-' + Date.now() }
          })
          this.emit('drive-fork-detected', { driveKey: keyHex, newLength, fork })
        } catch (_) { /* non-fatal — drive remains operational, fork is recorded */ }
      }
      const onVerifyError = (err) => {
        // Signature verification failure during replication. This is
        // less common than truncate but equally diagnostic.
        try {
          this.forkDetector.report({
            hypercoreKey: keyHex,
            blockIndex: 0,
            evidenceA: { fromRelay: 'expected', block: 'verified-prior-state', signature: 'expected-' + Date.now() },
            evidenceB: { fromRelay: 'replication', block: 'verification-error: ' + (err?.message || 'unknown'), signature: 'verify-error-' + Date.now() }
          })
          this.emit('drive-verification-error', { driveKey: keyHex, error: err })
        } catch (_) { /* non-fatal */ }
      }
      drive.core.on('truncate', onTruncate)
      drive.core.on('verification-error', onVerifyError)
      // Track listeners so we can remove them on close
      if (!this._driveForkListeners) this._driveForkListeners = new Map()
      this._driveForkListeners.set(keyHex, { core: drive.core, onTruncate, onVerifyError })
    }

    const isAuthor = drive.core?.writable || false
    // server=true if author OR if reader explicitly opted in via seedAsReader.
    // Default authors-only preserves prior behaviour for callers that didn't
    // ask for redundancy.
    const serveOnward = isAuthor || opts.seedAsReader === true
    this.swarm.join(drive.discoveryKey, { server: serveOnward, client: true })
    await this.swarm.flush()
    if (opts.seedAsReader === true && !isAuthor) {
      if (!this._readerReplicas) this._readerReplicas = new Set()
      this._readerReplicas.add(keyHex)
      this.emit('reader-replica-joined', { key: keyHex })
    }

    const shouldWait = opts.wait !== false
    if (shouldWait) {
      const timeout = opts.timeout || 15000
      await Promise.race([
        drive.update({ wait: true }),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('Drive update timed out')), timeout)
        )
      ]).catch((err) => {
        this.emit('open-timeout', { key: keyHex, error: err })
      })
    }

    this.drives.set(keyHex, drive)
    this.emit('opened', { key: keyHex })
    return drive
  }

  /**
   * Read a file from an opened drive.
   */
  async get (driveKey, path) {
    const keyHex = typeof driveKey === 'string' ? driveKey : b4a.toString(driveKey, 'hex')
    const drive = this.drives.get(keyHex)
    if (!drive) throw new Error('Drive not open: ' + keyHex.slice(0, 12) + '...')
    return drive.get(path)
  }

  /**
   * Write a file to an owned drive.
   */
  async put (driveKey, path, content) {
    const keyHex = typeof driveKey === 'string' ? driveKey : b4a.toString(driveKey, 'hex')
    const drive = this.drives.get(keyHex)
    if (!drive) throw new Error('Drive not open: ' + keyHex.slice(0, 12) + '...')
    const buf = typeof content === 'string' ? b4a.from(content) : content
    await drive.put(path, buf)
  }

  /**
   * List files in a drive directory.
   */
  async list (driveKey, dir) {
    const keyHex = typeof driveKey === 'string' ? driveKey : b4a.toString(driveKey, 'hex')
    const drive = this.drives.get(keyHex)
    if (!drive) throw new Error('Drive not open: ' + keyHex.slice(0, 12) + '...')
    const entries = []
    const folder = dir || '/'
    try {
      for await (const entry of drive.list(folder)) {
        entries.push(entry.key)
      }
    } catch (err) {
      // Hypercore lifecycle errors during iteration (SESSION_CLOSED,
      // DECODING_ERROR, SNAPSHOT_NOT_AVAILABLE) are recoverable — the drive
      // closed mid-listing or a block was corrupted. Return what we have.
      this.emit('drive-list-error', { key: keyHex, dir: folder, error: err.message, code: err.code })
    }
    return entries
  }

  /**
   * Close a specific drive and leave its swarm topic.
   */
  async closeDrive (driveKey) {
    const keyHex = typeof driveKey === 'string' ? driveKey : b4a.toString(driveKey, 'hex')
    const drive = this.drives.get(keyHex)
    if (!drive) return
    // Detach fork-detection listeners before closing the drive (so
    // we don't leak listeners on the underlying core).
    if (this._driveForkListeners && this._driveForkListeners.has(keyHex)) {
      const { core, onTruncate, onVerifyError } = this._driveForkListeners.get(keyHex)
      try { core.removeListener('truncate', onTruncate) } catch (_) {}
      try { core.removeListener('verification-error', onVerifyError) } catch (_) {}
      this._driveForkListeners.delete(keyHex)
    }
    try { await this.swarm.leave(drive.discoveryKey) } catch (_) {}
    try { await drive.close() } catch (_) {}
    this.drives.delete(keyHex)
  }

  // ─── Relay API ───────────────────────────────────────────────────

  /**
   * Request seeding for a Hyperdrive/Hypercore key.
   * Broadcasts a signed seed request to all connected relays.
   *
   * @param {Buffer|string} appKey - 32-byte key or 64-char hex string
   * @param {object} opts - { replicas, region, maxStorage, ttlDays, timeout }
   * @returns {Promise<object[]>} Array of relay acceptances
   */
  async seed (appKey, opts = {}) {
    const keyBuf = typeof appKey === 'string' ? b4a.from(appKey, 'hex') : appKey
    const keyHex = b4a.toString(keyBuf, 'hex')

    // Hypercore/Hyperdrive discoveryKeys are a KEYED BLAKE2b of the pubkey
    // (key = the ASCII string "hypercore"), not a plain BLAKE2b hash.
    // Using a plain hash here meant the signed seed-request advertised a
    // discoveryKey on a completely different DHT topic than the actual
    // drive, so relays consuming `msg.discoveryKeys` looked in the wrong
    // place and never connected to the publisher. Callers can also pass
    // `opts.discoveryKey` to pin an explicit value (e.g. from drive.discoveryKey).
    const discoveryKey = opts.discoveryKey
      ? (typeof opts.discoveryKey === 'string' ? b4a.from(opts.discoveryKey, 'hex') : opts.discoveryKey)
      : hypercoreCrypto.discoveryKey(keyBuf)
    this.swarm.join(discoveryKey, { server: true, client: true })
    this.swarm.flush().catch(() => {})

    const request = {
      appKey: keyBuf,
      discoveryKeys: [discoveryKey],
      replicationFactor: opts.replicas || 3,
      geoPreference: opts.region ? [opts.region] : [],
      maxStorageBytes: opts.maxStorage || 500 * 1024 * 1024,
      bountyRate: 0,
      ttlSeconds: (opts.ttlDays || 30) * 24 * 3600,
      publisherPubkey: b4a.alloc(32),
      publisherSignature: b4a.alloc(64)
    }

    if (this.keyPair && this.keyPair.secretKey) {
      request.publisherPubkey = this.keyPair.publicKey
      const payload = this._serializeForSigning(request)
      sodium.crypto_sign_detached(request.publisherSignature, payload, this.keyPair.secretKey)
    }

    const targetForEntry = opts.replicas || 3
    const floorForEntry = opts.floor != null ? opts.floor : Math.max(1, Math.floor(targetForEntry / 2))
    const entry = {
      request,
      acceptances: [],
      target: targetForEntry,
      floor: floorForEntry,
      lastSeedAt: Date.now()
    }
    this.seedRequests.set(keyHex, entry)

    // If no relays connected yet, wait briefly for discovery before broadcasting
    if (this.relays.size === 0 && this.autoDiscover) {
      await new Promise((resolve) => {
        const onRelay = () => { this.removeListener('relay-connected', onRelay); clearTimeout(t); resolve() }
        const t = setTimeout(() => { this.removeListener('relay-connected', onRelay); resolve() }, 5000)
        this.on('relay-connected', onRelay)
      })
    }

    // Broadcast seed request via Protomux to all connected relays (instant path)
    const sendTime = Date.now()
    entry.sentAt = sendTime
    for (const relay of this.relays.values()) {
      if (relay.channels.seed) {
        relay.channels.seed.requestMsg.send(request)
      }
    }

    // Also publish to the distributed registry (persistent path — relays scanning later will find it)
    if (this._registry) {
      this._registry.publishRequest(request).catch(() => {})
    }

    // Re-broadcast to any relays that connect during the wait window
    const onNewRelay = (evt) => {
      const relay = this.relays.get(evt.pubkey)
      if (relay && relay.channels.seed) {
        relay.channels.seed.requestMsg.send(request)
      }
    }
    this.on('relay-connected', onNewRelay)

    this.emit('seed-request-published', { appKey: keyHex })

    const targetReplicas = opts.replicas || 3
    const timeout = opts.timeout || 15_000

    await new Promise((resolve) => {
      let timer = null
      const done = () => {
        if (timer) clearTimeout(timer)
        this.removeListener('seed-accepted', check)
        resolve()
      }
      const check = () => {
        if (entry.acceptances.length >= targetReplicas) done()
      }
      this.on('seed-accepted', check)
      timer = setTimeout(done, timeout)
    })

    this.removeListener('relay-connected', onNewRelay)

    // Persistent retry: if we didn't get enough acceptances and the caller
    // didn't explicitly disable persistence, enqueue for retry across restarts.
    if (opts.retryPersistent !== false && entry.acceptances.length < targetReplicas) {
      this._enqueuePendingSeed(keyHex, opts, `insufficient-acceptances:${entry.acceptances.length}/${targetReplicas}`)
    } else if (opts.retryPersistent !== false && entry.acceptances.length >= targetReplicas) {
      // Success — clear any existing pending retry for this key
      this._clearPendingSeed(keyHex, 'success')
    }

    return entry.acceptances
  }

  // ─── Persistent seed retry queue ──────────────────────────────────

  _pendingSeedsFile () {
    if (!this._storagePath) return null
    return join(this._storagePath, 'pending-seeds.json')
  }

  async _loadPendingSeeds () {
    const file = this._pendingSeedsFile()
    if (!file) { this._pendingSeedsLoaded = true; return }
    try {
      const raw = await readFile(file, 'utf-8')
      const list = JSON.parse(raw)
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (entry && entry.appKey) this._pendingSeeds.set(entry.appKey, entry)
        }
      }
    } catch (_) {
      // Missing file or parse error — start with empty queue
    }
    this._pendingSeedsLoaded = true
  }

  async _savePendingSeeds () {
    const file = this._pendingSeedsFile()
    if (!file) return
    try {
      await mkdir(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      const data = JSON.stringify([...this._pendingSeeds.values()], null, 2)
      await writeFile(tmp, data, 'utf-8')
      await rename(tmp, file)
    } catch (err) {
      this.emit('pending-seeds-save-error', { error: err.message })
    }
  }

  _enqueuePendingSeed (appKey, opts, reason) {
    const existing = this._pendingSeeds.get(appKey)
    const attempts = existing ? existing.attempts + 1 : 1
    const delay = Math.min(
      this._pendingSeedConfig.baseDelay * Math.pow(2, attempts - 1),
      this._pendingSeedConfig.maxDelay
    )

    if (attempts > this._pendingSeedConfig.maxAttempts) {
      this._clearPendingSeed(appKey, 'max-attempts')
      this.emit('seed-pending-failed', { appKey, attempts, reason })
      return
    }

    const entry = {
      appKey,
      opts: { ...opts, retryPersistent: true },
      enqueuedAt: existing ? existing.enqueuedAt : Date.now(),
      attempts,
      lastAttempt: Date.now(),
      nextRetryAt: Date.now() + delay,
      reason
    }
    this._pendingSeeds.set(appKey, entry)
    this._savePendingSeeds().catch(() => {})
    this._scheduleSinglePendingSeed(appKey)
    this.emit('seed-pending-enqueued', { appKey, attempts, nextRetryAt: entry.nextRetryAt })
  }

  _clearPendingSeed (appKey, reason = 'cleared') {
    if (this._pendingSeedTimers.has(appKey)) {
      clearTimeout(this._pendingSeedTimers.get(appKey))
      this._pendingSeedTimers.delete(appKey)
    }
    if (this._pendingSeeds.delete(appKey)) {
      this._savePendingSeeds().catch(() => {})
      if (reason === 'cancelled') this.emit('seed-pending-cancelled', { appKey })
      else if (reason === 'success') this.emit('seed-pending-success', { appKey })
    }
  }

  _schedulePendingSeeds () {
    for (const appKey of this._pendingSeeds.keys()) {
      this._scheduleSinglePendingSeed(appKey)
    }
  }

  _scheduleSinglePendingSeed (appKey) {
    if (this._pendingSeedTimers.has(appKey)) {
      clearTimeout(this._pendingSeedTimers.get(appKey))
    }
    const entry = this._pendingSeeds.get(appKey)
    if (!entry) return

    const delay = Math.max(0, entry.nextRetryAt - Date.now())
    const timer = setTimeout(() => {
      this._pendingSeedTimers.delete(appKey)
      this._retryPendingSeed(appKey).catch((err) => {
        this.emit('seed-pending-retry-error', { appKey, error: err.message })
      })
    }, delay)
    if (timer.unref) timer.unref()
    this._pendingSeedTimers.set(appKey, timer)
  }

  async _retryPendingSeed (appKey) {
    const entry = this._pendingSeeds.get(appKey)
    if (!entry) return
    this.emit('seed-pending-retry', { appKey, attempt: entry.attempts })
    try {
      // Pass retryPersistent:true so failures re-enqueue rather than swallowing
      await this.seed(appKey, { ...entry.opts, retryPersistent: true })
    } catch (err) {
      // seed() itself rarely throws — it resolves with acceptances.
      // On unexpected error, re-enqueue with bumped attempts.
      this._enqueuePendingSeed(appKey, entry.opts, 'exception:' + err.message)
    }
  }

  getPendingSeeds () {
    return [...this._pendingSeeds.values()]
  }

  cancelPendingSeed (appKey) {
    this._clearPendingSeed(appKey, 'cancelled')
  }

  async retryPendingSeedsNow () {
    const keys = [...this._pendingSeeds.keys()]
    for (const appKey of keys) {
      if (this._pendingSeedTimers.has(appKey)) {
        clearTimeout(this._pendingSeedTimers.get(appKey))
        this._pendingSeedTimers.delete(appKey)
      }
      await this._retryPendingSeed(appKey).catch(() => {})
    }
  }

  /**
   * Unseed an app from all connected relays (developer kill switch).
   * Signs an unseed request with the client's keypair to prove publisher ownership.
   * The relay verifies the signature matches the publisherPubkey stored at seed time.
   *
   * @param {Buffer|string} appKey - 32-byte key or 64-char hex string
   * @returns {Promise<{ relays: number }>} Number of relays the unseed was broadcast to
   */
  async unseed (appKey) {
    if (!this.keyPair || !this.keyPair.secretKey) {
      throw new Error('Cannot unseed without a keypair (publisher identity required)')
    }

    const keyBuf = typeof appKey === 'string' ? b4a.from(appKey, 'hex') : appKey
    const keyHex = b4a.toString(keyBuf, 'hex')
    const timestamp = Date.now()

    // Sign (appKey + 'unseed' + timestamp) with publisher's secret key
    const tsBuf = b4a.alloc(8)
    const tsView = new DataView(tsBuf.buffer, tsBuf.byteOffset)
    tsView.setBigUint64(0, BigInt(timestamp))

    const payload = b4a.concat([keyBuf, b4a.from('unseed'), tsBuf])
    const signature = b4a.alloc(64)
    sodium.crypto_sign_detached(signature, payload, this.keyPair.secretKey)

    // Broadcast unseed via Protomux to all connected relays
    let broadcastCount = 0
    for (const relay of this.relays.values()) {
      if (relay.channels.seed) {
        // Use the seed protocol's unseed message
        const channel = relay.channels.seed
        if (channel.unseedMsg) {
          channel.unseedMsg.send({
            appKey: keyBuf,
            timestamp,
            publisherPubkey: this.keyPair.publicKey,
            publisherSignature: signature
          })
          broadcastCount++
        }
      }
    }

    // Clean up local state
    this.seedRequests.delete(keyHex)

    this.emit('unseed-published', {
      appKey: keyHex,
      relays: broadcastCount,
      timestamp
    })

    return { relays: broadcastCount }
  }

  /**
   * Reserve a circuit relay slot for NAT traversal.
   */
  async reserveRelay (relayPubKey) {
    const keyHex = typeof relayPubKey === 'string'
      ? relayPubKey
      : b4a.toString(relayPubKey, 'hex')

    const relay = this.relays.get(keyHex)
    if (!relay || !relay.channels.circuit) {
      throw new Error('Relay not connected or circuit protocol not available')
    }

    const peerPubkey = this.keyPair ? this.keyPair.publicKey : b4a.alloc(32)

    relay.channels.circuit.reserveMsg.send({
      peerPubkey,
      maxDurationMs: 60 * 60 * 1000,
      maxBytes: 64 * 1024 * 1024
    })

    return new Promise((resolve) => {
      const onStatus = (msg) => {
        if (msg.code === 0) {
          this.reservations.set(keyHex, { relayPubKey: keyHex, grantedAt: Date.now() })
          this.emit('relay-reserved', { relay: keyHex })
          resolve(true)
        } else {
          resolve(false)
        }
        this.removeListener('_circuit-status-' + keyHex, onStatus)
      }
      this.on('_circuit-status-' + keyHex, onStatus)
      setTimeout(() => {
        this.removeListener('_circuit-status-' + keyHex, onStatus)
        resolve(false)
      }, this.connectionTimeout)
    })
  }

  /**
   * Connect to a peer through a relay node (NAT traversal).
   */
  async connectViaRelay (targetPubKey, relayPubKey) {
    let relayHex = relayPubKey
      ? (typeof relayPubKey === 'string' ? relayPubKey : b4a.toString(relayPubKey, 'hex'))
      : null

    if (!relayHex) {
      relayHex = this._selectBestRelay('circuit')
    }

    if (!relayHex) {
      throw new Error('No relay nodes available for circuit relay')
    }

    const relay = this.relays.get(relayHex)
    if (!relay || !relay.channels.circuit) {
      throw new Error('Selected relay not connected')
    }

    const targetBuf = typeof targetPubKey === 'string' ? b4a.from(targetPubKey, 'hex') : targetPubKey
    const sourceBuf = this.keyPair ? this.keyPair.publicKey : b4a.alloc(32)

    relay.channels.circuit.connectMsg.send({
      targetPubkey: targetBuf,
      sourcePubkey: sourceBuf
    })

    return new Promise((resolve) => {
      const onStatus = (msg) => {
        this.removeListener('_circuit-status-' + relayHex, onStatus)
        resolve(msg.code === 0)
      }
      this.on('_circuit-status-' + relayHex, onStatus)
      setTimeout(() => {
        this.removeListener('_circuit-status-' + relayHex, onStatus)
        resolve(false)
      }, this.connectionTimeout)
    })
  }

  // ─── Status ──────────────────────────────────────────────────────

  /**
   * Get relay and drive status.
   */
  getRelays () {
    const list = []
    for (const [pubkey, relay] of this.relays) {
      list.push({
        pubkey,
        hasSeedProtocol: !!relay.channels.seed,
        hasCircuitProtocol: !!relay.channels.circuit,
        hasServiceProtocol: !!relay.channels.service,
        connectedAt: relay.connectedAt
      })
    }
    return list
  }

  /**
   * Get the cached service catalog from connected relays.
   * Catalogs are received via MSG_CATALOG on connect.
   */
  getServiceCatalog () {
    const catalogs = {}
    for (const [pubkey, relay] of this.relays) {
      if (relay.serviceCatalog) {
        catalogs[pubkey] = relay.serviceCatalog
      }
    }
    return catalogs
  }

  /**
   * Discover apps across the relays this client is connected to.
   *
   * The new model is per-relay: there is no global merged catalog. Each
   * relay maintains its own local catalog and the operator decides what's
   * in it. By default this method returns one row per (app, source-relay)
   * pair, tagged with the source relay's pubkey, so a UI can render a
   * "from relay X" badge alongside each app.
   *
   * For callers that want the old deduplicated view (one row per appKey,
   * with a `relays` array of pubkeys that host it), pass { groupBy: 'app' }.
   *
   * @param {object} [opts]
   * @param {'app'|null} [opts.groupBy] - 'app' for legacy merged shape, null (default) for per-source rows
   * @param {string} [opts.relay] - restrict to a single relay pubkey
   * @returns {Array<object>}
   */
  getAvailableApps ({ groupBy = null, relay = null } = {}) {
    if (groupBy === 'app') {
      // Legacy merged view (kept for backward compatibility).
      const appMap = new Map()
      for (const [pubkey, r] of this.relays) {
        if (relay && pubkey !== relay) continue
        const apps = r.seededApps || []
        for (const app of apps) {
          const existing = appMap.get(app.appKey)
          if (existing) {
            existing.relays.push(pubkey)
          } else {
            appMap.set(app.appKey, {
              appKey: app.appKey,
              appId: app.appId,
              version: app.version,
              discoveryKey: app.discoveryKey,
              blind: app.blind,
              relays: [pubkey]
            })
          }
        }
      }
      return Array.from(appMap.values())
    }

    // Default: one row per (app, source-relay) pair, tagged for badge UIs.
    const rows = []
    for (const [pubkey, r] of this.relays) {
      if (relay && pubkey !== relay) continue
      const apps = r.seededApps || []
      for (const app of apps) {
        rows.push({
          appKey: app.appKey,
          appId: app.appId,
          version: app.version,
          discoveryKey: app.discoveryKey,
          blind: app.blind,
          source: {
            relayPubkey: pubkey,
            // Federation flags get populated when the relay advertises its
            // /catalog.json federation section to the client (future hook).
            mirrored: false,
            republished: false
          }
        })
      }
    }
    return rows
  }

  /**
   * Group per-source app rows by appKey. Convenience for UIs that want to
   * show "this app is on N relays" while still keeping per-relay attribution
   * available in `sources`.
   *
   * @returns {Array<{appKey, appId, version, discoveryKey, blind, sources: Array}>}
   */
  getAvailableAppsBySource () {
    const map = new Map()
    for (const row of this.getAvailableApps()) {
      const existing = map.get(row.appKey)
      if (existing) {
        existing.sources.push(row.source)
      } else {
        map.set(row.appKey, {
          appKey: row.appKey,
          appId: row.appId,
          version: row.version,
          discoveryKey: row.discoveryKey,
          blind: row.blind,
          sources: [row.source]
        })
      }
    }
    return Array.from(map.values())
  }

  getSeedStatus (appKey) {
    const keyHex = typeof appKey === 'string' ? appKey : b4a.toString(appKey, 'hex')
    const entry = this.seedRequests.get(keyHex)
    if (!entry) return null
    return {
      appKey: keyHex,
      acceptances: entry.acceptances.length,
      relays: entry.acceptances.map((a) => ({
        pubkey: b4a.toString(a.relayPubkey, 'hex'),
        region: a.region
      }))
    }
  }

  /**
   * Volunteer to serve a drive this client only opened as a reader. The
   * drive must already be opened (via `open()` or `publish()`). Idempotent.
   *
   * Privacy: other peers will see this client's swarm pubkey as a source for
   * the drive's discoveryKey. For sensitive content, prefer ephemeral
   * keypairs per session.
   *
   * Bandwidth: this client will be asked to serve the drive's bytes to other
   * peers. Use `disableReaderReplica()` or `closeDrive()` to stop.
   *
   * @param {string|Buffer} driveKey
   */
  enableReaderReplica (driveKey) {
    const keyHex = typeof driveKey === 'string' ? driveKey : b4a.toString(driveKey, 'hex')
    const drive = this.drives.get(keyHex)
    if (!drive) throw new Error('Drive not open: ' + keyHex.slice(0, 12) + '...')
    if (drive.core?.writable) return false // author already serves
    this.swarm.join(drive.discoveryKey, { server: true, client: true })
    if (!this._readerReplicas) this._readerReplicas = new Set()
    if (this._readerReplicas.has(keyHex)) return false
    this._readerReplicas.add(keyHex)
    this.emit('reader-replica-joined', { key: keyHex })
    return true
  }

  /**
   * Stop serving a drive that was previously opted in as a reader-replica.
   * Does nothing if this drive was authored by the local client (authors
   * always serve their own content while published).
   */
  disableReaderReplica (driveKey) {
    const keyHex = typeof driveKey === 'string' ? driveKey : b4a.toString(driveKey, 'hex')
    const drive = this.drives.get(keyHex)
    if (!drive) return false
    if (drive.core?.writable) return false
    if (!this._readerReplicas?.has(keyHex)) return false
    // Re-join as client-only to drop the server announcement.
    this.swarm.join(drive.discoveryKey, { server: false, client: true })
    this._readerReplicas.delete(keyHex)
    this.emit('reader-replica-left', { key: keyHex })
    return true
  }

  /**
   * List drives this client is currently serving onward as a reader-replica.
   */
  getReaderReplicas () {
    return Array.from(this._readerReplicas || [])
  }

  /**
   * Named verb for the Keet-style "I want to help seed this" pattern.
   * Equivalent to `open(driveKey, { ...opts, seedAsReader: true })` — opens
   * the drive AND volunteers to serve it onward. Clearer call-site intent
   * than the opts bag.
   *
   * @param {string|Buffer} driveKey
   * @param {object} [opts]  Same options as open() (encryptionKey, wait, timeout)
   * @returns {Promise<Hyperdrive>}
   */
  async mirror (driveKey, opts = {}) {
    return this.open(driveKey, { ...opts, seedAsReader: true })
  }

  /**
   * Stop serving a drive that was previously mirrored. Equivalent to
   * `disableReaderReplica(driveKey)`.
   */
  unmirror (driveKey) {
    return this.disableReaderReplica(driveKey)
  }

  // ─── Community replicas ─────────────────────────────────────────────
  //
  // The "users volunteer to help seed their favourite app's public drives"
  // pattern. The app developer pre-registers which drives are eligible
  // (by key + metadata); the user opts in once with `enableCommunityReplicas()`
  // and the client mirrors every registered drive automatically. Drives the
  // developer later adds to the manifest also pick up (if the user is opted
  // in) via `_autoMirrorCommunity`.
  //
  // This does NOT persist the user's opt-in across restarts — apps that
  // want that should store the preference themselves and call
  // `enableCommunityReplicas()` again on startup.

  /**
   * App-side: declare which drives this app invites its users to help seed.
   * Each entry: `{ driveKey, label?, encryptionKey?, description? }`.
   * Safe to call multiple times; subsequent calls merge with existing entries
   * (later entries override on matching driveKey).
   *
   * @param {Array<object>} drives
   */
  registerCommunityReplicas (drives) {
    if (!Array.isArray(drives)) throw new Error('registerCommunityReplicas: drives must be an array')
    if (!this._communityReplicas) this._communityReplicas = new Map()
    for (const entry of drives) {
      if (!entry || typeof entry.driveKey !== 'string' || entry.driveKey.length !== 64) {
        throw new Error('registerCommunityReplicas: each entry needs a 64-hex driveKey')
      }
      this._communityReplicas.set(entry.driveKey, {
        driveKey: entry.driveKey,
        label: entry.label || null,
        description: entry.description || null,
        encryptionKey: entry.encryptionKey || null
      })
    }
    // If the user was already opted in, auto-mirror any newly-added drives.
    if (this._communityOptedIn) {
      this._autoMirrorCommunity().catch((err) => this.emit('community-replica-error', err))
    }
  }

  /**
   * App-side: inspect the current manifest.
   */
  getCommunityReplicas () {
    return Array.from((this._communityReplicas || new Map()).values())
  }

  /**
   * User-side: opt into helping seed the drives the app has registered.
   * By default mirrors every registered drive; pass `{ driveKey }` to opt
   * in to a single drive only.
   *
   * Returns `{ mirrored, failed }` where `mirrored` is the list of drive
   * keys we successfully joined and `failed` is the list that errored.
   */
  async enableCommunityReplicas (opts = {}) {
    if (!this._started) throw new Error('Client not started — call await app.start() first')
    if (!this._communityReplicas || this._communityReplicas.size === 0) {
      return { mirrored: [], failed: [] }
    }
    const only = opts.driveKey || null
    const entries = only
      ? [this._communityReplicas.get(only)].filter(Boolean)
      : Array.from(this._communityReplicas.values())

    const mirrored = []
    const failed = []
    for (const entry of entries) {
      try {
        await this.mirror(entry.driveKey, {
          encryptionKey: entry.encryptionKey || undefined,
          wait: false
        })
        mirrored.push(entry.driveKey)
        this.emit('community-replica-joined', { driveKey: entry.driveKey, label: entry.label })
      } catch (err) {
        failed.push({ driveKey: entry.driveKey, error: err.message })
        this.emit('community-replica-error', { driveKey: entry.driveKey, error: err })
      }
    }
    // Only mark as opted-in if at least one mirror succeeded; this way the
    // first successful call unlocks auto-mirror for later registrations.
    if (mirrored.length > 0) this._communityOptedIn = true
    return { mirrored, failed }
  }

  /**
   * User-side: stop mirroring community drives. Pass `{ driveKey }` to
   * drop a single one, or no arg to drop all.
   */
  disableCommunityReplicas (opts = {}) {
    if (!this._communityReplicas) return { disabled: [] }
    const only = opts.driveKey || null
    const keys = only
      ? [only]
      : Array.from(this._communityReplicas.keys())
    const disabled = []
    for (const k of keys) {
      if (this.unmirror(k)) disabled.push(k)
    }
    if (!only) this._communityOptedIn = false
    return { disabled }
  }

  /**
   * Internal: mirror any registered-but-not-yet-joined drives. Called when
   * a user is already opted in and the app registers additional drives.
   */
  async _autoMirrorCommunity () {
    if (!this._communityReplicas || !this._communityOptedIn) return
    const already = new Set(this.getReaderReplicas())
    for (const entry of this._communityReplicas.values()) {
      if (already.has(entry.driveKey)) continue
      try {
        await this.mirror(entry.driveKey, {
          encryptionKey: entry.encryptionKey || undefined,
          wait: false
        })
        this.emit('community-replica-joined', { driveKey: entry.driveKey, label: entry.label })
      } catch (err) {
        this.emit('community-replica-error', { driveKey: entry.driveKey, error: err })
      }
    }
  }

  /**
   * Replication status for an appKey, framed as the operational math
   * apps should be reasoning about. The Keet-style "always-on" property
   * is N×uptime — if your content is on N independent relays each with
   * decent uptime, your effective availability approaches 100% fast.
   *
   * Health bands (assuming target=3, floor=1):
   *   - healthy  : current >= target
   *   - degraded : floor < current < target
   *   - critical : current <= floor (re-broadcast a seed request)
   *
   * @param {string|Buffer} appKey
   * @returns {object|null}
   */
  getReplicationStatus (appKey) {
    const keyHex = typeof appKey === 'string' ? appKey : b4a.toString(appKey, 'hex')
    const entry = this.seedRequests.get(keyHex)
    if (!entry) return null
    const current = entry.acceptances.length
    const target = entry.target ?? 3
    const floor = entry.floor ?? Math.max(1, Math.floor(target / 2))
    let health
    if (current >= target) health = 'healthy'
    else if (current > floor) health = 'degraded'
    else health = 'critical'
    return {
      appKey: keyHex,
      current,
      target,
      floor,
      health,
      lastSeedAt: entry.lastSeedAt || null,
      relays: entry.acceptances.map((a) => ({
        pubkey: b4a.toString(a.relayPubkey, 'hex'),
        region: a.region
      }))
    }
  }

  /**
   * Distinguish "seed-request accepted" from "drive is actually replicating".
   *
   * An accepted seed request means the relay signed "yes I'll seed this" and
   * sent it back. It does NOT mean the relay has connected to the publisher
   * or pulled any bytes. In degraded network conditions, or when the
   * publisher's announce hasn't propagated through the DHT, a relay can
   * accept and then never actually connect. Callers who want "durable pin
   * confirmed" must check BOTH the acceptance count and the drive's live
   * hypercore peers.
   *
   * Returns:
   * {
   *   appKey,
   *   acceptances,          // from seedRequests — how many relays said "yes"
   *   activePeers,          // from drive.core.peers — how many are replicating *now*
   *   durable,              // heuristic: at least one active peer + some acceptance
   *   driveOpen,            // whether we have the drive loaded locally
   *   byteLengthLocal,      // local core length
   *   byteLengthRemoteMax   // max remoteLength across active peers (≥ local means synced)
   * }
   *
   * @param {string|Buffer} driveKey
   * @returns {object|null}
   */
  getDurableStatus (driveKey) {
    const keyHex = typeof driveKey === 'string' ? driveKey : b4a.toString(driveKey, 'hex')
    const entry = this.seedRequests.get(keyHex)
    const acceptances = entry ? entry.acceptances.length : 0
    const drive = this.drives.get(keyHex)

    if (!drive) {
      return {
        appKey: keyHex,
        acceptances,
        activePeers: 0,
        durable: false,
        driveOpen: false,
        byteLengthLocal: 0,
        byteLengthRemoteMax: 0
      }
    }

    const peers = (drive.core && drive.core.peers) || []
    const activePeers = peers.length
    const byteLengthLocal = drive.core ? (drive.core.length || 0) : 0
    let byteLengthRemoteMax = 0
    for (const p of peers) {
      const rl = p && p.remoteLength ? p.remoteLength : 0
      if (rl > byteLengthRemoteMax) byteLengthRemoteMax = rl
    }

    return {
      appKey: keyHex,
      acceptances,
      activePeers,
      // "durable" heuristic: at least one remote peer has reached our local
      // length (or beyond). That means someone has the bytes. Stronger than
      // "acceptance count > 0" but weaker than "N independent replicas all
      // caught up" — apps with a stricter bar should check the per-peer
      // breakdown themselves.
      durable: activePeers > 0 && byteLengthRemoteMax >= byteLengthLocal,
      driveOpen: true,
      byteLengthLocal,
      byteLengthRemoteMax
    }
  }

  /**
   * Block until a drive reaches "durable" state (or a timeout). Useful for
   * apps that want to confirm "my publish actually pinned" before they
   * consider the operation done — which acceptance alone doesn't guarantee.
   *
   * @param {string|Buffer} driveKey
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=30000]
   * @param {number} [opts.pollIntervalMs=500]
   * @param {number} [opts.minPeers=1]
   * @returns {Promise<object>} the final getDurableStatus() snapshot
   */
  async waitForDurable (driveKey, opts = {}) {
    const timeoutMs = opts.timeoutMs || 30000
    const pollMs = opts.pollIntervalMs || 500
    const minPeers = opts.minPeers || 1
    const deadline = Date.now() + timeoutMs
    let status = this.getDurableStatus(driveKey)
    while (Date.now() < deadline) {
      status = this.getDurableStatus(driveKey)
      if (status.durable && status.activePeers >= minPeers) return status
      await new Promise((r) => setTimeout(r, pollMs))
    }
    return status
  }

  /**
   * Aggregate replication picture across every appKey this client has seeded.
   * Useful for a dashboard / status panel.
   */
  getReplicationOverview () {
    const apps = []
    let healthy = 0
    let degraded = 0
    let critical = 0
    for (const keyHex of this.seedRequests.keys()) {
      const status = this.getReplicationStatus(keyHex)
      if (!status) continue
      apps.push(status)
      if (status.health === 'healthy') healthy++
      else if (status.health === 'degraded') degraded++
      else critical++
    }
    return {
      totalApps: apps.length,
      healthy,
      degraded,
      critical,
      apps
    }
  }

  /**
   * Start a background monitor that periodically checks replication for the
   * given appKey and re-broadcasts the seed request if current drops to or
   * below the floor. Idempotent: calling again on the same key resets the
   * interval. Returns a stop() handle.
   *
   * The monitor is opt-in — clients that publish content and don't care
   * about availability beyond the initial seed don't pay the cost.
   *
   * @param {string|Buffer} appKey
   * @param {object} [opts]
   * @param {number} [opts.checkInterval=300000] - ms between checks (default 5 min)
   * @param {number} [opts.replicas] - re-uses entry.target if not set
   * @returns {{stop: Function}}
   */
  enableReplicationMonitor (appKey, opts = {}) {
    const keyHex = typeof appKey === 'string' ? appKey : b4a.toString(appKey, 'hex')
    if (!this._replicationMonitors) this._replicationMonitors = new Map()
    const existing = this._replicationMonitors.get(keyHex)
    if (existing) existing.stop()

    const interval = opts.checkInterval || 5 * 60 * 1000
    let stopped = false
    const tick = async () => {
      if (stopped || !this._started) return
      const status = this.getReplicationStatus(keyHex)
      if (!status) return
      if (status.current <= status.floor) {
        try {
          await this.seed(keyHex, {
            replicas: opts.replicas || status.target,
            timeout: opts.timeout || 10_000
          })
          this.emit('replication-rebroadcast', { appKey: keyHex, before: status.current, target: status.target })
        } catch (err) {
          this.emit('replication-error', { appKey: keyHex, error: err.message })
        }
      }
    }

    const timer = setInterval(tick, interval)
    if (timer.unref) timer.unref()

    const handle = {
      stop: () => {
        if (stopped) return
        stopped = true
        clearInterval(timer)
        // Only remove from the map if we're still the live handle for this
        // key. Otherwise an old handle's stop() would wipe a newer monitor
        // installed via enableReplicationMonitor() being called again.
        if (this._replicationMonitors.get(keyHex) === handle) {
          this._replicationMonitors.delete(keyHex)
        }
      }
    }
    this._replicationMonitors.set(keyHex, handle)
    return handle
  }

  getStatus () {
    if (!this._started) return { started: false }
    return {
      started: true,
      relays: this.getRelays(),
      drives: this.drives.size,
      connections: this.swarm ? this.swarm.connections.size : 0
    }
  }

  // ─── Multi-device pairing ─────────────────────────────────────────
  //
  // The Keet "always-on" trick #2: same identity, multiple devices. If a
  // user runs the app on phone + laptop, either one being online keeps
  // their published content available.
  //
  // Two paths are supported:
  //
  //   (a) Identity sharing — exportIdentity / importIdentity. Both devices
  //       hold the same private key. Simplest; both devices indistinguishable
  //       on the wire. Best for "this is my second device, full trust."
  //
  //   (b) Device attestation — primary device signs a delegation cert for a
  //       secondary device's pubkey. The secondary device publishes with its
  //       own key but ships the delegation alongside. Allows TTL + revocation
  //       without rotating the primary identity. Verification is client-side
  //       today; relay-side verification is future work (the relay
  //       seed-request protocol would have to carry the cert).

  /**
   * Serialize this client's identity keypair into a transferable bundle.
   *
   * SECURITY: the bundle contains the raw private key. Treat it like a
   * password — transfer over a private channel (QR code with the device
   * physically present, an out-of-band encrypted message, etc.). Don't
   * email it or paste in chat.
   *
   * @returns {{publicKey: string, secretKey: string, version: number}}
   */
  exportIdentity () {
    if (!this.keyPair || !this.keyPair.secretKey) {
      throw new Error('No identity keypair to export')
    }
    return {
      version: 1,
      publicKey: b4a.toString(this.keyPair.publicKey, 'hex'),
      secretKey: b4a.toString(this.keyPair.secretKey, 'hex')
    }
  }

  /**
   * Replace this client's identity with a previously-exported bundle.
   * After import, this client publishes under the imported identity —
   * other peers see this device as the same publisher as the source.
   *
   * @param {object} bundle - The output of exportIdentity()
   */
  importIdentity (bundle) {
    if (!bundle || bundle.version !== 1) throw new Error('Invalid identity bundle (unsupported version)')
    if (!bundle.publicKey || !bundle.secretKey) throw new Error('Invalid identity bundle (missing keys)')
    const publicKey = b4a.from(bundle.publicKey, 'hex')
    const secretKey = b4a.from(bundle.secretKey, 'hex')
    if (publicKey.length !== 32) throw new Error('Invalid identity bundle (publicKey not 32 bytes)')
    if (secretKey.length !== 64) throw new Error('Invalid identity bundle (secretKey not 64 bytes)')
    this.keyPair = { publicKey, secretKey }
    this.emit('identity-imported', { publicKey: bundle.publicKey })
  }

  /**
   * Sign a delegation cert authorising another device's pubkey to publish
   * on behalf of this identity. The secondary device ships this cert with
   * its own signed messages so verifiers can check the chain.
   *
   * @param {string|Buffer} otherPubkey - The secondary device's Ed25519 pubkey
   * @param {object} [opts]
   * @param {number} [opts.ttlMs=2592000000] - 30 days default
   * @param {string} [opts.label] - Optional human-readable label ('iPhone', 'Backup laptop')
   * @returns {{primaryPubkey, devicePubkey, expiresAt, label, signature, version}}
   */
  createDeviceAttestation (otherPubkey, opts = {}) {
    if (!this.keyPair || !this.keyPair.secretKey) throw new Error('No identity to attest from')
    const devicePk = typeof otherPubkey === 'string' ? b4a.from(otherPubkey, 'hex') : otherPubkey
    if (devicePk.length !== 32) throw new Error('otherPubkey must be 32 bytes')
    const ttl = opts.ttlMs || 30 * 24 * 60 * 60 * 1000
    const expiresAt = Date.now() + ttl
    const label = opts.label || ''

    // Signed payload: primaryPubkey || devicePubkey || expiresAt(8 bytes BE) || label
    const expBuf = b4a.alloc(8)
    new DataView(expBuf.buffer, expBuf.byteOffset).setBigUint64(0, BigInt(expiresAt), false)
    const labelBuf = b4a.from(label, 'utf8')
    const payload = b4a.concat([this.keyPair.publicKey, devicePk, expBuf, labelBuf])
    const signature = b4a.alloc(64)
    sodium.crypto_sign_detached(signature, payload, this.keyPair.secretKey)

    return {
      version: 1,
      primaryPubkey: b4a.toString(this.keyPair.publicKey, 'hex'),
      devicePubkey: b4a.toString(devicePk, 'hex'),
      expiresAt,
      label,
      signature: b4a.toString(signature, 'hex')
    }
  }

  /**
   * Verify a device attestation cert. Static method (no client state needed
   * to verify — anyone with the cert can check it).
   *
   * @param {object} cert - Output of createDeviceAttestation()
   * @returns {{valid: boolean, reason?: string}}
   */
  static verifyDeviceAttestation (cert) {
    try {
      if (!cert || cert.version !== 1) return { valid: false, reason: 'unsupported version' }
      if (Date.now() > cert.expiresAt) return { valid: false, reason: 'expired' }

      const primaryPk = b4a.from(cert.primaryPubkey, 'hex')
      const devicePk = b4a.from(cert.devicePubkey, 'hex')
      const sig = b4a.from(cert.signature, 'hex')
      if (primaryPk.length !== 32 || devicePk.length !== 32 || sig.length !== 64) {
        return { valid: false, reason: 'malformed' }
      }

      const expBuf = b4a.alloc(8)
      new DataView(expBuf.buffer, expBuf.byteOffset).setBigUint64(0, BigInt(cert.expiresAt), false)
      const labelBuf = b4a.from(cert.label || '', 'utf8')
      const payload = b4a.concat([primaryPk, devicePk, expBuf, labelBuf])

      const ok = sodium.crypto_sign_verify_detached(sig, payload, primaryPk)
      return ok ? { valid: true } : { valid: false, reason: 'bad signature' }
    } catch (err) {
      return { valid: false, reason: err.message }
    }
  }

  /**
   * Create a signed revocation for a previously-issued device attestation.
   * Only the primary device (the one with the primary secret key) can make
   * a valid revocation — other identities' "revocations" fail signature
   * verification on the relay side.
   *
   * The returned revocation can be POSTed to any relay's
   * `/api/manage/delegation/revoke` endpoint; that relay will stop
   * accepting seed requests that use the revoked cert. Revocations are
   * not auto-federated in this version — the operator broadcasts to the
   * relays they care about.
   *
   * @param {object} cert - The cert being revoked (output of createDeviceAttestation)
   * @param {object} [opts]
   * @param {string} [opts.reason]
   * @returns {object} Revocation message
   */
  createCertRevocation (cert, opts = {}) {
    if (!this.keyPair || !this.keyPair.secretKey) {
      throw new Error('No identity to sign revocation from')
    }
    if (!cert || typeof cert.primaryPubkey !== 'string') {
      throw new Error('Invalid cert')
    }
    // The primary pubkey on the cert must match this client's identity —
    // otherwise we're trying to revoke a cert we didn't issue.
    const myPub = b4a.toString(this.keyPair.publicKey, 'hex')
    if (cert.primaryPubkey.toLowerCase() !== myPub.toLowerCase()) {
      throw new Error('createCertRevocation: this identity did not issue the given cert')
    }
    // Delegate to the shared primitive (same one relays verify with).
    return createRevocation(cert, this.keyPair.secretKey, opts)
  }

  // ─── Seeding manifest (author-published relay list) ───────────────
  //
  // Authors sign a small "these are the relays you should fetch my drives
  // from" document. Clients discover it over plain HTTP (GET
  // /api/authors/<pubkey>/seeding.json), use it to decide which relays to
  // connect to for a given author's content.
  //
  // The fetch helpers also double as a relay-health probe: you can hit
  // /.well-known/hiverelay.json on any HiveRelay node to learn its version,
  // accept policy, and feature set without opening a Hyperswarm connection.

  /**
   * Build + sign a seeding manifest using this client's identity.
   *
   * @param {object} args
   * @param {Array}  args.relays - [{url, role: 'primary'|'backup'|'mirror'}]
   * @param {Array}  args.drives - [{driveKey, channel?}]
   * @param {number} [args.timestamp] - ms epoch (for tests); defaults to now
   * @returns {object} signed manifest ready to publish
   */
  createSeedingManifest ({ relays, drives, timestamp } = {}) {
    if (!this.keyPair) throw new Error('createSeedingManifest: client has no identity')
    return createSeedingManifest({ keyPair: this.keyPair, relays, drives, timestamp })
  }

  /**
   * Publish a signed seeding manifest to a HiveRelay node over HTTP. The
   * manifest must already be signed — use createSeedingManifest() first.
   * Accepts either a full URL (http://host:port) or a bare host:port pair.
   *
   * Returns {ok, pubkey, replaced} on success, throws on any failure so
   * callers can decide whether to retry against a different relay.
   *
   * @param {string} relayUrl   e.g. 'http://relay.example.com:9100'
   * @param {object} manifest   signed manifest from createSeedingManifest()
   * @returns {Promise<{ok: true, pubkey: string, replaced: boolean}>}
   */
  async publishSeedingManifest (relayUrl, manifest) {
    if (typeof relayUrl !== 'string' || !relayUrl.length) {
      throw new Error('publishSeedingManifest: relayUrl required')
    }
    const base = relayUrl.replace(/\/+$/, '')
    const endpoint = base + '/api/authors/seeding.json'
    const res = await _fetchJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest)
    })
    if (!res.ok) {
      const err = new Error('publishSeedingManifest failed: ' + (res.body?.error || res.status))
      err.status = res.status
      err.body = res.body
      throw err
    }
    return res.body
  }

  /**
   * Fetch a seeding manifest for `pubkey` from `relayUrl`. Returns the
   * manifest (with signature verified) on success, null on 404. Throws on
   * network or signature-verification failure so callers distinguish
   * "no manifest cached" (expected) from "relay is broken" (not expected).
   *
   * @param {string} relayUrl
   * @param {string} pubkey - hex (64 chars)
   * @returns {Promise<object|null>}
   */
  async fetchSeedingManifest (relayUrl, pubkey) {
    if (typeof relayUrl !== 'string' || !relayUrl.length) {
      throw new Error('fetchSeedingManifest: relayUrl required')
    }
    if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) {
      throw new Error('fetchSeedingManifest: pubkey must be 64 hex chars')
    }
    const base = relayUrl.replace(/\/+$/, '')
    const endpoint = base + '/api/authors/' + pubkey.toLowerCase() + '/seeding.json'
    const res = await _fetchJson(endpoint, { method: 'GET' })
    if (res.status === 404) return null
    if (!res.ok) {
      const err = new Error('fetchSeedingManifest failed: ' + (res.body?.error || res.status))
      err.status = res.status
      throw err
    }
    const check = verifySeedingManifest(res.body)
    if (!check.valid) {
      throw new Error('fetched manifest failed verification: ' + check.reason)
    }
    if (check.pubkey.toLowerCase() !== pubkey.toLowerCase()) {
      throw new Error('fetched manifest pubkey mismatch')
    }
    return res.body
  }

  /**
   * Fetch a relay's capability document. Useful for relay-shopping:
   * pick relays by version, accept_mode, features without opening a
   * swarm connection.
   *
   * Signature verification (added in v0.6.0): if the doc is signed and
   * `opts.requireSignature` is true (or the doc is signed and we
   * choose to verify), the signature is validated against the pubkey
   * IN the doc (TOFU). A failed verification emits 'capability-verify-error'
   * and throws — the relay is shipping tampered metadata.
   *
   * @param {string} relayUrl
   * @param {object} [opts]
   * @param {boolean} [opts.requireSignature=false]   throw if doc is unsigned
   * @param {string}  [opts.expectedPubkey]           pin pubkey (out-of-band trust)
   * @returns {Promise<object>}
   */
  async fetchCapabilities (relayUrl, opts = {}) {
    if (typeof relayUrl !== 'string' || !relayUrl.length) {
      throw new Error('fetchCapabilities: relayUrl required')
    }
    const base = relayUrl.replace(/\/+$/, '')
    // Auto-populate expectedPubkey from the known-relays registry.
    // Caller-provided opts.expectedPubkey wins; the registry only
    // fills in when the caller didn't pin explicitly.
    if (!opts.expectedPubkey && this._knownRelays.has(base)) {
      opts = { ...opts, expectedPubkey: this._knownRelays.get(base) }
    }
    let doc
    const res = await _fetchJson(base + '/.well-known/hiverelay.json', { method: 'GET' })
    if (res.ok) {
      doc = res.body
    } else {
      // Try the API mirror in case a reverse proxy hides /.well-known.
      const fallback = await _fetchJson(base + '/api/capabilities', { method: 'GET' })
      if (!fallback.ok) throw new Error('fetchCapabilities failed: ' + (res.body?.error || res.status))
      doc = fallback.body
    }

    // Signature verification — opt-in via requireSignature for now,
    // but we ALWAYS check when a signature is present and emit an
    // event on mismatch. A future revision could elevate signature
    // failures to throw by default.
    if (doc && doc.signature) {
      const check = verifyCapabilityDoc(doc)
      if (!check.valid) {
        this.emit('capability-verify-error', { url: relayUrl, reason: check.reason })
        throw new Error('fetchCapabilities: signature verification failed: ' + check.reason)
      }
    } else if (opts.requireSignature) {
      throw new Error('fetchCapabilities: doc is unsigned and requireSignature was set')
    }

    // Pinned-pubkey check (out-of-band trust): if the caller knows
    // which pubkey the relay should have, fail fast on mismatch.
    if (opts.expectedPubkey && doc.pubkey && doc.pubkey.toLowerCase() !== opts.expectedPubkey.toLowerCase()) {
      this.emit('capability-pubkey-mismatch', {
        url: relayUrl,
        expected: opts.expectedPubkey,
        actual: doc.pubkey
      })
      throw new Error('fetchCapabilities: pubkey mismatch (expected ' + opts.expectedPubkey + ', got ' + doc.pubkey + ')')
    }

    // Staleness check (closes capability-doc replay sub-attack):
    // If the doc has an attestedAt timestamp older than maxAgeMs,
    // emit 'capability-doc-stale' so the caller can decide. We don't
    // throw — operators may legitimately leave caches running, and
    // a stale doc is still a known-good doc, just out of date.
    const maxAge = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : 24 * 60 * 60 * 1000
    if (typeof doc.attestedAt === 'number' && doc.attestedAt > 0) {
      const ageMs = Date.now() - doc.attestedAt
      if (ageMs > maxAge) {
        this.emit('capability-doc-stale', {
          url: relayUrl,
          attestedAt: doc.attestedAt,
          ageMs,
          maxAgeMs: maxAge
        })
      }
    }
    return doc
  }

  // ─── Quorum + fork-detection (v0.6.0 security additions) ──────────
  //
  // Implements docs/THREAT-MODEL.md defenses #1 (replica diversity) and
  // #2 (fork detection). All methods below are additive — apps that
  // don't call them keep working unchanged. Apps that do gain
  // structurally smaller attack surfaces against eclipse, withholding,
  // and silent equivocation.

  /**
   * Refresh the local capability-doc cache for a list of relays. Honors
   * a TTL so successive calls within the cache window are cheap.
   *
   * @param {string[]} relayUrls
   * @param {object} [opts]
   * @param {boolean} [opts.force=false]  bypass TTL
   * @returns {Promise<object[]>}  array of RelayInfo records
   */
  async refreshCapabilityCache (relayUrls, opts = {}) {
    if (!Array.isArray(relayUrls)) throw new Error('refreshCapabilityCache: relayUrls must be an array')
    const now = Date.now()
    const force = !!opts.force

    const results = []
    for (const url of relayUrls) {
      const cached = this._capabilityCache.get(url)
      if (!force && cached && (now - cached.fetchedAt) < this._capabilityCacheTtl) {
        results.push({ url, ...cached.relayInfo })
        continue
      }
      try {
        const doc = await this.fetchCapabilities(url)
        const relayInfo = capabilityDocToRelayInfo(url, doc)
        this._capabilityCache.set(url, { relayInfo, fetchedAt: now })
        results.push({ url, ...relayInfo })
      } catch (err) {
        // Don't throw — partial success matters for quorum selection.
        // The unreachable relay simply doesn't appear in the candidate
        // pool until next refresh.
        this.emit('capability-fetch-error', { url, error: err })
      }
    }
    return results
  }

  /**
   * Select a quorum from the cached capability docs.
   *
   * @param {object} [opts] — same shape as quorum-selector.selectQuorum
   * @returns {Array}  selected RelayInfo records (with `.diversityWarning` if applicable)
   */
  selectQuorum (opts = {}) {
    const candidates = []
    for (const [url, entry] of this._capabilityCache) {
      candidates.push({ url, ...entry.relayInfo })
    }
    const merged = {
      foundationPubkeys: this._foundationPubkeys,
      ...opts
    }
    const selected = selectQuorum(candidates, merged)
    if (selected.diversityWarning) {
      this.emit('quorum-warning', selected.diversityWarning)
    }
    return selected
  }

  /**
   * Convenience helper — describe the current quorum (size, regions,
   * operators, warning). Useful for UIs that want to show "you're
   * reading from N relays across M regions."
   */
  describeQuorum (selected) {
    return describeQuorum(selected)
  }

  /**
   * Issue an HTTP query to every relay in a quorum, in parallel.
   * Returns ALL responses (including failures) so the caller can do
   * its own comparison. Used by queryQuorumWithComparison() — most
   * apps will want that helper instead.
   *
   * @param {string} relativePath  path like '/catalog.json' or '/api/info'
   * @param {Array}  quorum        result of selectQuorum()
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=10000]
   * @returns {Promise<Array<{relay: string, ok: boolean, body?: any, error?: string}>>}
   */
  async queryQuorum (relativePath, quorum, opts = {}) {
    if (typeof relativePath !== 'string' || !relativePath.startsWith('/')) {
      throw new Error('queryQuorum: relativePath must start with /')
    }
    if (!Array.isArray(quorum) || quorum.length === 0) {
      throw new Error('queryQuorum: quorum must be a non-empty array')
    }
    const timeoutMs = opts.timeoutMs || 10_000
    return Promise.all(quorum.map(async (relay) => {
      if (!relay || !relay.url) return { relay: relay?.pubkey || '?', ok: false, error: 'no relay URL in quorum entry' }
      const url = relay.url.replace(/\/+$/, '') + relativePath
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const res = await globalThis.fetch(url, { signal: controller.signal })
        clearTimeout(timer)
        const text = await res.text().catch(() => '')
        let body = null
        try { body = text ? JSON.parse(text) : null } catch (_) { /* leave null */ }
        return { relay: relay.pubkey || relay.url, ok: res.ok, status: res.status, body }
      } catch (err) {
        return { relay: relay.pubkey || relay.url, ok: false, error: err.message }
      }
    }))
  }

  /**
   * Query a quorum AND compare responses for divergence. If responses
   * disagree on a value the caller declares "should be invariant"
   * (via opts.compareFields), report the divergence to ForkDetector
   * and emit a warning event.
   *
   * Returns { responses, agreed, divergent } so callers can decide how
   * to handle disagreement (fall back to majority, refuse to act,
   * surface to user, etc.).
   *
   * @param {string} relativePath
   * @param {Array}  quorum
   * @param {object} [opts]
   * @param {string[]} [opts.compareFields=[]]  fields that must agree across responses
   * @param {string} [opts.driveKey]            if comparing a specific drive, the hex key (used in fork records)
   */
  async queryQuorumWithComparison (relativePath, quorum, opts = {}) {
    const responses = await this.queryQuorum(relativePath, quorum, opts)
    const compareFields = opts.compareFields || []
    const okResponses = responses.filter(r => r.ok && r.body)
    if (okResponses.length < 2 || compareFields.length === 0) {
      return { responses, agreed: okResponses, divergent: [] }
    }
    const reference = okResponses[0]
    const divergent = []
    for (let i = 1; i < okResponses.length; i++) {
      const cmp = okResponses[i]
      const diffFields = compareFields.filter(f => reference.body?.[f] !== cmp.body?.[f])
      if (diffFields.length > 0) {
        divergent.push({
          relayA: reference.relay,
          relayB: cmp.relay,
          fields: diffFields,
          valuesA: Object.fromEntries(diffFields.map(f => [f, reference.body[f]])),
          valuesB: Object.fromEntries(diffFields.map(f => [f, cmp.body[f]]))
        })
      }
    }
    if (divergent.length > 0) {
      this.emit('quorum-divergence', { path: relativePath, divergent })
      // Optional: record as fork evidence if the caller passed a driveKey
      // and the comparison divergence is at the drive level (length /
      // version differences are equivocation candidates).
      if (opts.driveKey && this.forkDetector) {
        for (const d of divergent) {
          // Best-effort: encode the divergent values as evidence
          // payloads. A future revision should pull the actual signed
          // hypercore blocks; for now this captures the metadata so
          // the operator has something to investigate.
          this.forkDetector.report({
            hypercoreKey: opts.driveKey.toLowerCase(),
            blockIndex: 0,
            evidenceA: { fromRelay: d.relayA, block: JSON.stringify(d.valuesA), signature: 'metadata-only-' + d.relayA },
            evidenceB: { fromRelay: d.relayB, block: JSON.stringify(d.valuesB), signature: 'metadata-only-' + d.relayB }
          })
        }
      }
    }
    return { responses, agreed: okResponses, divergent }
  }

  /**
   * Pin a known relay's identity pubkey. Future fetchCapabilities()
   * calls against this URL will fail if the served capability doc's
   * pubkey doesn't match. Use for out-of-band trust (e.g. operator
   * shared their pubkey via QR code, federation entry, or printed
   * card).
   *
   * @param {string} url
   * @param {string} pubkey  hex pubkey (64 chars)
   */
  pinRelay (url, pubkey) {
    if (typeof url !== 'string' || !url.length) throw new Error('pinRelay: url required')
    if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) {
      throw new Error('pinRelay: pubkey must be 64 hex chars')
    }
    this._knownRelays.set(url.replace(/\/+$/, ''), pubkey.toLowerCase())
  }

  /**
   * Remove a relay from the pinned-pubkey registry. Subsequent
   * fetchCapabilities() calls revert to TOFU (trust whatever pubkey
   * the doc claims).
   *
   * @param {string} url
   */
  unpinRelay (url) {
    return this._knownRelays.delete(url.replace(/\/+$/, ''))
  }

  /**
   * Snapshot of currently-pinned relays.
   * @returns {Array<{url: string, pubkey: string}>}
   */
  pinnedRelays () {
    return [...this._knownRelays.entries()].map(([url, pubkey]) => ({ url, pubkey }))
  }

  /**
   * Publish a fork proof to a list of relay URLs. Auto-signs the proof
   * with this client's identity key as the observer attestation —
   * relays REQUIRE the signature (closes attack 8.2 from
   * SECURITY-STRATEGY.md).
   *
   * The proof is wrapped in a signed envelope:
   *   { version: 1, proof, observer: { pubkey, signature, attestedAt } }
   *
   * Best-effort: relays that 4xx/5xx are noted in the result but
   * don't abort the broadcast.
   *
   * @param {object} proof    { hypercoreKey, blockIndex, evidence: [a, b] }
   * @param {string[]} relayUrls
   * @returns {Promise<Array<{relay: string, ok: boolean, error?: string}>>}
   */
  async publishForkProof (proof, relayUrls) {
    if (!proof || typeof proof !== 'object') throw new Error('publishForkProof: proof required')
    if (!Array.isArray(relayUrls) || relayUrls.length === 0) {
      throw new Error('publishForkProof: relayUrls must be a non-empty array')
    }
    if (!this.keyPair || !this.keyPair.secretKey) {
      throw new Error('publishForkProof: client has no identity key (signed proofs required)')
    }

    // Adapt ForkDetector's list() output to the unsigned-proof shape
    // signForkProof expects, if the caller passed a record (which has
    // `evidence` as an array already). Otherwise assume already in the
    // right shape.
    const unsigned = {
      hypercoreKey: proof.hypercoreKey,
      blockIndex: typeof proof.blockIndex === 'number' ? proof.blockIndex : 0,
      evidence: Array.isArray(proof.evidence) ? proof.evidence : []
    }
    const signed = signForkProof(unsigned, this.keyPair)

    return Promise.all(relayUrls.map(async (url) => {
      const endpoint = url.replace(/\/+$/, '') + '/api/forks/proof'
      try {
        const res = await _fetchJson(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signed)
        })
        return { relay: url, ok: res.ok, status: res.status }
      } catch (err) {
        return { relay: url, ok: false, error: err.message }
      }
    }))
  }

  /**
   * Returns true if the ForkDetector has an unresolved fork on record
   * for this drive key. Quarantined drives should not be opened or
   * trusted until the operator resolves the fork.
   *
   * @param {string|Buffer} driveKey
   * @returns {boolean}
   */
  isDriveQuarantined (driveKey) {
    if (!this.forkDetector) return false
    const hex = typeof driveKey === 'string' ? driveKey : b4a.toString(driveKey, 'hex')
    return this.forkDetector.isQuarantined(hex)
  }

  // ─── Pairing-over-swarm (multi-device, no QR) ──────────────────────
  //
  // The friction point of exportIdentity/importIdentity is "now go copy
  // 200 bytes of base64 to the other device." createPairingCode +
  // claimPairingCode let users pair via a 6-digit code instead, with the
  // identity bundle moving over an end-to-end-encrypted Hyperswarm channel
  // derived from the hashed code. The code itself never traverses the wire
  // (HMAC challenge/response). See packages/client/pairing.js for protocol
  // details and security notes.

  /**
   * Generate a one-time numeric code that another device can use to claim
   * a copy of this device's publishing identity. Spins up a swarm join on
   * the derived topic and waits for a peer.
   *
   * @param {object} [opts]
   * @param {number} [opts.ttlMs=300000] - Code lifetime (default 5 min)
   * @param {string} [opts.code] - Use this code instead of generating one
   *   (testing). Must be 6 digits.
   * @returns {Promise<{code: string, expiresAt: number, topic: Buffer}>}
   */
  async createPairingCode (opts = {}) {
    const mgr = attachPairing(this)
    return mgr.createPairingCode(opts)
  }

  /**
   * Claim a pairing code generated by another device. On success, this
   * client's identity is replaced with the one received from the source
   * device (importIdentity is called).
   *
   * @param {string} code - 6-digit numeric pairing code
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=30000] - Give up after this long
   * @returns {Promise<{ok: boolean, identity?: {publicKey: string}, reason?: string}>}
   */
  async claimPairingCode (code, opts = {}) {
    const mgr = attachPairing(this)
    return mgr.claimPairingCode(code, opts)
  }

  // ─── Service RPC ──────────────────────────────────────────────────

  /**
   * Call a remote service on a relay node.
   *
   *   const result = await client.callService('identity', 'whoami')
   *   const drive = await client.callService('storage', 'drive-create', {}, { relay: pubkeyHex })
   */
  async callService (service, method, params = {}, opts = {}) {
    this._ensureStarted()

    const relayPubkey = opts.relay || this._selectBestRelay('service')
    if (!relayPubkey) throw new Error('NO_RELAY: no relay with service channel')

    const relay = this.relays.get(relayPubkey)
    if (!relay?.channels?.service) {
      throw new Error('NO_SERVICE_CHANNEL: relay ' + relayPubkey + ' has no service protocol')
    }

    const id = this._serviceRequestId++
    const timeout = opts.timeout || 30_000

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingServiceRequests.delete(id)
        reject(new Error('SERVICE_TIMEOUT'))
      }, timeout)

      this._pendingServiceRequests.set(id, { resolve, reject, timer })

      relay.channels.service.msg.send({
        type: 1,
        id,
        service,
        method,
        params
      })
    })
  }

  // ─── Internal ────────────────────────────────────────────────────

  _onConnection (conn, info) {
    const pubkeyHex = info.publicKey
      ? b4a.toString(info.publicKey, 'hex')
      : null

    if (!pubkeyHex) return

    const mux = Protomux.from(conn)
    const channels = {}

    try {
      const seedChannel = mux.createChannel({
        protocol: SEED_PROTOCOL,
        id: null,
        handshake: c.raw,
        onopen: () => {
          for (const entry of this.seedRequests.values()) {
            if (channels.seed) {
              channels.seed.requestMsg.send(entry.request)
            }
          }
        },
        onclose: () => { channels.seed = null }
      })

      const requestMsg = seedChannel.addMessage({
        encoding: seedRequestEncoding,
        onmessage: () => {}
      })

      const acceptMsg = seedChannel.addMessage({
        encoding: seedAcceptEncoding,
        onmessage: (msg) => this._onSeedAccept(pubkeyHex, msg)
      })

      const unseedMsg = seedChannel.addMessage({
        encoding: unseedRequestEncoding,
        onmessage: () => {} // Client doesn't handle incoming unseed requests
      })

      seedChannel._hiverelay = { requestMsg, acceptMsg, unseedMsg }
      channels.seed = { channel: seedChannel, requestMsg, acceptMsg, unseedMsg }
      seedChannel.open(b4a.from(JSON.stringify({ major: 1, minor: 0 })))
    } catch (err) {
      this.emit('protocol-error', { relay: pubkeyHex, protocol: 'seed', error: err })
    }

    try {
      const circuitChannel = mux.createChannel({
        protocol: CIRCUIT_PROTOCOL,
        id: null,
        onopen: () => {},
        onclose: () => { channels.circuit = null }
      })

      const reserveMsg = circuitChannel.addMessage({
        encoding: relayReserveEncoding,
        onmessage: () => {}
      })

      const connectMsg = circuitChannel.addMessage({
        encoding: {
          preencode (state, msg) {
            c.fixed32.preencode(state, msg.targetPubkey)
            c.fixed32.preencode(state, msg.sourcePubkey)
          },
          encode (state, msg) {
            c.fixed32.encode(state, msg.targetPubkey)
            c.fixed32.encode(state, msg.sourcePubkey)
          },
          decode (state) {
            return {
              targetPubkey: c.fixed32.decode(state),
              sourcePubkey: c.fixed32.decode(state)
            }
          }
        },
        onmessage: () => {}
      })

      const statusMsg = circuitChannel.addMessage({
        encoding: {
          preencode (state, msg) {
            c.uint.preencode(state, msg.code)
            c.string.preencode(state, msg.message)
          },
          encode (state, msg) {
            c.uint.encode(state, msg.code)
            c.string.encode(state, msg.message)
          },
          decode (state) {
            return {
              code: c.uint.decode(state),
              message: c.string.decode(state)
            }
          }
        },
        onmessage: (msg) => {
          const relay = this.relays.get(pubkeyHex)
          if (relay) relay.lastSeen = Date.now()
          this.emit('_circuit-status-' + pubkeyHex, msg)
          this.emit('relay-status', { relay: pubkeyHex, ...msg })
        }
      })

      channels.circuit = { channel: circuitChannel, reserveMsg, connectMsg, statusMsg }
      circuitChannel.open()
    } catch (err) {
      this.emit('protocol-error', { relay: pubkeyHex, protocol: 'circuit', error: err })
    }

    // ─── Service Protocol Channel ───
    try {
      const serviceChannel = mux.createChannel({
        protocol: 'hiverelay-services',
        id: b4a.from('services-v1'),
        onopen: () => {
          this.emit('service-channel-open', { relay: pubkeyHex })
        },
        onclose: () => { channels.service = null }
      })

      const serviceMsg = serviceChannel.addMessage({
        encoding: {
          preencode (state, msg) {
            const json = JSON.stringify(msg)
            state.end += 4 + b4a.byteLength(json)
          },
          encode (state, msg) {
            const json = JSON.stringify(msg)
            const buf = b4a.from(json)
            state.buffer.writeUInt32BE(buf.length, state.start)
            buf.copy(state.buffer, state.start + 4)
            state.start += 4 + buf.length
          },
          decode (state) {
            const len = state.buffer.readUInt32BE(state.start)
            const json = state.buffer.subarray(state.start + 4, state.start + 4 + len).toString()
            state.start += 4 + len
            try {
              return JSON.parse(json)
            } catch {
              return { type: -1, error: 'malformed JSON' }
            }
          }
        },
        onmessage: (msg) => this._onServiceMessage(pubkeyHex, msg)
      })

      channels.service = { channel: serviceChannel, msg: serviceMsg }
      serviceChannel.open()
    } catch (err) {
      this.emit('protocol-error', { relay: pubkeyHex, protocol: 'service', error: err })
    }

    if (!channels.seed && !channels.circuit && !channels.service) return

    this.relays.set(pubkeyHex, {
      conn,
      info,
      channels,
      connectedAt: Date.now(),
      lastSeen: Date.now()
    })

    if (!this._relayScores.has(pubkeyHex)) {
      this._relayScores.set(pubkeyHex, {
        latency: 0,
        successes: 0,
        failures: 0,
        bytesServed: 0,
        connectedSince: Date.now()
      })
    }

    conn.on('close', () => {
      this.relays.delete(pubkeyHex)
      this.reservations.delete(pubkeyHex)
      const closeScores = this._relayScores.get(pubkeyHex)
      if (closeScores) closeScores.failures++
      this.emit('relay-disconnected', { pubkey: pubkeyHex })
      if (this.relays.size === 0 && this._started) {
        this._attemptReconnect()
      }
    })

    conn.on('error', () => {
      this.relays.delete(pubkeyHex)
      const errorScores = this._relayScores.get(pubkeyHex)
      if (errorScores) errorScores.failures++
    })

    this._resetReconnect()
    this.emit('relay-connected', { pubkey: pubkeyHex })
  }

  _startReconnectLoop () {
    this._reconnect.timer = setInterval(() => {
      if (this.relays.size === 0 && this.autoDiscover && this._started) {
        this._attemptReconnect()
      }
    }, 30_000)
    if (this._reconnect.timer.unref) this._reconnect.timer.unref()
  }

  _attemptReconnect () {
    if (!this.autoDiscover || !this._started || this.swarm.destroyed) return

    const { delay, attempt } = this._reconnect
    const nextAttempt = attempt + 1

    this.emit('reconnecting', { attempt: nextAttempt, delay })

    // Destroy old discovery handle to prevent leaked DHT queries
    if (this._discoveryTopic) {
      try { this._discoveryTopic.destroy() } catch (_) {}
    }

    this._discoveryTopic = this.swarm.join(RELAY_DISCOVERY_TOPIC, {
      server: false,
      client: true
    })
    this.swarm.flush().catch(() => {})

    const nextDelay = Math.min(delay * 2, 60_000)
    this._reconnect.delay = nextDelay
    this._reconnect.attempt = nextAttempt
  }

  _startRelayHealthChecks () {
    const HEALTH_CHECK_INTERVAL = 60_000
    const STALE_THRESHOLD = 3 * 60 * 1000

    this._relayHealthInterval = setInterval(() => {
      const now = Date.now()
      for (const [pubkey, relay] of this.relays) {
        if (now - relay.lastSeen > STALE_THRESHOLD) {
          this.relays.delete(pubkey)
          this.reservations.delete(pubkey)
          this.emit('relay-stale', { pubkey })
          try { relay.conn.destroy() } catch (_) {}
        }
      }
    }, HEALTH_CHECK_INTERVAL)
    if (this._relayHealthInterval.unref) this._relayHealthInterval.unref()
  }

  _resetReconnect () {
    const wasReconnecting = this._reconnect.attempt > 0
    this._reconnect.delay = 5000
    this._reconnect.attempt = 0
    if (wasReconnecting) {
      this.emit('reconnected')
    }
  }

  _onSeedAccept (relayPubkeyHex, msg) {
    const now = Date.now()
    const relay = this.relays.get(relayPubkeyHex)
    if (relay) relay.lastSeen = now

    const appKeyHex = b4a.toString(msg.appKey, 'hex')
    const entry = this.seedRequests.get(appKeyHex)

    if (entry) {
      // Reject any seed-accept that lacks relay identity or signature
      if (!msg.relayPubkey || !msg.relaySignature) {
        this.emit('seed-unsigned-reject', { key: appKeyHex, msg })
        return
      }

      // Verify relay signature before accepting
      const payload = b4a.concat([msg.appKey, msg.relayPubkey, b4a.from(msg.region || '')])
      const valid = sodium.crypto_sign_verify_detached(msg.relaySignature, payload, msg.relayPubkey)
      if (!valid) {
        this.emit('invalid-accept', { appKey: appKeyHex, reason: 'bad relay signature' })
        return
      }

      entry.acceptances.push(msg)
    }

    const relayScores = this._relayScores.get(relayPubkeyHex)
    if (relayScores) {
      relayScores.successes++
      // Opportunistic latency: round-trip time from seed request to accept
      if (entry && entry.sentAt) {
        const rtt = now - entry.sentAt
        // Exponential moving average (α=0.3) to smooth out variance
        relayScores.latency = relayScores.latency > 0
          ? Math.round(relayScores.latency * 0.7 + rtt * 0.3)
          : rtt
      }
    }

    this.emit('seed-accepted', {
      appKey: appKeyHex,
      relay: b4a.toString(msg.relayPubkey, 'hex'),
      region: msg.region
    })
  }

  _onServiceMessage (relayPubkey, msg) {
    // Basic type validation on incoming messages
    if (!msg || typeof msg.type !== 'number') return
    // For response/error types, validate id is a number
    if ((msg.type === 2 || msg.type === 3) && typeof msg.id !== 'number') return

    const relay = this.relays.get(relayPubkey)
    if (relay) relay.lastSeen = Date.now()

    if (msg.type === 2) { // MSG_RESPONSE
      const pending = this._pendingServiceRequests.get(msg.id)
      if (pending) {
        clearTimeout(pending.timer)
        this._pendingServiceRequests.delete(msg.id)
        pending.resolve(msg.result)
      }
    } else if (msg.type === 3) { // MSG_ERROR
      const pending = this._pendingServiceRequests.get(msg.id)
      if (pending) {
        clearTimeout(pending.timer)
        this._pendingServiceRequests.delete(msg.id)
        pending.reject(new Error(msg.error))
      }
    } else if (msg.type === 0) { // MSG_CATALOG
      const relay3 = this.relays.get(relayPubkey)
      if (relay3) relay3.serviceCatalog = msg.services || []
      this.emit('service-catalog', { relay: relayPubkey, services: msg.services })
    } else if (msg.type === 7) { // MSG_APP_CATALOG
      const relay2 = this.relays.get(relayPubkey)
      if (relay2) relay2.seededApps = msg.apps || []
      this.emit('app-catalog', { relay: relayPubkey, apps: msg.apps || [] })
    }
  }

  _serializeForSigning (msg) {
    const parts = [msg.appKey]

    // Hash discoveryKeys array (must match server's _serializeForSigning)
    const discoveryKeysHash = b4a.alloc(32)
    if (msg.discoveryKeys && msg.discoveryKeys.length > 0) {
      const dkConcat = b4a.concat(msg.discoveryKeys)
      sodium.crypto_generichash(discoveryKeysHash, dkConcat)
    }
    parts.push(discoveryKeysHash)

    const meta = b4a.alloc(28)
    const view = new DataView(meta.buffer, meta.byteOffset)
    view.setUint8(0, msg.replicationFactor)
    view.setBigUint64(8, BigInt(msg.maxStorageBytes))
    view.setBigUint64(16, BigInt(msg.ttlSeconds))
    view.setUint32(24, msg.bountyRate || 0)
    parts.push(meta)
    return b4a.concat(parts)
  }

  _selectBestRelay (requireProtocol = 'circuit') {
    let best = null
    let bestScore = -1

    for (const [pubkey, relay] of this.relays) {
      if (requireProtocol && !relay.channels[requireProtocol]) continue

      const scores = this._relayScores.get(pubkey) || { successes: 0, failures: 0, latency: 0, connectedSince: Date.now() }
      const total = scores.successes + scores.failures
      const reliability = total > 0 ? scores.successes / total : 0.5
      const uptimeHours = (Date.now() - scores.connectedSince) / 3600000
      const latencyPenalty = scores.latency > 0 ? 1000 / scores.latency : 1

      const composite = (reliability * 10) + (uptimeHours * 0.5) + latencyPenalty
      if (composite > bestScore) {
        bestScore = composite
        best = pubkey
      }
    }

    return best
  }

  getRelayScores () {
    const scores = []
    for (const [pubkey, data] of this._relayScores) {
      const total = data.successes + data.failures
      scores.push({
        relay: pubkey,
        reliability: total > 0 ? (data.successes / total * 100).toFixed(1) + '%' : 'N/A',
        successes: data.successes,
        failures: data.failures,
        uptimeHours: ((Date.now() - data.connectedSince) / 3600000).toFixed(1),
        latencyMs: data.latency
      })
    }
    return scores.sort((a, b) => parseFloat(b.reliability) - parseFloat(a.reliability))
  }

  _ensureStarted () {
    if (!this._started) throw new Error('Client not started — call await app.start() first')
    if (!this.store) throw new Error('No store available — pass a storage path or { store } option')
  }

  // ─── Directory Reading (for publish('./my-app') sugar) ──────────

  async _readDirectory (dirPath, rootDir, opts = {}) {
    if (!rootDir) rootDir = resolve(dirPath)
    const maxFileSize = opts.maxFileSize || 100 * 1024 * 1024
    const files = []
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      // Skip symlinks entirely to avoid traversal attacks
      const fileStat = await lstat(fullPath)
      if (fileStat.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        // Skip node_modules, .git, hidden dirs
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
        const subFiles = await this._readDirectory(fullPath, rootDir, opts)
        files.push(...subFiles)
      } else if (entry.isFile()) {
        // Skip files larger than maxFileSize (default 100 MB)
        if (fileStat.size > maxFileSize) continue
        const relPath = '/' + relative(rootDir, fullPath)
        const content = await readFile(fullPath)
        files.push({ path: relPath, content })
      }
    }
    return files
  }

  // ─── App→Drive Mapping Persistence ──────────────────────────────

  async _loadAppDriveMapping (appId) {
    if (!this._storagePath) return null
    try {
      const mapPath = join(this._storagePath, 'app-drives.json')
      const data = JSON.parse(await readFile(mapPath, 'utf8'))
      return data[appId] || null
    } catch (_) {
      return null
    }
  }

  async _saveAppDriveMapping (appId, keyHex) {
    if (!this._storagePath) return
    try {
      await mkdir(this._storagePath, { recursive: true })
      const mapPath = join(this._storagePath, 'app-drives.json')
      let data = {}
      try { data = JSON.parse(await readFile(mapPath, 'utf8')) } catch (_) {}
      data[appId] = keyHex
      await writeFile(mapPath, JSON.stringify(data, null, 2))
    } catch (_) {}
  }

  /**
   * Shut down everything cleanly.
   */
  async destroy () {
    if (!this._started) return

    // Clean up health check timer
    if (this._relayHealthInterval) {
      clearInterval(this._relayHealthInterval)
      this._relayHealthInterval = null
    }

    // Clean up reconnect timer
    if (this._reconnect.timer) {
      clearInterval(this._reconnect.timer)
      this._reconnect.timer = null
    }
    this._reconnect.delay = 5000
    this._reconnect.attempt = 0

    // Stop replication monitors
    if (this._replicationMonitors) {
      for (const handle of this._replicationMonitors.values()) handle.stop()
      this._replicationMonitors.clear()
    }

    // Cancel pending seed retry timers (entries remain persisted for next session)
    for (const timer of this._pendingSeedTimers.values()) {
      clearTimeout(timer)
    }
    this._pendingSeedTimers.clear()
    // Flush queue to disk before teardown
    try { await this._savePendingSeeds() } catch (_) {}

    // Persist any in-memory fork records before tearing down. Fork
    // evidence is too valuable to lose on shutdown — operators may
    // not see the alert until the next session.
    if (this.forkDetector) {
      try { await this.forkDetector.save() } catch (_) {}
      this.forkDetector.removeAllListeners()
      this.forkDetector = null
    }
    // Capability cache is an in-memory optimization; nothing to persist.
    this._capabilityCache.clear()

    // Remove swarm connection listener (important for shared swarms)
    if (this._connectionHandler && this.swarm) {
      this.swarm.removeListener('connection', this._connectionHandler)
      this._connectionHandler = null
    }

    // Close all drives
    for (const [keyHex, drive] of this.drives) {
      try { await this.swarm.leave(drive.discoveryKey) } catch (_) {}
      try { await drive.close() } catch (_) {}
      this.drives.delete(keyHex)
    }

    // Leave discovery topic
    if (this._discoveryTopic) {
      try { await this.swarm.leave(RELAY_DISCOVERY_TOPIC) } catch (_) {}
      this._discoveryTopic = null
    }

    this.relays.clear()
    this.seedRequests.clear()
    this.reservations.clear()

    // Clean up pending service requests
    for (const pending of this._pendingServiceRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('CLIENT_DESTROYED'))
    }
    this._pendingServiceRequests.clear()

    // Stop registry
    if (this._registry) {
      try { await this._registry.stop() } catch (_) {}
      this._registry = null
    }

    // Tear down any pending pair codes / listeners
    if (this._pairing) {
      try { await this._pairing.destroy() } catch (_) {}
      this._pairing = null
    }

    // Stop and persist bootstrap cache
    if (this._bootstrapCache) {
      this._bootstrapCache.stop()
      try { await this._bootstrapCache.save() } catch (_) {}
      this._bootstrapCache = null
    }

    // Only destroy things we created
    if (this._ownsSwarm && this.swarm) {
      try { await this.swarm.destroy() } catch (_) {}
    }
    if (this._ownsStore && this.store) {
      try { await this.store.close() } catch (_) {}
    }

    this._started = false
    this.emit('destroyed')
  }
}

/**
 * Minimal JSON fetch helper used by the seeding-manifest and capabilities
 * methods. Uses globalThis.fetch (Node 18+, Bare via bare-fetch polyfill,
 * browsers natively). Returns {ok, status, body} rather than throwing on
 * non-2xx so callers can distinguish network errors from 404s.
 *
 * Request bodies are caller-provided strings; this helper doesn't do any
 * JSON-encoding (keep it transparent). Response body is always parsed as
 * JSON; empty / non-JSON responses yield body=null.
 */
async function _fetchJson (url, opts = {}) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('globalThis.fetch unavailable — upgrade to Node 18+ or install a fetch polyfill')
  }
  const response = await globalThis.fetch(url, opts)
  let body = null
  try {
    const text = await response.text()
    if (text) body = JSON.parse(text)
  } catch (_) {
    body = null
  }
  return { ok: response.ok, status: response.status, body }
}

/**
 * Adapt a capability document (per docs/v0.5.1-CAPABILITIES.md) into
 * the RelayInfo shape that the QuorumSelector expects. The selector
 * only uses pubkey + region + operator + features; other fields are
 * ignored at selection time but preserved on the cache entry for any
 * caller that wants to inspect them.
 */
function capabilityDocToRelayInfo (url, doc) {
  if (!doc || typeof doc !== 'object') {
    return { url, pubkey: '', features: [] }
  }
  return {
    url,
    pubkey: typeof doc.pubkey === 'string' ? doc.pubkey : '',
    region: typeof doc.region === 'string' ? doc.region : null,
    // If the capability doc declares a separate operator pubkey (for
    // multi-relay operators), prefer it; otherwise the relay pubkey
    // is its own operator identity.
    operator: typeof doc.operator === 'string' ? doc.operator : doc.pubkey,
    features: Array.isArray(doc.features) ? doc.features : [],
    // Optional ranking signals — selectors can use these if present.
    score: typeof doc.score === 'number' ? doc.score : undefined,
    latencyMs: typeof doc.latencyMs === 'number' ? doc.latencyMs : undefined
  }
}

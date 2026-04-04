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
 *   import { HiveRelayClient } from 'hiverelay/client'
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
import { EventEmitter } from 'events'
import { BootstrapCache } from '../core/bootstrap-cache.js'
import {
  seedRequestEncoding,
  seedAcceptEncoding,
  relayReserveEncoding
} from '../core/protocol/messages.js'

// Well-known topic that all HiveRelay nodes join for discovery
const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

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

    // Seed defaults
    this.autoSeed = config.autoSeed !== false
    this.seedReplicas = config.seedReplicas || 3
    this.seedTimeout = config.seedTimeout || 10_000

    this._started = false
    this._discoveryTopic = null
    this._reconnect = { timer: null, delay: 5000, attempt: 0 }
    this._relayHealthInterval = null
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
    this.swarm.on('connection', (conn, info) => {
      if (this.store) this.store.replicate(conn)
      this._onConnection(conn, info)
    })

    // Join discovery topic to find relay nodes
    if (this.autoDiscover) {
      this._discoveryTopic = this.swarm.join(RELAY_DISCOVERY_TOPIC, {
        server: false,
        client: true
      })
      await this.swarm.flush()
    }

    this._started = true
    this._startReconnectLoop()
    this._startRelayHealthChecks()
    this.emit('ready')
    this.emit('started')
    return this
  }

  // ─── Content API ─────────────────────────────────────────────────

  /**
   * Publish content to a new Hyperdrive and request relay seeding.
   *
   * @param {Array<{path: string, content: Buffer|string}>} files - Files to write
   * @param {object} opts
   * @param {boolean} opts.seed - Request seeding (default: this.autoSeed)
   * @param {number} opts.replicas - Number of relay replicas
   * @param {number} opts.timeout - Seed request timeout in ms
   * @returns {Promise<Hyperdrive>} The published drive
   */
  async publish (files, opts = {}) {
    this._ensureStarted()

    const drive = new Hyperdrive(this.store)
    await drive.ready()

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

    const shouldSeed = opts.seed !== undefined ? opts.seed : this.autoSeed
    if (shouldSeed) {
      const replicas = opts.replicas || this.seedReplicas
      const timeout = opts.timeout || this.seedTimeout
      try {
        const acceptances = await this.seed(drive.key, { replicas, timeout })
        this.emit('seeded', { key: keyHex, acceptances: acceptances.length })
      } catch (err) {
        this.emit('seed-error', { key: keyHex, error: err })
      }
    }

    this.emit('published', { key: keyHex, files: files.length })
    return drive
  }

  /**
   * Open an existing Hyperdrive by key and replicate it.
   *
   * @param {string|Buffer} key - 64-char hex string or 32-byte Buffer
   * @param {object} opts
   * @param {boolean} opts.wait - Wait for initial update (default true)
   * @param {number} opts.timeout - How long to wait for first update in ms (default 15000)
   * @returns {Promise<Hyperdrive>} The opened drive
   */
  async open (key, opts = {}) {
    this._ensureStarted()

    const keyBuf = typeof key === 'string' ? b4a.from(key, 'hex') : key
    const keyHex = b4a.toString(keyBuf, 'hex')

    if (this.drives.has(keyHex)) {
      return this.drives.get(keyHex)
    }

    const drive = new Hyperdrive(this.store, keyBuf)
    await drive.ready()

    this.swarm.join(drive.discoveryKey, { server: true, client: true })
    await this.swarm.flush()

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
    for await (const entry of drive.list(folder)) {
      entries.push(entry.key)
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
    try { await this.swarm.leave(drive.discoveryKey) } catch {}
    try { await drive.close() } catch {}
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

    const discoveryKey = b4a.alloc(32)
    sodium.crypto_generichash(discoveryKey, keyBuf)
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

    const entry = { request, acceptances: [] }
    this.seedRequests.set(keyHex, entry)

    for (const relay of this.relays.values()) {
      if (relay.channels.seed) {
        relay.channels.seed.requestMsg.send(request)
      }
    }

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

    return entry.acceptances
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
      for (const [key, relay] of this.relays) {
        if (relay.channels.circuit) {
          relayHex = key
          break
        }
      }
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
        connectedAt: relay.connectedAt
      })
    }
    return list
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

  getStatus () {
    if (!this._started) return { started: false }
    return {
      started: true,
      relays: this.getRelays(),
      drives: this.drives.size,
      connections: this.swarm ? this.swarm.connections.size : 0
    }
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

      seedChannel._hiverelay = { requestMsg, acceptMsg }
      channels.seed = { channel: seedChannel, requestMsg, acceptMsg }
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

    if (!channels.seed && !channels.circuit) return

    this.relays.set(pubkeyHex, {
      conn,
      info,
      channels,
      connectedAt: Date.now(),
      lastSeen: Date.now()
    })

    conn.on('close', () => {
      this.relays.delete(pubkeyHex)
      this.reservations.delete(pubkeyHex)
      this.emit('relay-disconnected', { pubkey: pubkeyHex })
      if (this.relays.size === 0 && this._started) {
        this._attemptReconnect()
      }
    })

    conn.on('error', () => {
      this.relays.delete(pubkeyHex)
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
    if (!this.autoDiscover || !this._started) return

    const { delay, attempt } = this._reconnect
    const nextAttempt = attempt + 1

    this.emit('reconnecting', { attempt: nextAttempt, delay })

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
          try { relay.conn.destroy() } catch {}
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
    const relay = this.relays.get(relayPubkeyHex)
    if (relay) relay.lastSeen = Date.now()

    const appKeyHex = b4a.toString(msg.appKey, 'hex')
    const entry = this.seedRequests.get(appKeyHex)

    if (entry) {
      entry.acceptances.push(msg)
    }

    this.emit('seed-accepted', {
      appKey: appKeyHex,
      relay: b4a.toString(msg.relayPubkey, 'hex'),
      region: msg.region
    })
  }

  _serializeForSigning (msg) {
    const parts = [msg.appKey]
    for (const dk of msg.discoveryKeys) parts.push(dk)
    const meta = Buffer.alloc(24)
    const view = new DataView(meta.buffer, meta.byteOffset)
    view.setUint8(0, msg.replicationFactor)
    view.setBigUint64(8, BigInt(msg.maxStorageBytes))
    view.setBigUint64(16, BigInt(msg.ttlSeconds))
    parts.push(meta)
    return b4a.concat(parts)
  }

  _ensureStarted () {
    if (!this._started) throw new Error('Client not started — call await app.start() first')
    if (!this.store) throw new Error('No store available — pass a storage path or { store } option')
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

    // Close all drives
    for (const [keyHex, drive] of this.drives) {
      try { await this.swarm.leave(drive.discoveryKey) } catch {}
      try { await drive.close() } catch {}
      this.drives.delete(keyHex)
    }

    // Leave discovery topic
    if (this._discoveryTopic) {
      try { await this.swarm.leave(RELAY_DISCOVERY_TOPIC) } catch {}
      this._discoveryTopic = null
    }

    this.relays.clear()
    this.seedRequests.clear()
    this.reservations.clear()

    // Stop and persist bootstrap cache
    if (this._bootstrapCache) {
      this._bootstrapCache.stop()
      try { await this._bootstrapCache.save() } catch {}
      this._bootstrapCache = null
    }

    // Only destroy things we created
    if (this._ownsSwarm && this.swarm) {
      try { await this.swarm.destroy() } catch {}
    }
    if (this._ownsStore && this.store) {
      try { await this.store.close() } catch {}
    }

    this._started = false
    this.emit('destroyed')
  }
}

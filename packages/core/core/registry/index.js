/**
 * Seeding Registry
 *
 * Distributed multi-log registry of seed requests.
 * Each relay has its own append-only local log; peers exchange log keys over
 * a lightweight Protomux metadata channel and replicate/index each other's logs.
 */

import b4a from 'b4a'
import sodium from 'sodium-universal'
import Protomux from 'protomux'
import { EventEmitter } from 'events'
import { isValidHexKey, normalizeContentType, normalizePrivacyTier } from '../constants.js'

// Well-known topic for registry discovery
const REGISTRY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(REGISTRY_TOPIC, b4a.from('hiverelay-seeding-registry-v1'))

const MSG_ANNOUNCE_LOG = 0
const REGISTRY_META_PROTOCOL = 'hiverelay-registry-meta'
const REGISTRY_META_ID = b4a.from('registry-meta-v1')

const META_ENCODING = {
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
    if (len > 64 * 1024) {
      state.start += 4 + len
      return { type: -1, error: 'message too large' }
    }
    const json = state.buffer.subarray(state.start + 4, state.start + 4 + len).toString()
    state.start += 4 + len
    try {
      return JSON.parse(json)
    } catch (_) {
      return { type: -1, error: 'malformed JSON' }
    }
  }
}

export class SeedingRegistry extends EventEmitter {
  constructor (store, swarm, opts = {}) {
    super()
    this.store = store
    this.swarm = swarm
    this.localLog = null
    this.peerLogs = new Map() // logKey hex -> Hypercore
    this.running = false

    // In-memory indexes rebuilt from logs
    this._requests = new Map() // appKey -> latest seed-request entry
    this._acceptances = new Map() // appKey -> [{ relayPubkey, region, timestamp }]
    this._cancellations = new Map() // appKey:publisherPubkey -> cancellation timestamp

    this._indexedOffsets = new Map() // logId -> indexed block count
    this._peerLogMeta = new Map() // logKeyHex -> { log, onAppend }
    this._metaChannels = new WeakMap() // conn -> { channel, msgHandler }
    this._onSwarmConnection = null
    this._onLocalAppend = null
  }

  async start () {
    // Create local log for this node's registry entries
    this.localLog = this.store.get({ name: 'seeding-registry-local' })
    await this.localLog.ready()

    const localLogKeyHex = b4a.toString(this.localLog.key, 'hex')

    // Rebuild index from local log
    await this._indexLog(this.localLog, localLogKeyHex)
    this._onLocalAppend = () => {
      this._indexLog(this.localLog, localLogKeyHex).catch((err) => {
        this.emit('index-error', { context: 'local-append', error: err.message || String(err) })
      })
    }
    this.localLog.on('append', this._onLocalAppend)

    // Join DHT topic to discover other registry peers
    this.swarm.join(REGISTRY_TOPIC, { server: true, client: true })

    // Listen for new connections to exchange registry log keys and replicate logs
    this._onSwarmConnection = (conn, info) => this._onConnection(conn, info)
    this.swarm.on('connection', this._onSwarmConnection)

    this.running = true
    this.emit('started', {
      key: localLogKeyHex
    })
  }

  _onConnection (conn, info) {
    if (!this.localLog) return

    // Always replicate our local log
    this.localLog.replicate(conn)

    // Exchange log keys so peers can replicate/index each other's logs
    this._attachMetaChannel(conn, info)
  }

  _attachMetaChannel (conn, info) {
    if (this._metaChannels.has(conn)) return

    const mux = Protomux.from(conn)
    const channel = mux.createChannel({
      protocol: REGISTRY_META_PROTOCOL,
      id: REGISTRY_META_ID,
      onopen: () => {
        if (!this.localLog) return
        const entry = this._metaChannels.get(conn)
        if (!entry) return
        const localLogKeyHex = b4a.toString(this.localLog.key, 'hex')
        entry.msgHandler.send({
          type: MSG_ANNOUNCE_LOG,
          logKey: localLogKeyHex,
          peerPubkey: this.swarm?.keyPair?.publicKey
            ? b4a.toString(this.swarm.keyPair.publicKey, 'hex')
            : null
        })
      }
    })

    if (!channel) return

    const msgHandler = channel.addMessage({
      encoding: META_ENCODING,
      onmessage: (msg) => this._onMetaMessage(conn, info, msg)
    })

    this._metaChannels.set(conn, { channel, msgHandler })
    channel.open()
  }

  _onMetaMessage (conn, info, msg) {
    if (!msg || msg.type === -1) return
    if (msg.type !== MSG_ANNOUNCE_LOG) return
    if (!msg.logKey || typeof msg.logKey !== 'string') return
    if (!isValidHexKey(msg.logKey, 64)) return

    const peerPubkey = msg.peerPubkey || (
      info?.publicKey ? b4a.toString(info.publicKey, 'hex') : null
    )

    this._registerPeerLog(msg.logKey, peerPubkey, conn).catch((err) => {
      this.emit('peer-log-error', {
        logKey: msg.logKey,
        peerPubkey,
        error: err.message || String(err)
      })
    })
  }

  async _registerPeerLog (logKeyHex, peerPubkey, conn) {
    if (!this.localLog) return

    const localLogKeyHex = b4a.toString(this.localLog.key, 'hex')
    if (logKeyHex === localLogKeyHex) return

    // Already known: just ensure replication on this connection
    const existing = this._peerLogMeta.get(logKeyHex)
    if (existing) {
      existing.log.replicate(conn)
      return
    }

    const log = this.store.get(b4a.from(logKeyHex, 'hex'))
    await log.ready()
    log.replicate(conn)

    await this._indexLog(log, logKeyHex)

    const onAppend = () => {
      this._indexLog(log, logKeyHex).catch((err) => {
        this.emit('index-error', {
          context: 'peer-append',
          logKey: logKeyHex,
          peerPubkey,
          error: err.message || String(err)
        })
      })
    }
    log.on('append', onAppend)

    this.peerLogs.set(logKeyHex, log)
    this._peerLogMeta.set(logKeyHex, { log, onAppend, peerPubkey })

    this.emit('peer-log-discovered', {
      logKey: logKeyHex,
      peerPubkey,
      blocks: log.length
    })
  }

  async _indexLog (log, logId = null) {
    const id = logId || b4a.toString(log.key, 'hex')
    let offset = this._indexedOffsets.get(id) || 0

    for (let i = offset; i < log.length; i++) {
      try {
        const block = await log.get(i)
        if (!block) continue
        const entry = JSON.parse(b4a.toString(block))
        this._applyEntry(entry)
      } catch (err) {
        this.emit('index-error', { context: 'indexLog', logId: id, index: i, error: err.message || String(err) })
      } finally {
        offset = i + 1
        this._indexedOffsets.set(id, offset)
      }
    }
  }

  _applyEntry (entry) {
    if (entry.type === 'seed-request') {
      const cancelKey = entry.appKey + ':' + entry.publisherPubkey
      const canceledAt = this._cancellations.get(cancelKey)
      if (canceledAt && canceledAt >= entry.timestamp) return

      const current = this._requests.get(entry.appKey)
      if (!current || current.timestamp <= entry.timestamp) {
        this._requests.set(entry.appKey, entry)
      }
      return
    }

    if (entry.type === 'seed-accept') {
      if (!this._acceptances.has(entry.appKey)) {
        this._acceptances.set(entry.appKey, [])
      }
      const list = this._acceptances.get(entry.appKey)
      const idx = list.findIndex(a => a.relayPubkey === entry.relayPubkey)
      if (idx === -1) {
        list.push(entry)
      } else if (list[idx].timestamp <= entry.timestamp) {
        list[idx] = entry
      }
      return
    }

    if (entry.type === 'seed-cancel') {
      const cancelKey = entry.appKey + ':' + entry.publisherPubkey
      const existingCancelTs = this._cancellations.get(cancelKey) || 0
      if (entry.timestamp > existingCancelTs) {
        this._cancellations.set(cancelKey, entry.timestamp)
      }

      const current = this._requests.get(entry.appKey)
      if (
        current &&
        current.publisherPubkey === entry.publisherPubkey &&
        current.timestamp <= entry.timestamp
      ) {
        this._requests.delete(entry.appKey)
      }
    }
  }

  /**
   * Publish a seed request to the registry
   */
  async publishRequest (request) {
    const privacyTier = normalizePrivacyTier(request.privacyTier, 'public')
    const contentType = normalizeContentType(request.contentType || request.type, 'app')
    const parentKey = typeof request.parentKey === 'string' && isValidHexKey(request.parentKey, 64)
      ? request.parentKey
      : null
    const mountPath = typeof request.mountPath === 'string' && request.mountPath.trim().startsWith('/')
      ? request.mountPath.trim()
      : null
    const entry = {
      type: 'seed-request',
      timestamp: Date.now(),
      appKey: b4a.toString(request.appKey, 'hex'),
      discoveryKeys: request.discoveryKeys.map(dk => b4a.toString(dk, 'hex')),
      contentType,
      parentKey,
      mountPath,
      replicationFactor: request.replicationFactor || 3,
      geoPreference: request.geoPreference || [],
      maxStorageBytes: request.maxStorageBytes || 0,
      bountyRate: request.bountyRate || 0,
      ttlSeconds: request.ttlSeconds || 30 * 24 * 3600, // 30 days default
      privacyTier,
      publisherPubkey: b4a.toString(request.publisherPubkey, 'hex')
    }

    await this.localLog.append(b4a.from(JSON.stringify(entry)))
    this._applyEntry(entry)
    this.emit('request-published', entry)
    return entry
  }

  /**
   * Record a seed acceptance in the registry
   */
  async recordAcceptance (appKeyHex, relayPubkeyHex, region) {
    const entry = {
      type: 'seed-accept',
      timestamp: Date.now(),
      appKey: appKeyHex,
      relayPubkey: relayPubkeyHex,
      region
    }

    await this.localLog.append(b4a.from(JSON.stringify(entry)))
    this._applyEntry(entry)
    this.emit('acceptance-recorded', entry)
    return entry
  }

  /**
   * Record a seed cancellation
   */
  async cancelRequest (appKeyHex, publisherPubkeyHex) {
    const entry = {
      type: 'seed-cancel',
      timestamp: Date.now(),
      appKey: appKeyHex,
      publisherPubkey: publisherPubkeyHex
    }

    await this.localLog.append(b4a.from(JSON.stringify(entry)))
    this._applyEntry(entry)
    this.emit('request-cancelled', entry)
    return entry
  }

  /**
   * Query active seed requests, optionally filtered
   */
  async getActiveRequests (filter = {}) {
    const now = Date.now()
    const results = []

    for (const [appKey, entry] of this._requests) {
      // Check if cancelled
      const cancelKey = appKey + ':' + entry.publisherPubkey
      const canceledAt = this._cancellations.get(cancelKey)
      if (canceledAt && canceledAt >= entry.timestamp) continue

      // Check TTL
      const expiresAt = entry.timestamp + (entry.ttlSeconds * 1000)
      if (expiresAt < now) continue

      // Apply filters
      if (filter.region && entry.geoPreference.length > 0) {
        if (!entry.geoPreference.includes(filter.region)) continue
      }
      if (filter.maxStorageBytes && entry.maxStorageBytes > filter.maxStorageBytes) continue

      results.push(entry)
    }

    return results
  }

  /**
   * Get relays currently seeding an app
   */
  async getRelaysForApp (appKeyHex) {
    return this._acceptances.get(appKeyHex) || []
  }

  get key () {
    return this.localLog ? this.localLog.key : null
  }

  async stop () {
    this.running = false
    try { await this.swarm.leave(REGISTRY_TOPIC) } catch (err) {
      this.emit('stop-error', { operation: 'swarm.leave', error: err.message })
    }
    if (this._onSwarmConnection) {
      this.swarm.removeListener('connection', this._onSwarmConnection)
      this._onSwarmConnection = null
    }
    if (this.localLog && this._onLocalAppend) {
      this.localLog.removeListener('append', this._onLocalAppend)
      this._onLocalAppend = null
    }
    for (const { log, onAppend } of this._peerLogMeta.values()) {
      if (onAppend) log.removeListener('append', onAppend)
    }
    if (this.localLog) {
      try { await this.localLog.close() } catch (err) {
        this.emit('stop-error', { operation: 'localLog.close', error: err.message })
      }
    }
    for (const log of this.peerLogs.values()) {
      try { await log.close() } catch (err) {
        this.emit('stop-error', { operation: 'peerLog.close', error: err.message })
      }
    }
    this.peerLogs.clear()
    this._peerLogMeta.clear()
    this._indexedOffsets.clear()
    this.emit('stopped')
  }
}

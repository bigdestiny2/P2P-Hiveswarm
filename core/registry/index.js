/**
 * Seeding Registry
 *
 * A Hypercore-powered distributed registry of seed requests.
 * Publishers announce apps they want seeded, relays discover and accept them.
 *
 * Each node maintains its own append-only log of registry entries.
 * Nodes discover each other via a well-known DHT topic and replicate
 * their logs, building a merged view of all seed requests.
 *
 * Entry types: seed-request, seed-accept, seed-cancel
 */

import Hypercore from 'hypercore'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { EventEmitter } from 'events'

// Well-known topic for registry discovery
const REGISTRY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(REGISTRY_TOPIC, b4a.from('hiverelay-seeding-registry-v1'))

export class SeedingRegistry extends EventEmitter {
  constructor (store, swarm, opts = {}) {
    super()
    this.store = store
    this.swarm = swarm
    this.localLog = null
    this.peerLogs = new Map() // pubkey hex -> Hypercore
    this.running = false

    // In-memory indexes rebuilt from logs
    this._requests = new Map() // appKey -> seed-request entry
    this._acceptances = new Map() // appKey -> [{ relayPubkey, region, timestamp }]
    this._cancellations = new Set() // appKey:publisherPubkey
  }

  async start () {
    // Create local log for this node's registry entries
    this.localLog = this.store.get({ name: 'seeding-registry-local' })
    await this.localLog.ready()

    // Rebuild index from local log
    await this._indexLog(this.localLog)

    // Join DHT topic to discover other registry peers
    this.swarm.join(REGISTRY_TOPIC, { server: true, client: true })

    // Listen for new connections to replicate registry logs
    this.swarm.on('connection', (conn) => this._onConnection(conn))

    this.running = true
    this.emit('started', {
      key: b4a.toString(this.localLog.key, 'hex')
    })
  }

  _onConnection (conn) {
    // Replicate our local log over this connection
    this.localLog.replicate(conn)
  }

  async _indexLog (log) {
    for (let i = 0; i < log.length; i++) {
      try {
        const block = await log.get(i)
        if (!block) continue
        const entry = JSON.parse(b4a.toString(block))
        this._applyEntry(entry)
      } catch {
        continue
      }
    }
  }

  _applyEntry (entry) {
    if (entry.type === 'seed-request') {
      this._requests.set(entry.appKey, entry)
    } else if (entry.type === 'seed-accept') {
      if (!this._acceptances.has(entry.appKey)) {
        this._acceptances.set(entry.appKey, [])
      }
      const list = this._acceptances.get(entry.appKey)
      // Deduplicate by relay pubkey
      if (!list.some(a => a.relayPubkey === entry.relayPubkey)) {
        list.push(entry)
      }
    } else if (entry.type === 'seed-cancel') {
      const cancelKey = entry.appKey + ':' + entry.publisherPubkey
      this._cancellations.add(cancelKey)
      this._requests.delete(entry.appKey)
    }
  }

  /**
   * Publish a seed request to the registry
   */
  async publishRequest (request) {
    const entry = {
      type: 'seed-request',
      timestamp: Date.now(),
      appKey: b4a.toString(request.appKey, 'hex'),
      discoveryKeys: request.discoveryKeys.map(dk => b4a.toString(dk, 'hex')),
      replicationFactor: request.replicationFactor || 3,
      geoPreference: request.geoPreference || [],
      maxStorageBytes: request.maxStorageBytes || 0,
      bountyRate: request.bountyRate || 0,
      ttlSeconds: request.ttlSeconds || 30 * 24 * 3600, // 30 days default
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
      if (this._cancellations.has(cancelKey)) continue

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
    try { await this.swarm.leave(REGISTRY_TOPIC) } catch {}
    if (this.localLog) {
      try { await this.localLog.close() } catch {}
    }
    for (const log of this.peerLogs.values()) {
      try { await log.close() } catch {}
    }
    this.peerLogs.clear()
    this.emit('stopped')
  }
}

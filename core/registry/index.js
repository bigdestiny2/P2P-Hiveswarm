/**
 * Seeding Registry
 *
 * An Autobase-powered distributed registry of seed requests.
 * Publishers announce apps they want seeded, relays discover and accept them.
 *
 * The registry is a multi-writer data structure where:
 * - Anyone can write seed requests
 * - Anyone can read the full registry
 * - Relay nodes filter requests matching their capacity
 */

import Autobase from 'autobase'
import b4a from 'b4a'
import { EventEmitter } from 'events'

export class SeedingRegistry extends EventEmitter {
  constructor (store, swarm, opts = {}) {
    super()
    this.store = store
    this.swarm = swarm
    this.autobase = null
    this.registryKey = opts.registryKey || null // null = create new
    this.running = false
  }

  async start () {
    // Create or join the registry autobase
    this.autobase = new Autobase(this.store, this.registryKey, {
      apply: this._apply.bind(this),
      open: (store) => store.get('registry-view'),
      valueEncoding: 'json'
    })

    await this.autobase.ready()

    // Join the swarm for the registry's discovery key
    if (this.autobase.key) {
      const topic = this.autobase.discoveryKey || this.autobase.key
      this.swarm.join(topic, { server: true, client: true })
    }

    this.running = true
    this.emit('started', {
      key: this.autobase.key ? b4a.toString(this.autobase.key, 'hex') : null
    })
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

    await this.autobase.append(JSON.stringify(entry))
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

    await this.autobase.append(JSON.stringify(entry))
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

    await this.autobase.append(JSON.stringify(entry))
    this.emit('request-cancelled', entry)
    return entry
  }

  /**
   * Query active seed requests, optionally filtered
   */
  async getActiveRequests (filter = {}) {
    const view = this.autobase.view
    if (!view) return []

    const requests = []
    const now = Date.now()

    for (let i = 0; i < view.length; i++) {
      try {
        const block = await view.get(i)
        if (!block) continue
        const entry = JSON.parse(block.toString())

        if (entry.type !== 'seed-request') continue

        // Check TTL
        const expiresAt = entry.timestamp + (entry.ttlSeconds * 1000)
        if (expiresAt < now) continue

        // Apply filters
        if (filter.region && entry.geoPreference.length > 0) {
          if (!entry.geoPreference.includes(filter.region)) continue
        }
        if (filter.maxStorageBytes && entry.maxStorageBytes > filter.maxStorageBytes) continue

        requests.push(entry)
      } catch {
        continue
      }
    }

    return requests
  }

  /**
   * Get relays currently seeding an app
   */
  async getRelaysForApp (appKeyHex) {
    const view = this.autobase.view
    if (!view) return []

    const relays = []

    for (let i = 0; i < view.length; i++) {
      try {
        const block = await view.get(i)
        if (!block) continue
        const entry = JSON.parse(block.toString())

        if (entry.type === 'seed-accept' && entry.appKey === appKeyHex) {
          relays.push(entry)
        }
      } catch {
        continue
      }
    }

    return relays
  }

  /**
   * Autobase apply function — linearizes the DAG into the view
   */
  async _apply (batch, clocks, change) {
    for (const node of batch) {
      try {
        const entry = JSON.parse(node.value.toString())
        await change.append(JSON.stringify(entry))
      } catch {
        // Skip malformed entries
      }
    }
  }

  async stop () {
    this.running = false
    if (this.autobase) await this.autobase.close()
    this.emit('stopped')
  }
}

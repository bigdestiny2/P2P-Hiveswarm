/**
 * Catalog Sync — Automatic Cross-Relay App Replication
 *
 * Watches the network discovery service for peer relays, fetches their
 * catalogs, and auto-seeds any apps this relay doesn't already have.
 *
 * This ensures the network is as robust as possible — every relay
 * mirrors every app by default, providing maximum redundancy.
 *
 * Configurable policies:
 *   - enabled: true/false (default: true)
 *   - syncInterval: how often to check peer catalogs (default: 60s)
 *   - maxStoragePercent: stop syncing if storage exceeds this % (default: 90)
 *   - allowlist/blocklist: filter which apps to replicate
 *   - blindApps: whether to replicate blind/encrypted apps (default: true)
 */

import { EventEmitter } from 'events'
import http from 'http'

const DEFAULT_SYNC_INTERVAL = 60_000    // 1 minute
const CATALOG_FETCH_TIMEOUT = 10_000    // 10s per relay
const MAX_CONCURRENT_SEEDS = 3          // Don't flood with parallel seeds
const BACKOFF_BASE = 5_000              // 5s base for retry backoff
const BACKOFF_MAX = 5 * 60_000          // 5 min max backoff

export class CatalogSync extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.node = opts.node                // relay node reference (for seedApp, seededApps)
    this.discovery = opts.discovery      // NetworkDiscovery instance
    this.config = {
      enabled: opts.enabled !== false,
      syncInterval: opts.syncInterval || DEFAULT_SYNC_INTERVAL,
      maxStoragePercent: opts.maxStoragePercent || 90,
      allowlist: opts.allowlist || null,        // null = allow all
      blocklist: new Set(opts.blocklist || []),
      blindApps: opts.blindApps !== false
    }

    this._syncTimer = null
    this._syncing = false
    this._seenApps = new Map()           // appKey -> { firstSeen, lastSeen, source }
    this._failedAttempts = new Map()     // appKey -> { count, nextRetry }
    this._stats = {
      totalSynced: 0,
      totalSkipped: 0,
      totalFailed: 0,
      lastSyncAt: null,
      lastSyncDuration: 0,
      peersPolled: 0,
      appsDiscovered: 0
    }
    this.running = false
  }

  start () {
    if (!this.config.enabled || this.running) return
    if (!this.discovery || !this.node) {
      this.emit('error', new Error('CatalogSync requires node and discovery references'))
      return
    }

    this.running = true

    // Run first sync after a short delay to let the network settle
    setTimeout(() => {
      if (this.running) this._sync().catch(err => this.emit('sync-error', err))
    }, 10_000)

    this._syncTimer = setInterval(() => {
      if (this.running && !this._syncing) {
        this._sync().catch(err => this.emit('sync-error', err))
      }
    }, this.config.syncInterval)
    if (this._syncTimer.unref) this._syncTimer.unref()

    this.emit('started', { syncInterval: this.config.syncInterval })
  }

  async stop () {
    this.running = false
    if (this._syncTimer) {
      clearInterval(this._syncTimer)
      this._syncTimer = null
    }
    this.emit('stopped')
  }

  /**
   * Main sync loop — fetch catalogs from all known peers, seed missing apps.
   */
  async _sync () {
    if (this._syncing) return
    this._syncing = true
    const startTime = Date.now()

    try {
      const relays = this._getPeerRelays()
      if (relays.length === 0) {
        this._syncing = false
        return
      }

      this._stats.peersPolled = relays.length

      // Fetch all catalogs in parallel
      const catalogs = await Promise.allSettled(
        relays.map(relay => this._fetchCatalog(relay))
      )

      // Collect all unique apps across all peers
      const remoteApps = new Map() // appKey -> { app, sources[] }
      for (let i = 0; i < catalogs.length; i++) {
        if (catalogs[i].status !== 'fulfilled' || !catalogs[i].value) continue
        const { apps, relayKey } = catalogs[i].value
        for (const app of apps) {
          const key = app.driveKey
          if (!key) continue
          if (!remoteApps.has(key)) {
            remoteApps.set(key, { app, sources: [relayKey] })
          } else {
            remoteApps.get(key).sources.push(relayKey)
          }
        }
      }

      this._stats.appsDiscovered = remoteApps.size

      // Filter to apps we don't already have
      const missing = []
      for (const [appKey, { app }] of remoteApps) {
        if (this.node.seededApps.has(appKey)) continue
        if (!this._shouldSync(appKey, app)) continue
        if (this._isBackedOff(appKey)) continue
        missing.push({ appKey, app })
      }

      // Seed missing apps (throttled)
      if (missing.length > 0) {
        this.emit('sync-found', { missing: missing.length, total: remoteApps.size })
        await this._seedMissing(missing)
      }

      // Sync identity attestations from peers
      await this._syncIdentities(relays)

      this._stats.lastSyncAt = Date.now()
      this._stats.lastSyncDuration = Date.now() - startTime
      this.emit('sync-complete', {
        synced: this._stats.totalSynced,
        duration: this._stats.lastSyncDuration,
        peersPolled: relays.length,
        appsDiscovered: remoteApps.size
      })
    } catch (err) {
      this.emit('sync-error', err)
    } finally {
      this._syncing = false
    }
  }

  /**
   * Check if we should sync a given app.
   */
  _shouldSync (appKey, app) {
    // Blocklist check
    if (this.config.blocklist.has(appKey)) {
      this._stats.totalSkipped++
      return false
    }

    // Allowlist check (if set, only sync allowed apps)
    if (this.config.allowlist && !this.config.allowlist.includes(appKey)) {
      this._stats.totalSkipped++
      return false
    }

    // Blind app policy
    if (app.blind && !this.config.blindApps) {
      this._stats.totalSkipped++
      return false
    }

    // Storage capacity check
    if (this._isStorageFull()) {
      this._stats.totalSkipped++
      return false
    }

    return true
  }

  /**
   * Check if storage is above the configured threshold.
   */
  _isStorageFull () {
    if (!this.node.metrics) return false
    const summary = this.node.metrics.getSummary()
    if (!summary.storage) return false
    const { used, max } = summary.storage
    if (!max || max === 0) return false
    const percent = (used / max) * 100
    return percent >= this.config.maxStoragePercent
  }

  /**
   * Check if an app is in backoff due to previous failed attempts.
   */
  _isBackedOff (appKey) {
    const failed = this._failedAttempts.get(appKey)
    if (!failed) return false
    return Date.now() < failed.nextRetry
  }

  /**
   * Record a failed seed attempt with exponential backoff.
   */
  _recordFailure (appKey) {
    const existing = this._failedAttempts.get(appKey) || { count: 0 }
    existing.count++
    const delay = Math.min(BACKOFF_BASE * Math.pow(2, existing.count - 1), BACKOFF_MAX)
    existing.nextRetry = Date.now() + delay
    this._failedAttempts.set(appKey, existing)
    this._stats.totalFailed++
  }

  /**
   * Seed missing apps with concurrency throttling.
   */
  async _seedMissing (missing) {
    // Process in batches
    for (let i = 0; i < missing.length; i += MAX_CONCURRENT_SEEDS) {
      if (!this.running) break

      const batch = missing.slice(i, i + MAX_CONCURRENT_SEEDS)
      const results = await Promise.allSettled(
        batch.map(({ appKey, app }) => this._seedOne(appKey, app))
      )

      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'rejected') {
          this._recordFailure(batch[j].appKey)
          this.emit('seed-failed', {
            appKey: batch[j].appKey,
            error: results[j].reason?.message || 'Unknown error'
          })
        }
      }
    }
  }

  /**
   * Seed a single app from the network.
   */
  async _seedOne (appKey, app) {
    const opts = {
      appId: app.id || null,
      version: app.version || null,
      blind: app.blind || false
    }

    this.emit('seeding-app', { appKey, name: app.name, blind: app.blind })

    const result = await this.node.seedApp(appKey, opts)

    if (result.alreadySeeded) return result

    this._stats.totalSynced++
    this._seenApps.set(appKey, {
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      name: app.name
    })

    // Clear any backoff on success
    this._failedAttempts.delete(appKey)

    this.emit('app-synced', {
      appKey,
      name: app.name,
      blind: app.blind,
      discoveryKey: result.discoveryKey
    })

    return result
  }

  /**
   * Sync identity attestations from peer relays.
   * Fetches developer lists from peers and imports attestations we don't have.
   */
  async _syncIdentities (relays) {
    if (!this.node.identity) return

    const attestation = this.node.identity.attestation
    let imported = 0

    for (const relay of relays) {
      try {
        const data = await this._fetchJson(relay, '/api/v1/identity/developers')
        if (!data || !data.developers) continue

        for (const dev of data.developers) {
          // Skip developers we already know about
          if (attestation.developers.has(dev.pubkey)) continue

          // Import each app key attestation
          for (const appKey of dev.appKeys) {
            if (attestation.appKeyIndex.has(appKey)) continue

            // We can't verify the original signature, but we trust
            // the peer relay already verified it. Store as peer-attested.
            if (!attestation.developers.has(dev.pubkey)) {
              attestation.developers.set(dev.pubkey, {
                appKeys: new Map(),
                registeredAt: dev.registeredAt,
                lastSeen: dev.lastSeen
              })
            }
            const devEntry = attestation.developers.get(dev.pubkey)
            devEntry.appKeys.set(appKey, {
              attestedAt: dev.registeredAt,
              source: 'peer-sync'
            })
            attestation.appKeyIndex.set(appKey, dev.pubkey)
            imported++
          }

          // Sync profile if available
          if (dev.profile && dev.profile.displayName) {
            const existing = await this.node.identity.developerStore.getCompactProfile(dev.pubkey)
            if (!existing || !existing.displayName) {
              this.node.identity.developerStore.setProfile(dev.pubkey, dev.profile)
            }
          }
        }
      } catch {
        // Silently skip relays that don't have identity endpoints
      }
    }

    if (imported > 0) {
      await attestation.save()
      this.emit('identities-synced', { imported })
    }
  }

  /**
   * Fetch JSON from a relay API endpoint.
   */
  async _fetchJson (relay, path) {
    return new Promise((resolve, reject) => {
      const url = `http://${relay.host}:${relay.apiPort}${path}`
      const req = http.get(url, { timeout: CATALOG_FETCH_TIMEOUT }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null) }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { body += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(body)) } catch { resolve(null) }
        })
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
    })
  }

  /**
   * Get list of peer relays with known API ports.
   */
  _getPeerRelays () {
    if (!this.discovery || !this.discovery._relays) return []

    const relays = []
    for (const [pubkey, relay] of this.discovery._relays) {
      if (relay.apiPort && relay.online && relay.host) {
        relays.push(relay)
      }
    }
    return relays
  }

  /**
   * Fetch catalog from a remote relay.
   */
  async _fetchCatalog (relay) {
    return new Promise((resolve, reject) => {
      const url = `http://${relay.host}:${relay.apiPort}/catalog.json?pageSize=500`

      const req = http.get(url, { timeout: CATALOG_FETCH_TIMEOUT }, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} from ${relay.publicKey.slice(0, 12)}`))
        }

        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { body += chunk })
        res.on('end', () => {
          try {
            const data = JSON.parse(body)
            resolve({
              relayKey: data.relayKey || relay.publicKey,
              apps: data.apps || []
            })
          } catch (err) {
            reject(new Error(`Invalid JSON from ${relay.publicKey.slice(0, 12)}`))
          }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`Timeout fetching catalog from ${relay.publicKey.slice(0, 12)}`))
      })
    })
  }

  /**
   * Force an immediate sync cycle (useful for API triggers).
   */
  async syncNow () {
    return this._sync()
  }

  /**
   * Get sync status and statistics.
   */
  getStats () {
    return {
      running: this.running,
      syncing: this._syncing,
      config: {
        syncInterval: this.config.syncInterval,
        maxStoragePercent: this.config.maxStoragePercent,
        blindApps: this.config.blindApps,
        hasAllowlist: !!this.config.allowlist,
        blocklistSize: this.config.blocklist.size
      },
      stats: { ...this._stats },
      knownPeers: this._getPeerRelays().length,
      pendingRetries: this._failedAttempts.size,
      syncedApps: Array.from(this._seenApps.entries()).map(([key, info]) => ({
        appKey: key,
        name: info.name,
        syncedAt: info.firstSeen
      }))
    }
  }
}

import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { EventEmitter } from 'events'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { isValidHexKey, normalizeContentType, normalizePrivacyTier } from '../constants.js'

/**
 * AppLifecycle — owns seeding, unseeding, and manifest indexing for a RelayNode.
 *
 * Holds the seededApps Map (via node.appRegistry.apps) and the seed mutex. The
 * owning RelayNode delegates its public seedApp/unseedApp/verifyUnseedRequest/
 * broadcastUnseed methods here, and forwards emitted events so existing
 * listeners continue to work.
 */
export class AppLifecycle extends EventEmitter {
  constructor (node) {
    super()
    this.node = node
    this._seedMutex = false
  }

  /**
   * The seededApps Map. Delegates to the AppRegistry so existing external
   * callers that reach into node.seededApps keep seeing the same instance.
   */
  get seededApps () {
    return this.node.appRegistry.apps
  }

  async reseedFromRegistry () {
    const node = this.node
    const entries = await node.appRegistry.load()
    if (!entries.length) {
      await this.migrateOldSeededApps()
      return
    }

    for (const entry of entries) {
      if (!entry.appKey) continue
      try {
        await this.seedApp(entry.appKey, {
          appId: entry.appId || null,
          type: entry.type || 'app',
          parentKey: entry.parentKey || null,
          mountPath: entry.mountPath || null,
          version: entry.version || null,
          privacyTier: entry.privacyTier || null
        })
        this.emit('reseeded', { appKey: entry.appKey })
      } catch (err) {
        this.emit('reseed-error', { appKey: entry.appKey, error: err })
      }
    }
  }

  /**
   * One-time migration from old seeded-apps.json to unified app-registry.json.
   */
  async migrateOldSeededApps () {
    const node = this.node
    try {
      const oldPath = join(node.config.storage, 'seeded-apps.json')
      const data = JSON.parse(await readFile(oldPath, 'utf8'))
      const entries = Array.isArray(data) ? data : []
      if (!entries.length) return

      for (const entry of entries) {
        const appKey = entry.appKey
        if (!appKey) continue
        try {
          await this.seedApp(appKey, {
            appId: entry.appId || null,
            type: entry.type || 'app',
            parentKey: entry.parentKey || null,
            mountPath: entry.mountPath || null,
            version: entry.version || null,
            privacyTier: entry.privacyTier || null
          })
          this.emit('reseeded', { appKey, source: 'migration' })
        } catch (err) {
          this.emit('reseed-error', { appKey, error: err })
        }
      }
    } catch (_) {
      // No old file — fresh install
    }
  }

  async seedApp (appKeyHex, opts = {}) {
    const node = this.node
    if (!node.seeder) throw new Error('Seeding not enabled')
    if (!isValidHexKey(appKeyHex)) throw new Error('Invalid app key: must be 64 hex characters')

    const contentType = normalizeContentType(opts.type, 'app')
    const parentKey = typeof opts.parentKey === 'string' ? opts.parentKey.toLowerCase() : null
    const mountPath = typeof opts.mountPath === 'string' ? opts.mountPath.trim() : null
    if (parentKey && !isValidHexKey(parentKey, 64)) {
      throw new Error('Invalid parent key: must be 64 hex characters')
    }
    if (mountPath && !mountPath.startsWith('/')) {
      throw new Error('Invalid mountPath: must start with "/"')
    }
    if ((parentKey || mountPath) && contentType !== 'drive') {
      throw new Error('parentKey and mountPath are only valid for content type "drive"')
    }

    const privacyTier = normalizePrivacyTier(opts.privacyTier || opts.tier, 'public')
    if (node.policyGuard) {
      const policyOperation = node.config.strictSeedingPrivacy !== false
        ? 'replicate-user-data'
        : (contentType === 'app' ? 'serve-code' : 'replicate-user-data')
      const policy = node.policyGuard.check(appKeyHex, privacyTier, policyOperation)
      if (!policy.allowed) {
        throw new Error(`POLICY_VIOLATION: ${policy.reason}`)
      }
    }

    // Already seeding this exact key — no-op
    if (this.seededApps.has(appKeyHex)) {
      const existing = this.seededApps.get(appKeyHex)
      return { discoveryKey: b4a.toString(existing.discoveryKey, 'hex'), alreadySeeded: true }
    }

    // Acquire seed mutex to prevent concurrent eviction races
    while (this._seedMutex) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    this._seedMutex = true
    try {
      return await this._seedAppInner(appKeyHex, opts, contentType, parentKey, mountPath, privacyTier)
    } finally {
      this._seedMutex = false
    }
  }

  async _seedAppInner (appKeyHex, opts, contentType, parentKey, mountPath, privacyTier) {
    const node = this.node

    // Re-check after acquiring mutex — another call may have seeded it
    if (this.seededApps.has(appKeyHex)) {
      const existing = this.seededApps.get(appKeyHex)
      return { discoveryKey: b4a.toString(existing.discoveryKey, 'hex'), alreadySeeded: true }
    }

    // Evict oldest app if storage capacity would be exceeded
    if (node.config.enableEviction !== false && node.seeder.totalBytesStored >= node.config.maxStorageBytes && this.seededApps.size > 0) {
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
        await node._evictOldestApp()
      } else {
        throw new Error('Storage capacity exceeded and no eligible app to evict')
      }
    }

    const publisherPubkey = opts.publisherPubkey
      ? (typeof opts.publisherPubkey === 'string'
          ? opts.publisherPubkey
          : b4a.toString(opts.publisherPubkey, 'hex'))
      : null

    const appKey = b4a.from(appKeyHex, 'hex')
    const drive = new Hyperdrive(node.store, appKey)

    try {
      await drive.ready()

      const discoveryKey = drive.discoveryKey

      // Signal that we're looking for peers for this drive's cores
      const done = drive.findingPeers ? drive.findingPeers() : null
      node.swarm.join(discoveryKey, { server: true, client: true })
      node.swarm.flush().then(() => { if (done) done() }).catch(() => { if (done) done() })

      // Eagerly replicate drive content with retry loop
      const eagerReplicate = async () => {
        const MAX_RETRIES = 6
        const RETRY_DELAYS = [5000, 10000, 15000, 30000, 60000, 120000]

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          // Bail out if the drive was closed (e.g. by unseedApp)
          if (drive.closed || drive.closing) return

          try {
            node.swarm.join(discoveryKey, { server: true, client: true })
            await node.swarm.flush()

            if (drive.closed || drive.closing) return

            await Promise.race([
              drive.update({ wait: true }),
              new Promise((_resolve, reject) => setTimeout(() => reject(new Error('update timeout')), 30000))
            ])

            if (drive.version > 0 && !drive.closed && !drive.closing) {
              let dl
              try {
                dl = drive.download('/')
              } catch (_dlErr) {
                // Drive closed between check and download call
                return
              }
              await Promise.race([
                dl.done(),
                new Promise((_resolve, reject) => setTimeout(() => reject(new Error('download timeout')), 120000))
              ]).catch(() => {}) // Swallow download errors (drive may close mid-download)

              if (drive.closed || drive.closing) return

              // After content is downloaded, read manifest and deduplicate
              await this._indexAppManifest(appKeyHex, drive)

              this.emit('reseeded', { appKey: appKeyHex, version: drive.version })
              return
            }
          } catch (_) {
            // SESSION_CLOSED, timeout, or drive closed during replication
            if (drive.closed || drive.closing) return
          }

          if (attempt < MAX_RETRIES - 1) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]))
          }
        }
        this.emit('reseed-error', { appKey: appKeyHex, error: 'max retries exceeded' })
      }
      eagerReplicate().catch(() => {})

      node.appRegistry.set(appKeyHex, {
        drive,
        discoveryKey,
        startedAt: Date.now(),
        bytesServed: 0,
        type: contentType,
        parentKey,
        mountPath,
        appId: opts.appId || null,
        version: opts.version || null,
        privacyTier,
        name: opts.name || opts.appId || null,
        description: opts.description || '',
        author: opts.author || null,
        categories: Array.isArray(opts.categories) ? opts.categories : null,
        blind: opts.blind || false,
        publisherPubkey
      })

      if (node.distributedDriveBridge) {
        node.distributedDriveBridge.registerDrive(appKeyHex, drive)
      }

      this.emit('seeding', { appKey: appKeyHex, discoveryKey: b4a.toString(discoveryKey, 'hex') })
      return { discoveryKey: b4a.toString(discoveryKey, 'hex') }
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
    const node = this.node
    try {
      const manifestBuf = await Promise.race([
        drive.get('/manifest.json'),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('manifest timeout')), 5000))
      ])
      if (!manifestBuf) return

      const manifest = JSON.parse(manifestBuf.toString())
      const manifestAppId = manifest.id || (manifest.name ? manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : null)
      const version = manifest.version || '0.0.0'
      const manifestType = normalizeContentType(
        manifest.contentType ||
        manifest.hiverelay?.contentType ||
        manifest.hiverelay?.type ||
        manifest.type,
        null
      )
      const existing = node.appRegistry.get(appKeyHex)
      const contentType = manifestType || normalizeContentType(existing?.type, 'app')
      const appId = manifestAppId || existing?.appId || null
      const parentKey = isValidHexKey(manifest.parentKey, 64)
        ? manifest.parentKey
        : existing?.parentKey || null
      const mountPath = typeof manifest.mountPath === 'string' && manifest.mountPath.trim().startsWith('/')
        ? manifest.mountPath.trim()
        : existing?.mountPath || null

      // Update this entry's metadata via the registry
      node.appRegistry.update(appKeyHex, {
        type: contentType,
        parentKey,
        mountPath,
        appId,
        version,
        privacyTier: manifest.privacyTier || manifest.privacy?.tier || manifest.privacy?.mode || undefined,
        name: manifest.name || appId,
        description: manifest.description || '',
        author: manifest.author || null,
        categories: manifest.categories || null
      })

      if (contentType !== 'app') return
      if (!appId) return

      // Check for version conflicts with existing apps
      const conflict = node.appRegistry.checkConflict(appId, appKeyHex, version)
      if (conflict.conflict) {
        if (conflict.shouldReplace) {
          this.emit('app-replaced', {
            appId,
            oldKey: conflict.existingKey,
            oldVersion: conflict.existingVersion,
            newKey: appKeyHex,
            newVersion: version
          })
          await this.unseedApp(conflict.existingKey)
        } else {
          this.emit('app-version-rejected', {
            appId,
            rejectedKey: appKeyHex,
            rejectedVersion: version,
            currentKey: conflict.existingKey,
            currentVersion: conflict.existingVersion
          })
          await this.unseedApp(appKeyHex)
        }
      }
    } catch (_) {
      // No manifest or parse error — skip deduplication silently
    }
  }

  async unseedApp (appKeyHex) {
    const node = this.node
    const entry = node.appRegistry.get(appKeyHex)
    if (!entry) return

    if (node.distributedDriveBridge) {
      node.distributedDriveBridge.unregisterDrive(appKeyHex)
    }

    try { await node.swarm.leave(entry.discoveryKey) } catch (_) {}
    try { await entry.drive.close() } catch (_) {}
    node.appRegistry.delete(appKeyHex) // auto-cleans dedup index + persists

    this.emit('unseeded', { appKey: appKeyHex })
  }

  /**
   * Authenticated unseed: verify the publisher signature before unseeding.
   * The publisher must sign (appKey + 'unseed' + timestamp) with the key
   * that originally published the app (stored in appRegistry.publisherPubkey).
   */
  verifyUnseedRequest (appKeyHex, publisherPubkeyHex, signatureHex, timestamp) {
    const node = this.node
    const entry = node.appRegistry.get(appKeyHex)
    if (!entry) return { ok: false, error: 'APP_NOT_FOUND' }

    // Verify the publisher key matches the one that seeded the app
    if (entry.publisherPubkey && entry.publisherPubkey !== publisherPubkeyHex) {
      return { ok: false, error: 'PUBLISHER_MISMATCH' }
    }

    // If no publisher was stored (legacy app), reject the unseed —
    // operator must use /unseed with API key instead
    if (!entry.publisherPubkey) {
      return { ok: false, error: 'NO_PUBLISHER_KEY: app has no recorded publisher — operator must unseed via /unseed with API key' }
    }

    // Check timestamp freshness (reject if older than 5 minutes)
    const age = Date.now() - timestamp
    if (age > 5 * 60 * 1000 || age < -60_000) {
      return { ok: false, error: 'STALE_TIMESTAMP' }
    }

    // Verify Ed25519 signature over (appKey + 'unseed' + timestamp)
    const appKeyBuf = b4a.from(appKeyHex, 'hex')
    const pubkeyBuf = b4a.from(publisherPubkeyHex, 'hex')
    const sigBuf = b4a.from(signatureHex, 'hex')

    const tsBuf = b4a.alloc(8)
    const tsView = new DataView(tsBuf.buffer, tsBuf.byteOffset)
    tsView.setBigUint64(0, BigInt(timestamp))

    const payload = b4a.concat([appKeyBuf, b4a.from('unseed'), tsBuf])
    const valid = sodium.crypto_sign_verify_detached(sigBuf, payload, pubkeyBuf)

    if (!valid) return { ok: false, error: 'INVALID_SIGNATURE' }
    return { ok: true }
  }

  /**
   * Broadcast an unseed request to all connected peers via P2P.
   */
  broadcastUnseed (appKeyHex, publisherPubkeyHex, signatureHex, timestamp) {
    const node = this.node
    if (!node._seedProtocol) return
    node._seedProtocol.publishUnseedRequest(
      b4a.from(appKeyHex, 'hex'),
      b4a.from(publisherPubkeyHex, 'hex'),
      b4a.from(signatureHex, 'hex'),
      timestamp
    )
  }
}

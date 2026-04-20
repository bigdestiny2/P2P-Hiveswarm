/**
 * Privacy Tier Enforcement
 * =========================
 * Declares and enforces privacy tiers for HiveRelay apps.
 *
 * Three tiers:
 *   "public"      — Data flows through relay in plaintext. Cached, searchable.
 *   "local-first" — App code via relay, user data encrypted on device only.
 *   "p2p-only"    — No relay involvement. Direct peer connections only.
 *
 * The PrivacyManager validates that app behavior matches its declared tier.
 * It wraps the platform APIs (storage, crypto, keys) and blocks operations
 * that violate the declared privacy level.
 */

import b4a from 'b4a'
import { KeyManager } from './keys.js'
import { LocalStorage } from './storage.js'
import { encrypt, decrypt } from './crypto.js'

const TIERS = ['public', 'local-first', 'p2p-only']

export class PrivacyManager {
  /**
   * @param {object} manifest - App privacy manifest
   * @param {string} manifest.appName - App identifier
   * @param {string} manifest.privacyTier - "public" | "local-first" | "p2p-only"
   * @param {object} [manifest.encryption] - Encryption config
   * @param {string} [manifest.encryption.atRest] - "xchacha20" | "none"
   * @param {string} [manifest.encryption.keyStorage] - "device" | "user-password"
   * @param {object} [manifest.sync] - Sync config
   * @param {string} [manifest.sync.mode] - "disabled" | "p2p-only" | "relay-allowed"
   * @param {string} storagePath - Base path for local data
   */
  constructor (manifest, storagePath) {
    if (!manifest.appName) throw new Error('manifest.appName required')
    if (!TIERS.includes(manifest.privacyTier)) {
      throw new Error(`Invalid privacy tier: ${manifest.privacyTier}. Must be one of: ${TIERS.join(', ')}`)
    }

    this.manifest = {
      appName: manifest.appName,
      privacyTier: manifest.privacyTier,
      encryption: {
        atRest: 'xchacha20',
        keyStorage: 'device',
        ...manifest.encryption
      },
      sync: {
        mode: manifest.privacyTier === 'public' ? 'relay-allowed' : 'p2p-only',
        ...manifest.sync
      }
    }

    this.storagePath = storagePath
    this.keyManager = null
    this.localStorage = null
    this._ready = false

    // Audit log — tracks what data went where
    this._auditLog = []
  }

  /**
   * Initialize all platform services according to the declared tier.
   */
  async init () {
    // Key management (all tiers get keys — public apps may not use them)
    this.keyManager = new KeyManager(this.storagePath)
    await this.keyManager.init()

    // Local storage (not used for public tier unless explicitly requested)
    if (this.manifest.privacyTier !== 'public') {
      const dataKey = this.keyManager.dataKey(this.manifest.appName, 'local-storage')
      this.localStorage = new LocalStorage({
        path: this.storagePath,
        name: this.manifest.appName,
        key: dataKey
      })
      await this.localStorage.init()
    }

    this._ready = true
  }

  // ── Tier Info ─────────────────────────────────────────────

  get tier () { return this.manifest.privacyTier }
  get appName () { return this.manifest.appName }

  /**
   * Describe what the current tier allows and blocks.
   */
  describe () {
    const tier = this.manifest.privacyTier
    return {
      tier,
      appName: this.manifest.appName,
      relaySeesAppCode: tier !== 'p2p-only',
      relaySeesUserData: tier === 'public',
      dataStoredLocally: tier !== 'public',
      dataEncryptedAtRest: tier !== 'public',
      syncViaRelay: tier === 'public',
      syncViaP2P: tier !== 'public',
      requiresBothOnline: tier === 'p2p-only'
    }
  }

  // ── Data Operations (tier-enforced) ───────────────────────

  /**
   * Store sensitive data. Enforces tier rules:
   * - public: stores in plaintext (warns)
   * - local-first: encrypts and stores on device
   * - p2p-only: encrypts and stores on device (never syncs)
   *
   * @param {string} key - Entry key
   * @param {object|Buffer|string} value - Data
   * @param {object} [opts]
   * @param {string} [opts.classification] - "public" | "sensitive" | "secret"
   * @returns {object} result with storage details
   */
  async store (key, value, opts = {}) {
    this._ensureReady()
    const classification = opts.classification || 'sensitive'

    // Public tier storing sensitive data: warn
    if (this.manifest.privacyTier === 'public' && classification !== 'public') {
      this._audit('warning', `Storing ${classification} data in public tier app "${this.manifest.appName}". Data will NOT be encrypted.`)
    }

    if (this.manifest.privacyTier === 'public') {
      // Public tier: return data as-is for relay storage (no local encrypted store)
      const buf = this._serialize(value)
      this._audit('store', `Public store: ${key} (${buf.length} bytes, unencrypted)`)
      return {
        key,
        size: buf.length,
        encrypted: false,
        location: 'relay',
        data: buf // Caller sends to relay
      }
    }

    // local-first and p2p-only: encrypt and store locally
    const result = await this.localStorage.set(key, this._serialize(value))
    this._audit('store', `Local store: ${key} (${result.size} bytes, encrypted)`)

    return {
      key,
      size: result.size,
      encrypted: true,
      location: 'device',
      data: null // Data stays on device — not returned for relay
    }
  }

  /**
   * Retrieve data. Enforces tier rules.
   *
   * @param {string} key - Entry key
   * @returns {Buffer|null}
   */
  async retrieve (key) {
    this._ensureReady()

    if (this.manifest.privacyTier === 'public') {
      // Public tier: data lives on relay, not locally
      this._audit('retrieve', `Public retrieve: ${key} — must fetch from relay`)
      return null // Caller must fetch from relay/gateway
    }

    const data = await this.localStorage.get(key)
    if (data) {
      this._audit('retrieve', `Local retrieve: ${key} (${data.length} bytes, decrypted)`)
    }
    return data
  }

  /**
   * Retrieve and parse JSON.
   */
  async retrieveJSON (key) {
    const buf = await this.retrieve(key)
    if (!buf) return null
    return JSON.parse(buf.toString())
  }

  /**
   * Delete stored data.
   */
  async remove (key) {
    this._ensureReady()
    if (this.manifest.privacyTier === 'public') {
      this._audit('delete', `Public delete: ${key} — must remove from relay`)
      return false
    }
    const result = await this.localStorage.delete(key)
    if (result) this._audit('delete', `Local delete: ${key}`)
    return result
  }

  // ── Sync Operations (tier-enforced) ───────────────────────

  /**
   * Prepare data for P2P sync. Returns encrypted blobs.
   *
   * @returns {Map<string, Buffer>|null} Encrypted blobs for sync, or null if sync disabled
   */
  async prepareSyncExport () {
    this._ensureReady()

    if (this.manifest.privacyTier === 'public') {
      this._audit('sync', 'Public tier: sync via relay (no export needed)')
      return null
    }

    if (this.manifest.sync.mode === 'disabled') {
      this._audit('sync', 'Sync disabled by manifest')
      return null
    }

    const blobs = await this.localStorage.exportEncrypted()
    this._audit('sync', `Exported ${blobs.size} encrypted blobs for P2P sync`)
    return blobs
  }

  /**
   * Import synced data from a peer.
   *
   * @param {Map<string, Buffer>} blobs - Encrypted blobs from peer
   * @returns {{ imported: number, failed: number }}
   */
  async importSyncData (blobs) {
    this._ensureReady()

    if (this.manifest.privacyTier === 'public') {
      this._audit('sync', 'Public tier: cannot import local sync data')
      return { imported: 0, failed: 0 }
    }

    const result = await this.localStorage.importEncrypted(blobs)
    this._audit('sync', `Imported ${result.imported} blobs, ${result.failed} failed`)
    return result
  }

  /**
   * Check if relay sync is allowed for this tier.
   */
  canSyncViaRelay () {
    return this.manifest.sync.mode === 'relay-allowed'
  }

  /**
   * Check if P2P sync is allowed for this tier.
   */
  canSyncViaP2P () {
    return this.manifest.sync.mode !== 'disabled'
  }

  // ── Encryption Helpers (tier-aware) ───────────────────────

  /**
   * Encrypt arbitrary data with the app's data key.
   * For sending encrypted blocks to relay (blind mode) or P2P peers.
   *
   * @param {Buffer|string|object} data
   * @returns {Buffer} encrypted
   */
  encryptForTransit (data) {
    this._ensureReady()
    const buf = this._serialize(data)
    const key = this.keyManager.dataKey(this.manifest.appName, 'transit')
    return encrypt(buf, key)
  }

  /**
   * Decrypt data encrypted with encryptForTransit().
   */
  decryptFromTransit (sealed) {
    this._ensureReady()
    const key = this.keyManager.dataKey(this.manifest.appName, 'transit')
    return decrypt(sealed, key)
  }

  /**
   * Get the encryption key for Hyperdrive blind mode.
   * This key encrypts the entire drive — relay stores ciphertext.
   */
  driveEncryptionKey () {
    this._ensureReady()
    if (this.manifest.privacyTier === 'public') {
      return null // No encryption for public drives
    }
    return this.keyManager.dataKey(this.manifest.appName, 'hyperdrive')
  }

  // ── Relay Interaction Rules ───────────────────────────────

  /**
   * Validate whether an operation is allowed given the current tier.
   * Returns { allowed: boolean, reason: string }
   */
  validateOperation (operation) {
    const tier = this.manifest.privacyTier
    const rules = {
      public: {
        'store-on-relay': { allowed: true },
        'read-from-relay': { allowed: true },
        'store-locally': { allowed: true },
        'sync-via-relay': { allowed: true },
        'sync-via-p2p': { allowed: true },
        'send-plaintext-to-relay': { allowed: true }
      },
      'local-first': {
        'store-on-relay': { allowed: false, reason: 'Local-first tier: user data must stay on device' },
        'read-from-relay': { allowed: true }, // App code can come from relay
        'store-locally': { allowed: true },
        'sync-via-relay': { allowed: false, reason: 'Local-first tier: sync only via P2P' },
        'sync-via-p2p': { allowed: true },
        'send-plaintext-to-relay': { allowed: false, reason: 'Local-first tier: data must be encrypted before leaving device' }
      },
      'p2p-only': {
        'store-on-relay': { allowed: false, reason: 'P2P-only tier: no relay storage' },
        'read-from-relay': { allowed: false, reason: 'P2P-only tier: no relay involvement' },
        'store-locally': { allowed: true },
        'sync-via-relay': { allowed: false, reason: 'P2P-only tier: no relay involvement' },
        'sync-via-p2p': { allowed: true },
        'send-plaintext-to-relay': { allowed: false, reason: 'P2P-only tier: no relay involvement' }
      }
    }

    const tierRules = rules[tier]
    if (!tierRules || !tierRules[operation]) {
      return { allowed: false, reason: `Unknown operation: ${operation}` }
    }
    return tierRules[operation]
  }

  // ── Audit Log ─────────────────────────────────────────────

  /**
   * Get the audit log — shows what data went where.
   * Critical for verifying privacy guarantees.
   */
  getAuditLog () {
    return [...this._auditLog]
  }

  /**
   * Get a privacy report — summary of data exposure.
   */
  getPrivacyReport () {
    const stores = this._auditLog.filter(e => e.action === 'store')
    const syncs = this._auditLog.filter(e => e.action === 'sync')
    const warnings = this._auditLog.filter(e => e.action === 'warning')

    const encryptedStores = stores.filter(e => e.detail.includes('encrypted') && !e.detail.includes('unencrypted'))
    const plaintextStores = stores.filter(e => e.detail.includes('unencrypted'))

    return {
      tier: this.manifest.privacyTier,
      appName: this.manifest.appName,
      totalOperations: this._auditLog.length,
      stores: {
        total: stores.length,
        encrypted: encryptedStores.length,
        plaintext: plaintextStores.length
      },
      syncs: syncs.length,
      warnings: warnings.length,
      warningDetails: warnings.map(w => w.detail),
      storageStats: this.localStorage ? this.localStorage.stats() : null,
      relayExposure: this.manifest.privacyTier === 'public'
        ? 'FULL — relay sees all data'
        : this.manifest.privacyTier === 'local-first'
          ? 'APP CODE ONLY — relay sees app code, never user data'
          : 'NONE — relay is not involved'
    }
  }

  // ── Internal ──────────────────────────────────────────────

  _ensureReady () {
    if (!this._ready) throw new Error('PrivacyManager not initialized — call init() first')
  }

  _serialize (value) {
    if (b4a.isBuffer(value)) return value
    if (typeof value === 'string') return b4a.from(value)
    return b4a.from(JSON.stringify(value))
  }

  _audit (action, detail) {
    this._auditLog.push({
      action,
      detail,
      timestamp: Date.now(),
      tier: this.manifest.privacyTier
    })
  }

  /**
   * Clean up all resources.
   */
  destroy () {
    if (this.keyManager) this.keyManager.destroy()
    this.localStorage = null
    this._ready = false
  }
}

export default PrivacyManager

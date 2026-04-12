/**
 * Platform Key Management API
 * =============================
 * Device key generation, storage, and hierarchical key derivation.
 *
 * Key hierarchy:
 *   deviceKey (root, hardware-backed in production)
 *     └── appKey = HKDF(deviceKey, "app:" + appName)
 *           └── dataKey = HKDF(appKey, "data:" + purpose)
 *           └── syncKey = HKDF(appKey, "sync:" + peerId)
 *
 * Uses HKDF via BLAKE2b-keyed-hash (sodium_crypto_generichash with key).
 * In production, deviceKey would come from Secure Enclave (iOS) or
 * Keystore (Android). This implementation stores it on disk with
 * restricted permissions as a development fallback.
 */

import sodium from 'sodium-universal'
import b4a from 'b4a'
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { join } from 'path'

const KEY_BYTES = 32

/**
 * KeyManager — manages the device key and derives child keys.
 */
export class KeyManager {
  /**
   * @param {string} storagePath - Directory for persisting keys
   */
  constructor (storagePath) {
    this.storagePath = storagePath
    this.deviceKey = null
    this.derivedKeys = new Map() // cache: context string → derived key
    this._ready = false
  }

  /**
   * Initialize — load or generate the device key.
   */
  async init () {
    await mkdir(this.storagePath, { recursive: true })
    const keyFile = join(this.storagePath, 'device-key.json')

    try {
      const data = await readFile(keyFile, 'utf8')
      const parsed = JSON.parse(data)
      this.deviceKey = b4a.from(parsed.deviceKey, 'hex')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err

      // Generate new device key
      this.deviceKey = b4a.alloc(KEY_BYTES)
      sodium.randombytes_buf(this.deviceKey)

      // Persist with restricted permissions
      const tmp = keyFile + '.tmp'
      await writeFile(tmp, JSON.stringify({
        deviceKey: b4a.toString(this.deviceKey, 'hex'),
        createdAt: new Date().toISOString(),
        warning: 'KEEP SECRET — this is your device root key'
      }, null, 2), { mode: 0o600 })
      await rename(tmp, keyFile)
    }

    this._ready = true
    return this.deviceKey
  }

  /**
   * Get the device root key.
   * @returns {Buffer} 32-byte device key
   */
  device () {
    if (!this._ready) throw new Error('KeyManager not initialized — call init() first')
    return this.deviceKey
  }

  /**
   * Derive a child key using HKDF-like construction (BLAKE2b keyed hash).
   *
   * @param {Buffer} parentKey - Parent key (32 bytes)
   * @param {string} context - Derivation context (e.g. "app:sanduq", "data:transactions")
   * @returns {Buffer} 32-byte derived key
   */
  derive (parentKey, context) {
    if (!b4a.isBuffer(parentKey) || parentKey.length !== KEY_BYTES) {
      throw new Error('Parent key must be 32 bytes')
    }
    if (typeof context !== 'string' || context.length === 0) {
      throw new Error('Context must be a non-empty string')
    }

    const cacheKey = b4a.toString(parentKey, 'hex') + ':' + context
    if (this.derivedKeys.has(cacheKey)) {
      return this.derivedKeys.get(cacheKey)
    }

    const derived = b4a.alloc(KEY_BYTES)
    const input = b4a.from(context)
    sodium.crypto_generichash(derived, input, parentKey)

    this.derivedKeys.set(cacheKey, derived)
    return derived
  }

  /**
   * Derive an app-specific key from the device key.
   *
   * @param {string} appName - Application identifier
   * @returns {Buffer} 32-byte app key
   */
  appKey (appName) {
    return this.derive(this.device(), 'app:' + appName)
  }

  /**
   * Derive a data encryption key for a specific purpose within an app.
   *
   * @param {string} appName - Application identifier
   * @param {string} purpose - Data purpose (e.g. "transactions", "profile", "messages")
   * @returns {Buffer} 32-byte data encryption key
   */
  dataKey (appName, purpose) {
    const app = this.appKey(appName)
    return this.derive(app, 'data:' + purpose)
  }

  /**
   * Derive a sync key for peer-to-peer encrypted sync.
   *
   * @param {string} appName - Application identifier
   * @param {string} peerId - Peer identifier (hex pubkey or friendly name)
   * @returns {Buffer} 32-byte sync key
   */
  syncKey (appName, peerId) {
    const app = this.appKey(appName)
    return this.derive(app, 'sync:' + peerId)
  }

  /**
   * Generate an ephemeral key (not persisted, not derived).
   * Used for session keys, one-time operations.
   *
   * @returns {Buffer} 32-byte random key
   */
  ephemeral () {
    const key = b4a.alloc(KEY_BYTES)
    sodium.randombytes_buf(key)
    return key
  }

  /**
   * Generate an Ed25519 signing keypair.
   *
   * @returns {{ publicKey: Buffer, secretKey: Buffer }}
   */
  signingKeypair () {
    const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
    const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
    sodium.crypto_sign_keypair(publicKey, secretKey)
    return { publicKey, secretKey }
  }

  /**
   * Wipe derived key cache (call on app close or key rotation).
   */
  clearCache () {
    // Zero out cached keys before clearing
    for (const key of this.derivedKeys.values()) {
      sodium.sodium_memzero(key)
    }
    this.derivedKeys.clear()
  }

  /**
   * Destroy — zero out all key material.
   */
  destroy () {
    this.clearCache()
    if (this.deviceKey) {
      sodium.sodium_memzero(this.deviceKey)
      this.deviceKey = null
    }
    this._ready = false
  }
}

export default KeyManager

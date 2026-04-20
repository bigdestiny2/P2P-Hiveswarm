/**
 * Access Control — Device Allowlist & Pairing
 * =============================================
 * Manages which device public keys are permitted to connect.
 * Used in private and hybrid modes to restrict access to paired devices only.
 *
 * Pairing flow:
 *   1. Operator enables pairing mode (time-limited)
 *   2. Pairing token + relay pubkey displayed as QR / string
 *   3. New device connects, presents token + its pubkey
 *   4. If token valid and not expired, device pubkey added to allowlist
 *   5. Pairing mode auto-disables after timeout or successful pair
 */

import { randomBytes } from 'crypto'
import { readFile, writeFile, rename, chmod } from 'fs/promises'
import { join } from 'path'
import b4a from 'b4a'
import { EventEmitter } from 'events'

const PAIRING_TOKEN_BYTES = 16
const DEFAULT_PAIRING_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export class AccessControl extends EventEmitter {
  constructor (storagePath, opts = {}) {
    super()
    this.storagePath = storagePath
    this.allowlistPath = join(storagePath, 'allowed-devices.json')
    this.allowedDevices = new Map() // pubkey hex → { name, pairedAt, lastSeen }
    this._pairingState = null // { token, expiresAt, timeout }
    this.maxDevices = opts.maxDevices || 50
  }

  async load () {
    try {
      const data = JSON.parse(await readFile(this.allowlistPath, 'utf8'))
      if (Array.isArray(data)) {
        for (const entry of data) {
          if (entry.pubkey) {
            this.allowedDevices.set(entry.pubkey, {
              name: entry.name || 'unknown',
              pairedAt: entry.pairedAt || Date.now(),
              lastSeen: entry.lastSeen || null
            })
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.emit('load-error', { error: err.message })
      }
    }
  }

  async save () {
    const entries = []
    for (const [pubkey, meta] of this.allowedDevices) {
      entries.push({ pubkey, ...meta })
    }
    const tmpPath = this.allowlistPath + '.tmp'
    await writeFile(tmpPath, JSON.stringify(entries, null, 2))
    await rename(tmpPath, this.allowlistPath)
    // Restrict permissions — only owner can read/write
    try { await chmod(this.allowlistPath, 0o600) } catch {}
  }

  /**
   * Check if a remote public key is allowed to connect.
   */
  isAllowed (remotePubKey) {
    const hex = b4a.isBuffer(remotePubKey)
      ? b4a.toString(remotePubKey, 'hex')
      : remotePubKey
    return this.allowedDevices.has(hex)
  }

  /**
   * Record activity for a device (updates lastSeen).
   */
  recordActivity (remotePubKey) {
    const hex = b4a.isBuffer(remotePubKey)
      ? b4a.toString(remotePubKey, 'hex')
      : remotePubKey
    const entry = this.allowedDevices.get(hex)
    if (entry) {
      entry.lastSeen = Date.now()
    }
  }

  /**
   * Manually add a device to the allowlist (operator action).
   */
  async addDevice (pubkeyHex, name = 'unknown') {
    if (this.allowedDevices.size >= this.maxDevices) {
      throw new Error(`Maximum devices reached (${this.maxDevices})`)
    }
    this.allowedDevices.set(pubkeyHex, {
      name,
      pairedAt: Date.now(),
      lastSeen: null
    })
    await this.save()
    this.emit('device-added', { pubkey: pubkeyHex, name })
  }

  /**
   * Remove a device from the allowlist.
   */
  async removeDevice (pubkeyHex) {
    if (!this.allowedDevices.has(pubkeyHex)) {
      throw new Error('Device not in allowlist')
    }
    this.allowedDevices.delete(pubkeyHex)
    await this.save()
    this.emit('device-removed', { pubkey: pubkeyHex })
  }

  /**
   * List all paired devices.
   */
  listDevices () {
    const devices = []
    for (const [pubkey, meta] of this.allowedDevices) {
      devices.push({ pubkey, ...meta })
    }
    return devices
  }

  // ─── Pairing Protocol ─────────────────────────────────────────

  /**
   * Enable pairing mode. Returns pairing info to display to user.
   * Pairing auto-expires after timeout.
   */
  enablePairing (opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_PAIRING_TIMEOUT_MS

    // Cancel any existing pairing session
    this.disablePairing()

    const token = randomBytes(PAIRING_TOKEN_BYTES).toString('hex')
    const expiresAt = Date.now() + timeoutMs

    const timeout = setTimeout(() => {
      this._pairingState = null
      this.emit('pairing-expired')
    }, timeoutMs)
    if (timeout.unref) timeout.unref()

    this._pairingState = { token, expiresAt, timeout }
    this.emit('pairing-enabled', { token, expiresAt })

    return { token, expiresAt }
  }

  /**
   * Disable pairing mode.
   */
  disablePairing () {
    if (this._pairingState) {
      clearTimeout(this._pairingState.timeout)
      this._pairingState = null
      this.emit('pairing-disabled')
    }
  }

  /**
   * Whether pairing mode is currently active.
   */
  get isPairing () {
    return this._pairingState !== null && Date.now() < this._pairingState.expiresAt
  }

  /**
   * Attempt to pair a device using a token.
   * Returns true if successful, false if token invalid/expired.
   */
  async attemptPair (token, devicePubkeyHex, deviceName = 'unknown') {
    if (!this._pairingState) {
      this.emit('pairing-rejected', { reason: 'pairing not active', pubkey: devicePubkeyHex })
      return false
    }

    if (Date.now() >= this._pairingState.expiresAt) {
      this.disablePairing()
      this.emit('pairing-rejected', { reason: 'token expired', pubkey: devicePubkeyHex })
      return false
    }

    if (token !== this._pairingState.token) {
      this.emit('pairing-rejected', { reason: 'invalid token', pubkey: devicePubkeyHex })
      return false
    }

    // Token valid — add device to allowlist
    await this.addDevice(devicePubkeyHex, deviceName)

    // Disable pairing after successful pair (one-shot by default)
    this.disablePairing()

    this.emit('pairing-success', { pubkey: devicePubkeyHex, name: deviceName })
    return true
  }

  /**
   * Generate the pairing payload to display (QR code content).
   */
  getPairingPayload (relayPubkeyHex, host, port) {
    if (!this._pairingState) return null
    return {
      pubkey: relayPubkeyHex,
      host,
      port,
      pairingToken: this._pairingState.token,
      expiresAt: this._pairingState.expiresAt
    }
  }

  // ─── Backup & Restore ──────────────────────────────────────────

  /**
   * Create an encrypted backup of the device allowlist.
   * Uses the relay's secret key to encrypt so only this node can restore.
   * Returns: { encrypted: Buffer, nonce: Buffer, timestamp }
   */
  async createBackup (secretKey) {
    if (!secretKey || secretKey.length < 32) {
      throw new Error('BACKUP_NEEDS_KEY: provide relay secretKey (32+ bytes)')
    }

    const entries = []
    for (const [pubkey, meta] of this.allowedDevices) {
      entries.push({ pubkey, ...meta })
    }

    const plaintext = b4a.from(JSON.stringify(entries))
    const nonce = randomBytes(24)
    const key = b4a.isBuffer(secretKey) ? secretKey.subarray(0, 32) : b4a.from(secretKey, 'hex').subarray(0, 32)

    // XSalsa20-Poly1305 symmetric encryption
    const { sodium_malloc, crypto_secretbox_easy, crypto_secretbox_MACBYTES } = await this._getSodium()
    const ciphertext = b4a.alloc(plaintext.length + crypto_secretbox_MACBYTES)
    crypto_secretbox_easy(ciphertext, plaintext, b4a.from(nonce), key)

    return {
      encrypted: b4a.toString(ciphertext, 'hex'),
      nonce: nonce.toString('hex'),
      timestamp: Date.now(),
      deviceCount: this.allowedDevices.size
    }
  }

  /**
   * Restore from an encrypted backup.
   * Merges restored devices with any existing devices (union).
   */
  async restoreBackup (backup, secretKey) {
    if (!backup || !backup.encrypted || !backup.nonce) {
      throw new Error('BACKUP_INVALID: need encrypted and nonce fields')
    }

    const key = b4a.isBuffer(secretKey) ? secretKey.subarray(0, 32) : b4a.from(secretKey, 'hex').subarray(0, 32)
    const ciphertext = b4a.from(backup.encrypted, 'hex')
    const nonce = b4a.from(backup.nonce, 'hex')

    const { crypto_secretbox_open_easy, crypto_secretbox_MACBYTES } = await this._getSodium()
    const plaintext = b4a.alloc(ciphertext.length - crypto_secretbox_MACBYTES)

    const success = crypto_secretbox_open_easy(plaintext, ciphertext, nonce, key)
    if (!success) {
      throw new Error('BACKUP_DECRYPT_FAILED: wrong key or corrupted backup')
    }

    const entries = JSON.parse(b4a.toString(plaintext))
    let restored = 0

    for (const entry of entries) {
      if (entry.pubkey && !this.allowedDevices.has(entry.pubkey)) {
        if (this.allowedDevices.size >= this.maxDevices) break
        this.allowedDevices.set(entry.pubkey, {
          name: entry.name || 'restored',
          pairedAt: entry.pairedAt || Date.now(),
          lastSeen: entry.lastSeen || null
        })
        restored++
      }
    }

    await this.save()
    this.emit('backup-restored', { restored, total: entries.length })
    return { restored, total: entries.length }
  }

  async _getSodium () {
    // Dynamic import to keep sodium optional at top level
    const sodium = (await import('sodium-universal')).default
    return sodium
  }

  destroy () {
    this.disablePairing()
    this.allowedDevices.clear()
  }
}

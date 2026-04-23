/**
 * Platform Local Storage API
 * ============================
 * Encrypted key-value storage on the local device.
 *
 * Data is encrypted at rest using XChaCha20-Poly1305 with an app-derived key.
 * Storage is namespaced per app — each app gets its own isolated store.
 *
 * Persistence: JSON file per namespace with atomic writes.
 * In production, this would back onto iOS Keychain / Android Keystore / IndexedDB.
 *
 * Usage:
 *   const storage = new LocalStorage({ path: './data', name: 'my-app', key: appKey })
 *   await storage.init()
 *   await storage.set('transactions', txData)
 *   const data = await storage.get('transactions')
 */

import b4a from 'b4a'
import { readFile, writeFile, rename, mkdir, unlink } from 'fs/promises'
import { join } from 'path'
import { encrypt, decrypt } from './crypto.js'

const DEFAULT_QUOTA = 100 * 1024 * 1024 // 100 MB

export class LocalStorage {
  /**
   * @param {object} opts
   * @param {string} opts.path - Base storage directory
   * @param {string} opts.name - Namespace (app identifier)
   * @param {Buffer} opts.key - 32-byte encryption key (from KeyManager.dataKey)
   * @param {number} [opts.quota] - Max storage in bytes (default 100MB)
   */
  constructor (opts) {
    if (!opts.path) throw new Error('opts.path required')
    if (!opts.name) throw new Error('opts.name required')
    if (!opts.key || opts.key.length !== 32) throw new Error('opts.key must be 32 bytes')

    this.basePath = opts.path
    this.name = opts.name
    this.key = opts.key
    this.quota = opts.quota || DEFAULT_QUOTA
    this.storePath = join(this.basePath, this.name)
    this.indexFile = join(this.storePath, 'index.json')

    // In-memory index: entryKey → { file, size, createdAt, updatedAt }
    this._index = new Map()
    this._totalBytes = 0
    this._ready = false
  }

  /**
   * Initialize storage — create directory and load index.
   */
  async init () {
    await mkdir(this.storePath, { recursive: true })

    try {
      const raw = await readFile(this.indexFile, 'utf8')
      const entries = JSON.parse(raw)
      for (const [k, v] of Object.entries(entries)) {
        this._index.set(k, v)
        this._totalBytes += v.size || 0
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      // Fresh store
    }

    this._ready = true
  }

  /**
   * Store a value. Data is encrypted before writing to disk.
   *
   * @param {string} entryKey - Key name
   * @param {Buffer|string|object} value - Data to store (objects are JSON-serialized)
   * @returns {{ size: number }} bytes written
   */
  async set (entryKey, value) {
    this._ensureReady()
    if (typeof entryKey !== 'string' || entryKey.length === 0) {
      throw new Error('Entry key must be a non-empty string')
    }

    // Serialize value
    let plaintext
    if (b4a.isBuffer(value)) {
      plaintext = value
    } else if (typeof value === 'string') {
      plaintext = b4a.from(value)
    } else {
      plaintext = b4a.from(JSON.stringify(value))
    }

    // Check quota (subtract old entry size if updating)
    const oldEntry = this._index.get(entryKey)
    const oldSize = oldEntry ? oldEntry.size : 0
    const newTotalBytes = this._totalBytes - oldSize + plaintext.length
    if (newTotalBytes > this.quota) {
      throw new Error(`Storage quota exceeded (${this.quota} bytes). Current: ${this._totalBytes}, new entry: ${plaintext.length}`)
    }

    // Encrypt
    const sealed = encrypt(plaintext, this.key)

    // Write encrypted data to file
    const fileName = this._fileNameFor(entryKey)
    const filePath = join(this.storePath, fileName)
    const tmpPath = filePath + '.tmp'

    await writeFile(tmpPath, sealed, { mode: 0o600 })
    await rename(tmpPath, filePath)

    // Update index
    const now = Date.now()
    const entry = {
      file: fileName,
      size: plaintext.length,
      encryptedSize: sealed.length,
      createdAt: oldEntry ? oldEntry.createdAt : now,
      updatedAt: now
    }
    this._index.set(entryKey, entry)
    this._totalBytes = newTotalBytes

    // Persist index
    await this._saveIndex()

    return { size: plaintext.length }
  }

  /**
   * Retrieve and decrypt a value.
   *
   * @param {string} entryKey - Key name
   * @returns {Buffer|null} Decrypted data, or null if not found
   */
  async get (entryKey) {
    this._ensureReady()

    const entry = this._index.get(entryKey)
    if (!entry) return null

    const filePath = join(this.storePath, entry.file)
    try {
      const sealed = await readFile(filePath)
      return decrypt(sealed, this.key)
    } catch (err) {
      if (err.code === 'ENOENT') {
        // File missing — remove from index
        this._index.delete(entryKey)
        this._totalBytes -= entry.size || 0
        await this._saveIndex()
        return null
      }
      throw err
    }
  }

  /**
   * Retrieve and parse a JSON value.
   *
   * @param {string} entryKey
   * @returns {object|null}
   */
  async getJSON (entryKey) {
    const buf = await this.get(entryKey)
    if (!buf) return null
    return JSON.parse(buf.toString())
  }

  /**
   * Delete an entry.
   *
   * @param {string} entryKey
   * @returns {boolean} true if entry existed
   */
  async delete (entryKey) {
    this._ensureReady()

    const entry = this._index.get(entryKey)
    if (!entry) return false

    const filePath = join(this.storePath, entry.file)
    try {
      await unlink(filePath)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }

    this._totalBytes -= entry.size || 0
    this._index.delete(entryKey)
    await this._saveIndex()

    return true
  }

  /**
   * Check if an entry exists.
   * @param {string} entryKey
   * @returns {boolean}
   */
  has (entryKey) {
    this._ensureReady()
    return this._index.has(entryKey)
  }

  /**
   * List all entry keys.
   * @returns {string[]}
   */
  keys () {
    this._ensureReady()
    return Array.from(this._index.keys())
  }

  /**
   * Get storage stats.
   * @returns {{ entries: number, totalBytes: number, quota: number, usedPercent: number }}
   */
  stats () {
    this._ensureReady()
    return {
      entries: this._index.size,
      totalBytes: this._totalBytes,
      encryptedBytes: Array.from(this._index.values()).reduce((sum, e) => sum + (e.encryptedSize || 0), 0),
      quota: this.quota,
      usedPercent: Math.round((this._totalBytes / this.quota) * 100)
    }
  }

  /**
   * Export all entries as encrypted blobs for P2P backup.
   * Returns a map of entryKey → encrypted Buffer.
   * The relay or backup peer gets these blobs but cannot decrypt them.
   *
   * @returns {Map<string, Buffer>}
   */
  async exportEncrypted () {
    this._ensureReady()
    const result = new Map()

    for (const [entryKey, entry] of this._index) {
      const filePath = join(this.storePath, entry.file)
      try {
        const sealed = await readFile(filePath)
        result.set(entryKey, sealed)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }

    return result
  }

  /**
   * Import encrypted blobs (from P2P backup restore).
   * Validates each blob can be decrypted with the current key.
   *
   * @param {Map<string, Buffer>} blobs - entryKey → encrypted Buffer
   * @returns {{ imported: number, failed: number }}
   */
  async importEncrypted (blobs) {
    this._ensureReady()
    let imported = 0
    let failed = 0

    for (const [entryKey, sealed] of blobs) {
      try {
        // Verify we can decrypt (validates key + integrity)
        const plaintext = decrypt(sealed, this.key)

        // Write the encrypted blob directly
        const fileName = this._fileNameFor(entryKey)
        const filePath = join(this.storePath, fileName)
        const tmpPath = filePath + '.tmp'
        await writeFile(tmpPath, sealed, { mode: 0o600 })
        await rename(tmpPath, filePath)

        const oldEntry = this._index.get(entryKey)
        if (oldEntry) this._totalBytes -= oldEntry.size || 0

        this._index.set(entryKey, {
          file: fileName,
          size: plaintext.length,
          encryptedSize: sealed.length,
          createdAt: Date.now(),
          updatedAt: Date.now()
        })
        this._totalBytes += plaintext.length
        imported++
      } catch (err) {
        failed++
      }
    }

    await this._saveIndex()
    return { imported, failed }
  }

  /**
   * Destroy all stored data (wipe).
   */
  async clear () {
    this._ensureReady()

    for (const entry of this._index.values()) {
      const filePath = join(this.storePath, entry.file)
      try { await unlink(filePath) } catch {}
    }

    this._index.clear()
    this._totalBytes = 0
    await this._saveIndex()
  }

  // ── Internal ──────────────────────────────────────────────

  _ensureReady () {
    if (!this._ready) throw new Error('LocalStorage not initialized — call init() first')
  }

  _fileNameFor (entryKey) {
    // Safe filename: replace any non-alphanumeric chars to prevent path traversal
    return entryKey.replace(/[^a-zA-Z0-9_-]/g, '_') + '.enc'
  }

  async _saveIndex () {
    const data = {}
    for (const [k, v] of this._index) {
      data[k] = v
    }
    const tmp = this.indexFile + '.tmp'
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(tmp, this.indexFile)
  }
}

export default LocalStorage

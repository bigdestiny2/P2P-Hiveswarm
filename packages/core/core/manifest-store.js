/**
 * Persistent store for author-published seeding manifests.
 *
 * Relays cache manifests so clients can fetch any author's seeding-relay
 * list over plain HTTP. Storage is a single JSON file — manifests are small
 * (a few kB) and the set scales with "how many authors publish here", not
 * "how many drives exist", so a flat file is fine for 0.5.1. If this
 * becomes hot we'll swap to a keyed store later without changing the API.
 *
 * Policy:
 *   - Only one manifest per pubkey is kept. Newer timestamp wins.
 *   - Manifests are verified before storage — an invalid/unsigned manifest
 *     is rejected, never cached.
 *   - Max `maxAuthors` manifests total. When the cap is hit, the oldest
 *     (by `storedAt`) is evicted. Default 10k.
 *   - File writes are atomic (tmp + rename) — same pattern as federation.js.
 */

import { EventEmitter } from 'events'
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { dirname, basename, join } from 'path'
import { verifySeedingManifest, isNewerManifest } from './seeding-manifest.js'

const DEFAULT_MAX_AUTHORS = 10_000

export class ManifestStore extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.storagePath] - JSON file for persistence; null = runtime only
   * @param {number} [opts.maxAuthors]  - Cap on stored manifests (default 10k)
   */
  constructor (opts = {}) {
    super()
    this.storagePath = opts.storagePath || null
    this.maxAuthors = opts.maxAuthors || DEFAULT_MAX_AUTHORS
    // pubkey (lowercase hex) → { manifest, storedAt }
    this._manifests = new Map()
  }

  /**
   * Load existing manifests from disk. Silently no-ops if storagePath is
   * unset or the file doesn't exist (first run). Bad manifests on disk are
   * dropped individually, not fatal.
   */
  async load () {
    if (!this.storagePath) return
    let raw
    try {
      raw = await readFile(this.storagePath, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }
    let parsed
    try { parsed = JSON.parse(raw) } catch (err) {
      this.emit('load-error', { message: 'bad JSON, starting fresh', error: err })
      return
    }
    if (!parsed || !Array.isArray(parsed.entries)) return
    for (const entry of parsed.entries) {
      if (!entry || !entry.manifest) continue
      const check = verifySeedingManifest(entry.manifest)
      if (!check.valid) {
        this.emit('load-rejected', { reason: check.reason })
        continue
      }
      const key = check.pubkey.toLowerCase()
      this._manifests.set(key, {
        manifest: entry.manifest,
        storedAt: typeof entry.storedAt === 'number' ? entry.storedAt : Date.now()
      })
    }
  }

  /**
   * Persist current state. Atomic (tmp + rename). Callers should await —
   * throwing here is intentional so API handlers can surface write errors
   * to operators instead of silently accepting a manifest that won't
   * survive restart.
   */
  async save () {
    if (!this.storagePath) return
    const entries = []
    for (const [, record] of this._manifests) {
      entries.push({ manifest: record.manifest, storedAt: record.storedAt })
    }
    const payload = JSON.stringify({ version: 1, entries }, null, 2)
    const dir = dirname(this.storagePath)
    try { await mkdir(dir, { recursive: true }) } catch (_) {}
    const tmp = join(dir, basename(this.storagePath) + '.tmp')
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, this.storagePath)
  }

  /**
   * Store a manifest if it verifies and is newer than any existing entry
   * for the same author.
   *
   * @param {object} manifest
   * @returns {{ok: true, replaced: boolean} | {ok: false, reason: string}}
   */
  put (manifest) {
    const check = verifySeedingManifest(manifest)
    if (!check.valid) return { ok: false, reason: check.reason }
    const key = check.pubkey.toLowerCase()
    const existing = this._manifests.get(key)
    if (existing && !isNewerManifest(manifest, existing.manifest)) {
      return { ok: false, reason: 'stale: existing manifest is newer or equal' }
    }
    this._manifests.set(key, { manifest, storedAt: Date.now() })
    this._enforceCap()
    this.emit('stored', { pubkey: key, replaced: !!existing })
    return { ok: true, replaced: !!existing }
  }

  /**
   * Look up a manifest by author pubkey (case-insensitive).
   * @param {string} pubkey - hex
   * @returns {object|null} manifest or null
   */
  get (pubkey) {
    if (typeof pubkey !== 'string') return null
    const rec = this._manifests.get(pubkey.toLowerCase())
    return rec ? rec.manifest : null
  }

  /**
   * Number of cached manifests.
   */
  size () {
    return this._manifests.size
  }

  /**
   * List all stored manifests (snapshot — safe to iterate without mutation
   * hazards).
   */
  list () {
    const out = []
    for (const [pubkey, record] of this._manifests) {
      out.push({ pubkey, manifest: record.manifest, storedAt: record.storedAt })
    }
    return out
  }

  /**
   * Remove an author's manifest. Used by operators who want to evict
   * misbehaving authors.
   */
  delete (pubkey) {
    if (typeof pubkey !== 'string') return false
    return this._manifests.delete(pubkey.toLowerCase())
  }

  _enforceCap () {
    if (this._manifests.size <= this.maxAuthors) return
    // Evict oldest first.
    const oldest = [...this._manifests.entries()]
      .sort((a, b) => a[1].storedAt - b[1].storedAt)
    while (this._manifests.size > this.maxAuthors && oldest.length) {
      const [key] = oldest.shift()
      this._manifests.delete(key)
      this.emit('evicted', { pubkey: key })
    }
  }
}

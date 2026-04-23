/**
 * Unified App Registry
 *
 * Single source of truth for all seeded apps. Replaces the scattered
 * seededApps Map, appIndex Map, seeded-apps.json, and app-registry.json
 * with one class that handles:
 *
 *   - In-memory state (apps Map + appId dedup index)
 *   - Disk persistence (auto-saves on every mutation)
 *   - Startup recovery (loads from disk, reseeds drives)
 *   - Catalog generation (for HTTP /catalog.json and P2P broadcast)
 *   - Version deduplication (only keep latest version per appId)
 */

import { readFile, writeFile, rename } from 'fs/promises'
import { join } from 'path'
import { EventEmitter } from 'events'
import { compareVersions, normalizeContentType } from './constants.js'

const REGISTRY_FILE = 'app-registry.json'

export class AppRegistry extends EventEmitter {
  constructor (storagePath) {
    super()
    this._storagePath = storagePath
    this._filePath = storagePath ? join(storagePath, REGISTRY_FILE) : null

    // Primary state: appKey hex → entry
    this.apps = new Map()

    // Dedup index: appId string → appKey hex (only latest version per appId)
    this.byAppId = new Map()

    this._saving = false
    this._savePending = false
    this._saveDebounceTimer = null
  }

  // ─── Queries ───────────────────────────────────────────────

  get size () { return this.apps.size }

  has (appKey) { return this.apps.has(appKey) }

  get (appKey) { return this.apps.get(appKey) }

  getByAppId (appId) {
    const appKey = this.byAppId.get(appId)
    return appKey ? this.apps.get(appKey) : null
  }

  keys () { return this.apps.keys() }

  values () { return this.apps.values() }

  entries () { return this.apps.entries() }

  [Symbol.iterator] () { return this.apps[Symbol.iterator]() }

  // ─── Mutations ─────────────────────────────────────────────

  _isAppType (entry) {
    return normalizeContentType(entry?.type, 'app') === 'app'
  }

  _isAppIdIndexed (entry) {
    return this._isAppType(entry) && typeof entry?.appId === 'string' && entry.appId.length > 0
  }

  _normalizeEntry (entry = {}) {
    const type = normalizeContentType(entry.type, 'app')
    const parentKey = typeof entry.parentKey === 'string' && entry.parentKey.length > 0
      ? entry.parentKey
      : null
    const mountPath = typeof entry.mountPath === 'string' && entry.mountPath.trim().length > 0
      ? entry.mountPath.trim()
      : null
    const categories = Array.isArray(entry.categories)
      ? [...new Set(entry.categories.map(c => String(c).trim()).filter(Boolean))]
      : null

    return {
      ...entry,
      type,
      parentKey,
      mountPath,
      categories
    }
  }

  /**
   * Register a seeded app. Automatically persists and emits change event.
   */
  set (appKey, entry) {
    const normalized = this._normalizeEntry(entry)
    this.apps.set(appKey, normalized)

    // Update dedup index if entry has an appId
    if (this._isAppIdIndexed(normalized)) {
      this.byAppId.set(normalized.appId, appKey)
    }

    this._scheduleSave()
    this.emit('change', { type: 'set', appKey, entry: normalized })
  }

  /**
   * Update metadata on an existing entry without replacing it.
   */
  update (appKey, updates) {
    const entry = this.apps.get(appKey)
    if (!entry) return false

    const hadIndexedAppId = this._isAppIdIndexed(entry)
    const previousAppId = entry.appId
    Object.assign(entry, this._normalizeEntry({ ...entry, ...updates }))

    // Update dedup index when app identity changed
    if (hadIndexedAppId && previousAppId && this.byAppId.get(previousAppId) === appKey) {
      this.byAppId.delete(previousAppId)
    }
    if (this._isAppIdIndexed(entry)) {
      this.byAppId.set(entry.appId, appKey)
    }

    this._scheduleSave()
    this.emit('change', { type: 'update', appKey, entry })
    return true
  }

  /**
   * Remove a seeded app. Automatically persists and emits change event.
   */
  delete (appKey) {
    const entry = this.apps.get(appKey)
    if (!entry) return false

    // Clean dedup index
    if (this._isAppIdIndexed(entry) && this.byAppId.get(entry.appId) === appKey) {
      this.byAppId.delete(entry.appId)
    }

    this.apps.delete(appKey)
    this._scheduleSave()
    this.emit('change', { type: 'delete', appKey })
    return true
  }

  // ─── Catalog Output ────────────────────────────────────────

  /**
   * Generate the app catalog for HTTP /catalog.json and P2P broadcast.
   * Returns array of { appKey, appId, version, discoveryKey, blind, seededAt, name, description }
   * No drive reads needed — all metadata comes from the registry.
   */
  catalog () {
    const items = []
    const seen = new Map() // appId → index in items array (dedup for app type)

    for (const [appKey, entry] of this.apps) {
      const type = normalizeContentType(entry.type, 'app')
      const appId = entry.appId || appKey.slice(0, 12)
      const catalogEntry = {
        appKey,
        type,
        parentKey: entry.parentKey || null,
        mountPath: entry.mountPath || null,
        id: appId,
        name: entry.name || entry.appId || 'Unknown App',
        description: entry.description || '',
        author: entry.author || 'anonymous',
        version: entry.version || '1.0.0',
        driveKey: appKey,
        discoveryKey: entry.discoveryKey
          ? (typeof entry.discoveryKey === 'string' ? entry.discoveryKey : entry.discoveryKey.toString('hex'))
          : null,
        blind: entry.blind || false,
        categories: entry.categories || ['uncategorized'],
        privacyTier: entry.privacyTier || 'public',
        seededAt: entry.startedAt || entry.seededAt || Date.now()
      }

      // Dedup app entries by appId — keep latest version
      if (type === 'app') {
        const existingIdx = seen.get(appId)
        if (existingIdx !== undefined) {
          const existing = items[existingIdx]
          if (compareVersions(catalogEntry.version, existing.version) > 0) {
            items[existingIdx] = catalogEntry
          }
        } else {
          seen.set(appId, items.length)
          items.push(catalogEntry)
        }
      } else {
        items.push(catalogEntry)
      }
    }

    return items
  }

  catalogByType (type) {
    const normalizedType = normalizeContentType(type, null)
    if (!normalizedType) return []
    return this.catalog().filter(entry => entry.type === normalizedType)
  }

  catalogByParent (parentKey) {
    if (!parentKey) return []
    return this.catalog().filter(entry => entry.parentKey === parentKey)
  }

  /**
   * Lightweight version for P2P MSG_APP_CATALOG broadcast.
   */
  catalogForBroadcast () {
    const apps = []
    for (const [appKey, entry] of this.apps) {
      apps.push({
        appKey,
        appId: entry.appId || null,
        type: normalizeContentType(entry.type, 'app'),
        parentKey: entry.parentKey || null,
        mountPath: entry.mountPath || null,
        version: entry.version || null,
        discoveryKey: entry.discoveryKey
          ? (typeof entry.discoveryKey === 'string' ? entry.discoveryKey : entry.discoveryKey.toString('hex'))
          : null,
        blind: entry.blind || false,
        privacyTier: entry.privacyTier || 'public',
        seededAt: entry.startedAt || entry.seededAt || Date.now()
      })
    }
    return apps
  }

  // ─── Deduplication ─────────────────────────────────────────

  /**
   * Check if adding an app with this appId would conflict with an existing one.
   * Returns { conflict: false } or { conflict: true, existingKey, existingVersion, shouldReplace }
   */
  checkConflict (appId, appKey, version) {
    const existingKey = this.byAppId.get(appId)
    if (!existingKey || existingKey === appKey) return { conflict: false }

    const existing = this.apps.get(existingKey)
    if (!existing) return { conflict: false }

    return {
      conflict: true,
      existingKey,
      existingVersion: existing.version || '0.0.0',
      shouldReplace: compareVersions(version, existing.version || '0.0.0') >= 0
    }
  }

  // ─── Persistence ───────────────────────────────────────────

  /**
   * Load registry from disk. Returns entries array for reseeding.
   */
  async load () {
    if (!this._filePath) return []

    try {
      const data = JSON.parse(await readFile(this._filePath, 'utf8'))

      // Support both array format (old seeded-apps.json) and object format
      const entries = Array.isArray(data) ? data : Object.values(data)

      // Populate in-memory state from disk
      for (const entry of entries) {
        const appKey = entry.appKey || entry.driveKey
        if (!appKey) continue

        this.apps.set(appKey, {
          startedAt: entry.startedAt || entry.seededAt || Date.now(),
          appId: entry.appId || entry.name || null,
          type: normalizeContentType(entry.type, 'app'),
          parentKey: entry.parentKey || null,
          mountPath: entry.mountPath || null,
          version: entry.version || null,
          name: entry.name || entry.appId || null,
          description: entry.description || '',
          author: entry.author || null,
          blind: entry.blind || false,
          privacyTier: entry.privacyTier || 'public',
          categories: entry.categories || null,
          bytesServed: 0,
          // drive and discoveryKey are set during reseeding
          drive: null,
          discoveryKey: null
        })

        if (entry.appId && normalizeContentType(entry.type, 'app') === 'app') {
          this.byAppId.set(entry.appId, appKey)
        }
      }

      return entries.map(e => ({
        appKey: e.appKey || e.driveKey,
        appId: e.appId || e.name || null,
        type: normalizeContentType(e.type, 'app'),
        parentKey: e.parentKey || null,
        mountPath: e.mountPath || null,
        version: e.version || null,
        privacyTier: e.privacyTier || 'public'
      })).filter(e => e.appKey)
    } catch (_) {
      return []
    }
  }

  /**
   * Save registry to disk. Uses atomic write (write temp, rename).
   * Coalesces rapid writes — only one save happens at a time.
   */
  async save () {
    if (!this._filePath) return

    if (this._saving) {
      this._savePending = true
      return
    }

    this._saving = true
    try {
      const entries = []
      for (const [appKey, entry] of this.apps) {
        entries.push({
          appKey,
          appId: entry.appId || null,
          type: normalizeContentType(entry.type, 'app'),
          parentKey: entry.parentKey || null,
          mountPath: entry.mountPath || null,
          version: entry.version || null,
          name: entry.name || entry.appId || null,
          description: entry.description || '',
          author: entry.author || null,
          blind: entry.blind || false,
          privacyTier: entry.privacyTier || 'public',
          categories: entry.categories || null,
          startedAt: entry.startedAt || Date.now(),
          discoveryKey: entry.discoveryKey
            ? (typeof entry.discoveryKey === 'string' ? entry.discoveryKey : entry.discoveryKey.toString('hex'))
            : null
        })
      }

      const tmpPath = this._filePath + '.tmp'
      await writeFile(tmpPath, JSON.stringify(entries, null, 2))
      await rename(tmpPath, this._filePath)
    } catch (err) {
      this.emit('error', { context: 'save', error: err })
    } finally {
      this._saving = false
      if (this._savePending) {
        this._savePending = false
        this.save().catch(() => {})
      }
    }
  }

  _scheduleSave () {
    if (this._saveDebounceTimer) clearTimeout(this._saveDebounceTimer)
    this._saveDebounceTimer = setTimeout(() => {
      this._saveDebounceTimer = null
      this.save().catch(() => {})
    }, 5000)
  }

  /**
   * Force an immediate save, bypassing the debounce timer.
   * Call during shutdown to ensure state is persisted.
   */
  async flush () {
    if (this._saveDebounceTimer) {
      clearTimeout(this._saveDebounceTimer)
      this._saveDebounceTimer = null
    }
    await this.save()
  }
}

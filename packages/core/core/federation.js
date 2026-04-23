/**
 * Federation — explicit, opt-in cross-relay catalog sharing.
 *
 * The deprecated CatalogSync module auto-polled every discovered relay and
 * auto-seeded everything new it found. That made operators answerable for
 * content they never agreed to carry. Federation replaces that with the
 * RSS / Nostr-relay model: an operator chooses which other relays to follow
 * or mirror, and even followed catalogs go through their accept-mode gate
 * before anything actually gets seeded.
 *
 * Two relationships:
 *   follow(url)   — periodically pulls /catalog.json from that relay. Each
 *                   newly discovered app is funneled through the local
 *                   accept-mode (Review queues it; Allowlist applies the
 *                   publisher filter; Open auto-accepts; Closed drops it).
 *   mirror(url)   — used for "my own other node" or a trusted partner. Apps
 *                   discovered through this relay's *Protomux* catalog
 *                   broadcast bypass the accept queue and are seeded
 *                   immediately. Use sparingly.
 *
 * No auto-discovery. If an operator hasn't followed/mirrored a relay,
 * nothing crosses over from that relay — full stop.
 */

import { EventEmitter } from 'events'
import http from 'http'
import { readFile, writeFile, mkdir, rename, unlink } from 'fs/promises'
import { dirname, basename, join } from 'path'

const DEFAULT_FOLLOW_INTERVAL = 5 * 60 * 1000 // 5 minutes
const FETCH_TIMEOUT = 10_000
const MAX_URL_LENGTH = 2048

// Validate a federation source URL. Returns the validated URL string or throws.
// Caller-supplied URLs (follow/mirror/republish) get the throwing variant; the
// load() path uses validateUrlSafe() which returns false instead so a single
// bad entry on disk can't crash federation startup.
function validateUrl (url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('Federation: URL must be a non-empty string')
  }
  if (url.length > MAX_URL_LENGTH) {
    throw new Error(`Federation: URL exceeds maximum length of ${MAX_URL_LENGTH} characters`)
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Federation: invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Federation: URL scheme must be http: or https: (got ${parsed.protocol})`)
  }
  return url
}

function validateUrlSafe (url) {
  try {
    validateUrl(url)
    return true
  } catch {
    return false
  }
}

export class Federation extends EventEmitter {
  /**
   * @param {object} opts
   * @param {RelayNode} opts.node - relay node reference (for accept queue, seedApp)
   * @param {number}  [opts.followInterval] - ms between catalog pulls for followed relays
   * @param {Array}   [opts.followed] - initial followed entries: [{ url, pubkey? }]
   * @param {Array}   [opts.mirrored] - initial mirrored entries: [{ url, pubkey? }]
   * @param {string}  [opts.storagePath] - JSON file for persisting follow/mirror state
   *                                       across restarts. If omitted, state is runtime-only.
   */
  constructor (opts = {}) {
    super()
    this.node = opts.node
    this.followInterval = opts.followInterval || DEFAULT_FOLLOW_INTERVAL
    this.storagePath = opts.storagePath || null
    // Keyed by URL so follow/unfollow are idempotent.
    this.followed = new Map()
    this.mirrored = new Map()
    // Republish: operator's curated channel of apps that originate on other
    // relays. Keyed by appKey. We don't (necessarily) seed them — we surface
    // them in /catalog.json with attribution so subscribers see them too.
    this.republished = new Map()
    for (const entry of opts.followed || []) this._addFollowed(entry.url, entry.pubkey, entry.addedAt)
    for (const entry of opts.mirrored || []) this._addMirrored(entry.url, entry.pubkey, entry.addedAt)
    for (const entry of opts.republished || []) this._addRepublished(entry)

    // Pubkey index for quick "is this peer mirrored?" lookups during catalog broadcasts.
    this._mirroredPubkeys = new Set()
    for (const e of this.mirrored.values()) {
      if (e.pubkey) this._mirroredPubkeys.add(e.pubkey)
    }

    this._timer = null
    this.running = false
    this._saveInFlight = null // de-dupe concurrent saves
  }

  /**
   * Load persisted follow/mirror state from disk. Safe to call when no file
   * exists (first boot) — silently no-ops in that case.
   */
  async load () {
    if (!this.storagePath) return
    let raw
    try {
      raw = await readFile(this.storagePath, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return
      this.emit('persistence-error', { phase: 'load', error: err })
      return
    }
    let data
    try {
      data = JSON.parse(raw)
    } catch (err) {
      this.emit('persistence-error', { phase: 'parse', error: err })
      return
    }
    if (Array.isArray(data.followed)) {
      for (const entry of data.followed) {
        if (!entry || !validateUrlSafe(entry.url)) {
          this.emit('persistence-error', { phase: 'load-skip-invalid', kind: 'followed', entry })
          continue
        }
        this._addFollowed(entry.url, entry.pubkey, entry.addedAt)
      }
    }
    if (Array.isArray(data.mirrored)) {
      for (const entry of data.mirrored) {
        if (!entry || !validateUrlSafe(entry.url)) {
          this.emit('persistence-error', { phase: 'load-skip-invalid', kind: 'mirrored', entry })
          continue
        }
        this._addMirrored(entry.url, entry.pubkey, entry.addedAt)
      }
    }
    if (Array.isArray(data.republished)) {
      for (const entry of data.republished) {
        // sourceUrl is optional on republished entries — only validate when present.
        if (entry && entry.sourceUrl != null && !validateUrlSafe(entry.sourceUrl)) {
          this.emit('persistence-error', { phase: 'load-skip-invalid', kind: 'republished', entry })
          continue
        }
        this._addRepublished(entry)
      }
    }
    this.emit('loaded', this.snapshot())
  }

  /**
   * Persist follow/mirror state. Coalesces concurrent calls so a burst of
   * follow()/unfollow() doesn't trigger overlapping writes.
   */
  async save () {
    if (!this.storagePath) return
    if (this._saveInFlight) return this._saveInFlight
    this._saveInFlight = (async () => {
      // Atomic write: writeFile(.tmp) then rename — POSIX rename is atomic,
      // so SIGKILL mid-write leaves either the old file intact or the new one
      // in place, never a partial. Cleans up .tmp on any error.
      const tmpPath = join(dirname(this.storagePath), basename(this.storagePath) + '.tmp')
      try {
        await mkdir(dirname(this.storagePath), { recursive: true })
        const payload = JSON.stringify({
          followed: Array.from(this.followed.values()),
          mirrored: Array.from(this.mirrored.values()),
          republished: Array.from(this.republished.values()),
          savedAt: Date.now()
        }, null, 2)
        await writeFile(tmpPath, payload, 'utf8')
        await rename(tmpPath, this.storagePath)
      } catch (err) {
        // Best-effort cleanup of any leftover .tmp on failure.
        try { await unlink(tmpPath) } catch (_) {}
        this.emit('persistence-error', { phase: 'save', error: err })
      } finally {
        this._saveInFlight = null
      }
    })()
    return this._saveInFlight
  }

  // Internal: add to map without emitting, used by load() so persisted state
  // doesn't trigger save() / events recursively. Bad URLs are dropped silently
  // — load() emits 'persistence-error' with phase 'load-skip-invalid' before
  // calling these so we have observability without crashing federation.
  _addFollowed (url, pubkey, addedAt) {
    if (!validateUrlSafe(url)) return
    this.followed.set(url, { url, pubkey: pubkey || null, addedAt: addedAt || Date.now() })
  }

  _addMirrored (url, pubkey, addedAt) {
    if (!validateUrlSafe(url)) return
    this.mirrored.set(url, { url, pubkey: pubkey || null, addedAt: addedAt || Date.now() })
    if (pubkey) this._mirroredPubkeys.add(pubkey)
  }

  _addRepublished (entry) {
    if (!entry || !entry.appKey) return
    if (entry.sourceUrl != null && !validateUrlSafe(entry.sourceUrl)) return
    this.republished.set(entry.appKey, {
      appKey: entry.appKey,
      sourceUrl: entry.sourceUrl || null,
      sourcePubkey: entry.sourcePubkey || null,
      channel: entry.channel || null,
      note: entry.note || null,
      addedAt: entry.addedAt || Date.now()
    })
  }

  start () {
    if (this.running) return
    this.running = true
    if (this.followed.size > 0) this._scheduleNextPoll()
    this.emit('started', this.snapshot())
  }

  async stop () {
    this.running = false
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this.emit('stopped')
  }

  // ─── Subscription management ────────────────────────────────────────

  follow (url, { pubkey = null } = {}) {
    validateUrl(url)
    this._addFollowed(url, pubkey, Date.now())
    this.emit('followed', { url, pubkey })
    this.save() // fire-and-forget; errors emit 'persistence-error'
    if (this.running && !this._timer) this._scheduleNextPoll()
  }

  mirror (url, { pubkey = null } = {}) {
    validateUrl(url)
    this._addMirrored(url, pubkey, Date.now())
    this.emit('mirrored', { url, pubkey })
    this.save()
  }

  unfollow (url) {
    const removedFollow = this.followed.delete(url)
    const mirrorEntry = this.mirrored.get(url)
    const removedMirror = this.mirrored.delete(url)
    if (mirrorEntry?.pubkey) this._mirroredPubkeys.delete(mirrorEntry.pubkey)
    if (removedFollow || removedMirror) {
      this.emit('unfollowed', { url })
      this.save()
    }
    return removedFollow || removedMirror
  }

  /**
   * Republish a single app from another relay's catalog with attribution.
   * The app appears in this relay's /catalog.json under federation.republished
   * with the source relay credited. Republishing does NOT auto-seed — if the
   * operator also wants to seed the app locally, they accept it via the
   * normal seed-request queue.
   */
  republish (appKey, { sourceUrl = null, sourcePubkey = null, channel = null, note = null } = {}) {
    if (!appKey || typeof appKey !== 'string') throw new Error('Federation: republish(appKey) requires a string appKey')
    if (sourceUrl != null) validateUrl(sourceUrl)
    this._addRepublished({ appKey, sourceUrl, sourcePubkey, channel, note, addedAt: Date.now() })
    this.emit('republished', { appKey, sourceUrl, channel })
    this.save()
  }

  unrepublish (appKey) {
    const removed = this.republished.delete(appKey)
    if (removed) {
      this.emit('unrepublished', { appKey })
      this.save()
    }
    return removed
  }

  /**
   * Is this remote relay pubkey on the operator's mirror list?
   * Called by the Protomux app-catalog handler in RelayNode to decide
   * whether to bypass the accept queue.
   */
  isMirroredPubkey (pubkey) {
    return !!pubkey && this._mirroredPubkeys.has(pubkey)
  }

  snapshot () {
    return {
      followed: Array.from(this.followed.values()),
      mirrored: Array.from(this.mirrored.values()),
      republished: Array.from(this.republished.values()),
      followIntervalMs: this.followInterval,
      running: this.running
    }
  }

  // ─── Polling followed catalogs ──────────────────────────────────────

  _scheduleNextPoll () {
    if (!this.running) return
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this._pollAll().catch(err => this.emit('poll-error', err)).finally(() => {
        if (this.running && this.followed.size > 0) this._scheduleNextPoll()
      })
    }, this.followInterval)
    if (this._timer.unref) this._timer.unref()
  }

  async _pollAll () {
    const entries = Array.from(this.followed.values())
    if (entries.length === 0) return
    const results = await Promise.allSettled(entries.map(e => this._pollOne(e)))
    let totalQueued = 0
    for (const r of results) {
      if (r.status === 'fulfilled') totalQueued += r.value || 0
    }
    this.emit('poll-complete', { polled: entries.length, queued: totalQueued })
  }

  async _pollOne (entry) {
    const data = await this._fetchCatalog(entry.url)
    if (!data || !Array.isArray(data.apps)) return 0

    let queued = 0
    for (const app of data.apps) {
      const appKey = app.appKey || app.driveKey || app.key
      if (!appKey) continue
      // Skip apps we already seed or have already queued.
      if (this.node?.seededApps?.has?.(appKey)) continue
      if (this.node?.appRegistry?.has?.(appKey)) continue
      if (this.node?._pendingRequests?.has?.(appKey)) continue

      // Funnel through the same accept-mode used for registry seed requests.
      const synthRequest = {
        appKey,
        publisherPubkey: app.publisherPubkey || app.author || null,
        contentType: app.type || 'app',
        privacyTier: app.privacyTier || 'public',
        replicationFactor: app.replicationFactor || 1,
        parentKey: app.parentKey || null,
        mountPath: app.mountPath || null,
        source: 'federation',
        sourceRelay: entry.url
      }

      const mode = this.node._resolveAcceptMode()
      const decision = this.node._decideAcceptance(synthRequest, mode)

      if (decision === 'reject') {
        this.emit('federation-rejected', { appKey, source: entry.url, mode })
        continue
      }

      if (decision === 'accept') {
        try {
          await this.node.seedApp(appKey, {
            publisherPubkey: synthRequest.publisherPubkey,
            type: synthRequest.contentType,
            parentKey: synthRequest.parentKey,
            mountPath: synthRequest.mountPath,
            privacyTier: synthRequest.privacyTier
          })
          this.emit('federation-seeded', { appKey, source: entry.url, mode })
        } catch (err) {
          this.emit('federation-error', { appKey, source: entry.url, error: err.message })
        }
        continue
      }

      // 'review' — queue for operator approval.
      this.node._pendingRequests.set(appKey, {
        ...synthRequest,
        discoveredAt: Date.now(),
        mode
      })
      this.node.emit('registry-pending', { appKey, publisher: synthRequest.publisherPubkey, source: 'federation' })
      this.emit('federation-queued', { appKey, source: entry.url })
      queued++
    }

    // Pull fork-proof gossip from this followed peer too. Bounded
    // poll — fork-proof gossip latency = followInterval (5 min by
    // default). Best-effort: if the remote has no /api/forks/proofs
    // endpoint or it errors, we silently move on.
    try { await this._pullForkProofs(entry.url) } catch (_) { /* non-fatal */ }

    return queued
  }

  /**
   * Pull a remote relay's published fork-proof list and merge into our
   * local fork detector. This is how equivocation evidence propagates
   * across federation peers — without active gossip there's no way for
   * client-A's fork detection to reach client-B.
   *
   * Best-effort: missing endpoint or malformed payload silently skipped.
   * Per-call timeout enforced via FETCH_TIMEOUT.
   */
  async _pullForkProofs (entryUrl) {
    if (!this.node?.forkDetector) return
    const data = await this._fetchJson(entryUrl, '/api/forks/proofs')
    if (!data || !Array.isArray(data.proofs)) return
    let merged = 0
    for (const proof of data.proofs) {
      if (!proof || !proof.hypercoreKey || !Array.isArray(proof.evidence) || proof.evidence.length < 2) continue
      const result = this.node.forkDetector.report({
        hypercoreKey: proof.hypercoreKey,
        blockIndex: proof.blockIndex || 0,
        evidenceA: proof.evidence[0],
        evidenceB: proof.evidence[1]
      })
      if (result.ok && !result.recordExists) merged++
    }
    if (merged > 0) {
      this.emit('fork-proofs-merged', { source: entryUrl, count: merged })
    }
  }

  _fetchCatalog (url) {
    return new Promise((resolve) => {
      const target = url.endsWith('/catalog.json') ? url : url.replace(/\/+$/, '') + '/catalog.json'
      const req = http.get(target, { timeout: FETCH_TIMEOUT }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null) }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(body)) } catch { resolve(null) }
        })
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
    })
  }

  /**
   * Generic JSON fetch helper for federation pulls. Reuses the same
   * timeout + error tolerance as _fetchCatalog. Returns null on any
   * failure so callers can short-circuit cleanly.
   */
  _fetchJson (baseUrl, path) {
    return new Promise((resolve) => {
      const target = baseUrl.replace(/\/+$/, '') + path
      const req = http.get(target, { timeout: FETCH_TIMEOUT }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null) }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(body)) } catch { resolve(null) }
        })
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
    })
  }
}

/**
 * ForkDetector — observe and persist fork-proof evidence.
 *
 * A fork in a hypercore is the cryptographic smoking gun for
 * equivocation: the same author's key has signed two different blocks
 * for the same index. This is impossible by accident — it's either a
 * key-compromise event or a deliberate equivocation attack (one of the
 * named attacks in THREAT-MODEL.md).
 *
 * When a client observes the same hypercore from multiple relays in
 * its quorum and sees divergent blocks at the same index, both
 * versions (with their signatures) constitute a permanent
 * cryptographic proof. This module:
 *
 *   1. Captures and persists those proof pairs (atomic write to disk)
 *   2. Tags the offending hypercore key as "do-not-trust" so the
 *      client refuses to use either source until the operator resolves
 *   3. Optionally publishes the proof to the federation gossip channel
 *      so other relays can refuse the bad key too
 *
 * Forks are never auto-resolved. They require operator intervention —
 * usually because the operator needs to decide which fork to canonize
 * (e.g. after a key-rotation event) or to declare the key compromised
 * and revoke it via P2P-Auth.
 *
 * Storage shape (atomic JSON writes, same pattern as ManifestStore):
 *
 *   {
 *     "schemaVersion": 1,
 *     "forks": {
 *       "<hypercore-key-hex>": {
 *         "discoveredAt": <ms epoch>,
 *         "blockIndex": <int>,
 *         "evidence": [
 *           { "fromRelay": "<relay-pubkey>", "block": "<base64>", "signature": "<base64>" },
 *           { "fromRelay": "<relay-pubkey>", "block": "<base64>", "signature": "<base64>" }
 *         ],
 *         "operatorAcknowledged": false,
 *         "resolution": null  // 'rotated' | 'revoked' | 'false-alarm' | null
 *       }
 *     }
 *   }
 */

import { EventEmitter } from 'events'
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { dirname, basename, join } from 'path'

const SCHEMA_VERSION = 1

export class ForkDetector extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.storagePath]   Where to persist fork evidence.
   *                                      Null = runtime-only (tests).
   * @param {number} [opts.maxForks=1000] Bound the on-disk store so a
   *                                      bad actor can't fill the
   *                                      operator's disk with fake fork
   *                                      proofs. Oldest-discovered
   *                                      evicted first.
   */
  constructor (opts = {}) {
    super()
    this.storagePath = opts.storagePath || null
    this.maxForks = opts.maxForks || 1000
    this._forks = new Map() // hypercoreKeyHex -> ForkRecord
  }

  /**
   * Load any persisted fork records on startup.
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
      this.emit('load-error', { message: 'bad fork-detector JSON, starting fresh', error: err })
      return
    }
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return
    for (const [key, record] of Object.entries(parsed.forks || {})) {
      this._forks.set(key.toLowerCase(), record)
    }
  }

  /**
   * Persist current state. Atomic write (.tmp + rename) so a crash
   * during write doesn't corrupt the file.
   */
  async save () {
    if (!this.storagePath) return
    const dir = dirname(this.storagePath)
    try { await mkdir(dir, { recursive: true }) } catch (_) {}
    const payload = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      forks: Object.fromEntries(this._forks)
    }, null, 2)
    const tmp = join(dir, basename(this.storagePath) + '.tmp')
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, this.storagePath)
  }

  /**
   * Report a fork observation. Call this from the client when two
   * relays serve different blocks at the same index for the same
   * hypercore.
   *
   * @param {object} args
   * @param {string} args.hypercoreKey      key (hex) of the offending hypercore
   * @param {number} args.blockIndex        index where the divergence occurred
   * @param {object} args.evidenceA         { fromRelay, block, signature }
   * @param {object} args.evidenceB         { fromRelay, block, signature }
   * @returns {{ok: boolean, recordExists: boolean, reason?: string}}
   */
  report ({ hypercoreKey, blockIndex, evidenceA, evidenceB }) {
    if (typeof hypercoreKey !== 'string' || !/^[0-9a-f]{64}$/i.test(hypercoreKey)) {
      return { ok: false, reason: 'bad hypercoreKey' }
    }
    if (typeof blockIndex !== 'number' || !Number.isInteger(blockIndex) || blockIndex < 0) {
      return { ok: false, reason: 'bad blockIndex' }
    }
    if (!isWellFormedEvidence(evidenceA) || !isWellFormedEvidence(evidenceB)) {
      return { ok: false, reason: 'evidence requires fromRelay + block + signature' }
    }
    if (evidenceA.signature === evidenceB.signature) {
      return { ok: false, reason: 'evidence pair has identical signatures — not a fork' }
    }

    const key = hypercoreKey.toLowerCase()
    const existing = this._forks.get(key)
    if (existing) {
      // We already know about this fork. Append additional evidence
      // (more relays observed the divergence) but don't reset the
      // discoveredAt timestamp.
      const seen = new Set(existing.evidence.map(e => e.fromRelay + ':' + e.signature))
      let added = 0
      for (const e of [evidenceA, evidenceB]) {
        const tag = e.fromRelay + ':' + e.signature
        if (!seen.has(tag)) {
          existing.evidence.push(e)
          seen.add(tag)
          added++
        }
      }
      if (added > 0) this.emit('evidence-added', { hypercoreKey: key, added })
      return { ok: true, recordExists: true }
    }

    const record = {
      discoveredAt: Date.now(),
      blockIndex,
      evidence: [evidenceA, evidenceB],
      operatorAcknowledged: false,
      resolution: null
    }
    this._forks.set(key, record)
    this._enforceCap()
    this.emit('fork-detected', { hypercoreKey: key, record })
    return { ok: true, recordExists: false }
  }

  /**
   * Returns true iff this hypercore has an unresolved fork on record.
   * Clients should treat such hypercores as do-not-trust until the
   * operator resolves them.
   */
  isQuarantined (hypercoreKey) {
    const record = this._forks.get(hypercoreKey.toLowerCase())
    if (!record) return false
    return record.resolution === null
  }

  /**
   * Operator resolution — mark the fork as handled.
   *
   * @param {string} hypercoreKey
   * @param {object} args
   * @param {string} args.resolution  one of: 'rotated' | 'revoked' | 'false-alarm'
   * @param {string} [args.note]      operator-supplied context
   */
  resolve (hypercoreKey, { resolution, note }) {
    const valid = ['rotated', 'revoked', 'false-alarm']
    if (!valid.includes(resolution)) {
      return { ok: false, reason: 'resolution must be one of: ' + valid.join(', ') }
    }
    const key = hypercoreKey.toLowerCase()
    const record = this._forks.get(key)
    if (!record) return { ok: false, reason: 'no fork on record for this key' }
    record.resolution = resolution
    record.operatorAcknowledged = true
    record.resolvedAt = Date.now()
    if (note) record.resolutionNote = note
    this.emit('fork-resolved', { hypercoreKey: key, resolution })
    return { ok: true }
  }

  /**
   * Snapshot of all fork records — for the dashboard / API.
   */
  list () {
    return [...this._forks.entries()].map(([k, v]) => ({ hypercoreKey: k, ...v }))
  }

  /**
   * Number of unresolved forks. Useful as a health-check metric.
   */
  unresolvedCount () {
    let n = 0
    for (const r of this._forks.values()) if (r.resolution === null) n++
    return n
  }

  /**
   * Drop the oldest fork records when we hit the cap. Operators with
   * extremely active networks may want to bump maxForks.
   */
  _enforceCap () {
    if (this._forks.size <= this.maxForks) return
    const sorted = [...this._forks.entries()]
      .sort((a, b) => a[1].discoveredAt - b[1].discoveredAt)
    while (this._forks.size > this.maxForks && sorted.length) {
      const [key] = sorted.shift()
      this._forks.delete(key)
      this.emit('evicted', { hypercoreKey: key })
    }
  }
}

function isWellFormedEvidence (e) {
  return e &&
    typeof e === 'object' &&
    typeof e.fromRelay === 'string' && e.fromRelay.length > 0 &&
    typeof e.block === 'string' && e.block.length > 0 &&
    typeof e.signature === 'string' && e.signature.length > 0
}

export { SCHEMA_VERSION as FORK_DETECTOR_SCHEMA_VERSION }

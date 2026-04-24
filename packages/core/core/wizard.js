/**
 * First-run setup wizard — state machine + persistence.
 *
 * Used by the Umbrel App Store package (and any other one-click install
 * surface) to guide a fresh operator from "I just installed this" to
 * "my relay is online and earning sats" in 5 steps:
 *
 *   1. welcome         — user clicks "Let's go"
 *   2. relay_name      — operator picks a name (or accepts default)
 *   3. lnbits_connect  — paste LNbits admin key (URL auto-detected)
 *   4. accept_mode     — choose review/open/allowlist/closed (default: review)
 *   5. complete        — wizard done; main dashboard takes over
 *
 * State persists to a small JSON file in the storage dir so that:
 *   - Container restarts don't reset wizard progress
 *   - Operators returning mid-wizard pick up where they left off
 *   - Docker volume preservation (Umbrel's default) survives reinstalls
 *
 * The wizard is OPTIONAL — relays started via CLI or env-only configs
 * skip it entirely. The HTTP layer checks `wizard.isComplete()` and
 * redirects to /wizard only when the answer is false.
 */

import { EventEmitter } from 'events'
import { readFile, writeFile, rename, mkdir, chmod } from 'fs/promises'
import { dirname, basename, join } from 'path'
import { randomBytes, createHmac, createCipheriv, createDecipheriv } from 'crypto'

const VALID_STEPS = ['welcome', 'relay_name', 'lnbits_connect', 'accept_mode', 'complete']
const VALID_ACCEPT_MODES = ['open', 'review', 'allowlist', 'closed']
const SCHEMA_VERSION = 2 // bump from 1 → 2: adminKey is now encrypted at rest

// Encryption: AES-256-GCM. We use Node built-ins (crypto module) rather
// than sodium because the wizard is the one place in the codebase
// that's purely a Node-only path (Bare/Pear runtimes don't run the
// setup wizard). One fewer cross-runtime concern.
const ENCRYPTION_ALGO = 'aes-256-gcm'
const KEY_LENGTH = 32 // 256 bits
const IV_LENGTH = 12 // GCM standard
const AUTH_TAG_LENGTH = 16

export class SetupWizard extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.storagePath - JSON file path; usually `<storage>/wizard.json`
   * @param {object} [opts.defaults] - default values pre-filled in each step
   */
  constructor (opts = {}) {
    super()
    if (!opts.storagePath) throw new Error('SetupWizard requires storagePath')
    this.storagePath = opts.storagePath
    this.defaults = opts.defaults || {}
    // Encryption key source — caller can override for tests, otherwise
    // we derive from $APP_SEED (Umbrel-provided) or fall back to a
    // local key file. See _resolveEncryptionKey().
    this._appSeed = opts.appSeed || process.env.APP_SEED || null
    this._encryptionKey = null // lazily derived on first encrypt/decrypt
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      step: 'welcome',
      relayName: this.defaults.relayName || generateDefaultName(),
      // adminKey is stored encrypted; the property holds the ciphertext
      // envelope { iv, ciphertext, authTag } when set, or null when
      // unset. The plaintext is reconstructed only when toConfig() is
      // called by the relay node consumer.
      lnbits: { url: this.defaults.lnbitsUrl || 'http://lnbits_web_1:5000', adminKey: null },
      acceptMode: 'review',
      startedAt: null,
      completedAt: null
    }
  }

  /**
   * Load existing wizard state from disk. Silently no-ops if the file
   * doesn't exist (first run). Bad files are reset to defaults rather
   * than crashing the relay startup.
   *
   * Migration: if we read a v1 file with a plaintext adminKey, we
   * encrypt it and re-save on next save(). The plaintext is held in
   * memory until then.
   */
  async load () {
    let raw
    try {
      raw = await readFile(this.storagePath, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }
    try {
      const parsed = JSON.parse(raw)
      if (!parsed) return
      if (parsed.schemaVersion === SCHEMA_VERSION) {
        // Current schema — adminKey is already encrypted on disk.
        this.state = { ...this.state, ...parsed }
      } else if (parsed.schemaVersion === 1) {
        // v1 → v2 migration: plaintext adminKey on disk needs encryption.
        // We accept the data, mark it for re-save, and emit a migration
        // event so operators see this happened.
        this.state = { ...this.state, ...parsed, schemaVersion: SCHEMA_VERSION }
        if (parsed.lnbits && typeof parsed.lnbits.adminKey === 'string' && parsed.lnbits.adminKey.length > 0) {
          // Re-wrap the plaintext as an encrypted envelope. We must do
          // this before save(), but the caller drives save() — so just
          // mark the in-memory state as "needs re-encryption" by
          // putting plaintext in a tagged shape we recognize.
          this._pendingPlaintextAdminKey = parsed.lnbits.adminKey
          this.state.lnbits.adminKey = null // hide plaintext from snapshot()
        }
        this.emit('schema-migrated', { from: 1, to: SCHEMA_VERSION })
      }
    } catch (err) {
      this.emit('load-error', { message: 'bad wizard.json, resetting', error: err })
    }
  }

  /**
   * Persist current state. Atomic — write to .tmp then rename. Same
   * pattern federation.js / manifest-store.js use, so a power cut
   * never leaves a half-written wizard file.
   *
   * If a pending plaintext adminKey is held in memory (from a v1
   * migration), encrypt it now before writing.
   */
  async save () {
    const dir = dirname(this.storagePath)
    try { await mkdir(dir, { recursive: true }) } catch (_) {}

    // Handle v1→v2 migration of plaintext adminKey.
    if (this._pendingPlaintextAdminKey) {
      this.state.lnbits.adminKey = await this._encrypt(this._pendingPlaintextAdminKey)
      this._pendingPlaintextAdminKey = null
    }

    const tmp = join(dir, basename(this.storagePath) + '.tmp')
    await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    // Restrictive perms — wizard.json contains the encrypted LNbits
    // admin key. Even with encryption, defense in depth says the file
    // shouldn't be world-readable. 600 = owner read/write only.
    try { await chmod(tmp, 0o600) } catch (_) {}
    await rename(tmp, this.storagePath)
  }

  /**
   * Whether the wizard has been completed. The HTTP layer uses this to
   * decide whether to render the wizard or the main dashboard.
   */
  isComplete () {
    return this.state.step === 'complete'
  }

  /**
   * Snapshot of current state for the UI to render. Sensitive fields
   * (LNbits admin key) are redacted — the UI never needs to display them
   * back to the user.
   */
  snapshot () {
    // `connected` reflects whether the wizard knows of an admin key,
    // whether it's encrypted at rest OR pending plaintext (mid-migration).
    const hasKey = !!(this.state.lnbits.adminKey || this._pendingPlaintextAdminKey)
    return {
      step: this.state.step,
      relayName: this.state.relayName,
      lnbits: {
        url: this.state.lnbits.url,
        connected: hasKey
      },
      acceptMode: this.state.acceptMode,
      startedAt: this.state.startedAt,
      completedAt: this.state.completedAt,
      isComplete: this.isComplete()
    }
  }

  /**
   * Advance to the next step or jump to a specific one. The wizard is
   * permissive about jumping back — operators can revisit prior steps to
   * change their mind without losing state.
   *
   * @param {object} args
   * @param {string} args.step - next step name (must be in VALID_STEPS)
   * @returns {{ok: true, state: object} | {ok: false, reason: string}}
   */
  goToStep ({ step }) {
    if (!VALID_STEPS.includes(step)) {
      return { ok: false, reason: 'unknown step: ' + step }
    }
    if (this.state.startedAt === null) this.state.startedAt = Date.now()
    this.state.step = step
    this.emit('step-changed', { step })
    return { ok: true, state: this.snapshot() }
  }

  /**
   * Set the relay's display name. Used in the dashboard, in /api/info,
   * and as a hint for federation peers. Length-bounded so it doesn't
   * cause UI-layout problems.
   */
  setRelayName ({ relayName }) {
    if (typeof relayName !== 'string') return { ok: false, reason: 'relayName must be a string' }
    const trimmed = relayName.trim()
    if (trimmed.length === 0) return { ok: false, reason: 'relayName cannot be empty' }
    if (trimmed.length > 60) return { ok: false, reason: 'relayName max 60 chars' }
    this.state.relayName = trimmed
    return { ok: true, state: this.snapshot() }
  }

  /**
   * Configure LNbits connection. URL is usually auto-detected (Umbrel's
   * internal Docker DNS); admin key is what the operator pastes.
   *
   * The adminKey is ENCRYPTED at rest using AES-256-GCM with a key
   * derived from $APP_SEED (Umbrel-provided) — see _resolveEncryptionKey.
   * The plaintext lives in memory only between this call and the next
   * save(); after save(), the plaintext is gone and only ciphertext
   * remains.
   *
   * Does NOT test the connection here — the HTTP handler should do a
   * live ping before persisting, so the wizard only ever stores credentials
   * we know work.
   */
  async setLNbitsCredentials ({ url, adminKey }) {
    if (url !== undefined && typeof url !== 'string') {
      return { ok: false, reason: 'lnbits.url must be a string' }
    }
    if (typeof adminKey !== 'string' || adminKey.length === 0) {
      return { ok: false, reason: 'lnbits.adminKey required' }
    }
    if (url) this.state.lnbits.url = url.replace(/\/+$/, '')
    try {
      this.state.lnbits.adminKey = await this._encrypt(adminKey)
    } catch (err) {
      return { ok: false, reason: 'failed to encrypt admin key: ' + err.message }
    }
    return { ok: true, state: this.snapshot() }
  }

  /**
   * Set the accept-mode policy.
   */
  setAcceptMode ({ acceptMode }) {
    if (!VALID_ACCEPT_MODES.includes(acceptMode)) {
      return { ok: false, reason: 'acceptMode must be one of: ' + VALID_ACCEPT_MODES.join(', ') }
    }
    this.state.acceptMode = acceptMode
    return { ok: true, state: this.snapshot() }
  }

  /**
   * Mark the wizard complete. Caller should also call save() to persist.
   * This is what the dashboard's /api/wizard/complete handler invokes
   * after the operator has finished step 5.
   */
  complete () {
    this.state.step = 'complete'
    this.state.completedAt = Date.now()
    this.emit('completed', this.snapshot())
    return { ok: true, state: this.snapshot() }
  }

  /**
   * Returns the wizard's current settings as a config object the relay
   * node can consume on next start. The HTTP layer calls this after
   * complete() to merge wizard answers into the live config.
   *
   * Decrypts the adminKey ciphertext envelope before returning.
   * Caller becomes responsible for the plaintext value after this
   * point — should pass directly to the LNbits client and never log.
   */
  async toConfig () {
    let adminKey = null
    // If we're holding a pending plaintext (mid-migration from v1),
    // use it directly — the encrypted form hasn't been written yet.
    // This MUST be checked before the encrypted-envelope path because
    // during migration the in-memory state.lnbits.adminKey is null
    // (we cleared it from snapshots).
    if (this._pendingPlaintextAdminKey) {
      adminKey = this._pendingPlaintextAdminKey
    } else if (this.state.lnbits.adminKey) {
      try {
        adminKey = await this._decrypt(this.state.lnbits.adminKey)
      } catch (err) {
        this.emit('decrypt-error', { context: 'toConfig', error: err })
        // Don't throw — the relay can still function without LNbits;
        // the caller will see adminKey=null and prompt the operator
        // to re-enter the credential.
      }
    }
    return {
      name: this.state.relayName,
      acceptMode: this.state.acceptMode,
      lnbits: {
        url: this.state.lnbits.url,
        adminKey
      }
    }
  }

  /**
   * Reset the wizard. Mostly for debugging / reinstall scenarios.
   */
  reset () {
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      step: 'welcome',
      relayName: generateDefaultName(),
      lnbits: { url: 'http://lnbits_web_1:5000', adminKey: null },
      acceptMode: 'review',
      startedAt: null,
      completedAt: null
    }
  }

  // ─── Encryption helpers (private) ────────────────────────────────
  //
  // Two-tier key resolution:
  //   1. If $APP_SEED is available (Umbrel sets this; deterministic per
  //      app id), derive the encryption key from it via HKDF-SHA256.
  //      Reinstalls of the app on the same Umbrel restore the same
  //      key — operator's saved adminKey survives reinstall.
  //   2. Otherwise (dev/test/non-Umbrel deploy), generate a random key
  //      and persist it to <storage>/wizard.key with 0600 perms. Less
  //      secure than $APP_SEED-derived (key-on-disk vs key-from-env)
  //      but better than nothing.

  async _resolveEncryptionKey () {
    if (this._encryptionKey) return this._encryptionKey
    if (this._appSeed && this._appSeed.length >= 32) {
      // HKDF-extract style: HMAC-SHA256( salt='hiverelay/wizard/v1', input=appSeed )
      // Outputs a 32-byte key suitable for AES-256-GCM.
      this._encryptionKey = createHmac('sha256', 'hiverelay/wizard/v1')
        .update(Buffer.from(this._appSeed, 'utf8'))
        .digest()
      return this._encryptionKey
    }
    // Fallback: per-storage random key file with restrictive perms.
    const keyPath = join(dirname(this.storagePath), 'wizard.key')
    try {
      const existing = await readFile(keyPath)
      if (existing.length === KEY_LENGTH) {
        this._encryptionKey = existing
        return this._encryptionKey
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    this._encryptionKey = randomBytes(KEY_LENGTH)
    try { await mkdir(dirname(keyPath), { recursive: true }) } catch (_) {}
    await writeFile(keyPath, this._encryptionKey)
    try { await chmod(keyPath, 0o600) } catch (_) {}
    this.emit('key-generated', { keyPath })
    return this._encryptionKey
  }

  async _encrypt (plaintext) {
    const key = await this._resolveEncryptionKey()
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ENCRYPTION_ALGO, key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    return {
      v: 1, // envelope format version (independent of schemaVersion)
      iv: iv.toString('base64'),
      ciphertext: ct.toString('base64'),
      authTag: authTag.toString('base64')
    }
  }

  async _decrypt (envelope) {
    if (!envelope || typeof envelope !== 'object') {
      throw new Error('decrypt: envelope must be an object')
    }
    if (envelope.v !== 1) {
      throw new Error('decrypt: unsupported envelope version: ' + envelope.v)
    }
    const key = await this._resolveEncryptionKey()
    const iv = Buffer.from(envelope.iv, 'base64')
    const ct = Buffer.from(envelope.ciphertext, 'base64')
    const tag = Buffer.from(envelope.authTag, 'base64')
    if (iv.length !== IV_LENGTH) throw new Error('decrypt: bad iv length')
    if (tag.length !== AUTH_TAG_LENGTH) throw new Error('decrypt: bad auth tag length')
    const decipher = createDecipheriv(ENCRYPTION_ALGO, key, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
  }
}

/**
 * Picks a friendly default name. Combines a region-flavored adjective
 * with a noun + a 4-digit suffix, so operators get something like
 * `silent-ember-4291` they can keep or change.
 */
function generateDefaultName () {
  const adjectives = ['silent', 'sturdy', 'glowing', 'patient', 'humble', 'eager', 'crisp', 'steady']
  const nouns = ['ember', 'beacon', 'anchor', 'lantern', 'spark', 'pillar', 'compass', 'haven']
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
  const noun = nouns[Math.floor(Math.random() * nouns.length)]
  const suffix = String(Math.floor(Math.random() * 9000) + 1000)
  return `${adj}-${noun}-${suffix}`
}

export { VALID_STEPS, VALID_ACCEPT_MODES, SCHEMA_VERSION as WIZARD_SCHEMA_VERSION }

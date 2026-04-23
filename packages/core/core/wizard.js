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
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { dirname, basename, join } from 'path'

const VALID_STEPS = ['welcome', 'relay_name', 'lnbits_connect', 'accept_mode', 'complete']
const VALID_ACCEPT_MODES = ['open', 'review', 'allowlist', 'closed']
const SCHEMA_VERSION = 1

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
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      step: 'welcome',
      relayName: this.defaults.relayName || generateDefaultName(),
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
      if (parsed && parsed.schemaVersion === SCHEMA_VERSION) {
        this.state = { ...this.state, ...parsed }
      }
    } catch (err) {
      this.emit('load-error', { message: 'bad wizard.json, resetting', error: err })
    }
  }

  /**
   * Persist current state. Atomic — write to .tmp then rename. Same
   * pattern federation.js / manifest-store.js use, so a power cut
   * never leaves a half-written wizard file.
   */
  async save () {
    const dir = dirname(this.storagePath)
    try { await mkdir(dir, { recursive: true }) } catch (_) {}
    const tmp = join(dir, basename(this.storagePath) + '.tmp')
    await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
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
    return {
      step: this.state.step,
      relayName: this.state.relayName,
      lnbits: {
        url: this.state.lnbits.url,
        connected: !!this.state.lnbits.adminKey
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
   * Does NOT test the connection here — the HTTP handler should do a
   * live ping before persisting, so the wizard only ever stores credentials
   * we know work.
   */
  setLNbitsCredentials ({ url, adminKey }) {
    if (url !== undefined && typeof url !== 'string') {
      return { ok: false, reason: 'lnbits.url must be a string' }
    }
    if (typeof adminKey !== 'string' || adminKey.length === 0) {
      return { ok: false, reason: 'lnbits.adminKey required' }
    }
    if (url) this.state.lnbits.url = url.replace(/\/+$/, '')
    this.state.lnbits.adminKey = adminKey
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
   */
  toConfig () {
    return {
      name: this.state.relayName,
      acceptMode: this.state.acceptMode,
      lnbits: {
        url: this.state.lnbits.url,
        adminKey: this.state.lnbits.adminKey
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

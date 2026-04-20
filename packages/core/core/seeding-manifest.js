/**
 * Author-published seeding manifest.
 *
 * A seeding manifest is a short, signed document an author publishes to
 * declare "my drives are seeded on these relays; please fetch here." It's
 * the author-side complement to per-relay federation.follow() — the operator
 * says "I mirror these pubkeys", and the author says "I'm seeded at these
 * relays".
 *
 * Clients fetch a manifest by author pubkey (from any relay that caches it)
 * and use it to decide which relays to connect to for that author's content.
 *
 * Shape:
 *
 *   {
 *     type: 'hiverelay/seeding-manifest',
 *     version: 1,
 *     pubkey: '<author hex>',
 *     timestamp: 1729555555555,
 *     relays: [
 *       { url: 'hyperswarm://<pk>', role: 'primary' },
 *       { url: 'wss://relay.example.com/dht', role: 'backup' }
 *     ],
 *     drives: [
 *       { driveKey: '<hex>', channel: 'production' },
 *       { driveKey: '<hex>', channel: 'beta' }
 *     ],
 *     signature: '<hex, covers a canonical serialization>'
 *   }
 *
 * Signature coverage: `type|version|pubkey|timestamp|relays_json|drives_json`
 * where each JSON blob is canonicalized (keys sorted, no whitespace). This
 * keeps verification deterministic across runtimes and JSON encoders.
 */

import b4a from 'b4a'
import sodium from 'sodium-universal'

const MANIFEST_TYPE = 'hiverelay/seeding-manifest'
const MANIFEST_VERSION = 1
const VALID_RELAY_ROLES = new Set(['primary', 'backup', 'mirror'])
// Manifests newer than this many milliseconds in the future are rejected to
// limit replay/timestamp-tampering windows. 5 min is a reasonable default
// that accommodates clock drift without opening a meaningful replay window.
const TIMESTAMP_SKEW_MS = 5 * 60 * 1000
// Absolute bounds — refuse to even try to sign/verify a manifest bigger
// than this. Prevents DoS via enormous payload.
const MAX_RELAYS = 32
const MAX_DRIVES = 512

/**
 * Build + sign a seeding manifest.
 *
 * @param {object} args
 * @param {object} args.keyPair          Ed25519 keypair { publicKey, secretKey }
 * @param {Array}  args.relays           [{url, role}]
 * @param {Array}  args.drives           [{driveKey, channel?}]
 * @param {number} [args.timestamp]      ms epoch, defaults to Date.now()
 * @returns {object} signed manifest
 */
export function createSeedingManifest ({ keyPair, relays, drives, timestamp }) {
  if (!keyPair || !keyPair.publicKey || !keyPair.secretKey) {
    throw new Error('createSeedingManifest: missing keyPair')
  }
  const normRelays = normalizeRelays(relays)
  const normDrives = normalizeDrives(drives)
  if (normRelays.length > MAX_RELAYS) throw new Error('too many relays (max ' + MAX_RELAYS + ')')
  if (normDrives.length > MAX_DRIVES) throw new Error('too many drives (max ' + MAX_DRIVES + ')')

  const manifest = {
    type: MANIFEST_TYPE,
    version: MANIFEST_VERSION,
    pubkey: b4a.toString(keyPair.publicKey, 'hex'),
    timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
    relays: normRelays,
    drives: normDrives
  }

  const payload = canonicalPayload(manifest)
  const sig = b4a.alloc(64)
  sodium.crypto_sign_detached(sig, payload, keyPair.secretKey)
  manifest.signature = b4a.toString(sig, 'hex')
  return manifest
}

/**
 * Verify a seeding manifest. Pure — no clock side effects besides Date.now().
 *
 *   {valid: true, pubkey}                      — accept
 *   {valid: false, reason: '<short string>'}   — reject with machine-readable reason
 *
 * @param {object} manifest
 * @param {object} [opts]
 * @param {number} [opts.now]  — Date.now() equivalent, for deterministic tests
 * @returns {{valid: boolean, pubkey?: string, reason?: string}}
 */
export function verifySeedingManifest (manifest, opts = {}) {
  try {
    if (!manifest || typeof manifest !== 'object') return { valid: false, reason: 'not an object' }
    if (manifest.type !== MANIFEST_TYPE) return { valid: false, reason: 'wrong type' }
    if (manifest.version !== MANIFEST_VERSION) return { valid: false, reason: 'unsupported version' }
    if (typeof manifest.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.pubkey)) {
      return { valid: false, reason: 'bad pubkey' }
    }
    if (typeof manifest.timestamp !== 'number' || !Number.isFinite(manifest.timestamp)) {
      return { valid: false, reason: 'bad timestamp' }
    }
    const now = typeof opts.now === 'number' ? opts.now : Date.now()
    if (manifest.timestamp > now + TIMESTAMP_SKEW_MS) {
      return { valid: false, reason: 'timestamp in the future' }
    }
    if (!Array.isArray(manifest.relays)) return { valid: false, reason: 'relays not array' }
    if (!Array.isArray(manifest.drives)) return { valid: false, reason: 'drives not array' }
    if (manifest.relays.length > MAX_RELAYS) return { valid: false, reason: 'too many relays' }
    if (manifest.drives.length > MAX_DRIVES) return { valid: false, reason: 'too many drives' }

    // Re-validate shape (rejecting junk entries early).
    try {
      normalizeRelays(manifest.relays)
      normalizeDrives(manifest.drives)
    } catch (err) {
      return { valid: false, reason: err.message || 'bad entries' }
    }

    if (typeof manifest.signature !== 'string' || !/^[0-9a-f]{128}$/i.test(manifest.signature)) {
      return { valid: false, reason: 'bad signature' }
    }

    const payload = canonicalPayload(manifest)
    const sig = b4a.from(manifest.signature, 'hex')
    const pub = b4a.from(manifest.pubkey, 'hex')
    const ok = sodium.crypto_sign_verify_detached(sig, payload, pub)
    if (!ok) return { valid: false, reason: 'signature verification failed' }
    return { valid: true, pubkey: manifest.pubkey }
  } catch (err) {
    return { valid: false, reason: err.message || 'error' }
  }
}

/**
 * Is `a` a later version of `b` for the same author? Used by relays caching
 * multiple manifests from one author — newer timestamp wins. If pubkeys
 * differ, a is not a replacement at all.
 */
export function isNewerManifest (a, b) {
  if (!b) return true
  if (!a || a.pubkey !== b.pubkey) return false
  return (a.timestamp || 0) > (b.timestamp || 0)
}

// ─── Internal helpers ─────────────────────────────────────────────

function normalizeRelays (relays) {
  if (!Array.isArray(relays)) throw new Error('relays must be an array')
  const out = []
  for (const r of relays) {
    if (!r || typeof r !== 'object') throw new Error('relay entry not an object')
    if (typeof r.url !== 'string' || r.url.length === 0 || r.url.length > 512) {
      throw new Error('bad relay url')
    }
    const role = r.role || 'primary'
    if (!VALID_RELAY_ROLES.has(role)) throw new Error('bad relay role: ' + role)
    out.push({ url: r.url, role })
  }
  return out
}

function normalizeDrives (drives) {
  if (!Array.isArray(drives)) throw new Error('drives must be an array')
  const out = []
  for (const d of drives) {
    if (!d || typeof d !== 'object') throw new Error('drive entry not an object')
    if (typeof d.driveKey !== 'string' || !/^[0-9a-f]{64}$/i.test(d.driveKey)) {
      throw new Error('bad driveKey')
    }
    const entry = { driveKey: d.driveKey.toLowerCase() }
    if (d.channel !== undefined) {
      if (typeof d.channel !== 'string' || d.channel.length > 64) {
        throw new Error('bad channel')
      }
      entry.channel = d.channel
    }
    out.push(entry)
  }
  return out
}

/**
 * Canonical signable payload. We don't use JSON.stringify directly on the
 * whole manifest because JSON key order is implementation-defined in the
 * spec (though v8/node/bare happen to be stable). Instead we build a
 * fixed-order concatenation of:
 *
 *   type\n version\n pubkey\n timestamp\n relays_json\n drives_json
 *
 * where relays_json and drives_json each serialize an array of entries with
 * keys sorted alphabetically.
 */
function canonicalPayload (manifest) {
  const parts = [
    manifest.type,
    String(manifest.version),
    manifest.pubkey,
    String(manifest.timestamp),
    serializeArray(manifest.relays),
    serializeArray(manifest.drives)
  ]
  return b4a.from(parts.join('\n'), 'utf8')
}

function serializeArray (arr) {
  return JSON.stringify((arr || []).map(sortKeys))
}

function sortKeys (obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]
  return out
}

export {
  MANIFEST_TYPE,
  MANIFEST_VERSION,
  MAX_RELAYS,
  MAX_DRIVES,
  TIMESTAMP_SKEW_MS
}

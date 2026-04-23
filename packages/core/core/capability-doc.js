/**
 * HiveRelay capability advertisement.
 *
 * Returns a machine-readable JSON document describing this relay's identity,
 * version, accept policy, federation state, and operational limits. Clients
 * scan many relays' capability docs to pick which to talk to, without having
 * to speak Hypercore first. Served at:
 *
 *   GET /.well-known/hiverelay.json
 *
 * Shape is additive — unknown fields MUST be ignored by clients. Bump
 * `schemaVersion` only for breaking changes.
 *
 *   schemaVersion: 1  →  initial shape (v0.5.1)
 *
 * Zero external deps beyond b4a so this helper is safe to import from both
 * Node and Bare runtimes.
 */

import b4a from 'b4a'
import sodium from 'sodium-universal'
import { resolveAcceptMode } from './accept-mode.js'

const SCHEMA_VERSION = 1
// Signature envelope version, bumped independently of schemaVersion.
// Adding signing in v0.6.0 doesn't change the doc shape — clients that
// don't verify still parse the doc fine — so we don't bump schemaVersion.
const SIGNATURE_VERSION = 1

/**
 * Build the capability document from relay state.
 *
 * All inputs are optional — missing state is advertised as null/absent rather
 * than throwing. Designed to be cheap: called per HTTP request, returns in
 * <1ms even on a busy relay. Don't put expensive aggregations in here.
 *
 * @param {object} opts
 * @param {object} [opts.relay]       The RelayNode / BareRelay instance
 * @param {string} [opts.version]     Software version (e.g. '0.5.1')
 * @param {string} [opts.software]    Software URL
 * @param {string} [opts.name]        Operator-chosen relay name
 * @param {string} [opts.description] Operator-chosen blurb
 * @param {string} [opts.contact]     Operator contact (mailto:, https:, ...)
 * @param {string} [opts.termsOfService] URL to ToS document
 * @param {string} [opts.icon]        URL to an icon image
 * @param {string} [opts.runtime]     'node' | 'bare' — autodetected if absent
 * @returns {object} JSON-serializable capability document
 */
export function buildCapabilityDoc (opts = {}) {
  const relay = opts.relay || null
  const config = (relay && relay.config) || {}
  const runtime = opts.runtime || (typeof global !== 'undefined' && global.Bare ? 'bare' : 'node')

  // Identity ─ prefer explicit node identity, fall back to swarm keypair.
  const identity = extractIdentity(relay)

  // Accept policy ─ cheap, pure function over config.
  const acceptMode = resolveAcceptMode(config)

  // Transports actually enabled right now, not just compiled in.
  const transports = []
  if (config.discovery && config.discovery.dht !== false) transports.push('hyperswarm')
  if (config.discovery && config.discovery.mdns) transports.push('mdns')
  if (relay && relay.dhtRelayWs && relay.dhtRelayWs.running) transports.push('dht-relay-ws')
  if (relay && relay.torTransport && relay.torTransport.running) transports.push('tor')
  if (relay && relay.holesailTransport) transports.push('holesail')

  // Federation — snapshot is a pure read, no I/O.
  let federation = null
  if (relay && relay.federation) {
    try {
      const snap = relay.federation.snapshot()
      federation = {
        followed: Array.isArray(snap.followed) ? snap.followed.length : 0,
        mirrored: Array.isArray(snap.mirrored) ? snap.mirrored.length : 0,
        republished: Array.isArray(snap.republished) ? snap.republished.length : 0
      }
    } catch (_) {
      federation = null
    }
  }

  // Limitation block — standardized names where semantics align with common
  // relay-info conventions, plus HiveRelay-specific fields. Clients SHOULD
  // treat all as informational; actual enforcement lives on the relay.
  const limitation = {
    accept_mode: acceptMode,
    max_pending_requests: numberOr(config.maxPendingRequests, null),
    max_connections: numberOr(config.maxConnections, null),
    max_storage_bytes: numberOr(config.maxStorageBytes, null),
    max_relay_bandwidth_mbps: numberOr(config.maxRelayBandwidthMbps, null),
    delegation_required: booleanOr(config.delegationRequired, false),
    payment_required: !!(relay && relay.paymentManager && relay.paymentManager.paymentProvider),
    auth_required: booleanOr(config.authRequired, false)
  }

  // Supported feature flags, advertised so clients can branch. Names map
  // 1:1 to what the SDK checks.
  const features = []
  if (relay && relay.federation) features.push('federation')
  if (relay && relay._checkDelegation) features.push('delegation-certs')
  if (relay && relay._revokedCertSignatures) features.push('delegation-revocation')
  if (relay && relay.dhtRelayWs) features.push('dht-relay-ws')
  if (relay && relay.seedingRegistry) features.push('seeding-registry')
  if (relay && relay.alertManager) features.push('alerts')
  if (relay && relay.selfHeal) features.push('self-heal')
  if (relay && relay.torTransport) features.push('tor-transport')
  if (relay && relay._bandwidthReceipt) features.push('bandwidth-receipts')
  if (relay && relay.reputation) features.push('reputation')
  features.push('capability-doc') // we're advertising this doc, so always set

  // Fees block — only populated if a paymentManager is configured AND the
  // operator has set a fee schedule.
  let fees = null
  if (relay && relay.paymentManager && config.fees && typeof config.fees === 'object') {
    fees = config.fees
  }

  // Counts — cheap. More detailed telemetry lives on /api/overview.
  let catalog = null
  if (relay && relay.appRegistry && typeof relay.appRegistry.catalog === 'function') {
    try {
      const entries = relay.appRegistry.catalog() || []
      catalog = {
        total: entries.length,
        apps: entries.filter(e => e.type === 'app').length,
        drives: entries.filter(e => e.type === 'drive' && !e.parentKey).length,
        resources: entries.filter(e => e.type === 'drive' && !!e.parentKey).length,
        datasets: entries.filter(e => e.type === 'dataset').length,
        media: entries.filter(e => e.type === 'media').length
      }
    } catch (_) { catalog = null }
  }

  // Region — operators configure via regions[]. First entry is canonical.
  const region = (Array.isArray(config.regions) && config.regions[0]) || null

  const doc = {
    schemaVersion: SCHEMA_VERSION,
    name: opts.name || config.name || null,
    description: opts.description || config.description || null,
    icon: opts.icon || config.icon || null,
    pubkey: identity,
    software: opts.software || 'https://github.com/bigdestiny2/p2p-hiverelay',
    version: opts.version || null,
    runtime,
    region,
    contact: opts.contact || config.contact || null,
    terms_of_service: opts.termsOfService || config.termsOfService || null,
    supported_transports: transports,
    features: features.sort(),
    limitation,
    federation,
    catalog,
    fees
  }

  // Sign the doc with the relay's identity secret key, if available.
  // The signature covers a canonical serialization of all fields above
  // (sorted keys, no signature field). Clients verify against the
  // pubkey IN the doc — TOFU model. A future revision should support
  // operator-pinned pubkey verification (out-of-band trust on first
  // contact, then verify the SAME pubkey on every subsequent fetch).
  const secretKey = opts.identitySecretKey ||
    (relay && relay.identityKeyPair && relay.identityKeyPair.secretKey) ||
    (relay && relay.swarm && relay.swarm.keyPair && relay.swarm.keyPair.secretKey) ||
    null
  if (secretKey && identity) {
    try {
      const payload = canonicalSignablePayload(doc)
      const sig = b4a.alloc(64)
      sodium.crypto_sign_detached(sig, payload, secretKey)
      doc.signature = {
        v: SIGNATURE_VERSION,
        sig: b4a.toString(sig, 'hex')
      }
    } catch (_) {
      // If signing fails, ship the unsigned doc rather than 500-ing —
      // unsigned is still better than no doc at all, and the signature
      // is additive defense.
    }
  }
  return doc
}

/**
 * Verify a capability doc's signature against the pubkey contained in
 * the doc itself (TOFU model). Returns { valid, reason }.
 *
 * The verification is over the canonical signable payload — the same
 * function buildCapabilityDoc uses to construct the signed bytes —
 * so JSON re-encoding between server and client doesn't break it.
 *
 * @param {object} doc
 * @returns {{valid: boolean, reason?: string}}
 */
export function verifyCapabilityDoc (doc) {
  if (!doc || typeof doc !== 'object') return { valid: false, reason: 'not an object' }
  if (!doc.signature) return { valid: false, reason: 'no signature on doc' }
  if (doc.signature.v !== SIGNATURE_VERSION) {
    return { valid: false, reason: 'unsupported signature version: ' + doc.signature.v }
  }
  if (typeof doc.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(doc.pubkey)) {
    return { valid: false, reason: 'no valid pubkey on doc' }
  }
  if (typeof doc.signature.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(doc.signature.sig)) {
    return { valid: false, reason: 'malformed signature' }
  }
  try {
    const payload = canonicalSignablePayload(doc)
    const sig = b4a.from(doc.signature.sig, 'hex')
    const pub = b4a.from(doc.pubkey, 'hex')
    const ok = sodium.crypto_sign_verify_detached(sig, payload, pub)
    return ok ? { valid: true } : { valid: false, reason: 'signature verification failed' }
  } catch (err) {
    return { valid: false, reason: 'verify error: ' + err.message }
  }
}

/**
 * Canonical serialization for signing. Excludes the signature field
 * (chicken-and-egg) and serializes all other fields with sorted keys
 * so two encoders that differ on key order still produce identical
 * bytes for the same doc.
 */
function canonicalSignablePayload (doc) {
  const clone = {}
  for (const k of Object.keys(doc).sort()) {
    if (k === 'signature') continue
    clone[k] = sortKeysDeep(doc[k])
  }
  return b4a.from(JSON.stringify(clone), 'utf8')
}

function sortKeysDeep (val) {
  if (Array.isArray(val)) return val.map(sortKeysDeep)
  if (val && typeof val === 'object') {
    const out = {}
    for (const k of Object.keys(val).sort()) out[k] = sortKeysDeep(val[k])
    return out
  }
  return val
}

function extractIdentity (relay) {
  if (!relay) return null
  if (typeof relay.getIdentityPublicKey === 'function') {
    try {
      const pk = relay.getIdentityPublicKey()
      if (pk) return typeof pk === 'string' ? pk : b4a.toString(pk, 'hex')
    } catch (_) {}
  }
  if (relay.publicKey) {
    try { return b4a.toString(relay.publicKey, 'hex') } catch (_) {}
  }
  if (relay.swarm && relay.swarm.keyPair && relay.swarm.keyPair.publicKey) {
    try { return b4a.toString(relay.swarm.keyPair.publicKey, 'hex') } catch (_) {}
  }
  return null
}

function numberOr (v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function booleanOr (v, fallback) {
  return typeof v === 'boolean' ? v : fallback
}

export { SCHEMA_VERSION as CAPABILITY_DOC_SCHEMA_VERSION }

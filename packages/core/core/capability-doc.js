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
import { resolveAcceptMode } from './accept-mode.js'

const SCHEMA_VERSION = 1

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

  return {
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

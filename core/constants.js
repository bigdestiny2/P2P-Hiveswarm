/**
 * Shared constants and utility helpers for HiveRelay.
 *
 * Consolidates values and functions that were duplicated across the
 * codebase (relay-node, client SDK, gateway, network-discovery, etc.).
 */

import b4a from 'b4a'
import sodium from 'sodium-universal'

// ─── Discovery ───────────────────────────────────────────────

/**
 * Well-known 32-byte DHT topic that all HiveRelay nodes join for
 * peer discovery.  Derived deterministically from the string
 * 'hiverelay-discovery-v1' via BLAKE2b (crypto_generichash).
 */
const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

// ─── Validation ──────────────────────────────────────────────

/**
 * Validate a hex-encoded key string.
 * @param {*} str - value to check
 * @param {number} [len=64] - expected character length (64 for 32-byte keys)
 * @returns {boolean}
 */
function isValidHexKey (str, len = 64) {
  return typeof str === 'string' && str.length === len && /^[0-9a-f]+$/i.test(str)
}

// ─── Versioning ──────────────────────────────────────────────

/**
 * Compare two semver-style version strings.
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
function compareVersions (a, b) {
  const pa = (a || '0.0.0').split('.').map(Number)
  const pb = (b || '0.0.0').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

// ─── Binary helpers ──────────────────────────────────────────

/**
 * Convert a number to an 8-byte big-endian Buffer (uint64).
 * @param {number} n
 * @returns {Buffer}
 */
function uint64ToBuffer (n) {
  const buf = b4a.alloc(8)
  const view = new DataView(buf.buffer, buf.byteOffset, 8)
  view.setBigUint64(0, BigInt(n), false) // big-endian
  return buf
}

export {
  RELAY_DISCOVERY_TOPIC,
  isValidHexKey,
  compareVersions,
  uint64ToBuffer
}

/**
 * Fork-proof observer signatures.
 *
 * Closes attack 8.2 from SECURITY-STRATEGY.md: when fork proofs are
 * accepted unsigned, an adversary can POST junk proofs to quarantine
 * legitimate drives across the federation. Requiring an observer
 * signature commits the report to a specific identity, costs the
 * attacker a fresh keypair per fake proof, and gives Operator Score
 * (M2) something to weight against.
 *
 * Design:
 *   - The signature covers a canonical serialization of:
 *       hypercoreKey | blockIndex | canonicalEvidence | observer.pubkey | attestedAt
 *     so any field tampering invalidates the signature.
 *   - attestedAt is a millisecond-epoch timestamp inside the signed
 *     payload. Receivers can reject proofs older than a configurable
 *     freshness window (default 7 days) — old proofs may be replayed
 *     against drives that have since had the fork resolved.
 *   - Same Ed25519 primitive as delegation certs and seeding manifests
 *     for cross-reuse of audit experience.
 *
 * Compatibility:
 *   - Existing unsigned proofs continue to be accepted by ForkDetector
 *     locally (an app's own fork detection has internal trust). The
 *     signed envelope is a transport-level requirement: when proofs
 *     cross the network (POST /api/forks/proof, federation pull),
 *     they MUST be signed.
 *   - The signed envelope wraps the proof, doesn't replace it. So
 *     downstream code that consumes proofs via `signedProof.proof`
 *     looks unchanged.
 */

import b4a from 'b4a'
import sodium from 'sodium-universal'

const SIGNATURE_VERSION = 1
const DEFAULT_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
// Future-replay protection: don't accept attestedAt timestamps more
// than this far in the future (a reasonable clock-skew tolerance).
const FUTURE_SKEW_TOLERANCE_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Sign a fork proof with an observer's identity keypair. Returns the
 * full signed envelope ready to POST or include in gossip.
 *
 * @param {object} proof - the unsigned proof:
 *                         { hypercoreKey, blockIndex, evidence: [a, b] }
 * @param {object} observerKeyPair - { publicKey: Buffer(32), secretKey: Buffer(64) }
 * @param {object} [opts]
 * @param {number} [opts.attestedAt] - override timestamp (for tests)
 * @returns {object} signed envelope:
 *                   { version, proof, observer: { pubkey, signature, attestedAt } }
 */
export function signForkProof (proof, observerKeyPair, opts = {}) {
  if (!proof || typeof proof !== 'object') {
    throw new Error('signForkProof: proof required')
  }
  if (!observerKeyPair || !observerKeyPair.publicKey || !observerKeyPair.secretKey) {
    throw new Error('signForkProof: observerKeyPair { publicKey, secretKey } required')
  }
  if (typeof proof.hypercoreKey !== 'string' || !/^[0-9a-f]{64}$/i.test(proof.hypercoreKey)) {
    throw new Error('signForkProof: proof.hypercoreKey must be 64 hex chars')
  }
  if (!Array.isArray(proof.evidence) || proof.evidence.length < 2) {
    throw new Error('signForkProof: proof.evidence must have at least 2 entries')
  }

  const attestedAt = typeof opts.attestedAt === 'number' ? opts.attestedAt : Date.now()
  const observerPubkeyHex = b4a.toString(observerKeyPair.publicKey, 'hex')

  const payload = canonicalSignablePayload({
    hypercoreKey: proof.hypercoreKey.toLowerCase(),
    blockIndex: typeof proof.blockIndex === 'number' ? proof.blockIndex : 0,
    evidence: proof.evidence,
    observerPubkey: observerPubkeyHex,
    attestedAt
  })

  const sig = b4a.alloc(64)
  sodium.crypto_sign_detached(sig, payload, observerKeyPair.secretKey)

  return {
    version: SIGNATURE_VERSION,
    proof: {
      hypercoreKey: proof.hypercoreKey.toLowerCase(),
      blockIndex: typeof proof.blockIndex === 'number' ? proof.blockIndex : 0,
      evidence: proof.evidence
    },
    observer: {
      pubkey: observerPubkeyHex,
      signature: b4a.toString(sig, 'hex'),
      attestedAt
    }
  }
}

/**
 * Verify a signed fork-proof envelope.
 *
 * @param {object} signed - output of signForkProof()
 * @param {object} [opts]
 * @param {number} [opts.now]                Date.now() override for tests
 * @param {number} [opts.freshnessWindowMs]  reject older than this (default 7d)
 * @returns {{valid: boolean, observer?: string, reason?: string}}
 */
export function verifyForkProof (signed, opts = {}) {
  try {
    if (!signed || typeof signed !== 'object') return { valid: false, reason: 'not an object' }
    if (signed.version !== SIGNATURE_VERSION) {
      return { valid: false, reason: 'unsupported signature version: ' + signed.version }
    }
    if (!signed.proof || typeof signed.proof !== 'object') {
      return { valid: false, reason: 'no proof in envelope' }
    }
    if (!signed.observer || typeof signed.observer !== 'object') {
      return { valid: false, reason: 'no observer in envelope' }
    }
    const { proof, observer } = signed
    if (typeof proof.hypercoreKey !== 'string' || !/^[0-9a-f]{64}$/i.test(proof.hypercoreKey)) {
      return { valid: false, reason: 'bad proof.hypercoreKey' }
    }
    if (!Array.isArray(proof.evidence) || proof.evidence.length < 2) {
      return { valid: false, reason: 'proof.evidence must have at least 2 entries' }
    }
    if (typeof observer.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(observer.pubkey)) {
      return { valid: false, reason: 'bad observer.pubkey' }
    }
    if (typeof observer.signature !== 'string' || !/^[0-9a-f]{128}$/i.test(observer.signature)) {
      return { valid: false, reason: 'bad observer.signature' }
    }
    if (typeof observer.attestedAt !== 'number' || !Number.isFinite(observer.attestedAt)) {
      return { valid: false, reason: 'bad observer.attestedAt' }
    }

    const now = typeof opts.now === 'number' ? opts.now : Date.now()
    if (observer.attestedAt > now + FUTURE_SKEW_TOLERANCE_MS) {
      return { valid: false, reason: 'attestedAt is in the future' }
    }
    const window = opts.freshnessWindowMs || DEFAULT_FRESHNESS_WINDOW_MS
    if (now - observer.attestedAt > window) {
      return { valid: false, reason: 'attestedAt is too old (replay protection)' }
    }

    const payload = canonicalSignablePayload({
      hypercoreKey: proof.hypercoreKey,
      blockIndex: proof.blockIndex || 0,
      evidence: proof.evidence,
      observerPubkey: observer.pubkey,
      attestedAt: observer.attestedAt
    })
    const sig = b4a.from(observer.signature, 'hex')
    const pub = b4a.from(observer.pubkey, 'hex')
    const ok = sodium.crypto_sign_verify_detached(sig, payload, pub)
    if (!ok) return { valid: false, reason: 'signature verification failed' }
    return { valid: true, observer: observer.pubkey }
  } catch (err) {
    return { valid: false, reason: 'verify error: ' + err.message }
  }
}

/**
 * Canonical serialization for signing. Sorts evidence-entry keys so
 * different JSON encoders produce identical bytes for the same
 * logical input.
 */
function canonicalSignablePayload (parts) {
  const evidenceCanonical = (parts.evidence || []).map(e => {
    if (!e || typeof e !== 'object') return null
    const sorted = {}
    for (const k of Object.keys(e).sort()) sorted[k] = e[k]
    return sorted
  })
  const lines = [
    String(parts.hypercoreKey),
    String(parts.blockIndex),
    JSON.stringify(evidenceCanonical),
    String(parts.observerPubkey),
    String(parts.attestedAt)
  ]
  return b4a.from(lines.join('\n'), 'utf8')
}

export {
  SIGNATURE_VERSION as FORK_PROOF_SIGNATURE_VERSION,
  DEFAULT_FRESHNESS_WINDOW_MS,
  FUTURE_SKEW_TOLERANCE_MS
}

/**
 * Delegation cert verification + revocation
 *
 * Pure functions for verifying device-attestation certs produced by
 * `HiveRelayClient.createDeviceAttestation`. The cert payload format is:
 *
 *   payload = primaryPubkey(32) || devicePubkey(32) || expiresAt(8 bytes BE) || label(utf8)
 *   signature = ed25519_sign(payload, primaryPrivateKey)
 *
 * Revocations let the primary identity invalidate a previously-issued cert
 * before its natural `expiresAt`. A revocation is signed by the primary key
 * and refers to the cert's signature (64-byte uniqueness) so lookups are
 * cheap. Revocation payload:
 *
 *   payload = primaryPubkey(32) || revokedCertSig(64) || revokedAt(8 BE) || reason(utf8, ≤256 bytes)
 *   signature = ed25519_sign(payload, primaryPrivateKey)
 *
 * This module is I/O-free so it can be imported from both the Node and
 * Bare runtimes. Persistence and broadcast live above this layer.
 */

import b4a from 'b4a'
import sodium from 'sodium-universal'

const MAX_REASON_BYTES = 256

/**
 * Verify a device delegation cert.
 *
 * @param {object} cert - The cert to verify (shape produced by createDeviceAttestation)
 * @returns {{valid: boolean, primaryPubkey?: string, reason?: string}}
 */
export function verifyDelegationCert (cert) {
  try {
    if (!cert || typeof cert !== 'object') {
      return { valid: false, reason: 'missing cert' }
    }
    if (cert.version !== 1) {
      return { valid: false, reason: 'unsupported version' }
    }
    if (typeof cert.primaryPubkey !== 'string' || typeof cert.devicePubkey !== 'string') {
      return { valid: false, reason: 'missing pubkey' }
    }
    if (typeof cert.signature !== 'string') {
      return { valid: false, reason: 'missing signature' }
    }
    if (typeof cert.expiresAt !== 'number' || !Number.isFinite(cert.expiresAt)) {
      return { valid: false, reason: 'missing expiresAt' }
    }
    if (Date.now() > cert.expiresAt) {
      return { valid: false, reason: 'expired' }
    }

    let primaryPk, devicePk, sig
    try {
      primaryPk = b4a.from(cert.primaryPubkey, 'hex')
      devicePk = b4a.from(cert.devicePubkey, 'hex')
      sig = b4a.from(cert.signature, 'hex')
    } catch (err) {
      return { valid: false, reason: 'malformed hex' }
    }

    if (primaryPk.length !== 32 || devicePk.length !== 32 || sig.length !== 64) {
      return { valid: false, reason: 'malformed' }
    }

    const expBuf = b4a.alloc(8)
    new DataView(expBuf.buffer, expBuf.byteOffset).setBigUint64(0, BigInt(cert.expiresAt), false)
    const labelBuf = b4a.from(typeof cert.label === 'string' ? cert.label : '', 'utf8')
    const payload = b4a.concat([primaryPk, devicePk, expBuf, labelBuf])

    const ok = sodium.crypto_sign_verify_detached(sig, payload, primaryPk)
    if (!ok) return { valid: false, reason: 'bad signature' }

    return { valid: true, primaryPubkey: cert.primaryPubkey }
  } catch (err) {
    return { valid: false, reason: err && err.message ? err.message : String(err) }
  }
}

/**
 * Build a revocation message for a specific cert. Called by the primary
 * device (the one with the primary secret key) when a previously-issued
 * cert needs to be invalidated early (e.g. a paired device is lost).
 *
 * @param {object} cert - The cert being revoked (produced by createDeviceAttestation)
 * @param {Buffer|Uint8Array} primarySecretKey - The primary device's ed25519 secret key
 * @param {object} [opts]
 * @param {string} [opts.reason] - Human-readable reason, ≤256 UTF-8 bytes
 * @returns {{version, primaryPubkey, revokedCertSignature, revokedAt, reason, signature}}
 */
export function createRevocation (cert, primarySecretKey, opts = {}) {
  if (!cert || typeof cert !== 'object' || typeof cert.signature !== 'string') {
    throw new Error('createRevocation: invalid cert')
  }
  if (!primarySecretKey || primarySecretKey.length !== 64) {
    throw new Error('createRevocation: primarySecretKey must be a 64-byte ed25519 secret key')
  }

  const reason = typeof opts.reason === 'string' ? opts.reason : ''
  const reasonBuf = b4a.from(reason, 'utf8')
  if (reasonBuf.length > MAX_REASON_BYTES) {
    throw new Error(`createRevocation: reason exceeds ${MAX_REASON_BYTES} bytes`)
  }

  const primaryPk = b4a.from(cert.primaryPubkey, 'hex')
  const revokedSig = b4a.from(cert.signature, 'hex')
  if (primaryPk.length !== 32 || revokedSig.length !== 64) {
    throw new Error('createRevocation: malformed cert primaryPubkey/signature')
  }

  const revokedAt = Date.now()
  const tsBuf = b4a.alloc(8)
  new DataView(tsBuf.buffer, tsBuf.byteOffset).setBigUint64(0, BigInt(revokedAt), false)

  const payload = b4a.concat([primaryPk, revokedSig, tsBuf, reasonBuf])
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, payload, primarySecretKey)

  return {
    version: 1,
    primaryPubkey: cert.primaryPubkey,
    revokedCertSignature: cert.signature,
    revokedAt,
    reason,
    signature: b4a.toString(sig, 'hex')
  }
}

/**
 * Verify a revocation message. Must be signed by the same primary pubkey
 * that signed the original cert — anyone else's "revocation" is a forgery
 * and must be rejected. Revocation expiry is tied to the cert it invalidates
 * (handled by the caller: drop the revocation after the cert's expiresAt).
 *
 * @param {object} rev - The revocation message
 * @returns {{valid: boolean, revokedCertSignature?: string, reason?: string}}
 */
export function verifyRevocation (rev) {
  try {
    if (!rev || typeof rev !== 'object') return { valid: false, reason: 'missing revocation' }
    if (rev.version !== 1) return { valid: false, reason: 'unsupported version' }
    if (typeof rev.primaryPubkey !== 'string' || typeof rev.revokedCertSignature !== 'string' ||
        typeof rev.signature !== 'string') {
      return { valid: false, reason: 'missing fields' }
    }
    if (typeof rev.revokedAt !== 'number' || !Number.isFinite(rev.revokedAt)) {
      return { valid: false, reason: 'missing revokedAt' }
    }

    let primaryPk, revokedSig, sig
    try {
      primaryPk = b4a.from(rev.primaryPubkey, 'hex')
      revokedSig = b4a.from(rev.revokedCertSignature, 'hex')
      sig = b4a.from(rev.signature, 'hex')
    } catch (_) {
      return { valid: false, reason: 'malformed hex' }
    }
    if (primaryPk.length !== 32 || revokedSig.length !== 64 || sig.length !== 64) {
      return { valid: false, reason: 'malformed' }
    }

    const reason = typeof rev.reason === 'string' ? rev.reason : ''
    const reasonBuf = b4a.from(reason, 'utf8')
    if (reasonBuf.length > MAX_REASON_BYTES) {
      return { valid: false, reason: 'reason-too-long' }
    }

    const tsBuf = b4a.alloc(8)
    new DataView(tsBuf.buffer, tsBuf.byteOffset).setBigUint64(0, BigInt(rev.revokedAt), false)
    const payload = b4a.concat([primaryPk, revokedSig, tsBuf, reasonBuf])

    const ok = sodium.crypto_sign_verify_detached(sig, payload, primaryPk)
    if (!ok) return { valid: false, reason: 'bad signature' }

    return { valid: true, revokedCertSignature: rev.revokedCertSignature }
  } catch (err) {
    return { valid: false, reason: err && err.message ? err.message : String(err) }
  }
}

export default verifyDelegationCert

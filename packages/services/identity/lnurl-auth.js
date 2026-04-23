/**
 * LNURL-auth — Login with Lightning
 *
 * Implements the LNURL-auth protocol (LUD-04) for passwordless
 * authentication using a Lightning wallet's secp256k1 keypair.
 *
 * Flow:
 *   1. Relay generates a challenge (k1) and returns LNURL
 *   2. User scans QR with Lightning wallet
 *   3. Wallet signs the challenge with its key
 *   4. Wallet calls the relay's callback URL with sig + key
 *   5. Relay verifies the signature, creates a session
 *
 * The wallet's secp256k1 public key becomes the developer identity.
 * This is the same key used in Nostr (npub), making identity portable.
 *
 * Spec: https://github.com/lnurl/luds/blob/luds/04.md
 *
 * Note on key derivation: Per LUD-04, wallets derive a site-specific
 * key from their master key using the domain as input. This means the
 * key a wallet uses for your relay is deterministic but unique per domain.
 * We store whatever key the wallet presents — it's consistent per wallet
 * per domain.
 */

import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'
import { schnorrVerify, sha256Hex, bytesToHex } from './crypto.js'

// LNURL-auth also supports standard ECDSA secp256k1 signatures
// (not just Schnorr). Most wallets use DER-encoded ECDSA.
import * as secp from '@noble/secp256k1'

const CHALLENGE_TTL = 300_000 // 5 minutes
const CHALLENGE_BYTES = 32

export class LnurlAuth extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.domain = opts.domain || 'localhost'
    this.challengeTtl = opts.challengeTtl || CHALLENGE_TTL
    // k1 (hex) → { createdAt, expiresAt }
    this.pendingChallenges = new Map()
    // Callback handlers
    this.developerStore = opts.developerStore || null
    this.attestationService = opts.attestationService || null
  }

  /**
   * Generate a new LNURL-auth challenge.
   * Returns the k1 value and the full LNURL callback URL.
   *
   * @param {object} opts
   * @param {string} opts.baseUrl - The relay's base URL (e.g., https://relay.example.com)
   * @returns {{ k1: string, lnurl: string, expires: number }}
   */
  createChallenge (opts = {}) {
    const k1 = bytesToHex(randomBytes(CHALLENGE_BYTES))
    const expiresAt = Date.now() + this.challengeTtl

    this.pendingChallenges.set(k1, {
      createdAt: Date.now(),
      expiresAt
    })

    // Cleanup old challenges
    this._cleanup()

    const baseUrl = opts.baseUrl || `https://${this.domain}`
    const callbackUrl = `${baseUrl}/api/v1/identity/lnurl-auth/callback?tag=login&k1=${k1}&action=login`

    // LNURL is the callback URL encoded as bech32 (lnurl...)
    // For simplicity, we return both the raw URL and the encoded version
    const lnurl = encodeLnurl(callbackUrl)

    return {
      k1,
      callback: callbackUrl,
      lnurl,
      expires: expiresAt,
      tag: 'login'
    }
  }

  /**
   * Verify a wallet's response to an LNURL-auth challenge.
   * Called when the wallet hits the callback URL with sig + key.
   *
   * Per LUD-04, the wallet signs the k1 challenge with its linking key.
   * The signature is DER-encoded ECDSA over secp256k1.
   *
   * @param {string} k1 - The original challenge (hex)
   * @param {string} sig - DER-encoded signature (hex)
   * @param {string} key - Compressed public key (hex, 66 chars)
   * @returns {{ ok: boolean, developerKey?: string, session?: object, reason?: string }}
   */
  async verifyCallback (k1, sig, key) {
    // Check challenge exists and hasn't expired
    const challenge = this.pendingChallenges.get(k1)
    if (!challenge) {
      return { ok: false, reason: 'UNKNOWN_CHALLENGE' }
    }
    if (Date.now() > challenge.expiresAt) {
      this.pendingChallenges.delete(k1)
      return { ok: false, reason: 'CHALLENGE_EXPIRED' }
    }

    // Validate key format (compressed secp256k1 = 33 bytes = 66 hex chars)
    if (!key || (key.length !== 66 && key.length !== 64)) {
      return { ok: false, reason: 'INVALID_KEY_FORMAT' }
    }

    // Verify the ECDSA signature over the k1 challenge
    // LUD-04 specifies: sign(SHA256(k1_bytes), linking_key)
    const k1Hash = sha256Hex(Buffer.from(k1, 'hex'))
    let valid = false

    try {
      // Try DER-encoded ECDSA signature (standard LNURL-auth format)
      const sigBytes = hexToUint8(sig)
      const msgHash = hexToUint8(k1Hash)
      const keyBytes = hexToUint8(key)

      // secp.verify handles both DER and compact signature formats
      valid = secp.verify(sigBytes, msgHash, keyBytes)
    } catch {
      // If ECDSA fails, try Schnorr (some wallets use Schnorr)
      try {
        const xOnlyKey = key.length === 66 ? key.slice(2) : key
        valid = await schnorrVerify(sig, k1Hash, xOnlyKey)
      } catch {
        valid = false
      }
    }

    if (!valid) {
      return { ok: false, reason: 'INVALID_SIGNATURE' }
    }

    // Consume the challenge (one-time use)
    this.pendingChallenges.delete(k1)

    // Extract x-only pubkey (32 bytes) for developer identity
    const developerKey = key.length === 66 ? key.slice(2) : key

    // Create session if developer store is available
    let session = null
    if (this.developerStore) {
      session = this.developerStore.createSession(developerKey)
    }

    this.emit('auth-success', { developerKey, key })

    return {
      ok: true,
      developerKey,
      compressedKey: key.length === 66 ? key : null,
      session
    }
  }

  /**
   * Check if a challenge is still pending/valid.
   */
  isChallengePending (k1) {
    const challenge = this.pendingChallenges.get(k1)
    if (!challenge) return false
    if (Date.now() > challenge.expiresAt) {
      this.pendingChallenges.delete(k1)
      return false
    }
    return true
  }

  _cleanup () {
    const now = Date.now()
    for (const [k1, challenge] of this.pendingChallenges) {
      if (now > challenge.expiresAt) this.pendingChallenges.delete(k1)
    }
  }

  stats () {
    this._cleanup()
    return {
      pendingChallenges: this.pendingChallenges.size
    }
  }
}

// ─── LNURL Encoding ───

/**
 * Encode a URL as an LNURL (bech32-encoded with hrp "lnurl").
 */
function encodeLnurl (url) {
  const data = new TextEncoder().encode(url)
  return bech32Encode('lnurl', data)
}

function bech32Encode (hrp, data) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

  // Convert 8-bit bytes to 5-bit groups
  let acc = 0
  let bits = 0
  const data5bit = []
  for (const byte of data) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      data5bit.push((acc >> bits) & 0x1f)
    }
  }
  if (bits > 0) {
    data5bit.push((acc << (5 - bits)) & 0x1f)
  }

  const checksum = bech32Checksum(hrp, data5bit)
  const all = [...data5bit, ...checksum]

  return hrp + '1' + all.map(v => CHARSET[v]).join('')
}

function bech32Polymod (values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i]
    }
  }
  return chk
}

function bech32HrpExpand (hrp) {
  const ret = []
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5)
  ret.push(0)
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31)
  return ret
}

function bech32Checksum (hrp, data) {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
  const polymod = bech32Polymod(values) ^ 1
  const ret = []
  for (let i = 0; i < 6; i++) {
    ret.push((polymod >> (5 * (5 - i))) & 31)
  }
  return ret
}

function hexToUint8 (hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  }
  return bytes
}

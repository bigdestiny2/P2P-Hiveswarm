/**
 * Identity Crypto — secp256k1 primitives for the Identity Protocol Layer
 *
 * Provides Schnorr signing/verification (BIP-340) compatible with:
 *   - Lightning Network node keys
 *   - Nostr protocol (NIP-01, NIP-19)
 *   - Bitcoin key infrastructure
 *
 * Uses @noble/secp256k1 for the secp256k1 curve operations
 * and @noble/hashes for SHA-256 used in Schnorr signatures.
 *
 * Key formats:
 *   - secp256k1 private key: 32 bytes (64 hex chars)
 *   - secp256k1 public key (x-only / Schnorr): 32 bytes (64 hex chars)
 *   - secp256k1 public key (compressed): 33 bytes (66 hex chars)
 *   - Ed25519 public key: 32 bytes (64 hex chars) — used by Hyperswarm
 *   - Schnorr signature: 64 bytes (128 hex chars)
 */

import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { randomBytes } from 'crypto'

// Noble secp256k1 v2+ requires explicit hash wiring
secp.hashes.sha256 = (...msgs) => {
  const filtered = msgs.filter(m => m != null)
  return sha256(secp.etc.concatBytes(...filtered))
}
secp.hashes.hmacSha256 = (key, ...msgs) => {
  const filtered = msgs.filter(m => m != null)
  return hmac(sha256, key, secp.etc.concatBytes(...filtered))
}

const { schnorr, getPublicKey } = secp

/**
 * Generate a new secp256k1 keypair.
 * Returns x-only public key (32 bytes) for Schnorr/Nostr compatibility.
 */
export function generateKeypair () {
  const privateKey = randomBytes(32)
  const publicKey = getPublicKey(privateKey, true) // compressed (33 bytes)
  const xOnlyPubkey = publicKey.slice(1) // strip prefix byte → 32 bytes (x-only)

  return {
    privateKey: Buffer.from(privateKey),
    publicKey: Buffer.from(xOnlyPubkey),
    publicKeyHex: bytesToHex(xOnlyPubkey),
    compressedPubkey: Buffer.from(publicKey)
  }
}

/**
 * Get x-only public key from private key.
 */
export function pubkeyFromPrivate (privateKeyHex) {
  const compressed = getPublicKey(hexToBytes(privateKeyHex), true)
  return bytesToHex(compressed.slice(1))
}

/**
 * Sign a message using Schnorr (BIP-340).
 * Compatible with Nostr event signing.
 *
 * @param {string} messageHex - Message to sign (hex encoded)
 * @param {string} privateKeyHex - 32-byte private key (hex)
 * @returns {string} 64-byte Schnorr signature (hex)
 */
export async function schnorrSign (messageHex, privateKeyHex) {
  const msgBytes = hexToBytes(messageHex)
  const privBytes = hexToBytes(privateKeyHex)
  const sig = await schnorr.sign(msgBytes, privBytes)
  return bytesToHex(sig)
}

/**
 * Verify a Schnorr signature (BIP-340).
 * Compatible with Nostr event verification.
 *
 * @param {string} signatureHex - 64-byte signature (hex)
 * @param {string} messageHex - Signed message (hex)
 * @param {string} pubkeyHex - 32-byte x-only public key (hex)
 * @returns {boolean}
 */
export async function schnorrVerify (signatureHex, messageHex, pubkeyHex) {
  try {
    const sig = hexToBytes(signatureHex)
    const msg = hexToBytes(messageHex)
    const pub = hexToBytes(pubkeyHex)
    return await schnorr.verify(sig, msg, pub)
  } catch {
    return false
  }
}

/**
 * Hash a UTF-8 string with SHA-256, return hex.
 * Used to create message digests for signing.
 */
export function sha256Hex (input) {
  const bytes = typeof input === 'string'
    ? new TextEncoder().encode(input)
    : input
  return bytesToHex(sha256(bytes))
}

/**
 * Create a tagged hash per BIP-340 convention.
 * tag_hash = SHA256(SHA256(tag) || SHA256(tag) || message)
 */
export function taggedHash (tag, messageHex) {
  const tagBytes = new TextEncoder().encode(tag)
  const tagHash = sha256(tagBytes)
  const msgBytes = hexToBytes(messageHex)

  const buf = new Uint8Array(tagHash.length * 2 + msgBytes.length)
  buf.set(tagHash, 0)
  buf.set(tagHash, tagHash.length)
  buf.set(msgBytes, tagHash.length * 2)

  return bytesToHex(sha256(buf))
}

/**
 * Create the attestation message that links an Ed25519 app key
 * to a secp256k1 developer identity.
 *
 * Format: SHA256("hiverelay:attestation" || ed25519_pubkey || secp256k1_pubkey || timestamp)
 *
 * @param {string} ed25519PubkeyHex - App's Ed25519 public key (64 hex chars)
 * @param {string} secp256k1PubkeyHex - Developer's secp256k1 public key (64 hex chars)
 * @param {number} timestamp - Unix timestamp (seconds)
 * @returns {string} Message hash to sign (hex)
 */
export function createAttestationMessage (ed25519PubkeyHex, secp256k1PubkeyHex, timestamp) {
  const payload = `hiverelay:attestation:${ed25519PubkeyHex}:${secp256k1PubkeyHex}:${timestamp}`
  return sha256Hex(payload)
}

/**
 * Create an LNURL-auth challenge (k1 parameter).
 * Returns 32 random bytes as hex — the challenge the wallet signs.
 */
export function createAuthChallenge () {
  return bytesToHex(randomBytes(32))
}

/**
 * Convert a Nostr npub (bech32) to hex pubkey.
 * Simplified implementation — handles npub1... format.
 */
export function npubToHex (npub) {
  if (!npub.startsWith('npub1')) {
    throw new Error('Invalid npub format')
  }
  // Bech32 decode (simplified — 5-bit to 8-bit conversion)
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const data5bit = []
  for (let i = 5; i < npub.length - 6; i++) { // skip prefix and checksum
    const idx = CHARSET.indexOf(npub[i])
    if (idx === -1) throw new Error('Invalid bech32 character')
    data5bit.push(idx)
  }

  // Convert 5-bit groups to 8-bit bytes
  let acc = 0
  let bits = 0
  const bytes = []
  for (const val of data5bit) {
    acc = (acc << 5) | val
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }

  if (bytes.length !== 32) throw new Error('Invalid npub length')
  return bytesToHex(new Uint8Array(bytes))
}

/**
 * Convert a hex pubkey to Nostr npub (bech32).
 */
export function hexToNpub (hex) {
  const bytes = hexToBytes(hex)
  if (bytes.length !== 32) throw new Error('Invalid pubkey length')

  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

  // Convert 8-bit bytes to 5-bit groups
  let acc = 0
  let bits = 0
  const data5bit = []
  for (const byte of bytes) {
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

  // Bech32 encoding with checksum
  const hrp = 'npub'
  const values = [0, ...data5bit] // witness version 0 for bech32m... actually npub uses bech32
  const checksum = bech32Checksum(hrp, values)
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

export { bytesToHex, hexToBytes }

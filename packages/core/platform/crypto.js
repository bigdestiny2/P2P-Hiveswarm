/**
 * Platform Crypto API
 * ====================
 * Encryption, decryption, and hashing primitives for HiveRelay apps.
 *
 * Uses sodium-universal (libsodium) for all operations:
 * - Symmetric encryption: XChaCha20-Poly1305 (AEAD)
 * - Hashing: BLAKE2b (32-byte output)
 * - Random: OS CSPRNG via sodium
 *
 * All functions accept and return Buffers (b4a).
 */

import sodium from 'sodium-universal'
import b4a from 'b4a'

// XChaCha20-Poly1305 constants
const NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES // 24
const TAG_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES // 16
const KEY_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES // 32

/**
 * Encrypt plaintext with a 32-byte key using XChaCha20-Poly1305.
 *
 * Returns: nonce (24 bytes) || ciphertext+tag
 * The nonce is randomly generated and prepended to the output.
 *
 * @param {Buffer} plaintext - Data to encrypt
 * @param {Buffer} key - 32-byte encryption key
 * @param {Buffer} [aad] - Optional additional authenticated data
 * @returns {Buffer} nonce || ciphertext (authenticated)
 */
export function encrypt (plaintext, key, aad) {
  if (!b4a.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`Key must be ${KEY_BYTES} bytes`)
  }
  if (!b4a.isBuffer(plaintext)) {
    plaintext = b4a.from(plaintext)
  }

  const nonce = b4a.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)

  const ciphertext = b4a.alloc(plaintext.length + TAG_BYTES)

  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    ciphertext,
    plaintext,
    aad || null,
    null, // nsec (unused in this API)
    nonce,
    key
  )

  // Prepend nonce so decrypt can extract it
  return b4a.concat([nonce, ciphertext])
}

/**
 * Decrypt ciphertext produced by encrypt().
 *
 * @param {Buffer} sealed - nonce (24 bytes) || ciphertext+tag
 * @param {Buffer} key - 32-byte encryption key
 * @param {Buffer} [aad] - Optional additional authenticated data (must match encrypt)
 * @returns {Buffer} plaintext
 * @throws {Error} if decryption fails (wrong key, tampered data)
 */
export function decrypt (sealed, key, aad) {
  if (!b4a.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`Key must be ${KEY_BYTES} bytes`)
  }
  if (!b4a.isBuffer(sealed) || sealed.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error('Sealed data too short')
  }

  const nonce = sealed.subarray(0, NONCE_BYTES)
  const ciphertext = sealed.subarray(NONCE_BYTES)

  const plaintext = b4a.alloc(ciphertext.length - TAG_BYTES)

  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      plaintext,
      null, // nsec
      ciphertext,
      aad || null,
      nonce,
      key
    )
  } catch (err) {
    throw new Error('Decryption failed — wrong key or tampered data')
  }

  return plaintext
}

/**
 * BLAKE2b hash (32 bytes by default).
 *
 * @param {Buffer|string} data - Input data
 * @param {number} [outputLen=32] - Output length in bytes (16-64)
 * @returns {Buffer} hash
 */
export function hash (data, outputLen = 32) {
  if (!b4a.isBuffer(data)) data = b4a.from(data)
  const output = b4a.alloc(outputLen)
  sodium.crypto_generichash(output, data)
  return output
}

/**
 * Keyed BLAKE2b hash (MAC).
 *
 * @param {Buffer|string} data - Input data
 * @param {Buffer} key - 16-64 byte key
 * @param {number} [outputLen=32] - Output length in bytes
 * @returns {Buffer} MAC
 */
export function hashKeyed (data, key, outputLen = 32) {
  if (!b4a.isBuffer(data)) data = b4a.from(data)
  const output = b4a.alloc(outputLen)
  sodium.crypto_generichash(output, data, key)
  return output
}

/**
 * Generate cryptographically secure random bytes.
 *
 * @param {number} n - Number of bytes
 * @returns {Buffer}
 */
export function randomBytes (n) {
  const buf = b4a.alloc(n)
  sodium.randombytes_buf(buf)
  return buf
}

/**
 * Generate a random 32-byte encryption key.
 * @returns {Buffer}
 */
export function generateKey () {
  return randomBytes(KEY_BYTES)
}

/**
 * Constant-time buffer comparison.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {boolean}
 */
export function equal (a, b) {
  if (a.length !== b.length) return false
  return sodium.sodium_memcmp(a, b)
}

// Export constants for consumers
export const CONSTANTS = {
  KEY_BYTES,
  NONCE_BYTES,
  TAG_BYTES
}

export default {
  encrypt,
  decrypt,
  hash,
  hashKeyed,
  randomBytes,
  generateKey,
  equal,
  CONSTANTS
}

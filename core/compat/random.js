/**
 * Cross-runtime random-bytes helper.
 *
 * Works on:
 *   - Node.js (uses `node:crypto`)
 *   - Bare / Pear (uses `sodium-universal`, already a top-level dep)
 *
 * Exports:
 *   - randomBytes(size) → Buffer/Uint8Array of cryptographically-strong bytes
 *   - randomHex(size)   → hex string of size*2 chars
 */

import sodium from 'sodium-universal'
import b4a from 'b4a'

export function randomBytes (size) {
  const buf = b4a.alloc(size)
  sodium.randombytes_buf(buf)
  return buf
}

export function randomHex (size) {
  return b4a.toString(randomBytes(size), 'hex')
}

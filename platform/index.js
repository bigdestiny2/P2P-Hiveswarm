/**
 * HiveRelay Platform APIs
 * ========================
 * Privacy-respecting infrastructure primitives for Pear apps.
 *
 * Usage:
 *   import { PrivacyManager, KeyManager, LocalStorage, crypto } from './platform/index.js'
 */

export { PrivacyManager } from './privacy.js'
export { KeyManager } from './keys.js'
export { LocalStorage } from './storage.js'
export { encrypt, decrypt, hash, hashKeyed, randomBytes, generateKey, equal, CONSTANTS } from './crypto.js'
export { default as crypto } from './crypto.js'

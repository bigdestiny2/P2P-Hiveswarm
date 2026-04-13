/**
 * Identity Protocol Layer (IPL)
 *
 * Unified identity system that bridges:
 *   - Ed25519 keys (Hyperswarm P2P identity)
 *   - secp256k1 keys (Lightning/Nostr/Bitcoin identity)
 *
 * A developer's Lightning wallet key IS their identity.
 * The same key that pays invoices also proves who they are,
 * signs their app attestations, and resolves to their Nostr profile.
 *
 * Components:
 *   - AttestationService: Cryptographic bridge (secp256k1 ↔ Ed25519)
 *   - DeveloperStore: Profile resolution (Nostr/manual)
 *   - LnurlAuth: Passwordless authentication via Lightning wallet
 *   - Crypto: secp256k1 Schnorr sign/verify primitives
 */

import { AttestationService } from './attestation.js'
import { DeveloperStore } from './developer-store.js'
import { LnurlAuth } from './lnurl-auth.js'
import { EventEmitter } from 'events'

export class IdentityProtocol extends EventEmitter {
  constructor (opts = {}) {
    super()
    const storagePath = opts.storagePath || null

    this.attestation = new AttestationService({
      storagePath,
      maxAge: opts.attestationMaxAge
    })

    this.developers = new DeveloperStore({
      storagePath,
      nostrRelays: opts.nostrRelays,
      cacheTtl: opts.profileCacheTtl,
      sessionTtl: opts.sessionTtl
    })

    this.lnurlAuth = new LnurlAuth({
      domain: opts.domain,
      developerStore: this.developers,
      attestationService: this.attestation
    })

    // Alias for API compatibility (api.js uses identity.developerStore)
    this.developerStore = this.developers

    // Forward events
    this.attestation.on('attestation', (e) => this.emit('attestation', e))
    this.attestation.on('revocation', (e) => this.emit('revocation', e))
    this.developers.on('profile-updated', (e) => this.emit('profile-updated', e))
    this.lnurlAuth.on('auth-success', (e) => this.emit('auth-success', e))
  }

  /**
   * Load persisted state from disk.
   */
  async load () {
    await this.attestation.load()
    await this.developers.load()
  }

  /**
   * Resolve the full identity for an Ed25519 app key.
   * Returns developer profile + attestation info, or null if unlinked.
   *
   * @param {string} appKey - Ed25519 public key (hex)
   * @returns {{ developerKey, profile, attestation } | null}
   */
  async resolveIdentity (appKey) {
    const dev = this.attestation.resolveDeveloper(appKey)
    if (!dev) return null

    const profile = await this.developers.getCompactProfile(dev.developerKey)

    return {
      developerKey: dev.developerKey,
      profile,
      metadata: dev.metadata,
      attestation: dev.attestation
    }
  }

  /**
   * Router middleware that enriches context with developer identity.
   * Attach to the relay's router to auto-resolve identity on every call.
   */
  middleware () {
    return (route, params, context) => {
      this.attestation.enrichContext(context)
      return true
    }
  }

  /**
   * Validate a session token from a request.
   * Returns the developer key or null.
   */
  validateSession (token) {
    return this.developers.validateSession(token)
  }

  /**
   * Validate a request's authorization.
   * Checks for session token in Authorization header or cookie.
   *
   * @param {object} req - HTTP request
   * @returns {string|null} developerKey or null
   */
  authenticateRequest (req) {
    // Check Authorization: Bearer <session-token>
    const auth = req.headers?.authorization
    if (auth && auth.startsWith('Bearer ')) {
      const token = auth.slice(7)
      // Don't intercept API key auth — only handle session tokens (64 hex chars)
      if (token.length === 64 && /^[a-f0-9]+$/.test(token)) {
        return this.developers.validateSession(token)
      }
    }

    // Check X-Session-Token header
    const sessionToken = req.headers?.['x-session-token']
    if (sessionToken) {
      return this.developers.validateSession(sessionToken)
    }

    return null
  }

  stats () {
    return {
      ...this.attestation.stats(),
      ...this.developers.stats(),
      ...this.lnurlAuth.stats()
    }
  }
}

export { AttestationService } from './attestation.js'
export { DeveloperStore } from './developer-store.js'
export { LnurlAuth } from './lnurl-auth.js'
export * as identityCrypto from './crypto.js'

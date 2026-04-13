/**
 * Key Attestation Protocol
 *
 * The cryptographic bridge between Ed25519 (Hyperswarm/P2P identity)
 * and secp256k1 (Lightning/Nostr/Bitcoin identity).
 *
 * A developer proves they control a secp256k1 key (via Lightning wallet)
 * and then signs an attestation binding their Ed25519 app key(s) to that
 * identity. The relay stores and serves these attestations so any peer
 * can verify "this app belongs to this developer."
 *
 * Attestation lifecycle:
 *   1. Developer authenticates via LNURL-auth (proves secp256k1 ownership)
 *   2. Developer submits attestation: signs(ed25519AppKey, secp256k1Pubkey, timestamp)
 *   3. Relay verifies signature and stores the binding
 *   4. Any peer can query: "who owns this app key?" → returns developer identity
 *   5. Attestations can be revoked by the developer
 *
 * Wire format (stored + transmitted):
 *   {
 *     version: 1,
 *     type: 'app-key-attestation',
 *     appKey: string (Ed25519 hex, 64 chars),
 *     developerKey: string (secp256k1 x-only hex, 64 chars),
 *     timestamp: number (unix seconds),
 *     signature: string (Schnorr sig hex, 128 chars),
 *     metadata: { appName?, appDescription?, appVersion? }
 *   }
 */

import { EventEmitter } from 'events'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import {
  schnorrSign,
  schnorrVerify,
  createAttestationMessage
} from './crypto.js'

export class AttestationService extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.storagePath = opts.storagePath || null
    // developerKey (secp256k1 hex) → { profile, appKeys: Map<appKey, attestation> }
    this.developers = new Map()
    // appKey (Ed25519 hex) → developerKey (secp256k1 hex) — reverse index
    this.appKeyIndex = new Map()
    // Attestation expiry (0 = never expire, default: 1 year)
    this.maxAge = opts.maxAge || 365 * 24 * 60 * 60
  }

  /**
   * Create and sign a new attestation binding an Ed25519 app key
   * to a secp256k1 developer identity.
   *
   * @param {string} appKey - Ed25519 app public key (hex)
   * @param {string} developerKey - secp256k1 x-only public key (hex)
   * @param {string} privateKey - secp256k1 private key (hex) — only used client-side
   * @param {object} metadata - Optional app metadata { appName, appDescription, appVersion }
   * @returns {object} Signed attestation object
   */
  async createAttestation (appKey, developerKey, privateKey, metadata = {}) {
    if (!appKey || appKey.length !== 64) throw new Error('INVALID_APP_KEY')
    if (!developerKey || developerKey.length !== 64) throw new Error('INVALID_DEVELOPER_KEY')

    const timestamp = Math.floor(Date.now() / 1000)
    const message = createAttestationMessage(appKey, developerKey, timestamp)
    const signature = await schnorrSign(message, privateKey)

    return {
      version: 1,
      type: 'app-key-attestation',
      appKey,
      developerKey,
      timestamp,
      signature,
      metadata: {
        appName: metadata.appName || null,
        appDescription: metadata.appDescription || null,
        appVersion: metadata.appVersion || null
      }
    }
  }

  /**
   * Verify and store an attestation submitted by a developer.
   * Called by the relay when a developer submits a signed attestation.
   *
   * @param {object} attestation - Signed attestation object
   * @returns {{ valid: boolean, reason?: string }}
   */
  async submitAttestation (attestation) {
    // Validate structure
    if (!attestation || attestation.version !== 1 || attestation.type !== 'app-key-attestation') {
      return { valid: false, reason: 'INVALID_FORMAT' }
    }

    const { appKey, developerKey, timestamp, signature, metadata } = attestation

    if (!appKey || appKey.length !== 64) return { valid: false, reason: 'INVALID_APP_KEY' }
    if (!developerKey || developerKey.length !== 64) return { valid: false, reason: 'INVALID_DEVELOPER_KEY' }
    if (!signature || signature.length !== 128) return { valid: false, reason: 'INVALID_SIGNATURE' }
    if (!timestamp || typeof timestamp !== 'number') return { valid: false, reason: 'INVALID_TIMESTAMP' }

    // Check timestamp freshness (reject if too old or in the future)
    const now = Math.floor(Date.now() / 1000)
    if (timestamp > now + 300) return { valid: false, reason: 'TIMESTAMP_FUTURE' }
    if (this.maxAge > 0 && (now - timestamp) > this.maxAge) return { valid: false, reason: 'ATTESTATION_EXPIRED' }

    // Check if app key is already claimed by a different developer
    const existingOwner = this.appKeyIndex.get(appKey)
    if (existingOwner && existingOwner !== developerKey) {
      return { valid: false, reason: 'APP_KEY_CLAIMED' }
    }

    // Verify Schnorr signature
    const message = createAttestationMessage(appKey, developerKey, timestamp)
    const valid = await schnorrVerify(signature, message, developerKey)
    if (!valid) return { valid: false, reason: 'INVALID_SIGNATURE' }

    // Store the attestation
    if (!this.developers.has(developerKey)) {
      this.developers.set(developerKey, {
        developerKey,
        appKeys: new Map(),
        registeredAt: now,
        lastSeen: now
      })
    }

    const dev = this.developers.get(developerKey)
    dev.appKeys.set(appKey, {
      attestation,
      verifiedAt: now,
      metadata: metadata || {}
    })
    dev.lastSeen = now

    // Update reverse index
    this.appKeyIndex.set(appKey, developerKey)

    this.emit('attestation', { appKey, developerKey, metadata })

    // Persist
    if (this.storagePath) await this.save()

    return { valid: true }
  }

  /**
   * Revoke an attestation. Only the developer who created it can revoke.
   *
   * @param {string} appKey - Ed25519 app key to unlink
   * @param {string} developerKey - Must match the original developer
   */
  async revokeAttestation (appKey, developerKey) {
    const owner = this.appKeyIndex.get(appKey)
    if (!owner || owner !== developerKey) {
      return { revoked: false, reason: 'NOT_OWNER' }
    }

    const dev = this.developers.get(developerKey)
    if (dev) dev.appKeys.delete(appKey)
    this.appKeyIndex.delete(appKey)

    this.emit('revocation', { appKey, developerKey })

    if (this.storagePath) await this.save()

    return { revoked: true }
  }

  /**
   * Look up the developer identity for an Ed25519 app key.
   *
   * @param {string} appKey - Ed25519 public key (hex)
   * @returns {{ developerKey, metadata, registeredAt } | null}
   */
  resolveDeveloper (appKey) {
    const developerKey = this.appKeyIndex.get(appKey)
    if (!developerKey) return null

    const dev = this.developers.get(developerKey)
    if (!dev) return null

    const entry = dev.appKeys.get(appKey)
    if (!entry) return null

    return {
      developerKey,
      metadata: entry.metadata,
      attestation: entry.attestation,
      registeredAt: dev.registeredAt
    }
  }

  /**
   * Get all app keys owned by a developer.
   *
   * @param {string} developerKey - secp256k1 x-only public key (hex)
   * @returns {Array<{ appKey, metadata, verifiedAt }>}
   */
  getDeveloperApps (developerKey) {
    const dev = this.developers.get(developerKey)
    if (!dev) return []

    const apps = []
    for (const [appKey, entry] of dev.appKeys) {
      apps.push({
        appKey,
        metadata: entry.metadata,
        verifiedAt: entry.verifiedAt
      })
    }
    return apps
  }

  /**
   * Get all registered developers.
   */
  listDevelopers () {
    const list = []
    for (const [key, dev] of this.developers) {
      list.push({
        developerKey: key,
        appCount: dev.appKeys.size,
        registeredAt: dev.registeredAt,
        lastSeen: dev.lastSeen
      })
    }
    return list
  }

  /**
   * Resolve the developer identity for a router context.
   * Used by middleware to enrich context with developer info.
   *
   * @param {object} context - Router dispatch context
   * @returns {object} Enriched context
   */
  enrichContext (context) {
    const appKey = context.remotePubkey || context.appKey
    if (!appKey) return context

    const developer = this.resolveDeveloper(appKey)
    if (developer) {
      context.developerKey = developer.developerKey
      context.developerMeta = developer.metadata
    }
    return context
  }

  // ─── Persistence ───

  async save () {
    if (!this.storagePath) return
    await mkdir(this.storagePath, { recursive: true })

    const data = {
      version: 1,
      savedAt: Date.now(),
      developers: []
    }

    for (const [key, dev] of this.developers) {
      const apps = []
      for (const [appKey, entry] of dev.appKeys) {
        apps.push({ appKey, attestation: entry.attestation, verifiedAt: entry.verifiedAt, metadata: entry.metadata })
      }
      data.developers.push({
        developerKey: key,
        registeredAt: dev.registeredAt,
        lastSeen: dev.lastSeen,
        apps
      })
    }

    const filePath = join(this.storagePath, 'attestations.json')
    await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  async load () {
    if (!this.storagePath) return
    const filePath = join(this.storagePath, 'attestations.json')

    let raw
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch {
      return // No file yet
    }

    const data = JSON.parse(raw)
    if (data.version !== 1) return

    for (const dev of data.developers) {
      const appKeys = new Map()
      for (const entry of dev.apps) {
        appKeys.set(entry.appKey, {
          attestation: entry.attestation,
          verifiedAt: entry.verifiedAt,
          metadata: entry.metadata || {}
        })
        this.appKeyIndex.set(entry.appKey, dev.developerKey)
      }
      this.developers.set(dev.developerKey, {
        developerKey: dev.developerKey,
        appKeys,
        registeredAt: dev.registeredAt,
        lastSeen: dev.lastSeen
      })
    }
  }

  stats () {
    let totalAttestations = 0
    for (const dev of this.developers.values()) {
      totalAttestations += dev.appKeys.size
    }
    return {
      developers: this.developers.size,
      attestations: totalAttestations,
      appKeysLinked: this.appKeyIndex.size
    }
  }
}

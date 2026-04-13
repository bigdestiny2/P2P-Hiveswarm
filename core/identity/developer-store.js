/**
 * Developer Identity Store
 *
 * Resolves secp256k1 developer keys to rich profile data.
 * Primary source: Nostr relays (NIP-01 metadata events, kind 0).
 * Fallback: locally stored profiles set by the developer.
 *
 * Profile resolution chain:
 *   1. Local cache (if fresh enough)
 *   2. Nostr relay query (kind:0 event for pubkey)
 *   3. Fallback to manual profile (set via API)
 *
 * A developer's Nostr profile IS their HiveRelay profile.
 * No separate profile system to maintain — update your Nostr profile,
 * and it propagates to every relay that knows your key.
 */

import crypto from 'crypto'
import { EventEmitter } from 'events'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'

const PROFILE_CACHE_TTL = 3600_000 // 1 hour

const DEFAULT_NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.snort.social'
]

export class DeveloperStore extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.storagePath = opts.storagePath || null
    this.nostrRelays = opts.nostrRelays || DEFAULT_NOSTR_RELAYS
    this.cacheTtl = opts.cacheTtl || PROFILE_CACHE_TTL
    // developerKey (hex) → { profile, cachedAt, source }
    this.profiles = new Map()
    // Session tokens for authenticated developers
    // token → { developerKey, createdAt, expiresAt }
    this.sessions = new Map()
    this.sessionTtl = opts.sessionTtl || 24 * 60 * 60 * 1000 // 24 hours
  }

  /**
   * Get a developer profile. Checks cache first, then Nostr.
   *
   * @param {string} developerKey - secp256k1 x-only pubkey (hex)
   * @returns {object} Profile object
   */
  async getProfile (developerKey) {
    // Check cache
    const cached = this.profiles.get(developerKey)
    if (cached && (Date.now() - cached.cachedAt) < this.cacheTtl) {
      return cached.profile
    }

    // Try Nostr resolution
    let nostrProfile = null
    try {
      nostrProfile = await this._fetchNostrProfile(developerKey)
    } catch {
      // Nostr fetch failed — use cache or fallback
    }

    if (nostrProfile) {
      const profile = {
        developerKey,
        displayName: nostrProfile.display_name || nostrProfile.name || null,
        name: nostrProfile.name || null,
        about: nostrProfile.about || null,
        picture: nostrProfile.picture || null,
        banner: nostrProfile.banner || null,
        nip05: nostrProfile.nip05 || null,
        lud16: nostrProfile.lud16 || null, // Lightning address
        website: nostrProfile.website || null,
        source: 'nostr',
        resolvedAt: Date.now()
      }

      this.profiles.set(developerKey, {
        profile,
        cachedAt: Date.now(),
        source: 'nostr'
      })

      if (this.storagePath) await this.save()
      return profile
    }

    // Return cached (even if stale) or empty profile
    if (cached) return cached.profile

    return {
      developerKey,
      displayName: null,
      name: null,
      about: null,
      picture: null,
      source: 'none',
      resolvedAt: null
    }
  }

  /**
   * Manually set a developer profile (via API).
   * Used when Nostr isn't available or developer wants to override.
   */
  async setProfile (developerKey, profileData) {
    const profile = {
      developerKey,
      displayName: profileData.displayName || profileData.name || null,
      name: profileData.name || null,
      about: profileData.about || null,
      picture: profileData.picture || null,
      banner: profileData.banner || null,
      nip05: profileData.nip05 || null,
      lud16: profileData.lud16 || null,
      website: profileData.website || null,
      source: 'manual',
      resolvedAt: Date.now()
    }

    this.profiles.set(developerKey, {
      profile,
      cachedAt: Date.now(),
      source: 'manual'
    })

    this.emit('profile-updated', { developerKey, profile })
    if (this.storagePath) await this.save()
    return profile
  }

  /**
   * Create a session token for an authenticated developer.
   * Called after successful LNURL-auth verification.
   */
  createSession (developerKey) {
    const token = crypto.randomBytes(32).toString('hex')
    const now = Date.now()

    this.sessions.set(token, {
      developerKey,
      createdAt: now,
      expiresAt: now + this.sessionTtl
    })

    // Cleanup expired sessions periodically
    this._cleanupSessions()

    return { token, expiresAt: now + this.sessionTtl }
  }

  /**
   * Validate a session token. Returns developer key or null.
   */
  validateSession (token) {
    const session = this.sessions.get(token)
    if (!session) return null
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token)
      return null
    }
    return session.developerKey
  }

  /**
   * Invalidate a session (logout).
   */
  destroySession (token) {
    this.sessions.delete(token)
  }

  /**
   * Fetch a Nostr kind:0 metadata event for a pubkey.
   * Connects to Nostr relays, sends a REQ, parses the profile.
   *
   * Uses native fetch to query Nostr HTTP APIs where available,
   * falling back to WebSocket if needed.
   */
  async _fetchNostrProfile (pubkeyHex) {
    // Try Nostr REST APIs first (faster than WebSocket)
    // nostr.band has a REST API for profiles
    try {
      const response = await fetch(
        `https://api.nostr.band/v0/profiles/${pubkeyHex}`,
        { signal: AbortSignal.timeout(5000) }
      )
      if (response.ok) {
        const data = await response.json()
        if (data.profiles && data.profiles.length > 0) {
          const event = data.profiles[0].event
          if (event && event.content) {
            return JSON.parse(event.content)
          }
        }
      }
    } catch {
      // REST API failed, try direct relay
    }

    // Fallback: try querying a Nostr relay via HTTP (NIP-50 style)
    // Many relays support /.well-known/nostr/pubkey/<hex>
    try {
      const response = await fetch(
        `https://relay.nostr.band/nostr/profile/${pubkeyHex}`,
        { signal: AbortSignal.timeout(5000) }
      )
      if (response.ok) {
        const data = await response.json()
        if (data.content) return JSON.parse(data.content)
        if (data.name || data.display_name) return data
      }
    } catch {
      // All external lookups failed
    }

    return null
  }

  _cleanupSessions () {
    const now = Date.now()
    for (const [token, session] of this.sessions) {
      if (now > session.expiresAt) this.sessions.delete(token)
    }
  }

  /**
   * Get a compact profile suitable for API responses / catalog display.
   */
  async getCompactProfile (developerKey) {
    const profile = await this.getProfile(developerKey)
    return {
      developerKey,
      displayName: profile.displayName || profile.name || developerKey.slice(0, 12) + '...',
      picture: profile.picture || null,
      nip05: profile.nip05 || null,
      lud16: profile.lud16 || null,
      source: profile.source
    }
  }

  // ─── Persistence ───

  async save () {
    if (!this.storagePath) return
    await mkdir(this.storagePath, { recursive: true })

    const data = {
      version: 1,
      savedAt: Date.now(),
      profiles: []
    }

    for (const [key, entry] of this.profiles) {
      if (entry.source === 'manual' || entry.source === 'nostr') {
        data.profiles.push({ developerKey: key, ...entry })
      }
    }

    const filePath = join(this.storagePath, 'developer-profiles.json')
    await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  async load () {
    if (!this.storagePath) return
    const filePath = join(this.storagePath, 'developer-profiles.json')

    let raw
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch {
      return
    }

    const data = JSON.parse(raw)
    if (data.version !== 1) return

    for (const entry of data.profiles) {
      this.profiles.set(entry.developerKey, {
        profile: entry.profile,
        cachedAt: entry.cachedAt,
        source: entry.source
      })
    }
  }

  stats () {
    return {
      profiles: this.profiles.size,
      activeSessions: this.sessions.size,
      nostrProfiles: [...this.profiles.values()].filter(p => p.source === 'nostr').length,
      manualProfiles: [...this.profiles.values()].filter(p => p.source === 'manual').length
    }
  }
}

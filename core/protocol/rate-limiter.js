/**
 * Token Bucket Rate Limiter for P2P Protocols
 *
 * Provides per-peer rate limiting to prevent spam and abuse.
 * Used by protocol handlers to limit message rates from individual peers.
 */

export class TokenBucketRateLimiter {
  constructor (opts = {}) {
    this.tokensPerMinute = opts.tokensPerMinute || 100
    this.burstSize = opts.burstSize || 20
    this.banThreshold = opts.banThreshold || 5 // Multiplier before auto-ban
    this.banDurationMs = opts.banDurationMs || 5 * 60 * 1000 // 5 minutes

    this.buckets = new Map() // peerKey -> { tokens, lastRefill, violations }
    this.bannedPeers = new Map() // peerKey -> bannedUntil
    this._cleanupInterval = setInterval(() => this._cleanup(), 60_000)
  }

  /**
   * Check if a peer is allowed to make a request
   * @param {string} peerKey - Public key hex of the peer
   * @returns {object} { allowed: boolean, remaining: number, banned: boolean }
   */
  check (peerKey) {
    // Check if peer is banned
    const bannedUntil = this.bannedPeers.get(peerKey)
    if (bannedUntil) {
      if (Date.now() < bannedUntil) {
        return { allowed: false, remaining: 0, banned: true, bannedUntil }
      }
      // Ban expired
      this.bannedPeers.delete(peerKey)
    }

    // Get or create bucket
    let bucket = this.buckets.get(peerKey)
    if (!bucket) {
      bucket = {
        tokens: this.burstSize,
        lastRefill: Date.now(),
        violations: 0
      }
      this.buckets.set(peerKey, bucket)
    }

    // Refill tokens based on time elapsed
    const now = Date.now()
    const elapsed = now - bucket.lastRefill
    const tokensToAdd = (elapsed / 60000) * this.tokensPerMinute
    bucket.tokens = Math.min(this.burstSize, bucket.tokens + tokensToAdd)
    bucket.lastRefill = now

    // Check if request is allowed
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return { allowed: true, remaining: Math.floor(bucket.tokens), banned: false }
    }

    // Request denied - increment violations
    bucket.violations += 1

    // Auto-ban if violations exceed threshold
    if (bucket.violations > this.burstSize * this.banThreshold) {
      const banUntil = Date.now() + this.banDurationMs
      this.bannedPeers.set(peerKey, banUntil)
      this.buckets.delete(peerKey)
      return { allowed: false, remaining: 0, banned: true, bannedUntil: banUntil }
    }

    return { allowed: false, remaining: 0, banned: false }
  }

  /**
   * Get stats for a peer
   */
  getStats (peerKey) {
    const bucket = this.buckets.get(peerKey)
    const bannedUntil = this.bannedPeers.get(peerKey)

    return {
      tokens: bucket ? Math.floor(bucket.tokens) : this.burstSize,
      banned: !!bannedUntil,
      bannedUntil: bannedUntil || null
    }
  }

  /**
   * Manually ban a peer
   */
  ban (peerKey, durationMs = null) {
    const banUntil = Date.now() + (durationMs || this.banDurationMs)
    this.bannedPeers.set(peerKey, banUntil)
    this.buckets.delete(peerKey)
    return banUntil
  }

  /**
   * Unban a peer
   */
  unban (peerKey) {
    this.bannedPeers.delete(peerKey)
  }

  _cleanup () {
    const now = Date.now()

    // Clean up expired bans
    for (const [peerKey, bannedUntil] of this.bannedPeers) {
      if (now >= bannedUntil) {
        this.bannedPeers.delete(peerKey)
      }
    }

    // Clean up inactive buckets (10 minutes of inactivity)
    for (const [peerKey, bucket] of this.buckets) {
      if (now - bucket.lastRefill > 10 * 60 * 1000) {
        this.buckets.delete(peerKey)
      }
    }
  }

  destroy () {
    clearInterval(this._cleanupInterval)
    this.buckets.clear()
    this.bannedPeers.clear()
  }
}

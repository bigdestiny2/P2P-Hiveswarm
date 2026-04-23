/**
 * Free-Tier Manager
 *
 * Everything starts free. No payment required to use services.
 * Apps get generous free-tier limits — 10k AI calls, 50k embeddings,
 * 200k total calls per month. New wallets also get 1k welcome credits.
 *
 * When free-tier limits are hit, devs can contact the relay operator
 * for free credits or top up via Lightning.
 *
 * Tiers:
 *   free      - Default. Generous rate limits, no payment needed.
 *   standard  - Auto-promoted when app has credit balance, or via SLA.
 *   unlimited - Whitelisted apps (operator's own apps, partners).
 */

import { EventEmitter } from 'events'

const DEFAULT_FREE_LIMITS = {
  // Per-month limits for free tier
  'ai.infer': 10_000, // 10k inference calls/month
  'ai.embed': 50_000, // 50k embeddings/month
  'storage.drive-write': 10_000, // 10k writes/month
  'storage.drive-create': 100, // 100 drives/month
  _totalCalls: 200_000, // 200k total calls/month across all services
  _totalCostSats: 0 // free tier doesn't charge
}

const DEFAULT_STANDARD_LIMITS = {
  'ai.infer': 100_000,
  'ai.embed': 500_000,
  'storage.drive-write': 100_000,
  'storage.drive-create': 1_000,
  _totalCalls: 2_000_000,
  _totalCostSats: Infinity
}

export class FreeTierManager extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.freeLimits = { ...DEFAULT_FREE_LIMITS, ...opts.freeLimits }
    this.standardLimits = { ...DEFAULT_STANDARD_LIMITS, ...opts.standardLimits }

    // App tier assignments: appPubkey -> 'free' | 'standard' | 'unlimited'
    this.tiers = new Map()
    // Whitelisted apps (unlimited tier)
    this.whitelist = new Set(opts.whitelist || [])
    // CreditManager reference — if set, apps with credits get 'standard' tier
    this.creditManager = opts.creditManager || null
  }

  /**
   * Check if an app is allowed to make a service call.
   * Returns { allowed: true } or { allowed: false, reason, limit, current }.
   */
  check (appPubkey, route, meter) {
    const tier = this.getTier(appPubkey)

    // Unlimited apps are never throttled
    if (tier === 'unlimited') return { allowed: true, tier }

    // Standard tier has very high limits
    if (tier === 'standard') {
      const limits = this.standardLimits
      return this._checkLimits(appPubkey, route, meter, limits, tier)
    }

    // Free tier — enforce quotas
    const limits = this.freeLimits
    return this._checkLimits(appPubkey, route, meter, limits, tier)
  }

  _checkLimits (appPubkey, route, meter, limits, tier) {
    // Check per-route limit
    if (limits[route] !== undefined) {
      const current = meter.getRouteCalls(appPubkey, route)
      if (current >= limits[route]) {
        this.emit('quota-exceeded', { app: appPubkey, route, limit: limits[route], current, tier })
        return {
          allowed: false,
          tier,
          reason: `QUOTA_EXCEEDED: ${route} limit ${limits[route]}/month reached`,
          limit: limits[route],
          current
        }
      }
    }

    // Check total calls limit
    if (limits._totalCalls !== undefined) {
      const usage = meter.getUsage(appPubkey)
      if (usage.totalCalls >= limits._totalCalls) {
        this.emit('quota-exceeded', { app: appPubkey, route: '_total', limit: limits._totalCalls, current: usage.totalCalls, tier })
        return {
          allowed: false,
          tier,
          reason: `QUOTA_EXCEEDED: total call limit ${limits._totalCalls}/month reached`,
          limit: limits._totalCalls,
          current: usage.totalCalls
        }
      }
    }

    return { allowed: true, tier }
  }

  /**
   * Get the tier for an app.
   */
  getTier (appPubkey) {
    if (this.whitelist.has(appPubkey)) return 'unlimited'
    const explicit = this.tiers.get(appPubkey)
    if (explicit) return explicit
    // Auto-promote to 'standard' if app has credit balance
    if (this.creditManager && this.creditManager.getBalance(appPubkey) > 0) {
      return 'standard'
    }
    return 'free'
  }

  /**
   * Set an app's tier (e.g., after SLA contract creation).
   */
  setTier (appPubkey, tier) {
    if (!['free', 'standard', 'unlimited'].includes(tier)) {
      throw new Error('INVALID_TIER: must be free, standard, or unlimited')
    }
    this.tiers.set(appPubkey, tier)
    this.emit('tier-changed', { app: appPubkey, tier })
  }

  /**
   * Add app to whitelist (unlimited, no quotas).
   */
  addWhitelist (appPubkey) {
    this.whitelist.add(appPubkey)
  }

  /**
   * Remove from whitelist.
   */
  removeWhitelist (appPubkey) {
    this.whitelist.delete(appPubkey)
  }

  /**
   * Get quota status for an app.
   */
  getQuota (appPubkey, meter) {
    const tier = this.getTier(appPubkey)
    const usage = meter.getUsage(appPubkey)
    const limits = tier === 'standard'
      ? this.standardLimits
      : tier === 'unlimited'
        ? null
        : this.freeLimits

    if (!limits) return { tier, usage, limits: null, message: 'unlimited' }

    const remaining = {}
    for (const [route, limit] of Object.entries(limits)) {
      if (route.startsWith('_')) continue
      const used = meter.getRouteCalls(appPubkey, route)
      remaining[route] = { limit, used, remaining: Math.max(0, limit - used) }
    }

    return {
      tier,
      totalCalls: { limit: limits._totalCalls, used: usage.totalCalls, remaining: Math.max(0, limits._totalCalls - usage.totalCalls) },
      routes: remaining,
      message: tier === 'free' ? 'Free tier — contact relay operator for free credits, or top up via Lightning for higher limits' : null
    }
  }
}

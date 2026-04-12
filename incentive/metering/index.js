/**
 * Service Meter
 *
 * Tracks usage per app (by pubkey) across all services.
 * Feeds into PaymentManager for earnings and free-tier for quota enforcement.
 *
 * Usage flows:
 *   1. Router middleware calls meter.record() on every service dispatch
 *   2. Free-tier manager calls meter.getUsage() to check quotas
 *   3. Settlement loop calls meter.flush() to convert usage → earnings
 */

import { EventEmitter } from 'events'

// Default pricing (sats per unit)
const DEFAULT_RATES = {
  'ai.infer': 10, // sats per inference call
  'ai.embed': 5, // sats per embedding call
  'storage.drive-write': 2, // sats per write
  'storage.drive-read': 0, // reads are free
  'compute.submit': 20, // sats per compute job
  'identity.sign': 1, // sats per signature
  'identity.verify': 0, // verification is free
  'schema.validate': 0 // validation is free
}

export class ServiceMeter extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.rates = { ...DEFAULT_RATES, ...opts.rates }
    // appPubkey -> { service.method -> { calls, lastCall } }
    this.usage = new Map()
    // Rolling window for quota checks (resets monthly)
    this.windowStart = Date.now()
    this.windowMs = opts.windowMs || 30 * 24 * 60 * 60 * 1000 // 30 days
  }

  /**
   * Record a service call.
   * Called from router middleware on every dispatch.
   */
  record (appPubkey, route, meta = {}) {
    if (!appPubkey) return

    let app = this.usage.get(appPubkey)
    if (!app) {
      app = {}
      this.usage.set(appPubkey, app)
    }

    if (!app[route]) {
      app[route] = { calls: 0, totalCost: 0, lastCall: 0 }
    }

    const entry = app[route]
    entry.calls++
    entry.lastCall = Date.now()

    const rate = this.rates[route] || 0
    entry.totalCost += rate

    this.emit('usage', { app: appPubkey, route, calls: entry.calls, cost: rate })
    return { rate, totalCalls: entry.calls, totalCost: entry.totalCost }
  }

  /**
   * Get usage summary for an app in the current window.
   */
  getUsage (appPubkey) {
    const app = this.usage.get(appPubkey)
    if (!app) return { routes: {}, totalCalls: 0, totalCost: 0 }

    let totalCalls = 0
    let totalCost = 0
    for (const route of Object.keys(app)) {
      totalCalls += app[route].calls
      totalCost += app[route].totalCost
    }

    return { routes: { ...app }, totalCalls, totalCost }
  }

  /**
   * Get total cost for an app (for billing).
   */
  getTotalCost (appPubkey) {
    const usage = this.getUsage(appPubkey)
    return usage.totalCost
  }

  /**
   * Get call count for a specific route (for quota checking).
   */
  getRouteCalls (appPubkey, route) {
    const app = this.usage.get(appPubkey)
    if (!app || !app[route]) return 0
    return app[route].calls
  }

  /**
   * Flush usage into payment earnings and reset counters.
   * Called periodically by settlement loop.
   */
  flush (paymentManager) {
    const results = []

    for (const [appPubkey, routes] of this.usage) {
      let totalCost = 0
      const breakdown = {}

      for (const [route, entry] of Object.entries(routes)) {
        if (entry.totalCost > 0) {
          totalCost += entry.totalCost
          breakdown[route] = { calls: entry.calls, cost: entry.totalCost }
        }
      }

      if (totalCost > 0 && paymentManager) {
        // Record earnings for the relay operator
        try {
          for (const [pubkey] of paymentManager.accounts) {
            paymentManager.recordEarnings(
              pubkey,
              totalCost,
              `Service usage from ${appPubkey.slice(0, 12)}...`
            )
          }
        } catch {}
      }

      results.push({ app: appPubkey, totalCost, breakdown })
    }

    // Reset counters
    this.usage.clear()
    this.windowStart = Date.now()
    this.emit('flushed', { apps: results.length, results })

    return results
  }

  /**
   * Get aggregate stats across all apps.
   */
  stats () {
    let totalApps = 0
    let totalCalls = 0
    let totalRevenue = 0

    for (const [, routes] of this.usage) {
      totalApps++
      for (const entry of Object.values(routes)) {
        totalCalls += entry.calls
        totalRevenue += entry.totalCost
      }
    }

    return {
      totalApps,
      totalCalls,
      totalRevenue,
      windowStart: this.windowStart,
      rates: { ...this.rates }
    }
  }
}

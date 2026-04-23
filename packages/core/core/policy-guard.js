/**
 * PolicyGuard — Fail-Safe Privacy Enforcement
 *
 * ONE JOB: Ensure app data never reaches the relay in a way
 * that violates the app's declared privacy tier.
 *
 * This is not a policy resolution engine. It is a guardrail.
 * It checks one constraint (relay exposure) and enforces it
 * with immediate service suspension on violation.
 *
 * Violations are not warnings. They are security failures.
 */

import { EventEmitter } from 'events'

/**
 * What the relay is allowed to see, per tier:
 *
 *   public      → relay sees app code AND user data (full exposure)
 *   local-first → relay sees app code ONLY (user data never leaves device)
 *   p2p-only    → relay sees NOTHING (no relay involvement)
 */
const RELAY_EXPOSURE = {
  public: 'full',
  'local-first': 'code-only',
  'p2p-only': 'none'
}

export class PolicyGuard extends EventEmitter {
  constructor () {
    super()
    this.suspendedApps = new Map() // appKeyHex → { reason, suspendedAt, tier }
  }

  /**
   * Get the allowed relay exposure for a tier.
   */
  getAllowedExposure (tier) {
    return RELAY_EXPOSURE[tier] || 'full'
  }

  /**
   * Check if an operation is permitted. If not, suspend the app immediately.
   *
   * @param {string} appKeyHex - The app being operated on
   * @param {string} tier - The app's declared privacy tier
   * @param {string} operation - What's happening: 'replicate-user-data' | 'store-on-relay' | 'read-from-relay' | 'delete-from-relay' | 'serve-code'
   * @returns {{ allowed: boolean, suspended?: boolean, reason?: string }}
   */
  check (appKeyHex, tier, operation) {
    // Already suspended? Block everything.
    if (this.suspendedApps.has(appKeyHex)) {
      return { allowed: false, suspended: true, reason: this.suspendedApps.get(appKeyHex).reason }
    }

    const exposure = RELAY_EXPOSURE[tier]

    // Serving app code is allowed for public and local-first
    if (operation === 'serve-code') {
      if (exposure === 'none') {
        return this._suspend(appKeyHex, tier, 'p2p-only app must not be served by relay')
      }
      return { allowed: true }
    }

    // User data operations: only allowed if tier is public
    if (
      operation === 'replicate-user-data' ||
      operation === 'store-on-relay' ||
      operation === 'read-from-relay' ||
      operation === 'delete-from-relay'
    ) {
      if (exposure !== 'full') {
        return this._suspend(appKeyHex, tier,
          `${tier} tier violation: user data must not reach relay (attempted: ${operation})`
        )
      }
      return { allowed: true }
    }

    // Unknown operation: deny by default
    return this._suspend(appKeyHex, tier, `unknown operation: ${operation}`)
  }

  /**
   * Suspend an app. Immediate effect — all subsequent operations blocked.
   */
  _suspend (appKeyHex, tier, reason) {
    const suspension = {
      reason,
      tier,
      suspendedAt: Date.now()
    }
    this.suspendedApps.set(appKeyHex, suspension)

    this.emit('violation', {
      appKey: appKeyHex,
      tier,
      reason,
      action: 'suspended',
      timestamp: Date.now()
    })

    return { allowed: false, suspended: true, reason }
  }

  /**
   * Operator manually reinstates an app after reviewing the violation.
   * Requires explicit action — suspensions don't auto-clear.
   */
  reinstate (appKeyHex) {
    const was = this.suspendedApps.get(appKeyHex)
    if (!was) return false
    this.suspendedApps.delete(appKeyHex)
    this.emit('reinstated', { appKey: appKeyHex, was })
    return true
  }

  /**
   * Check if an app is currently suspended.
   */
  isSuspended (appKeyHex) {
    return this.suspendedApps.has(appKeyHex)
  }

  /**
   * Get all current violations.
   */
  getViolations () {
    const violations = []
    for (const [appKey, info] of this.suspendedApps) {
      violations.push({ appKey, ...info })
    }
    return violations
  }
}

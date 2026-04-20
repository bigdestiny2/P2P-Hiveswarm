/**
 * SLA Contracts Service
 *
 * Manages service-level agreement contracts between app developers and relay
 * operators. Relays stake collateral against performance guarantees (reliability,
 * latency). Automated enforcement via proof-of-relay scores triggers slashing
 * on violation.
 *
 * Enforcement is fully automated — proof-of-relay driven with immediate slashing.
 */

import crypto from 'crypto'
import { ServiceProvider } from 'p2p-hiverelay/core/services/provider.js'

const MAX_VIOLATIONS = 3
const CHECK_INTERVAL_MS = 60_000
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours

export class SLAService extends ServiceProvider {
  constructor (opts = {}) {
    super()
    this.contracts = new Map() // id -> SLA contract
    this.node = null
    this._checkInterval = null
    this.persistence = opts.persistence || null

    if (this.persistence) {
      for (const [id, contract] of this.persistence.entries()) {
        this.contracts.set(id, contract)
      }
    }
  }

  _persist (id) {
    if (!this.persistence) return
    const contract = this.contracts.get(id)
    if (!contract) {
      try { this.persistence.delete(id) } catch (_) {}
      return
    }
    try {
      this.persistence.set(id, contract)
    } catch (_) {
      // Silent — no emit channel on ServiceProvider by default
    }
  }

  manifest () {
    return {
      name: 'sla',
      version: '1.0.0',
      description: 'SLA contract management with automated proof-of-relay enforcement',
      capabilities: ['create', 'list', 'get', 'terminate', 'check', 'violations', 'stats']
    }
  }

  async start (context) {
    this.node = context.node
    this._checkInterval = setInterval(() => this._enforceAll(), CHECK_INTERVAL_MS)
    if (this._checkInterval.unref) this._checkInterval.unref()
  }

  async stop () {
    if (this._checkInterval) {
      clearInterval(this._checkInterval)
      this._checkInterval = null
    }
    this.contracts.clear()
  }

  /**
   * Create a new SLA contract.
   * @param {object} params
   * @param {string} params.appKey - Hex key of the app being guaranteed
   * @param {string} params.relayPubkey - Hex key of the relay providing guarantee
   * @param {object} params.guarantees - { minReliability: 0-1, maxLatencyMs: number }
   * @param {number} params.collateral - Sats staked
   * @param {number} params.premiumRate - Multiplier over base rate (e.g., 3.0)
   * @param {number} params.duration - Contract duration in ms
   */
  async create (params, context) {
    // Remote callers must identify themselves
    if (context?.caller === 'remote' && !context?.remotePubkey) {
      throw new Error('SLA_UNAUTHORIZED: remote caller must be authenticated')
    }
    if (!params.appKey || typeof params.appKey !== 'string') {
      throw new Error('SLA_MISSING_APP_KEY')
    }
    if (!params.relayPubkey || typeof params.relayPubkey !== 'string') {
      throw new Error('SLA_MISSING_RELAY_PUBKEY')
    }
    if (!params.guarantees || typeof params.guarantees !== 'object') {
      throw new Error('SLA_MISSING_GUARANTEES')
    }
    if (params.guarantees.minReliability === undefined || params.guarantees.maxLatencyMs === undefined) {
      throw new Error('SLA_INCOMPLETE_GUARANTEES')
    }
    if (typeof params.collateral !== 'number' || params.collateral <= 0) {
      throw new Error('SLA_INVALID_COLLATERAL')
    }
    if (typeof params.duration !== 'number' || params.duration <= 0) {
      throw new Error('SLA_INVALID_DURATION')
    }

    const id = crypto.randomBytes(16).toString('hex')
    const now = Date.now()

    const contract = {
      id,
      appKey: params.appKey,
      relayPubkey: params.relayPubkey,
      guarantees: {
        minReliability: params.guarantees.minReliability,
        maxLatencyMs: params.guarantees.maxLatencyMs
      },
      collateral: params.collateral,
      collateralRemaining: params.collateral,
      premiumRate: params.premiumRate || 1.0,
      createdAt: now,
      expiresAt: now + params.duration,
      status: 'active',
      violations: [],
      window: params.window || DEFAULT_WINDOW_MS
    }

    this.contracts.set(id, contract)
    this._persist(id)

    this.node?.router?.pubsub?.publish('sla/created', {
      contractId: id,
      appKey: contract.appKey,
      relayPubkey: contract.relayPubkey
    })

    return contract
  }

  /**
   * List contracts, optionally filtered.
   * @param {object} [params] - { relayPubkey?, status?, appKey? }
   */
  async list (params = {}) {
    const result = []
    for (const contract of this.contracts.values()) {
      if (params.relayPubkey && contract.relayPubkey !== params.relayPubkey) continue
      if (params.status && contract.status !== params.status) continue
      if (params.appKey && contract.appKey !== params.appKey) continue
      result.push(contract)
    }
    return result
  }

  /**
   * Get a single contract by ID.
   */
  async get (params) {
    const contract = this.contracts.get(params.id)
    if (!contract) throw new Error('SLA_NOT_FOUND')
    return contract
  }

  /**
   * Terminate a contract. Optionally slash remaining collateral.
   */
  async terminate (params, context) {
    const contract = this.contracts.get(params.id)
    if (!contract) throw new Error('SLA_NOT_FOUND')

    // Only contract parties can terminate
    if (context?.caller === 'remote') {
      const caller = context.remotePubkey
      if (caller !== contract.relayPubkey && caller !== contract.appKey) {
        throw new Error('SLA_UNAUTHORIZED: only contract parties can terminate')
      }
    }

    contract.status = 'terminated'

    if (params.slashRemaining && contract.collateralRemaining > 0) {
      this.node?.paymentManager?.slash(
        contract.relayPubkey,
        contract.collateralRemaining,
        `SLA ${contract.id} terminated with slash`
      )
      contract.collateralRemaining = 0
    }

    this._persist(contract.id)
    this.node?.router?.pubsub?.publish('sla/terminated', { contractId: contract.id })
    return { id: contract.id, status: 'terminated' }
  }

  /**
   * Manually check a single contract.
   */
  async check (params) {
    const contract = this.contracts.get(params.id)
    if (!contract) throw new Error('SLA_NOT_FOUND')
    return this._checkContract(contract)
  }

  /**
   * Get violations for a contract.
   */
  async violations (params) {
    const contract = this.contracts.get(params.id)
    if (!contract) throw new Error('SLA_NOT_FOUND')
    return contract.violations
  }

  /**
   * Aggregate SLA stats.
   */
  async stats () {
    let active = 0; let violated = 0; let terminated = 0; let expired = 0
    let totalCollateral = 0; let totalPenalties = 0

    for (const c of this.contracts.values()) {
      if (c.status === 'active') active++
      else if (c.status === 'violated') violated++
      else if (c.status === 'terminated') terminated++
      else if (c.status === 'expired') expired++

      totalCollateral += c.collateral
      for (const v of c.violations) totalPenalties += v.penalty
    }

    return {
      total: this.contracts.size,
      active,
      violated,
      terminated,
      expired,
      totalCollateral,
      totalPenalties
    }
  }

  // --- Enforcement ---

  _enforceAll () {
    const now = Date.now()

    for (const contract of this.contracts.values()) {
      if (contract.status !== 'active') continue

      // Expire contracts past their duration
      if (now > contract.expiresAt) {
        contract.status = 'expired'
        this._persist(contract.id)
        this.node?.router?.pubsub?.publish('sla/expired', { contractId: contract.id })
        continue
      }

      this._checkContract(contract)
    }
  }

  _checkContract (contract) {
    if (contract.status !== 'active') {
      return { contractId: contract.id, passed: true, violations: [] }
    }

    const newViolations = []

    // Read proof-of-relay scores
    const score = this.node?._proofOfRelay?.scores?.get(contract.relayPubkey)

    // Reliability check
    const reliability = score && score.challenges > 0
      ? score.passes / score.challenges
      : 1 // No data = no violation
    if (reliability < contract.guarantees.minReliability && score?.challenges > 0) {
      newViolations.push({
        type: 'reliability',
        details: {
          actual: reliability,
          required: contract.guarantees.minReliability,
          challenges: score.challenges,
          passes: score.passes
        }
      })
    }

    // Latency check
    const avgLatency = score?.avgLatencyMs || 0
    if (avgLatency > contract.guarantees.maxLatencyMs && avgLatency > 0) {
      newViolations.push({
        type: 'latency',
        details: {
          actual: avgLatency,
          maxAllowed: contract.guarantees.maxLatencyMs
        }
      })
    }

    // Record violations and slash
    for (const violation of newViolations) {
      const penalty = Math.floor(contract.collateral / 10)
      const actualPenalty = Math.min(penalty, contract.collateralRemaining)

      violation.timestamp = Date.now()
      violation.penalty = actualPenalty
      contract.violations.push(violation)
      contract.collateralRemaining -= actualPenalty

      this.node?.paymentManager?.slash(
        contract.relayPubkey,
        actualPenalty,
        `SLA violation: ${violation.type} on contract ${contract.id}`
      )

      this.node?.router?.pubsub?.publish('sla/violation', {
        contractId: contract.id,
        ...violation
      })
    }

    // Auto-terminate after max violations
    if (contract.violations.length >= MAX_VIOLATIONS) {
      contract.status = 'violated'

      if (contract.collateralRemaining > 0) {
        this.node?.paymentManager?.slash(
          contract.relayPubkey,
          contract.collateralRemaining,
          `SLA ${contract.id} auto-terminated: max violations exceeded`
        )
        contract.collateralRemaining = 0
      }

      this.node?.router?.pubsub?.publish('sla/terminated', {
        contractId: contract.id,
        reason: 'max_violations_exceeded'
      })
    }

    if (newViolations.length > 0) {
      this._persist(contract.id)
    }

    return {
      contractId: contract.id,
      passed: newViolations.length === 0,
      violations: newViolations
    }
  }
}

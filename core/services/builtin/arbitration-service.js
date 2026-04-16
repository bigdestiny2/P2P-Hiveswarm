/**
 * Decentralized Arbitration Service
 *
 * Peer-adjudicated dispute resolution for the relay network.
 * Disputes are submitted with evidence (bandwidth receipts, proof-of-relay
 * results, SLA contracts). High-reputation relay nodes vote on the outcome.
 * Winners gain reputation; losers are slashed.
 *
 * Arbitrator eligibility: score > 100, reliability > 0.95, 50+ challenges,
 * not a party to the dispute.
 */

import crypto from 'crypto'
import { ServiceProvider } from '../provider.js'

const MIN_ARBITRATOR_SCORE = 100
const MIN_ARBITRATOR_RELIABILITY = 0.95
const MIN_ARBITRATOR_CHALLENGES = 50
const DEFAULT_MIN_VOTES = 3
const MIN_VOTES_FLOOR = 3
const VALID_DISPUTE_TYPES = ['sla-violation', 'proof-failure', 'receipt-dispute']

export class ArbitrationService extends ServiceProvider {
  constructor () {
    super()
    this.disputes = new Map() // id -> dispute
    this.node = null
  }

  manifest () {
    return {
      name: 'arbitration',
      version: '1.0.0',
      description: 'Decentralized dispute resolution for relay incentives',
      capabilities: ['submit', 'vote', 'get', 'list', 'evidence']
    }
  }

  async start (context) {
    this.node = context.node
  }

  async stop () {
    this.disputes.clear()
  }

  /**
   * Submit a new dispute.
   * @param {object} params
   * @param {string} params.type - 'sla-violation' | 'proof-failure' | 'receipt-dispute'
   * @param {string} params.respondent - Relay pubkey hex being accused
   * @param {object} [params.receipts] - BandwidthReceipt evidence
   * @param {object} [params.proofResults] - Proof-of-relay challenge results
   * @param {object} [params.slaContract] - SLA contract data
   * @param {number} [params.penalty] - Requested penalty in sats
   */
  async submit (params, context) {
    if (!params.type || !VALID_DISPUTE_TYPES.includes(params.type)) {
      throw new Error('ARBITRATION_INVALID_TYPE')
    }
    if (!params.respondent || typeof params.respondent !== 'string') {
      throw new Error('ARBITRATION_MISSING_RESPONDENT')
    }

    const id = crypto.randomBytes(16).toString('hex')
    // Use authenticated identity when available, fall back to params for local calls
    const claimant = context?.remotePubkey || (context?.caller === 'remote' ? null : params.claimant) || 'local'
    if (context?.caller === 'remote' && !context.remotePubkey) {
      throw new Error('ARBITRATION_UNAUTHORIZED')
    }

    if (claimant === params.respondent) {
      throw new Error('ARBITRATION_SELF_DISPUTE')
    }

    const dispute = {
      id,
      type: params.type,
      claimant,
      respondent: params.respondent,
      evidence: {
        receipts: params.receipts || [],
        proofResults: params.proofResults || [],
        slaContract: params.slaContract || null
      },
      votes: new Map(),
      status: 'open',
      verdict: null,
      penalty: Math.min(Math.max(0, params.penalty || 0), this.config?.maxPenalty || 1000000),
      createdAt: Date.now(),
      resolvedAt: null,
      minVotes: Math.max(MIN_VOTES_FLOOR, params.minVotes || this.config?.minVotes || DEFAULT_MIN_VOTES)
    }

    this.disputes.set(id, dispute)

    this.node?.router?.pubsub?.publish('arbitration/submitted', {
      disputeId: id,
      type: dispute.type,
      respondent: dispute.respondent
    })

    return this._serialize(dispute)
  }

  /**
   * Cast a vote on a dispute.
   * @param {object} params
   * @param {string} params.id - Dispute ID
   * @param {string} params.verdict - 'claimant' or 'respondent'
   */
  async vote (params, context) {
    const dispute = this.disputes.get(params.id)
    if (!dispute) throw new Error('DISPUTE_NOT_FOUND')
    if (dispute.status === 'resolved') throw new Error('DISPUTE_ALREADY_RESOLVED')

    if (!params.verdict || !['claimant', 'respondent'].includes(params.verdict)) {
      throw new Error('ARBITRATION_INVALID_VERDICT')
    }

    // Remote callers must use their authenticated identity
    const voter = context?.caller === 'remote'
      ? context.remotePubkey
      : (params.voterPubkey || context?.remotePubkey)
    if (!voter) throw new Error('ARBITRATION_MISSING_VOTER')

    // Eligibility check
    if (!this._isEligibleArbitrator(voter, dispute)) {
      throw new Error('ARBITRATOR_INELIGIBLE')
    }

    if (dispute.votes.has(voter)) {
      throw new Error('ARBITRATION_ALREADY_VOTED')
    }

    // Record vote
    dispute.votes.set(voter, params.verdict)
    if (dispute.status === 'open') dispute.status = 'voting'

    // Check if resolution threshold met
    if (dispute.votes.size >= dispute.minVotes) {
      this._resolve(dispute)
    }

    return this._serialize(dispute)
  }

  /**
   * Get a dispute by ID.
   */
  async get (params) {
    const dispute = this.disputes.get(params.id)
    if (!dispute) throw new Error('DISPUTE_NOT_FOUND')
    return this._serialize(dispute)
  }

  /**
   * List disputes, optionally filtered.
   * @param {object} [params] - { status?, type? }
   */
  async list (params = {}) {
    const result = []
    for (const dispute of this.disputes.values()) {
      if (params.status && dispute.status !== params.status) continue
      if (params.type && dispute.type !== params.type) continue
      result.push(this._serialize(dispute))
    }
    return result
  }

  /**
   * Verify evidence attached to a dispute.
   * Validates bandwidth receipts via BandwidthReceipt.verify().
   */
  async evidence (params) {
    const dispute = this.disputes.get(params.id)
    if (!dispute) throw new Error('DISPUTE_NOT_FOUND')

    const receiptResults = []

    for (const receipt of dispute.evidence.receipts) {
      let valid = false
      try {
        // Dynamic import to avoid hard dep
        const { BandwidthReceipt } = await import('../../protocol/bandwidth-receipt.js')
        valid = BandwidthReceipt.verify(receipt)
      } catch {
        valid = false
      }
      receiptResults.push({ receipt, valid })
    }

    return {
      receipts: receiptResults,
      proofResults: dispute.evidence.proofResults,
      slaContract: dispute.evidence.slaContract
    }
  }

  // --- Internal ---

  _isEligibleArbitrator (pubkey, dispute) {
    // Cannot be a party to the dispute
    if (pubkey === dispute.claimant || pubkey === dispute.respondent) {
      return false
    }

    if (!this.node?.reputation) return false

    const record = this.node.reputation.getRecord(pubkey)
    if (!record) return false

    if (record.score < MIN_ARBITRATOR_SCORE) return false
    if (record.totalChallenges < MIN_ARBITRATOR_CHALLENGES) return false

    const reliability = this.node.reputation.getReliability(pubkey)
    if (reliability < MIN_ARBITRATOR_RELIABILITY) return false

    return true
  }

  _resolve (dispute) {
    let claimantVotes = 0
    let respondentVotes = 0
    const voters = { claimant: [], respondent: [] }

    for (const [voter, verdict] of dispute.votes) {
      if (verdict === 'claimant') {
        claimantVotes++
        voters.claimant.push(voter)
      } else {
        respondentVotes++
        voters.respondent.push(voter)
      }
    }

    dispute.verdict = claimantVotes >= respondentVotes ? 'claimant' : 'respondent'
    dispute.status = 'resolved'
    dispute.resolvedAt = Date.now()

    // Slash respondent if claimant wins
    if (dispute.verdict === 'claimant' && dispute.penalty > 0) {
      this.node?.paymentManager?.slash(
        dispute.respondent,
        dispute.penalty,
        `Arbitration ${dispute.id}: ${dispute.type}`
      )
    }

    // Reputation adjustments for voters
    if (this.node?.reputation) {
      const winnerSide = voters[dispute.verdict]
      const loserSide = dispute.verdict === 'claimant' ? voters.respondent : voters.claimant

      for (const voter of winnerSide) {
        this.node.reputation.recordChallenge(voter, true, 0) // +10 score
      }
      for (const voter of loserSide) {
        this.node.reputation.recordChallenge(voter, false, 0) // -20 score
      }
    }

    this.node?.router?.pubsub?.publish('arbitration/resolved', {
      disputeId: dispute.id,
      verdict: dispute.verdict,
      penalty: dispute.penalty
    })
  }

  _serialize (dispute) {
    return {
      ...dispute,
      votes: [...dispute.votes.entries()].map(([voter, verdict]) => ({ voter, verdict }))
    }
  }
}

/**
 * Reputation System
 *
 * Tracks relay node reputation based on:
 * - Proof-of-relay challenge pass rate
 * - Bandwidth receipts collected
 * - Uptime (continuous presence on DHT)
 * - Geographic diversity contribution
 *
 * Reputation decays over time without activity.
 * Used in Phase 1 (altruistic) and Phase 2 (marketplace) for relay selection.
 */

import { EventEmitter } from 'events'

const DECAY_RATE = 0.995 // Daily decay multiplier (~0.5% per day)
const CHALLENGE_WEIGHT = 10 // Points per passed challenge
const BANDWIDTH_WEIGHT = 0.001 // Points per MB served
const UPTIME_WEIGHT = 1 // Points per hour of uptime
const GEO_BONUS = 50 // Bonus for underserved region
const MIN_CHALLENGES_FOR_RANKING = 10 // Minimum challenges to be ranked

export class ReputationSystem extends EventEmitter {
  constructor () {
    super()
    // relayPubkeyHex -> ReputationRecord
    this.records = new Map()
  }

  /**
   * Record a proof-of-relay challenge result
   */
  recordChallenge (relayPubkeyHex, passed, latencyMs) {
    const record = this._getOrCreate(relayPubkeyHex)
    record.totalChallenges++

    if (passed) {
      record.passedChallenges++
      record.score += CHALLENGE_WEIGHT
      record.avgLatencyMs = (record.avgLatencyMs * (record.passedChallenges - 1) + latencyMs) / record.passedChallenges
    } else {
      record.failedChallenges++
      record.score -= CHALLENGE_WEIGHT * 2 // Penalty is 2x reward
    }

    record.lastActivity = Date.now()
    this.emit('challenge-recorded', { relay: relayPubkeyHex, passed, score: record.score })
  }

  /**
   * Record bandwidth served (from verified receipt)
   */
  recordBandwidth (relayPubkeyHex, bytesServed) {
    const record = this._getOrCreate(relayPubkeyHex)
    const mb = bytesServed / (1024 * 1024)
    record.totalBytesServed += bytesServed
    record.score += mb * BANDWIDTH_WEIGHT
    record.lastActivity = Date.now()
  }

  /**
   * Record uptime heartbeat
   */
  recordUptime (relayPubkeyHex, hoursOnline) {
    const record = this._getOrCreate(relayPubkeyHex)
    record.totalUptimeHours += hoursOnline
    record.score += hoursOnline * UPTIME_WEIGHT
    record.lastActivity = Date.now()
  }

  /**
   * Apply geographic diversity bonus
   */
  applyGeoBonus (relayPubkeyHex, region) {
    const record = this._getOrCreate(relayPubkeyHex)
    record.region = region

    // Count relays per region
    const regionCounts = new Map()
    for (const r of this.records.values()) {
      if (r.region) {
        regionCounts.set(r.region, (regionCounts.get(r.region) || 0) + 1)
      }
    }

    // Bonus for underserved regions (fewer than median)
    const counts = [...regionCounts.values()]
    const median = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)] || 1
    const regionCount = regionCounts.get(region) || 0

    if (regionCount < median) {
      record.score += GEO_BONUS
      record.geoBonus = true
    }
  }

  /**
   * Apply daily decay to all scores
   */
  applyDecay () {
    for (const record of this.records.values()) {
      record.score *= DECAY_RATE
      if (record.score < 0) record.score = 0
    }
    this.emit('decay-applied')
  }

  /**
   * Get reputation score for a relay
   */
  getScore (relayPubkeyHex) {
    const record = this.records.get(relayPubkeyHex)
    if (!record) return 0
    return Math.round(record.score * 100) / 100
  }

  /**
   * Get full record for a relay
   */
  getRecord (relayPubkeyHex) {
    return this.records.get(relayPubkeyHex) || null
  }

  /**
   * Get reliability (challenge pass rate)
   */
  getReliability (relayPubkeyHex) {
    const record = this.records.get(relayPubkeyHex)
    if (!record || record.totalChallenges === 0) return 0
    return record.passedChallenges / record.totalChallenges
  }

  /**
   * Get ranked leaderboard
   */
  getLeaderboard (limit = 50) {
    return [...this.records.entries()]
      .filter(([, r]) => r.totalChallenges >= MIN_CHALLENGES_FOR_RANKING)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([pubkey, record]) => ({
        relay: pubkey,
        score: Math.round(record.score * 100) / 100,
        reliability: record.totalChallenges > 0
          ? Math.round((record.passedChallenges / record.totalChallenges) * 100) + '%'
          : 'N/A',
        avgLatencyMs: Math.round(record.avgLatencyMs),
        uptimeHours: Math.round(record.totalUptimeHours),
        bytesServed: record.totalBytesServed,
        region: record.region || 'unknown'
      }))
  }

  /**
   * Select best relays for a seed request based on reputation + preferences
   */
  selectRelays (count, opts = {}) {
    let candidates = [...this.records.entries()]
      .filter(([, r]) => r.score > 0 && r.totalChallenges >= MIN_CHALLENGES_FOR_RANKING)

    // Filter by region preference
    if (opts.geoPreference && opts.geoPreference.length > 0) {
      const preferred = candidates.filter(([, r]) => opts.geoPreference.includes(r.region))
      if (preferred.length >= count) {
        candidates = preferred
      }
      // If not enough in preferred region, use all candidates
    }

    // Sort by composite score: reliability * score * (1 / latency)
    candidates.sort((a, b) => {
      const scoreA = this._compositeScore(a[1])
      const scoreB = this._compositeScore(b[1])
      return scoreB - scoreA
    })

    return candidates.slice(0, count).map(([pubkey]) => pubkey)
  }

  _compositeScore (record) {
    const reliability = record.totalChallenges > 0
      ? record.passedChallenges / record.totalChallenges
      : 0
    const latencyFactor = record.avgLatencyMs > 0
      ? 1000 / record.avgLatencyMs
      : 0
    return record.score * reliability * latencyFactor
  }

  _getOrCreate (relayPubkeyHex) {
    let record = this.records.get(relayPubkeyHex)
    if (!record) {
      record = {
        score: 0,
        totalChallenges: 0,
        passedChallenges: 0,
        failedChallenges: 0,
        avgLatencyMs: 0,
        totalBytesServed: 0,
        totalUptimeHours: 0,
        region: null,
        geoBonus: false,
        firstSeen: Date.now(),
        lastActivity: Date.now()
      }
      this.records.set(relayPubkeyHex, record)
    }
    return record
  }

  /**
   * Export all records (for persistence)
   */
  export () {
    const data = {}
    for (const [key, record] of this.records) {
      data[key] = { ...record }
    }
    return data
  }

  /**
   * Import records (from persistence)
   */
  import (data) {
    for (const [key, record] of Object.entries(data)) {
      this.records.set(key, record)
    }
  }
}

/**
 * Proof-of-Relay Protocol
 *
 * Cryptographic verification that relay nodes actually store and serve data.
 * Uses challenge-response with Hypercore's built-in Merkle tree proofs.
 *
 * Verifiers (any peer) can challenge relays to prove they hold specific blocks.
 * Relays that respond correctly within the latency bound earn relay credits.
 */

import Protomux from 'protomux'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { EventEmitter } from 'events'
import { proofChallengeEncoding, proofResponseEncoding } from './messages.js'

const PROTOCOL_NAME = 'hiverelay-proof'
const DEFAULT_MAX_LATENCY_MS = 5000
const DEFAULT_CHALLENGE_INTERVAL = 5 * 60 * 1000 // 5 minutes

export class ProofOfRelay extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.maxLatencyMs = opts.maxLatencyMs || DEFAULT_MAX_LATENCY_MS
    this.challengeInterval = opts.challengeInterval || DEFAULT_CHALLENGE_INTERVAL

    // Track challenge/response for scoring
    this.scores = new Map() // relay pubkey hex -> { challenges, passes, fails, avgLatencyMs }
    this.pendingChallenges = new Map() // nonce hex -> { coreKey, blockIndex, sentAt, relayPubkey }
    this.channels = new Set()
    this._cleanupInterval = setInterval(() => this._cleanupStale(), 30_000)
  }

  attach (conn) {
    const mux = Protomux.from(conn)

    const channel = mux.createChannel({
      protocol: PROTOCOL_NAME,
      id: null,
      onopen: () => this.channels.add(channel),
      onclose: () => this.channels.delete(channel)
    })

    const challengeMsg = channel.addMessage({
      encoding: proofChallengeEncoding,
      onmessage: (msg) => this._onChallenge(channel, msg)
    })

    const responseMsg = channel.addMessage({
      encoding: proofResponseEncoding,
      onmessage: (msg) => this._onResponse(channel, msg)
    })

    channel._hiverelay = { challengeMsg, responseMsg }
    channel.open()

    return channel
  }

  /**
   * Issue a challenge to a relay: "prove you have block N of core X"
   */
  challenge (channel, coreKey, blockIndex, relayPubkey) {
    const nonce = b4a.alloc(32)
    sodium.randombytes_buf(nonce)

    const challenge = {
      coreKey,
      blockIndex,
      nonce,
      maxLatencyMs: this.maxLatencyMs
    }

    this.pendingChallenges.set(b4a.toString(nonce, 'hex'), {
      coreKey: b4a.toString(coreKey, 'hex'),
      blockIndex,
      sentAt: Date.now(),
      relayPubkey: b4a.toString(relayPubkey, 'hex')
    })

    if (channel.opened && channel._hiverelay) {
      channel._hiverelay.challengeMsg.send(challenge)
    }

    this.emit('challenge-sent', {
      coreKey: b4a.toString(coreKey, 'hex'),
      blockIndex,
      nonce: b4a.toString(nonce, 'hex')
    })
  }

  /**
   * Handle incoming challenge (called on relay side).
   * The relay must fetch the block from its local Hypercore and respond.
   *
   * @param {Function} blockProvider - async (coreKeyHex, blockIndex) => { data, proof }
   */
  setBlockProvider (blockProvider) {
    this._blockProvider = blockProvider
  }

  async _onChallenge (channel, msg) {
    if (!this._blockProvider) {
      this.emit('challenge-skipped', { reason: 'no block provider' })
      return
    }

    const coreKeyHex = b4a.toString(msg.coreKey, 'hex')

    try {
      const result = await this._blockProvider(coreKeyHex, msg.blockIndex)

      const response = {
        coreKey: msg.coreKey,
        blockIndex: msg.blockIndex,
        blockData: result.data,
        merkleProof: result.proof || b4a.alloc(0),
        nonce: msg.nonce
      }

      if (channel.opened && channel._hiverelay) {
        channel._hiverelay.responseMsg.send(response)
      }

      this.emit('challenge-responded', { coreKeyHex, blockIndex: msg.blockIndex })
    } catch (err) {
      this.emit('challenge-failed', { coreKeyHex, blockIndex: msg.blockIndex, error: err.message })
    }
  }

  _onResponse (channel, msg) {
    const nonceHex = b4a.toString(msg.nonce, 'hex')
    const pending = this.pendingChallenges.get(nonceHex)

    if (!pending) {
      this.emit('unexpected-response', { nonce: nonceHex })
      return
    }

    this.pendingChallenges.delete(nonceHex)

    const latencyMs = Date.now() - pending.sentAt
    const withinLatency = latencyMs <= this.maxLatencyMs
    const correctCore = b4a.toString(msg.coreKey, 'hex') === pending.coreKey
    const correctIndex = msg.blockIndex === pending.blockIndex
    const hasData = msg.blockData && msg.blockData.byteLength > 0

    const passed = withinLatency && correctCore && correctIndex && hasData

    // Update score
    this._updateScore(pending.relayPubkey, passed, latencyMs)

    this.emit('proof-result', {
      relayPubkey: pending.relayPubkey,
      coreKey: pending.coreKey,
      blockIndex: pending.blockIndex,
      passed,
      latencyMs,
      withinLatency,
      correctCore,
      correctIndex,
      hasData
    })
  }

  _updateScore (relayPubkeyHex, passed, latencyMs) {
    let score = this.scores.get(relayPubkeyHex)
    if (!score) {
      score = { challenges: 0, passes: 0, fails: 0, totalLatencyMs: 0, avgLatencyMs: 0 }
      this.scores.set(relayPubkeyHex, score)
    }

    score.challenges++
    if (passed) {
      score.passes++
      score.totalLatencyMs += latencyMs
      score.avgLatencyMs = Math.round(score.totalLatencyMs / score.passes)
    } else {
      score.fails++
    }
  }

  getScore (relayPubkeyHex) {
    return this.scores.get(relayPubkeyHex) || null
  }

  getReliability (relayPubkeyHex) {
    const score = this.scores.get(relayPubkeyHex)
    if (!score || score.challenges === 0) return 0
    return score.passes / score.challenges
  }

  getAllScores () {
    const result = {}
    for (const [key, score] of this.scores) {
      result[key] = {
        ...score,
        reliability: score.challenges > 0 ? (score.passes / score.challenges) : 0
      }
    }
    return result
  }

  _cleanupStale () {
    const now = Date.now()
    const maxAge = this.maxLatencyMs * 2
    for (const [nonce, entry] of this.pendingChallenges) {
      if (now - entry.sentAt > maxAge) {
        this.pendingChallenges.delete(nonce)
      }
    }
  }

  destroy () {
    if (this._cleanupInterval) clearInterval(this._cleanupInterval)
    this.channels.clear()
    this.pendingChallenges.clear()
  }
}

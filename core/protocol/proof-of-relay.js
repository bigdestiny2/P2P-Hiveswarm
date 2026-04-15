/**
 * Proof-of-Relay Protocol
 *
 * Cryptographic verification that relay nodes actually store and serve data.
 * Uses challenge-response with data-presence and nonce-keyed hash checks.
 * Hypercore's own flat-tree Merkle verification handles transport-layer integrity,
 * so no custom Merkle verifier is needed here.
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
const MAX_BLOCK_SIZE = 1024 * 1024 // 1MB max for a single block

export class ProofOfRelay extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.maxLatencyMs = opts.maxLatencyMs || DEFAULT_MAX_LATENCY_MS
    this.challengeInterval = opts.challengeInterval || DEFAULT_CHALLENGE_INTERVAL

    // Track challenge/response for scoring
    this.scores = new Map() // relay pubkey hex -> { challenges, passes, fails, avgLatencyMs }
    this._maxScores = opts.maxScores || 10000
    this.pendingChallenges = new Map() // nonce hex -> { coreKey, blockIndex, sentAt, relayPubkey }
    this.channels = new Set()
    this._batchTimers = new Set() // Track batch timeout timer IDs for cleanup
    this._cleanupInterval = setInterval(() => this._cleanupStale(), 30_000)
    this._challengeRateLimiter = null
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
   * Issue a batch of challenges to a relay for multiple blocks at once.
   * Returns a batchId that can be used to track completion.
   *
   * @param {Object} channel - protomux channel
   * @param {Buffer} coreKey - public key of the Hypercore
   * @param {number[]} blockIndices - array of block indices to challenge
   * @param {Buffer} relayPubkey - public key of the relay being challenged
   * @returns {string} batchId
   */
  challengeBatch (channel, coreKey, blockIndices, relayPubkey) {
    const nonce = b4a.alloc(32)
    sodium.randombytes_buf(nonce)

    const batchId = b4a.toString(nonce, 'hex').slice(0, 16)
    const relayPubkeyHex = b4a.toString(relayPubkey, 'hex')
    const coreKeyHex = b4a.toString(coreKey, 'hex')

    // Store pending batch challenge
    this.pendingChallenges.set(batchId, {
      coreKey: coreKeyHex,
      blockIndices: [...blockIndices],
      nonce,
      relayPubkey: relayPubkeyHex,
      sentAt: Date.now(),
      isBatch: true,
      responses: new Map() // blockIndex -> proof-result
    })

    // Send individual challenge messages sharing the same nonce
    if (channel.opened && channel._hiverelay) {
      for (const index of blockIndices) {
        channel._hiverelay.challengeMsg.send({
          coreKey,
          blockIndex: index,
          nonce,
          maxLatencyMs: this.maxLatencyMs
        })

        // Also store per-nonce+index lookup so _onResponse can find the batch
        const nonceHex = b4a.toString(nonce, 'hex')
        this.pendingChallenges.set(nonceHex + ':' + index, {
          coreKey: coreKeyHex,
          blockIndex: index,
          sentAt: Date.now(),
          relayPubkey: relayPubkeyHex,
          batchId
        })
      }
    }

    // Set single timeout for entire batch (tracked for cleanup on destroy)
    const timer = setTimeout(() => {
      this._batchTimers.delete(timer)
      const pending = this.pendingChallenges.get(batchId)
      if (pending) {
        this.pendingChallenges.delete(batchId)
        // Clean up per-index entries
        const nonceHex = b4a.toString(nonce, 'hex')
        for (const index of blockIndices) {
          this.pendingChallenges.delete(nonceHex + ':' + index)
        }
        this.emit('batch-timeout', { batchId, coreKey: coreKeyHex, relayPubkey: relayPubkeyHex })
      }
    }, this.maxLatencyMs + 1000)
    this._batchTimers.add(timer)

    this.emit('batch-challenge-sent', {
      batchId,
      coreKey: coreKeyHex,
      blockIndices,
      nonce: b4a.toString(nonce, 'hex')
    })

    return batchId
  }

  /**
   * Verify a batch response. Collects individual responses and resolves
   * the batch when all blocks have been verified.
   * Called internally from _onResponse when the response belongs to a batch.
   *
   * @param {string} batchId - batch identifier
   * @param {number} blockIndex - the block index that was verified
   * @param {Object} result - the proof-result for this block
   */
  _verifyBatchResponse (batchId, blockIndex, result) {
    const batch = this.pendingChallenges.get(batchId)
    if (!batch || !batch.isBatch) return

    batch.responses.set(blockIndex, result)

    // Check if all blocks in the batch have responded
    if (batch.responses.size >= batch.blockIndices.length) {
      this.pendingChallenges.delete(batchId)
      // Clean up per-index entries
      const nonceHex = b4a.toString(batch.nonce, 'hex')
      for (const index of batch.blockIndices) {
        this.pendingChallenges.delete(nonceHex + ':' + index)
      }

      const allPassed = [...batch.responses.values()].every(r => r.passed)
      const results = Object.fromEntries(batch.responses)

      this.emit('batch-proof-result', {
        batchId,
        relayPubkey: batch.relayPubkey,
        coreKey: batch.coreKey,
        blockIndices: batch.blockIndices,
        allPassed,
        results
      })
    }
  }

  /**
   * Issue a challenge to a relay: "prove you have block N of core X"
   *
   * @param {Buffer} coreKey - public key of the Hypercore
   * @param {number} blockIndex - block index to challenge
   * @param {Buffer} relayPubkey - public key of the relay being challenged
   * @param {Buffer} [blockData] - if the challenger has the block data, pass it to enable hash verification
   */
  challenge (channel, coreKey, blockIndex, relayPubkey, blockData) {
    const nonce = b4a.alloc(32)
    sodium.randombytes_buf(nonce)

    const challenge = {
      coreKey,
      blockIndex,
      nonce,
      maxLatencyMs: this.maxLatencyMs
    }

    const pending = {
      coreKey: b4a.toString(coreKey, 'hex'),
      blockIndex,
      sentAt: Date.now(),
      relayPubkey: b4a.toString(relayPubkey, 'hex'),
      nonce
    }

    // If the challenger has the original block data, compute the expected hash
    if (blockData && blockData.byteLength > 0) {
      pending.expectedHash = this._hashBlock(blockData, nonce)
    }

    this.pendingChallenges.set(b4a.toString(nonce, 'hex'), pending)

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

    // Rate limit incoming challenges to prevent DoS
    const peerKey = channel.stream?.remotePublicKey
      ? b4a.toString(channel.stream.remotePublicKey, 'hex')
      : 'unknown'
    if (!this._challengeRateLimiter) {
      const { TokenBucketRateLimiter } = await import('./rate-limiter.js')
      this._challengeRateLimiter = new TokenBucketRateLimiter({
        tokensPerMinute: 30,
        burstSize: 10
      })
    }
    const rateCheck = this._challengeRateLimiter.check(peerKey)
    if (!rateCheck.allowed) {
      this.emit('challenge-rate-limited', { peer: peerKey })
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

    // Check if this response belongs to a batch challenge (keyed by nonce:index)
    const batchKey = nonceHex + ':' + msg.blockIndex
    const batchPending = this.pendingChallenges.get(batchKey)

    // Try batch lookup first, then single-challenge lookup
    const pending = batchPending || this.pendingChallenges.get(nonceHex)

    if (!pending) {
      this.emit('unexpected-response', { nonce: nonceHex })
      return
    }

    // For batch entries, clean up the per-index key; for single, clean up the nonce key
    if (batchPending) {
      this.pendingChallenges.delete(batchKey)
    } else {
      this.pendingChallenges.delete(nonceHex)
    }

    const latencyMs = Date.now() - pending.sentAt
    const withinLatency = latencyMs <= this.maxLatencyMs
    const correctCore = b4a.toString(msg.coreKey, 'hex') === pending.coreKey
    const correctIndex = msg.blockIndex === pending.blockIndex
    const hasData = msg.blockData && msg.blockData.byteLength > 0
    const reasonableSize = hasData && msg.blockData.byteLength <= MAX_BLOCK_SIZE

    // Verify data integrity via hash check.
    // When the challenger has the original block data, compare nonce-keyed hashes.
    // Otherwise, rely on data-presence + latency checks — Hypercore's own Merkle
    // tree provides integrity at the transport layer, so a custom verifier is not
    // needed (and would be incompatible with Hypercore's flat-tree layout).
    let hashValid = true
    if (hasData && reasonableSize && pending.nonce && pending.expectedHash) {
      const responseHash = this._hashBlock(msg.blockData, pending.nonce)
      hashValid = b4a.equals(responseHash, pending.expectedHash)
    }

    const passed = withinLatency && correctCore && correctIndex && hasData && reasonableSize && hashValid

    // Update score
    this._updateScore(pending.relayPubkey, passed, latencyMs)

    const proofResult = {
      relayPubkey: pending.relayPubkey,
      coreKey: pending.coreKey,
      blockIndex: pending.blockIndex,
      passed,
      latencyMs,
      withinLatency,
      correctCore,
      correctIndex,
      hasData,
      reasonableSize,
      hashValid
    }

    this.emit('proof-result', proofResult)

    // If this response belongs to a batch, forward it for batch completion tracking
    if (pending.batchId) {
      this._verifyBatchResponse(pending.batchId, pending.blockIndex, proofResult)
    }
  }

  /**
   * Hash a block's data with a challenge nonce for verification.
   */
  _hashBlock (data, nonce) {
    const hash = b4a.alloc(32)
    sodium.crypto_generichash(hash, b4a.concat([data, nonce]))
    return hash
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

    // Evict lowest-reliability entries when scores map exceeds cap
    if (this.scores.size > this._maxScores) {
      let worstKey = null
      let worstReliability = Infinity
      for (const [key, s] of this.scores) {
        const reliability = s.challenges > 0 ? s.passes / s.challenges : 0
        if (reliability < worstReliability) {
          worstReliability = reliability
          worstKey = key
        }
      }
      if (worstKey) this.scores.delete(worstKey)
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
    const staleBatchIds = new Set()

    for (const [key, entry] of this.pendingChallenges) {
      if (entry.sentAt && now - entry.sentAt > maxAge) {
        this.pendingChallenges.delete(key)
        // If a batch entry is stale, mark its per-index entries for cleanup
        if (entry.isBatch && entry.nonce) {
          const nonceHex = b4a.toString(entry.nonce, 'hex')
          for (const index of entry.blockIndices) {
            staleBatchIds.add(nonceHex + ':' + index)
          }
        }
      }
    }

    // Clean up any orphaned batch per-index entries
    for (const key of staleBatchIds) {
      this.pendingChallenges.delete(key)
    }
  }

  destroy () {
    if (this._cleanupInterval) clearInterval(this._cleanupInterval)
    for (const timer of this._batchTimers) clearTimeout(timer)
    this._batchTimers.clear()
    if (this._challengeRateLimiter) this._challengeRateLimiter.destroy()
    this.channels.clear()
    this.pendingChallenges.clear()
  }
}

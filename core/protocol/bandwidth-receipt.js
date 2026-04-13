/**
 * Bandwidth Receipt Protocol
 *
 * After a data transfer, the receiving peer signs a receipt acknowledging
 * the relay served data. Relays collect these receipts as proof of work
 * for the incentive layer.
 *
 * Receipts are cryptographically signed and can be verified by anyone.
 */

import b4a from 'b4a'
import sodium from 'sodium-universal'
import { EventEmitter } from 'events'

/**
 * Circular buffer for efficient receipt storage
 * Automatically overwrites old entries when full
 */
class CircularBuffer {
  constructor (capacity) {
    this.capacity = capacity
    this.buffer = new Array(capacity)
    this.head = 0 // Next write position
    this.size = 0 // Current number of elements
  }

  push (item) {
    this.buffer[this.head] = item
    this.head = (this.head + 1) % this.capacity
    if (this.size < this.capacity) {
      this.size++
    }
  }

  toArray () {
    if (this.size < this.capacity) {
      return this.buffer.slice(0, this.size)
    }
    // Return in chronological order
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)]
  }

  [Symbol.iterator] () {
    return this.toArray()[Symbol.iterator]()
  }

  reduce (fn, initial) {
    return this.toArray().reduce(fn, initial)
  }

  filter (fn) {
    return this.toArray().filter(fn)
  }

  map (fn) {
    return this.toArray().map(fn)
  }

  clear () {
    this.buffer.fill(undefined)
    this.head = 0
    this.size = 0
  }

  get length () {
    return this.size
  }
}

export class BandwidthReceipt extends EventEmitter {
  constructor (keyPair, opts = {}) {
    super()
    this.keyPair = keyPair
    this.maxReceipts = opts.maxReceipts || 10_000
    // Use circular buffers for O(1) insertions
    this.issuedReceipts = new CircularBuffer(this.maxReceipts)
    this.collectedReceipts = new CircularBuffer(this.maxReceipts)

    // Replay attack prevention: track seen receipt nonces
    this._seenNonces = new Map() // nonce hex -> timestamp for time-based eviction
    this._maxSeenNonces = opts.maxSeenNonces || 50_000 // Limit memory usage

    // Maximum allowed bytes per receipt (100 TB - prevents integer overflow attacks)
    this._maxReceiptBytes = opts.maxReceiptBytes || 100 * 1024 * 1024 * 1024 * 1024

    // Receipt aggregation: accumulate small transfers into fewer signed receipts
    this._pendingReceipts = new Map() // relayPubkeyHex -> { bytes, startTime, chunks }
    this._aggregateThresholdBytes = opts.aggregateThresholdBytes || 10 * 1024 * 1024 // 10MB
    this._aggregateWindowMs = opts.aggregateWindowMs || 10_000 // 10 seconds
    this._flushInterval = setInterval(() => this._flushStale(), this._aggregateWindowMs)
    if (this._flushInterval.unref) this._flushInterval.unref()
  }

  /**
   * Generate a unique nonce for receipt signing (replay attack prevention)
   */
  _generateNonce () {
    const nonce = b4a.alloc(16)
    sodium.randombytes_buf(nonce)
    return nonce
  }

  /**
   * Check if a nonce has been seen before (prevent replay attacks)
   */
  _isNonceSeen (nonce) {
    const key = b4a.toString(nonce, 'hex')
    return this._seenNonces.has(key)
  }

  /**
   * Mark a nonce as seen
   */
  _markNonceSeen (nonce) {
    const key = b4a.toString(nonce, 'hex')
    const now = Date.now()
    // Time-based eviction: remove nonces older than 1 hour
    if (this._seenNonces.size >= this._maxSeenNonces) {
      for (const [k, ts] of this._seenNonces) {
        if (now - ts > 3600_000) {
          this._seenNonces.delete(k)
        }
      }
      // If still at capacity after time-based eviction, remove oldest
      if (this._seenNonces.size >= this._maxSeenNonces) {
        const oldest = this._seenNonces.keys().next().value
        this._seenNonces.delete(oldest)
      }
    }
    this._seenNonces.set(key, now)
  }

  /**
   * Create a signed receipt acknowledging data received from a relay.
   * Called by the receiving peer.
   */
  createReceipt (relayPubkey, bytesTransferred, sessionId) {
    // Validate bytesTransferred to prevent overflow attacks
    if (typeof bytesTransferred !== 'number' || bytesTransferred < 0 ||
        bytesTransferred > this._maxReceiptBytes || !Number.isFinite(bytesTransferred)) {
      throw new Error(`Invalid bytesTransferred: ${bytesTransferred}`)
    }

    const timestamp = Math.floor(Date.now() / 1000)
    const nonce = this._generateNonce()

    const payload = b4a.concat([
      relayPubkey,
      this.keyPair.publicKey,
      uint64ToBuffer(bytesTransferred),
      uint32ToBuffer(timestamp),
      sessionId,
      nonce
    ])

    const signature = b4a.alloc(64)
    sodium.crypto_sign_detached(signature, payload, this.keyPair.secretKey)

    const receipt = {
      relayPubkey,
      peerPubkey: this.keyPair.publicKey,
      bytesTransferred,
      timestamp,
      sessionId,
      nonce,
      peerSignature: signature
    }

    this.issuedReceipts.push(receipt)
    this.emit('receipt-issued', receipt)

    return receipt
  }

  /**
   * Verify a bandwidth receipt's signature.
   * Can be called by anyone to verify a receipt is authentic.
   */
  static verify (receipt) {
    // Validate required fields
    if (!receipt.relayPubkey || !receipt.peerPubkey ||
        !receipt.peerSignature || !receipt.nonce) {
      return false
    }

    // Validate bytesTransferred is reasonable (100 TB max)
    const MAX_BYTES = 100 * 1024 * 1024 * 1024 * 1024
    if (typeof receipt.bytesTransferred !== 'number' ||
        receipt.bytesTransferred < 0 ||
        receipt.bytesTransferred > MAX_BYTES ||
        !Number.isFinite(receipt.bytesTransferred)) {
      return false
    }

    const payload = b4a.concat([
      receipt.relayPubkey,
      receipt.peerPubkey,
      uint64ToBuffer(receipt.bytesTransferred),
      uint32ToBuffer(receipt.timestamp),
      receipt.sessionId,
      receipt.nonce
    ])

    return sodium.crypto_sign_verify_detached(
      receipt.peerSignature,
      payload,
      receipt.peerPubkey
    )
  }

  /**
   * Collect a receipt (called by relay nodes to store proof of service)
   */
  collectReceipt (receipt) {
    if (!BandwidthReceipt.verify(receipt)) {
      this.emit('receipt-invalid', receipt)
      return false
    }

    // Replay attack prevention: check if nonce already seen
    if (this._isNonceSeen(receipt.nonce)) {
      this.emit('receipt-replay-detected', receipt)
      return false
    }

    // Mark nonce as seen
    this._markNonceSeen(receipt.nonce)

    this.collectedReceipts.push(receipt)
    this.emit('receipt-collected', receipt)
    return true
  }

  /**
   * Accumulate bytes for a relay and flush when thresholds are reached.
   * This is an optimization layer on top of createReceipt() -- it batches
   * many small transfers into fewer signed receipts.
   *
   * @param {Buffer} relayPubkey - public key of the relay
   * @param {number} bytesTransferred - bytes to accumulate
   * @param {Buffer} sessionId - session identifier for receipt creation
   * @returns {Object|null} receipt if flushed, null if still accumulating
   */
  aggregateReceipt (relayPubkey, bytesTransferred, sessionId) {
    const keyHex = b4a.toString(relayPubkey, 'hex')
    let entry = this._pendingReceipts.get(keyHex)

    if (!entry) {
      entry = { bytes: 0, startTime: Date.now(), chunks: 0, relayPubkey, sessionId }
      this._pendingReceipts.set(keyHex, entry)
    }

    // Validate bytesTransferred (same checks as createReceipt)
    if (typeof bytesTransferred !== 'number' || bytesTransferred < 0 ||
        bytesTransferred > this._maxReceiptBytes || !Number.isFinite(bytesTransferred)) {
      return null
    }

    entry.bytes += bytesTransferred
    entry.chunks++

    // Flush if byte threshold or time window exceeded
    if (entry.bytes >= this._aggregateThresholdBytes ||
        Date.now() - entry.startTime >= this._aggregateWindowMs) {
      return this._flushReceipt(keyHex, entry)
    }

    return null
  }

  /**
   * Create a single signed receipt for the aggregated amount and reset.
   */
  _flushReceipt (keyHex, entry) {
    this._pendingReceipts.delete(keyHex)

    const receipt = this.createReceipt(entry.relayPubkey, entry.bytes, entry.sessionId)

    this.emit('receipt-flushed', {
      relayPubkey: keyHex,
      bytes: entry.bytes,
      chunks: entry.chunks,
      receipt
    })

    return receipt
  }

  /**
   * Flush all pending receipts. Call on shutdown to ensure nothing is lost.
   *
   * @returns {Object[]} array of flushed receipts
   */
  flushAll () {
    const flushed = []
    for (const [keyHex, entry] of this._pendingReceipts) {
      flushed.push(this._flushReceipt(keyHex, entry))
    }
    return flushed
  }

  /**
   * Flush entries that have exceeded the time window.
   * Called periodically by _flushInterval.
   */
  _flushStale () {
    const now = Date.now()
    for (const [keyHex, entry] of this._pendingReceipts) {
      if (now - entry.startTime >= this._aggregateWindowMs) {
        this._flushReceipt(keyHex, entry)
      }
    }
  }

  /**
   * Stop the aggregation flush interval. Call on shutdown.
   */
  stop () {
    if (this._flushInterval) {
      clearInterval(this._flushInterval)
      this._flushInterval = null
    }
    // Flush any remaining pending receipts
    this.flushAll()
  }

  /**
   * Get total bandwidth proven by collected receipts
   */
  getTotalProvenBandwidth () {
    return this.collectedReceipts.reduce((sum, r) => sum + r.bytesTransferred, 0)
  }

  /**
   * Get receipts within a time window (for periodic settlement)
   */
  getReceiptsInWindow (startTimestamp, endTimestamp) {
    return this.collectedReceipts.filter(
      r => r.timestamp >= startTimestamp && r.timestamp <= endTimestamp
    )
  }

  /**
   * Export collected receipts for submission to incentive layer
   */
  exportReceipts () {
    return this.collectedReceipts.map(r => ({
      relayPubkey: b4a.toString(r.relayPubkey, 'hex'),
      peerPubkey: b4a.toString(r.peerPubkey, 'hex'),
      bytesTransferred: r.bytesTransferred,
      timestamp: r.timestamp,
      sessionId: b4a.toString(r.sessionId, 'hex'),
      nonce: b4a.toString(r.nonce, 'hex'),
      peerSignature: b4a.toString(r.peerSignature, 'hex')
    }))
  }
}

function uint64ToBuffer (n) {
  const buf = b4a.alloc(8)
  const view = new DataView(buf.buffer, buf.byteOffset, 8)
  view.setBigUint64(0, BigInt(n), false) // big-endian
  return buf
}

function uint32ToBuffer (n) {
  const buf = b4a.alloc(4)
  const view = new DataView(buf.buffer, buf.byteOffset, 4)
  view.setUint32(0, n, false)
  return buf
}

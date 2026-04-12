/**
 * Topic-based Pub/Sub Engine
 *
 * Two-tier design for fast dispatch:
 * - Exact topics: Map lookup, O(1)
 * - Glob patterns (topics containing *): linear scan over patterns array
 *
 * Topic format: hierarchical with "/" separator
 * Example: "events/seeding", "services/storage/*", "events/*"
 */

import crypto from 'crypto'
import { EventEmitter } from 'events'

export class PubSub extends EventEmitter {
  constructor (opts = {}) {
    super()
    this._exact = new Map() // topic -> Map<subId, Subscriber>
    this._patterns = [] // [{ pattern, regex, subscribers: Map<subId, Subscriber> }]
    this._subIndex = new Map() // subId -> { type: 'exact'|'pattern', topic|patternIdx }
    this._maxTopics = opts.maxTopics ?? 10_000
    this._maxSubscribersPerTopic = opts.maxSubscribersPerTopic ?? 1_000
    this._defaultTTL = opts.defaultTTL ?? 60 * 60 * 1000 // 1 hour
    this._cleanupInterval = setInterval(() => this._cleanupExpired(), 60_000)
  }

  /**
   * Subscribe to a topic or glob pattern.
   *
   * @param {string} topic - Exact topic or glob (e.g., "events/*")
   * @param {Function} callback - async (topic, data) => void
   * @param {object} [opts]
   * @param {Function} [opts.filter] - Predicate: (data) => boolean
   * @param {string} [opts.remotePubkey] - For P2P subscribers
   * @param {number} [opts.ttl] - Subscription TTL in ms
   * @returns {string} Subscription ID
   */
  subscribe (topic, callback, opts = {}) {
    const subId = crypto.randomBytes(8).toString('hex')
    const subscriber = {
      id: subId,
      callback,
      filter: opts.filter || null,
      remotePubkey: opts.remotePubkey || null,
      createdAt: Date.now(),
      expiresAt: Date.now() + (opts.ttl ?? this._defaultTTL)
    }

    if (topic.includes('*')) {
      // Glob pattern subscription
      let entry = this._patterns.find(p => p.pattern === topic)
      if (!entry) {
        const escaped = topic.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        const regexStr = '^' + escaped.replace(/\*/g, '[^/]*') + '$'
        entry = { pattern: topic, regex: new RegExp(regexStr), subscribers: new Map() }
        this._patterns.push(entry)
      }
      if (entry.subscribers.size >= this._maxSubscribersPerTopic) {
        throw new Error('PUBSUB_MAX_SUBSCRIBERS')
      }
      entry.subscribers.set(subId, subscriber)
      this._subIndex.set(subId, { type: 'pattern', pattern: topic })
    } else {
      // Exact topic subscription
      if (!this._exact.has(topic)) {
        if (this._exact.size >= this._maxTopics) {
          throw new Error('PUBSUB_MAX_TOPICS')
        }
        this._exact.set(topic, new Map())
      }
      const subs = this._exact.get(topic)
      if (subs.size >= this._maxSubscribersPerTopic) {
        throw new Error('PUBSUB_MAX_SUBSCRIBERS')
      }
      subs.set(subId, subscriber)
      this._subIndex.set(subId, { type: 'exact', topic })
    }

    this.emit('subscribed', { subId, topic })
    return subId
  }

  /**
   * Remove a subscription by ID.
   */
  unsubscribe (subId) {
    const index = this._subIndex.get(subId)
    if (!index) return false

    if (index.type === 'exact') {
      const subs = this._exact.get(index.topic)
      if (subs) {
        subs.delete(subId)
        if (subs.size === 0) this._exact.delete(index.topic)
      }
    } else {
      const entry = this._patterns.find(p => p.pattern === index.pattern)
      if (entry) {
        entry.subscribers.delete(subId)
        if (entry.subscribers.size === 0) {
          this._patterns = this._patterns.filter(p => p.pattern !== index.pattern)
        }
      }
    }

    this._subIndex.delete(subId)
    this.emit('unsubscribed', { subId })
    return true
  }

  /**
   * Publish data to a topic. Fire-and-forget: catches per-subscriber errors.
   *
   * @param {string} topic - The topic to publish to
   * @param {*} data - Payload
   */
  async publish (topic, data) {
    const subscribers = []

    // Exact match — O(1)
    const exact = this._exact.get(topic)
    if (exact) {
      for (const sub of exact.values()) subscribers.push(sub)
    }

    // Glob match — linear in pattern count (expected small)
    for (const entry of this._patterns) {
      if (entry.regex.test(topic)) {
        for (const sub of entry.subscribers.values()) subscribers.push(sub)
      }
    }

    if (subscribers.length === 0) return 0

    let delivered = 0
    const now = Date.now()

    for (const sub of subscribers) {
      // Skip expired
      if (sub.expiresAt < now) continue
      // Apply filter
      if (sub.filter && !sub.filter(data)) continue

      try {
        await sub.callback(topic, data)
        delivered++
      } catch (err) {
        this.emit('subscriber-error', { subId: sub.id, topic, error: err.message })
      }
    }

    return delivered
  }

  /**
   * List active topics (exact only).
   */
  topics () {
    return [...this._exact.keys()]
  }

  /**
   * Total exact topic count.
   */
  topicCount () {
    return this._exact.size + this._patterns.length
  }

  /**
   * Total subscriber count across all topics.
   */
  subscriberCount () {
    let count = 0
    for (const subs of this._exact.values()) count += subs.size
    for (const entry of this._patterns) count += entry.subscribers.size
    return count
  }

  _cleanupExpired () {
    const now = Date.now()
    for (const [subId, index] of this._subIndex) {
      let sub = null
      if (index.type === 'exact') {
        const subs = this._exact.get(index.topic)
        if (subs) sub = subs.get(subId)
      } else {
        const entry = this._patterns.find(p => p.pattern === index.pattern)
        if (entry) sub = entry.subscribers.get(subId)
      }
      if (sub && sub.expiresAt < now) {
        this.unsubscribe(subId)
      }
    }
  }

  destroy () {
    clearInterval(this._cleanupInterval)
    this._exact.clear()
    this._patterns = []
    this._subIndex.clear()
  }
}

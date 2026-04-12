/**
 * Pricing Engine
 *
 * Token-based pricing for HiveRelay services.
 * Designed to be 5-10x cheaper than cloud AI APIs (Claude, ChatGPT, etc.)
 * because relay operators serve local models at near-zero marginal cost.
 *
 * Pricing philosophy:
 *   - Local LLM inference has ~zero marginal cost per token
 *   - Operators pay fixed costs: hardware, electricity, bandwidth
 *   - Credits are cheap enough that devs don't think twice
 *   - Volume discounts via CreditManager bonus schedule
 *
 * Comparison (at BTC ≈ $60,000, 1 sat ≈ $0.0006):
 *
 *   Service          | HiveRelay          | Claude API         | OpenAI API
 *   ai.infer (1K in) | 1 sat ($0.0006)    | $0.003             | $0.0025
 *   ai.infer (1K out)| 2 sats ($0.0012)   | $0.015             | $0.010
 *   ai.embed (1K)    | 0.5 sat ($0.0003)  | $0.0001            | $0.00002
 *   compute.submit   | 10 sats ($0.006)   | Lambda ~$0.02      | --
 *   storage.write    | 1 sat ($0.0006)     | S3 ~$0.005/1K PUT  | --
 *
 *   → HiveRelay AI inference is ~5x cheaper than Claude, ~4x cheaper than OpenAI
 *   → Embeddings are priced higher than cloud (local GPU vs cloud batch)
 *   → Compute and storage are dramatically cheaper (P2P, no cloud overhead)
 */

import { EventEmitter } from 'events'

/**
 * Default rate card (sats per unit).
 * Relay operators can override these via config.
 */
const DEFAULT_RATES = {
  // ─── AI Services ───
  // Priced per 1K tokens (input vs output)
  'ai.infer': {
    perInputToken: 0.001, // 1 sat per 1K input tokens
    perOutputToken: 0.002, // 2 sats per 1K output tokens
    perCall: 1, // 1 sat minimum per call
    description: 'LLM inference'
  },
  'ai.embed': {
    perInputToken: 0.0005, // 0.5 sat per 1K input tokens
    perCall: 0.5, // 0.5 sat minimum per call
    description: 'Text embeddings'
  },
  'ai.list-models': {
    perCall: 0, // Free — discovery endpoint
    description: 'List available models'
  },
  'ai.status': {
    perCall: 0,
    description: 'AI service status'
  },

  // ─── Compute Services ───
  'compute.submit': {
    perCall: 10, // 10 sats per job submission
    perMs: 0.001, // 1 sat per second of compute
    maxCharge: 1000, // 1000 sat cap per job
    description: 'Sandboxed code execution'
  },
  'compute.status': {
    perCall: 0,
    description: 'Job status check'
  },
  'compute.result': {
    perCall: 0,
    description: 'Fetch job result'
  },

  // ─── Storage Services ───
  'storage.drive-create': {
    perCall: 5, // 5 sats to create a drive
    description: 'Create Hyperdrive'
  },
  'storage.drive-write': {
    perCall: 1, // 1 sat per write
    perKB: 0.01, // 0.01 sat per KB written
    description: 'Write to drive'
  },
  'storage.drive-read': {
    perCall: 0, // Reads are free (P2P replication)
    description: 'Read from drive'
  },
  'storage.drive-list': {
    perCall: 0,
    description: 'List drive contents'
  },

  // ─── Identity Services ───
  'identity.whoami': {
    perCall: 0,
    description: 'Get identity'
  },
  'identity.sign': {
    perCall: 1, // 1 sat per signature
    description: 'Cryptographic signature'
  },
  'identity.verify': {
    perCall: 0, // Verification is free
    description: 'Verify signature'
  },

  // ─── Schema Services ───
  'schema.register': {
    perCall: 2, // 2 sats to register schema
    description: 'Register data schema'
  },
  'schema.validate': {
    perCall: 0, // Validation is free
    description: 'Validate against schema'
  },
  'schema.list': {
    perCall: 0,
    description: 'List schemas'
  },

  // ─── SLA Services ───
  'sla.create': {
    perCall: 0, // SLA creation is free (collateral is separate)
    description: 'Create SLA contract'
  },
  'sla.list': {
    perCall: 0,
    description: 'List SLA contracts'
  },
  'sla.get': {
    perCall: 0,
    description: 'Get SLA details'
  }
}

export class PricingEngine extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.rates = {}
    // Merge defaults with overrides
    for (const [route, defaults] of Object.entries(DEFAULT_RATES)) {
      this.rates[route] = { ...defaults, ...(opts.rates?.[route] || {}) }
    }
    // Allow adding entirely new routes
    if (opts.rates) {
      for (const [route, rate] of Object.entries(opts.rates)) {
        if (!this.rates[route]) this.rates[route] = rate
      }
    }
    // Operator margin multiplier (1.0 = no markup, 1.5 = 50% markup)
    this.margin = opts.margin || 1.0
  }

  /**
   * Calculate cost in sats for a service call.
   * Takes the route and response metadata (tokens, bytes, duration).
   *
   * @param {string} route - Service route (e.g., 'ai.infer')
   * @param {object} meta - Call metadata from service response
   * @param {number} [meta.inputTokens] - Input tokens consumed
   * @param {number} [meta.outputTokens] - Output tokens generated
   * @param {number} [meta.bytes] - Bytes written/transferred
   * @param {number} [meta.durationMs] - Compute duration in ms
   * @returns {{ cost: number, breakdown: object }}
   */
  calculate (route, meta = {}) {
    const rate = this.rates[route]
    if (!rate) {
      // Unknown route — charge minimum 1 sat
      return { cost: 1, breakdown: { base: 1 }, route }
    }

    let cost = 0
    const breakdown = {}

    // Per-call base cost
    if (rate.perCall) {
      cost += rate.perCall
      breakdown.base = rate.perCall
    }

    // Token-based pricing (AI services)
    if (rate.perInputToken && meta.inputTokens) {
      const inputCost = meta.inputTokens * rate.perInputToken
      cost += inputCost
      breakdown.inputTokens = { count: meta.inputTokens, cost: inputCost }
    }
    if (rate.perOutputToken && meta.outputTokens) {
      const outputCost = meta.outputTokens * rate.perOutputToken
      cost += outputCost
      breakdown.outputTokens = { count: meta.outputTokens, cost: outputCost }
    }

    // Byte-based pricing (storage)
    if (rate.perKB && meta.bytes) {
      const kbCost = (meta.bytes / 1024) * rate.perKB
      cost += kbCost
      breakdown.bytes = { count: meta.bytes, cost: kbCost }
    }

    // Duration-based pricing (compute)
    if (rate.perMs && meta.durationMs) {
      const durationCost = meta.durationMs * rate.perMs
      cost += durationCost
      breakdown.duration = { ms: meta.durationMs, cost: durationCost }
    }

    // Apply operator margin
    cost *= this.margin

    // Apply cap if set
    if (rate.maxCharge && cost > rate.maxCharge) {
      cost = rate.maxCharge
      breakdown.capped = true
    }

    // Round up to nearest sat (minimum 0 for free routes)
    cost = Math.ceil(cost)

    return { cost, breakdown, route }
  }

  /**
   * Get the rate card for display / API response.
   */
  getRateCard () {
    const card = {}
    for (const [route, rate] of Object.entries(this.rates)) {
      card[route] = {
        ...rate,
        effectiveMargin: this.margin
      }
    }
    return card
  }

  /**
   * Get human-readable pricing comparison.
   * Useful for marketing / dashboard.
   */
  getComparison (btcPriceUsd = 60000) {
    const satToUsd = btcPriceUsd / 100_000_000

    return {
      btcPriceUsd,
      satToUsd,
      services: {
        'ai.infer': {
          hiverelay: {
            per1kInput: this.rates['ai.infer'].perInputToken * 1000 * this.margin,
            per1kOutput: this.rates['ai.infer'].perOutputToken * 1000 * this.margin,
            per1kInputUsd: this.rates['ai.infer'].perInputToken * 1000 * this.margin * satToUsd,
            per1kOutputUsd: this.rates['ai.infer'].perOutputToken * 1000 * this.margin * satToUsd
          },
          claude: { per1kInputUsd: 0.003, per1kOutputUsd: 0.015 },
          openai: { per1kInputUsd: 0.0025, per1kOutputUsd: 0.010 },
          savingsVsClaude: '~5x cheaper (input), ~12x cheaper (output)',
          savingsVsOpenai: '~4x cheaper (input), ~8x cheaper (output)'
        },
        'compute.submit': {
          hiverelay: {
            perJob: this.rates['compute.submit'].perCall * this.margin,
            perSecond: this.rates['compute.submit'].perMs * 1000 * this.margin,
            perJobUsd: this.rates['compute.submit'].perCall * this.margin * satToUsd
          },
          awsLambda: { perRequestUsd: 0.0000002, perGbSecUsd: 0.0000166 },
          savings: 'Comparable for small jobs, cheaper for GPU workloads'
        }
      }
    }
  }

  /**
   * Estimate cost for a batch of service calls (for budgeting).
   */
  estimate (calls) {
    let total = 0
    const items = []

    for (const call of calls) {
      const result = this.calculate(call.route, call.meta || {})
      total += result.cost
      items.push(result)
    }

    return { total, items }
  }

  /**
   * Check if a route is free (no charge).
   */
  isFree (route) {
    const rate = this.rates[route]
    if (!rate) return false
    return rate.perCall === 0 &&
      !rate.perInputToken &&
      !rate.perOutputToken &&
      !rate.perKB &&
      !rate.perMs
  }
}

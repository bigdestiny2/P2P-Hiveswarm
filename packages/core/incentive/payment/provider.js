/**
 * PaymentProvider — the contract every payment rail implements.
 *
 * Two providers ship today:
 *   - LightningProvider  (LND/CLN gRPC, sat-denominated)
 *   - MockProvider       (in-memory, for tests)
 *
 * The contract is designed to accommodate future providers without changing
 * PaymentManager. Concrete targets the interface should survive:
 *   - Lightning + Taproot Assets for USDt-over-Lightning (same invoice shape,
 *     different asset)
 *   - Tether Wallet SDK (multi-chain, credit-top-up model)
 *   - Fedimint / cashu / any future micropayment rail
 *
 * This file is documentation + a lightweight base class. Providers are
 * already plain duck-typed objects (MockProvider doesn't extend anything),
 * so adoption is opt-in — new providers can inherit for method stubs, old
 * ones keep working as-is.
 */

import { EventEmitter } from 'events'

/**
 * Asset identifier. Providers that only support one asset can ignore.
 *   'BTC'   — satoshis (the Lightning default)
 *   'USDT'  — Tether USD; carried via Taproot Assets on Lightning, or via
 *             an on-chain/off-chain Tether Wallet path
 *   others  — extensible string tag; verify with `capabilities().assets`
 */

export class PaymentProvider extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.connected = false
  }

  /**
   * Establish connection to the backend (open gRPC channel, validate
   * credentials, etc.). Must be called before any pay/createInvoice.
   * Should emit 'connected' on success, 'disconnected' on teardown.
   */
  async connect () { throw new Error('PaymentProvider.connect() not implemented') }

  async disconnect () { /* default: no-op */ }

  /**
   * Pay an invoice / settlement request.
   *
   * @param {string|object} invoice - BOLT11 string for Lightning, or a
   *   provider-specific payment request object for other rails
   * @param {number} amount - amount in the unit native to the asset
   *   (sats for BTC, USDt units for USDT — typically 10^-6 dollars)
   * @param {object} [opts]
   * @param {string} [opts.asset='BTC'] - asset identifier
   * @returns {Promise<{amount, asset, preimage?, txid?, timestamp}>} payment record
   */
  async pay (invoice, amount, opts = {}) {
    throw new Error('PaymentProvider.pay() not implemented')
  }

  /**
   * Create an invoice / payment request that can be paid by a counterparty.
   *
   * @param {number} amount - in the asset's native unit
   * @param {string} [memo]
   * @param {object} [opts]
   * @param {string} [opts.asset='BTC']
   * @param {number} [opts.expirySeconds=3600]
   * @returns {Promise<{invoice, amount, asset, memo, rHash?, timestamp, expiresAt}>}
   */
  async createInvoice (amount, memo = '', opts = {}) {
    throw new Error('PaymentProvider.createInvoice() not implemented')
  }

  /**
   * Look up the status of a previously-created invoice. Some rails (plain
   * Lightning) settle via subscription callback; this method supports poll
   * semantics for rails that don't.
   */
  async getInvoiceStatus (identifier) {
    throw new Error('PaymentProvider.getInvoiceStatus() not implemented')
  }

  /**
   * Capability probe. Clients use this to negotiate which provider to use
   * when an operator offers more than one.
   *
   * @returns {{
   *   name: string,
   *   assets: string[],
   *   rails: Array<'lightning'|'onchain'|'wallet-sdk'|string>,
   *   micropayments: boolean,   // true if sub-cent payments are economical
   *   topUpModel: boolean,      // true if the provider requires pre-funding
   *                             // credits rather than pay-per-call
   *   connected: boolean
   * }}
   */
  capabilities () {
    return {
      name: this.constructor.name,
      assets: ['BTC'],
      rails: ['lightning'],
      micropayments: true,
      topUpModel: false,
      connected: this.connected
    }
  }
}

/**
 * Utility: pick the best available provider for a given (asset, amount)
 * requirement from a list of providers. Used by PaymentManager when an
 * operator advertises multiple rails.
 *
 * Preference order:
 *   1. Provider supports the asset + rail the caller asked for (if any)
 *   2. Micropayment-friendly providers win for amounts < $0.10 equivalent
 *   3. Top-up-model providers accepted for larger amounts
 *   4. First provider in list that supports the asset
 *
 * @param {PaymentProvider[]} providers
 * @param {{asset?: string, rail?: string, amountUsd?: number}} [requirement]
 */
export function selectProvider (providers, requirement = {}) {
  const asset = requirement.asset || 'BTC'
  const rail = requirement.rail || null
  const isMicropayment = (requirement.amountUsd || 0) < 0.10

  const supporting = providers.filter((p) => {
    const caps = p.capabilities()
    if (!caps.connected) return false
    if (!caps.assets.includes(asset)) return false
    if (rail && !caps.rails.includes(rail)) return false
    return true
  })
  if (supporting.length === 0) return null

  if (isMicropayment) {
    const micro = supporting.find((p) => p.capabilities().micropayments)
    if (micro) return micro
  }
  return supporting[0]
}

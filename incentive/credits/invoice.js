/**
 * Invoice Manager
 *
 * Manages the full lifecycle of Lightning invoices for credit purchases:
 *   1. App requests credits → generate Lightning invoice
 *   2. Invoice is returned to app (bolt11 string)
 *   3. App pays via any Lightning wallet
 *   4. Invoice settles → CreditManager tops up wallet
 *
 * Supports both:
 *   - LND invoice subscription (real-time settlement detection)
 *   - Polling (for providers without subscription support)
 *
 * Invoice states: pending → settled | expired | cancelled
 */

import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'

const INVOICE_EXPIRY_MS = 15 * 60 * 1000 // 15 minutes default
const POLL_INTERVAL_MS = 5_000 // Check every 5s for pending invoices
const MAX_PENDING = 100 // Max concurrent pending invoices per relay

export class InvoiceManager extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.provider = opts.provider || null // LightningProvider or MockProvider
    this.creditManager = opts.creditManager || null
    this.expiryMs = opts.expiryMs || INVOICE_EXPIRY_MS
    this.pollIntervalMs = opts.pollIntervalMs || POLL_INTERVAL_MS

    // invoiceId -> Invoice
    this.invoices = new Map()
    // paymentHash -> invoiceId (for settlement lookup)
    this.hashIndex = new Map()

    this._pollTimer = null
    this._started = false
  }

  /**
   * Start the invoice manager.
   * Begins polling for settled invoices if no subscription available.
   */
  start () {
    if (this._started) return
    this._started = true

    // Start polling for invoice settlements
    this._pollTimer = setInterval(() => {
      this._checkPendingInvoices().catch(err => {
        this.emit('poll-error', { error: err.message })
      })
    }, this.pollIntervalMs)

    // Also run expiry cleanup
    this._expiryTimer = setInterval(() => {
      this._expirePending()
    }, 60_000) // Check every minute

    this.emit('started')
  }

  /**
   * Stop the invoice manager.
   */
  stop () {
    if (this._pollTimer) clearInterval(this._pollTimer)
    if (this._expiryTimer) clearInterval(this._expiryTimer)
    this._started = false
    this.emit('stopped')
  }

  /**
   * Create a new invoice for an app to purchase credits.
   *
   * @param {string} appPubkey - The app's public key
   * @param {number} amountSats - Amount in sats to invoice
   * @param {object} [opts] - Options
   * @param {string} [opts.memo] - Invoice memo
   * @returns {Promise<Invoice>}
   */
  async createInvoice (appPubkey, amountSats, opts = {}) {
    if (!this.provider) throw new Error('NO_PROVIDER: payment provider not configured')
    if (!this.provider.connected) throw new Error('PROVIDER_DISCONNECTED')
    if (amountSats < 100) throw new Error('MIN_AMOUNT: minimum invoice is 100 sats')
    if (amountSats > 100_000_000) throw new Error('MAX_AMOUNT: maximum invoice is 1 BTC')

    // Check pending invoice limit
    let pendingCount = 0
    for (const inv of this.invoices.values()) {
      if (inv.status === 'pending') pendingCount++
    }
    if (pendingCount >= MAX_PENDING) {
      throw new Error('MAX_PENDING: too many pending invoices')
    }

    const memo = opts.memo || `HiveRelay credits: ${amountSats} sats for ${appPubkey.slice(0, 12)}...`
    const providerInvoice = await this.provider.createInvoice(amountSats, memo)

    const invoice = {
      id: this._invoiceId(),
      appPubkey,
      amountSats,
      bolt11: providerInvoice.bolt11,
      paymentHash: providerInvoice.rHash || null,
      memo,
      status: 'pending', // pending | settled | expired | cancelled
      createdAt: Date.now(),
      expiresAt: Date.now() + this.expiryMs,
      settledAt: null,
      creditTx: null // CreditManager transaction ID once credited
    }

    this.invoices.set(invoice.id, invoice)
    if (invoice.paymentHash) {
      this.hashIndex.set(invoice.paymentHash, invoice.id)
    }

    this.emit('invoice-created', {
      id: invoice.id,
      app: appPubkey,
      amount: amountSats,
      bolt11: invoice.bolt11,
      expiresAt: invoice.expiresAt
    })

    return {
      id: invoice.id,
      bolt11: invoice.bolt11,
      amount: amountSats,
      expiresAt: invoice.expiresAt,
      status: 'pending'
    }
  }

  /**
   * Get invoice status.
   */
  getInvoice (invoiceId) {
    const inv = this.invoices.get(invoiceId)
    if (!inv) return null

    return {
      id: inv.id,
      appPubkey: inv.appPubkey,
      amountSats: inv.amountSats,
      bolt11: inv.bolt11,
      status: inv.status,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      settledAt: inv.settledAt
    }
  }

  /**
   * Get all invoices for an app.
   */
  getAppInvoices (appPubkey, opts = {}) {
    const result = []
    for (const inv of this.invoices.values()) {
      if (inv.appPubkey === appPubkey) {
        result.push({
          id: inv.id,
          amountSats: inv.amountSats,
          status: inv.status,
          createdAt: inv.createdAt,
          settledAt: inv.settledAt
        })
      }
    }

    // Sort newest first
    result.sort((a, b) => b.createdAt - a.createdAt)

    const limit = opts.limit || 50
    return result.slice(0, limit)
  }

  /**
   * Cancel a pending invoice.
   */
  cancelInvoice (invoiceId) {
    const inv = this.invoices.get(invoiceId)
    if (!inv) throw new Error('INVOICE_NOT_FOUND')
    if (inv.status !== 'pending') throw new Error('INVOICE_NOT_PENDING')

    inv.status = 'cancelled'
    this.emit('invoice-cancelled', { id: inv.id, app: inv.appPubkey })
    return { id: inv.id, status: 'cancelled' }
  }

  /**
   * Manually mark an invoice as settled.
   * Used when settlement is detected externally (e.g., webhook, subscription).
   */
  async settleInvoice (invoiceIdOrHash, opts = {}) {
    let inv

    // Look up by hash or ID
    if (this.hashIndex.has(invoiceIdOrHash)) {
      const id = this.hashIndex.get(invoiceIdOrHash)
      inv = this.invoices.get(id)
    } else {
      inv = this.invoices.get(invoiceIdOrHash)
    }

    if (!inv) throw new Error('INVOICE_NOT_FOUND')
    if (inv.status === 'settled') return { id: inv.id, status: 'settled', alreadySettled: true }
    if (inv.status !== 'pending') throw new Error('INVOICE_NOT_PENDING: status is ' + inv.status)

    inv.status = 'settled'
    inv.settledAt = Date.now()

    // Credit the app's wallet
    if (this.creditManager) {
      const tx = this.creditManager.topUp(inv.appPubkey, inv.amountSats, {
        invoiceId: inv.id,
        paymentHash: inv.paymentHash
      })
      inv.creditTx = tx.id
    }

    this.emit('invoice-settled', {
      id: inv.id,
      app: inv.appPubkey,
      amount: inv.amountSats,
      creditTx: inv.creditTx
    })

    return { id: inv.id, status: 'settled', creditTx: inv.creditTx }
  }

  /**
   * Check pending invoices against the payment provider.
   * Called on a polling interval.
   */
  async _checkPendingInvoices () {
    if (!this.provider || !this.provider.connected) return

    for (const inv of this.invoices.values()) {
      if (inv.status !== 'pending') continue
      if (Date.now() > inv.expiresAt) continue // Will be expired by _expirePending

      try {
        // Check if the provider has a lookupInvoice method
        if (typeof this.provider.lookupInvoice === 'function') {
          const lookup = await this.provider.lookupInvoice(inv.paymentHash)
          if (lookup && lookup.settled) {
            await this.settleInvoice(inv.id)
          }
        }
      } catch {
        // Ignore lookup errors for individual invoices
      }
    }
  }

  /**
   * Expire invoices past their expiry time.
   */
  _expirePending () {
    const now = Date.now()
    for (const inv of this.invoices.values()) {
      if (inv.status === 'pending' && now > inv.expiresAt) {
        inv.status = 'expired'
        this.emit('invoice-expired', { id: inv.id, app: inv.appPubkey })
      }
    }
  }

  /**
   * Stats for monitoring.
   */
  stats () {
    let pending = 0
    let settled = 0
    let expired = 0
    let cancelled = 0
    let totalSettledSats = 0

    for (const inv of this.invoices.values()) {
      if (inv.status === 'pending') pending++
      else if (inv.status === 'settled') { settled++; totalSettledSats += inv.amountSats } else if (inv.status === 'expired') expired++
      else if (inv.status === 'cancelled') cancelled++
    }

    return { total: this.invoices.size, pending, settled, expired, cancelled, totalSettledSats }
  }

  /**
   * Cleanup old settled/expired/cancelled invoices (older than 30 days).
   */
  cleanup (maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs
    let cleaned = 0

    for (const [id, inv] of this.invoices) {
      if (inv.status !== 'pending' && inv.createdAt < cutoff) {
        this.invoices.delete(id)
        if (inv.paymentHash) this.hashIndex.delete(inv.paymentHash)
        cleaned++
      }
    }

    return { cleaned }
  }

  _invoiceId () {
    return 'inv_' + randomBytes(12).toString('hex')
  }
}

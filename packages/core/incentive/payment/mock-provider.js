/**
 * Mock Lightning Payment Provider
 *
 * Same interface as the real LND provider but runs entirely in-memory.
 * Used for testing and development without a Lightning node.
 */

import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'

export class MockProvider extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.connected = false
    this.balance = opts.balance || 1_000_000 // default 1M sats
    this.payments = [] // { invoice, amount, timestamp }
    this.invoices = [] // { bolt11, amount, memo, timestamp }
    this.failNext = false // set true to simulate payment failure
  }

  async connect () {
    this.connected = true
    this.emit('connected')
  }

  async pay (invoice, amount, opts = {}) {
    if (!this.connected) throw new Error('Provider not connected')
    if (this.failNext) {
      this.failNext = false
      throw new Error('MOCK_PAYMENT_FAILED: simulated failure')
    }
    if (amount > this.balance) {
      throw new Error('INSUFFICIENT_BALANCE')
    }

    const asset = opts.asset || 'BTC'
    this.balance -= amount
    const payment = {
      invoice,
      amount,
      asset,
      timestamp: Date.now(),
      preimage: randomBytes(32).toString('hex')
    }
    this.payments.push(payment)
    this.emit('payment-sent', payment)
    return payment
  }

  async createInvoice (amount, memo = '', opts = {}) {
    if (!this.connected) throw new Error('Provider not connected')

    const asset = opts.asset || 'BTC'
    const bolt11 = 'lnbc' + amount + 'mock' + randomBytes(16).toString('hex')
    const rHash = randomBytes(32).toString('hex')
    const invoice = {
      bolt11,
      amount,
      asset,
      memo,
      rHash,
      settled: false,
      timestamp: Date.now()
    }
    this.invoices.push(invoice)
    this.emit('invoice-created', invoice)
    return invoice
  }

  capabilities () {
    return {
      name: 'MockProvider',
      assets: ['BTC', 'USDT'], // mock knows both for test flexibility
      rails: ['lightning'],
      micropayments: true,
      topUpModel: false,
      connected: this.connected
    }
  }

  async getBalance () {
    if (!this.connected) throw new Error('Provider not connected')
    return { confirmed: this.balance, unconfirmed: 0 }
  }

  async getInfo () {
    if (!this.connected) throw new Error('Provider not connected')
    return {
      pubkey: randomBytes(33).toString('hex'),
      alias: 'mock-node',
      channels: { active: 3, inactive: 0, pending: 0 },
      blockHeight: 800000
    }
  }

  async lookupInvoice (rHash) {
    if (!this.connected) throw new Error('Provider not connected')
    // Check if any invoice was marked as settled
    const inv = this.invoices.find(i => i.rHash === rHash)
    return inv ? { settled: !!inv.settled, amount: inv.amount } : null
  }

  /**
   * Mark a mock invoice as settled (for testing settlement detection).
   */
  settleInvoice (rHash) {
    const inv = this.invoices.find(i => i.rHash === rHash)
    if (inv) inv.settled = true
  }

  async disconnect () {
    this.connected = false
    this.emit('disconnected')
  }
}

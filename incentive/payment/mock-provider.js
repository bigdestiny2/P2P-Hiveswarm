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

  async pay (invoice, amountSats) {
    if (!this.connected) throw new Error('Provider not connected')
    if (this.failNext) {
      this.failNext = false
      throw new Error('MOCK_PAYMENT_FAILED: simulated failure')
    }
    if (amountSats > this.balance) {
      throw new Error('INSUFFICIENT_BALANCE')
    }

    this.balance -= amountSats
    const payment = {
      invoice,
      amount: amountSats,
      timestamp: Date.now(),
      preimage: randomBytes(32).toString('hex')
    }
    this.payments.push(payment)
    this.emit('payment-sent', payment)
    return payment
  }

  async createInvoice (amountSats, memo = '') {
    if (!this.connected) throw new Error('Provider not connected')

    const bolt11 = 'lnbc' + amountSats + 'mock' + randomBytes(16).toString('hex')
    const invoice = {
      bolt11,
      amount: amountSats,
      memo,
      timestamp: Date.now()
    }
    this.invoices.push(invoice)
    this.emit('invoice-created', invoice)
    return invoice
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

  async disconnect () {
    this.connected = false
    this.emit('disconnected')
  }
}

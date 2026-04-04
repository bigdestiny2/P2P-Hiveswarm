/**
 * Payment Layer (Phase 2)
 *
 * Handles micropayments between app developers and relay operators.
 * Designed for Bitcoin Lightning Network but abstracted for other rails.
 *
 * This module provides the accounting and settlement logic.
 * Actual Lightning/payment integration is pluggable.
 */

import { EventEmitter } from 'events'

// Held-amount schedule (Storj-inspired)
// New relays have earnings held back, returned after 15 months of good standing
const HELD_SCHEDULE = [
  { monthStart: 1, monthEnd: 3, heldPct: 75 },
  { monthStart: 4, monthEnd: 6, heldPct: 50 },
  { monthStart: 7, monthEnd: 9, heldPct: 25 },
  { monthStart: 10, monthEnd: Infinity, heldPct: 0 }
]

const HELD_RETURN_MONTH = 15

export class PaymentManager extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.paymentProvider = opts.paymentProvider || null // Pluggable: Lightning, on-chain, etc.

    // Relay accounts: relayPubkeyHex -> PaymentAccount
    this.accounts = new Map()
  }

  /**
   * Register a new relay operator account
   */
  registerRelay (relayPubkeyHex, paymentAddress) {
    if (this.accounts.has(relayPubkeyHex)) return this.accounts.get(relayPubkeyHex)

    const account = {
      relayPubkey: relayPubkeyHex,
      paymentAddress,
      registeredAt: Date.now(),
      totalEarned: 0, // Total earned (before held amount)
      totalPaid: 0, // Total actually paid out
      totalHeld: 0, // Currently held
      heldReturned: 0, // Held amount returned
      monthsActive: 0,
      lastSettlement: null,
      ledger: [] // { timestamp, type, amount, description }
    }

    this.accounts.set(relayPubkeyHex, account)
    this.emit('relay-registered', { relay: relayPubkeyHex })
    return account
  }

  /**
   * Record earnings for a relay (from bandwidth receipts)
   */
  recordEarnings (relayPubkeyHex, amountSats, description = '') {
    const account = this.accounts.get(relayPubkeyHex)
    if (!account) throw new Error('Relay not registered')

    const heldPct = this._getHeldPercentage(account)
    const heldAmount = Math.floor(amountSats * heldPct / 100)
    const payableAmount = amountSats - heldAmount

    account.totalEarned += amountSats
    account.totalHeld += heldAmount

    account.ledger.push({
      timestamp: Date.now(),
      type: 'earning',
      amount: amountSats,
      held: heldAmount,
      payable: payableAmount,
      description
    })

    this.emit('earnings-recorded', {
      relay: relayPubkeyHex,
      amount: amountSats,
      held: heldAmount,
      payable: payableAmount
    })

    return { amountSats, heldAmount, payableAmount }
  }

  /**
   * Process settlement (pay out accumulated earnings)
   */
  async settle (relayPubkeyHex) {
    const account = this.accounts.get(relayPubkeyHex)
    if (!account) throw new Error('Relay not registered')

    const payable = account.totalEarned - account.totalPaid - account.totalHeld + account.heldReturned

    if (payable <= 0) {
      return { paid: 0, reason: 'nothing to settle' }
    }

    // Attempt payment via provider
    if (this.paymentProvider) {
      try {
        await this.paymentProvider.pay(account.paymentAddress, payable)
      } catch (err) {
        this.emit('settlement-failed', { relay: relayPubkeyHex, amount: payable, error: err.message })
        throw err
      }
    }

    account.totalPaid += payable
    account.lastSettlement = Date.now()

    account.ledger.push({
      timestamp: Date.now(),
      type: 'settlement',
      amount: payable,
      description: `Settlement of ${payable} sats`
    })

    this.emit('settlement-complete', { relay: relayPubkeyHex, amount: payable })
    return { paid: payable }
  }

  /**
   * Return held amounts for relays past the return threshold
   */
  processHeldReturns () {
    const now = Date.now()
    const returned = []

    for (const [pubkey, account] of this.accounts) {
      const monthsActive = Math.floor((now - account.registeredAt) / (30 * 24 * 3600 * 1000))
      account.monthsActive = monthsActive

      if (monthsActive >= HELD_RETURN_MONTH && account.totalHeld > account.heldReturned) {
        const toReturn = account.totalHeld - account.heldReturned
        account.heldReturned += toReturn

        account.ledger.push({
          timestamp: now,
          type: 'held-return',
          amount: toReturn,
          description: `Held amount returned after ${monthsActive} months`
        })

        returned.push({ relay: pubkey, amount: toReturn })
        this.emit('held-returned', { relay: pubkey, amount: toReturn })
      }
    }

    return returned
  }

  /**
   * Slash a relay's held amount (for provably bad behavior)
   */
  slash (relayPubkeyHex, amountSats, reason) {
    const account = this.accounts.get(relayPubkeyHex)
    if (!account) return

    const slashable = account.totalHeld - account.heldReturned
    const slashed = Math.min(amountSats, slashable)

    account.totalHeld -= slashed

    account.ledger.push({
      timestamp: Date.now(),
      type: 'slash',
      amount: -slashed,
      description: `Slashed: ${reason}`
    })

    this.emit('relay-slashed', { relay: relayPubkeyHex, amount: slashed, reason })
    return { slashed }
  }

  /**
   * Get account summary for a relay
   */
  getAccountSummary (relayPubkeyHex) {
    const account = this.accounts.get(relayPubkeyHex)
    if (!account) return null

    return {
      relay: account.relayPubkey,
      monthsActive: account.monthsActive,
      heldPercentage: this._getHeldPercentage(account),
      totalEarned: account.totalEarned,
      totalPaid: account.totalPaid,
      currentlyHeld: account.totalHeld - account.heldReturned,
      pendingPayout: account.totalEarned - account.totalPaid - account.totalHeld + account.heldReturned,
      lastSettlement: account.lastSettlement
    }
  }

  _getHeldPercentage (account) {
    const monthsActive = Math.floor((Date.now() - account.registeredAt) / (30 * 24 * 3600 * 1000)) + 1

    for (const tier of HELD_SCHEDULE) {
      if (monthsActive >= tier.monthStart && monthsActive <= tier.monthEnd) {
        return tier.heldPct
      }
    }
    return 0
  }

  /**
   * Pricing calculator
   */
  static calculatePrice (service, amount) {
    // Default rates (can be overridden by market)
    const RATES = {
      storage: 100, // sats per GB per month
      bandwidth: 50, // sats per GB transferred
      relay: 75, // sats per GB relayed
      availability: 10 // sats per hour of guaranteed uptime
    }

    const rate = RATES[service]
    if (!rate) throw new Error(`Unknown service: ${service}`)

    return Math.ceil(rate * amount)
  }
}

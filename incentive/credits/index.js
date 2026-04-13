/**
 * Credit Manager
 *
 * Manages app developer credit wallets on the HiveRelay network.
 * App devs buy credits (denominated in sats) via Lightning invoices.
 * Credits are deducted per service call based on the pricing engine.
 *
 * Everything operates FREE by default — the free tier is generous.
 * New wallets receive welcome credits (default 1,000 sats) automatically.
 * Developers can contact the relay operator for additional free credits.
 * Relay operators receive welcome credits when their node starts.
 *
 * Flow:
 *   1. App connects → gets free tier access immediately (no wallet needed)
 *   2. App requests wallet → auto-credited with welcome credits
 *   3. App buys more credits via Lightning invoice (optional)
 *   4. On each service call, router middleware deducts from wallet
 *   5. If balance hits zero, app falls back to free-tier limits (still works!)
 *
 * Persistence:
 *   Wallets are serialized to disk and restored on startup.
 *   In production, this would be backed by a proper database.
 */

import { EventEmitter } from 'events'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'

export class CreditManager extends EventEmitter {
  constructor (opts = {}) {
    super()
    // appPubkey -> Wallet
    this.wallets = new Map()
    this.storagePath = opts.storagePath || null
    this.minTopUp = opts.minTopUp || 100 // minimum 100 sats top-up
    this.maxBalance = opts.maxBalance || 100_000_000 // 1 BTC max balance
    this.bonusSchedule = opts.bonusSchedule || DEFAULT_BONUS_SCHEDULE
    this.welcomeCredits = opts.welcomeCredits != null ? opts.welcomeCredits : 1000
  }

  /**
   * Create or get a wallet for an app.
   */
  getOrCreateWallet (appPubkey) {
    let wallet = this.wallets.get(appPubkey)
    if (wallet) return wallet

    wallet = {
      appPubkey,
      balance: 0,
      totalDeposited: 0,
      totalSpent: 0,
      totalBonusReceived: 0,
      welcomeCreditsReceived: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      transactions: [],
      frozen: false
    }

    this.wallets.set(appPubkey, wallet)

    // Auto-credit welcome credits to new wallets
    if (this.welcomeCredits > 0) {
      wallet.balance += this.welcomeCredits
      wallet.welcomeCreditsReceived = this.welcomeCredits
      wallet.transactions.push({
        id: this._txId(),
        type: 'welcome',
        amount: this.welcomeCredits,
        balance: wallet.balance,
        timestamp: Date.now(),
        note: 'Welcome credits — everything starts free on HiveRelay'
      })
      this.emit('welcome-credits', { app: appPubkey, amount: this.welcomeCredits })
    }

    this.emit('wallet-created', { app: appPubkey, welcomeCredits: this.welcomeCredits })
    return wallet
  }

  /**
   * Credit an app's wallet (after Lightning invoice settlement).
   * Returns the actual amount credited (including any bonus).
   */
  topUp (appPubkey, amountSats, opts = {}) {
    if (amountSats < this.minTopUp) {
      throw new Error(`MIN_TOPUP: minimum top-up is ${this.minTopUp} sats`)
    }

    const wallet = this.getOrCreateWallet(appPubkey)

    if (wallet.frozen) {
      throw new Error('WALLET_FROZEN: wallet is frozen, contact support')
    }

    // Calculate volume bonus
    const bonus = this._calculateBonus(amountSats)
    const totalCredit = amountSats + bonus

    if (wallet.balance + totalCredit > this.maxBalance) {
      throw new Error(`MAX_BALANCE: would exceed maximum balance of ${this.maxBalance} sats`)
    }

    wallet.balance += totalCredit
    wallet.totalDeposited += amountSats
    wallet.totalBonusReceived += bonus
    wallet.lastActivity = Date.now()

    const tx = {
      id: this._txId(),
      type: 'deposit',
      amount: amountSats,
      bonus,
      totalCredit,
      balance: wallet.balance,
      timestamp: Date.now(),
      invoiceId: opts.invoiceId || null,
      paymentHash: opts.paymentHash || null
    }
    wallet.transactions.push(tx)

    this.emit('credit-added', {
      app: appPubkey,
      amount: amountSats,
      bonus,
      totalCredit,
      balance: wallet.balance
    })

    return tx
  }

  /**
   * Deduct credits for a service call.
   * Returns { success, cost, balance } or throws if insufficient.
   */
  deduct (appPubkey, costSats, route, meta = {}) {
    const wallet = this.wallets.get(appPubkey)
    if (!wallet) {
      return { success: false, reason: 'NO_WALLET', cost: costSats, balance: 0 }
    }

    if (wallet.frozen) {
      return { success: false, reason: 'WALLET_FROZEN', cost: costSats, balance: wallet.balance }
    }

    if (wallet.balance < costSats) {
      this.emit('insufficient-credits', {
        app: appPubkey,
        cost: costSats,
        balance: wallet.balance,
        route
      })
      return { success: false, reason: 'INSUFFICIENT_CREDITS', cost: costSats, balance: wallet.balance }
    }

    wallet.balance -= costSats
    wallet.totalSpent += costSats
    wallet.lastActivity = Date.now()

    const tx = {
      id: this._txId(),
      type: 'deduction',
      amount: -costSats,
      route,
      balance: wallet.balance,
      timestamp: Date.now(),
      meta
    }
    wallet.transactions.push(tx)

    // Trim transaction history to last 10000 entries
    if (wallet.transactions.length > 10000) {
      wallet.transactions = wallet.transactions.slice(-10000)
    }

    this.emit('credit-deducted', {
      app: appPubkey,
      cost: costSats,
      route,
      balance: wallet.balance
    })

    return { success: true, cost: costSats, balance: wallet.balance }
  }

  /**
   * Get wallet balance.
   */
  getBalance (appPubkey) {
    const wallet = this.wallets.get(appPubkey)
    if (!wallet) return 0
    return wallet.balance
  }

  /**
   * Get full wallet summary.
   */
  getWallet (appPubkey) {
    const wallet = this.wallets.get(appPubkey)
    if (!wallet) return null

    return {
      appPubkey: wallet.appPubkey,
      balance: wallet.balance,
      totalDeposited: wallet.totalDeposited,
      totalSpent: wallet.totalSpent,
      totalBonusReceived: wallet.totalBonusReceived,
      welcomeCreditsReceived: wallet.welcomeCreditsReceived || 0,
      frozen: wallet.frozen,
      createdAt: wallet.createdAt,
      lastActivity: wallet.lastActivity,
      transactionCount: wallet.transactions.length
    }
  }

  /**
   * Get transaction history (paginated).
   */
  getTransactions (appPubkey, opts = {}) {
    const wallet = this.wallets.get(appPubkey)
    if (!wallet) return { transactions: [], total: 0 }

    const limit = opts.limit || 50
    const offset = opts.offset || 0
    const txs = wallet.transactions.slice().reverse()

    return {
      transactions: txs.slice(offset, offset + limit),
      total: txs.length,
      limit,
      offset
    }
  }

  /**
   * Freeze a wallet (admin action — suspected abuse).
   */
  freezeWallet (appPubkey, reason) {
    const wallet = this.wallets.get(appPubkey)
    if (!wallet) throw new Error('NO_WALLET')
    wallet.frozen = true
    wallet.transactions.push({
      id: this._txId(),
      type: 'freeze',
      amount: 0,
      balance: wallet.balance,
      timestamp: Date.now(),
      reason
    })
    this.emit('wallet-frozen', { app: appPubkey, reason })
  }

  /**
   * Unfreeze a wallet.
   */
  unfreezeWallet (appPubkey) {
    const wallet = this.wallets.get(appPubkey)
    if (!wallet) throw new Error('NO_WALLET')
    wallet.frozen = false
    wallet.transactions.push({
      id: this._txId(),
      type: 'unfreeze',
      amount: 0,
      balance: wallet.balance,
      timestamp: Date.now()
    })
    this.emit('wallet-unfrozen', { app: appPubkey })
  }

  /**
   * Grant free credits to an app (operator/admin action).
   * Used when devs contact the relay operator to request credits.
   */
  grantCredits (appPubkey, amountSats, reason) {
    if (amountSats <= 0) throw new Error('INVALID_AMOUNT: must be positive')
    const wallet = this.getOrCreateWallet(appPubkey)

    if (wallet.frozen) {
      throw new Error('WALLET_FROZEN: wallet is frozen')
    }

    if (wallet.balance + amountSats > this.maxBalance) {
      throw new Error(`MAX_BALANCE: would exceed maximum balance of ${this.maxBalance} sats`)
    }

    wallet.balance += amountSats
    wallet.lastActivity = Date.now()

    const tx = {
      id: this._txId(),
      type: 'grant',
      amount: amountSats,
      balance: wallet.balance,
      timestamp: Date.now(),
      reason: reason || 'Operator credit grant'
    }
    wallet.transactions.push(tx)

    this.emit('credits-granted', {
      app: appPubkey,
      amount: amountSats,
      balance: wallet.balance,
      reason
    })

    return tx
  }

  /**
   * Check if an app has enough credits for a given cost.
   * Non-destructive check (no deduction).
   */
  canAfford (appPubkey, costSats) {
    const wallet = this.wallets.get(appPubkey)
    if (!wallet) return false
    if (wallet.frozen) return false
    return wallet.balance >= costSats
  }

  /**
   * Aggregate stats across all wallets.
   */
  stats () {
    let totalWallets = 0
    let totalBalance = 0
    let totalDeposited = 0
    let totalSpent = 0
    let totalWelcomeCredits = 0
    let frozenWallets = 0

    for (const wallet of this.wallets.values()) {
      totalWallets++
      totalBalance += wallet.balance
      totalDeposited += wallet.totalDeposited
      totalSpent += wallet.totalSpent
      totalWelcomeCredits += wallet.welcomeCreditsReceived || 0
      if (wallet.frozen) frozenWallets++
    }

    return {
      totalWallets,
      totalBalance,
      totalDeposited,
      totalSpent,
      totalWelcomeCredits,
      welcomeCreditsPerWallet: this.welcomeCredits,
      frozenWallets,
      avgBalance: totalWallets > 0 ? Math.floor(totalBalance / totalWallets) : 0
    }
  }

  /**
   * Persist wallets to disk.
   */
  async save () {
    if (!this.storagePath) return

    const data = {}
    for (const [key, wallet] of this.wallets) {
      data[key] = {
        ...wallet,
        // Only persist last 1000 transactions
        transactions: wallet.transactions.slice(-1000)
      }
    }

    try {
      await mkdir(dirname(this.storagePath), { recursive: true })
      await writeFile(this.storagePath, JSON.stringify(data, null, 2))
    } catch (err) {
      this.emit('save-error', { error: err.message })
    }
  }

  /**
   * Load wallets from disk.
   */
  async load () {
    if (!this.storagePath) return

    try {
      const raw = await readFile(this.storagePath, 'utf8')
      const data = JSON.parse(raw)
      for (const [key, wallet] of Object.entries(data)) {
        this.wallets.set(key, wallet)
      }
      this.emit('loaded', { wallets: this.wallets.size })
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.emit('load-error', { error: err.message })
      }
    }
  }

  /**
   * Calculate volume bonus for a deposit.
   * Bigger deposits get bonus credits — incentivizes bulk purchases.
   */
  _calculateBonus (amountSats) {
    for (let i = this.bonusSchedule.length - 1; i >= 0; i--) {
      const tier = this.bonusSchedule[i]
      if (amountSats >= tier.minDeposit) {
        return Math.floor(amountSats * tier.bonusPct / 100)
      }
    }
    return 0
  }

  _txId () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }
}

/**
 * Volume bonus schedule.
 * Bigger top-ups get bonus credits.
 */
const DEFAULT_BONUS_SCHEDULE = [
  { minDeposit: 10_000, bonusPct: 5 }, // 10k sats → 5% bonus
  { minDeposit: 100_000, bonusPct: 10 }, // 100k sats → 10% bonus
  { minDeposit: 1_000_000, bonusPct: 15 }, // 1M sats → 15% bonus
  { minDeposit: 10_000_000, bonusPct: 20 } // 10M sats → 20% bonus
]

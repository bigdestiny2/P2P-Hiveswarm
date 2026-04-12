import test from 'brittle'
import { CreditManager } from '../../incentive/credits/index.js'
import { PricingEngine } from '../../incentive/credits/pricing.js'
import { InvoiceManager } from '../../incentive/credits/invoice.js'
import { MockProvider } from '../../incentive/payment/mock-provider.js'
import { FreeTierManager } from '../../incentive/free-tier/index.js'
import { ServiceMeter } from '../../incentive/metering/index.js'

// ──────────────────────────────────────────────
// CreditManager Tests
// ──────────────────────────────────────────────

test('CreditManager — creates wallet on first access', async (t) => {
  const cm = new CreditManager()
  const wallet = cm.getOrCreateWallet('app-1')
  t.is(wallet.balance, 0)
  t.is(wallet.appPubkey, 'app-1')
  t.ok(wallet.createdAt > 0)
})

test('CreditManager — top-up adds credits', async (t) => {
  const cm = new CreditManager()
  const tx = cm.topUp('app-1', 5000)
  t.is(tx.amount, 5000)
  t.is(tx.type, 'deposit')
  t.is(cm.getBalance('app-1'), 5000)
})

test('CreditManager — top-up with volume bonus', async (t) => {
  const cm = new CreditManager()
  // 10k sats → 5% bonus = 500 sats bonus
  const tx = cm.topUp('app-1', 10_000)
  t.is(tx.amount, 10_000)
  t.is(tx.bonus, 500)
  t.is(tx.totalCredit, 10_500)
  t.is(cm.getBalance('app-1'), 10_500)
})

test('CreditManager — large deposit bonus tiers', async (t) => {
  const cm = new CreditManager()

  // 100k sats → 10% bonus
  const tx1 = cm.topUp('app-1', 100_000)
  t.is(tx1.bonus, 10_000)

  // 1M sats → 15% bonus
  const tx2 = cm.topUp('app-2', 1_000_000)
  t.is(tx2.bonus, 150_000)
})

test('CreditManager — deduct subtracts from balance', async (t) => {
  const cm = new CreditManager()
  cm.topUp('app-1', 1000)

  const result = cm.deduct('app-1', 100, 'ai.infer')
  t.is(result.success, true)
  t.is(result.cost, 100)
  t.is(result.balance, 900)
  t.is(cm.getBalance('app-1'), 900)
})

test('CreditManager — deduct fails on insufficient credits', async (t) => {
  const cm = new CreditManager()
  cm.topUp('app-1', 200)

  const result = cm.deduct('app-1', 500, 'ai.infer')
  t.is(result.success, false)
  t.is(result.reason, 'INSUFFICIENT_CREDITS')
  // Balance unchanged
  t.is(cm.getBalance('app-1'), 200)
})

test('CreditManager — deduct fails on no wallet', async (t) => {
  const cm = new CreditManager()
  const result = cm.deduct('unknown-app', 10, 'ai.infer')
  t.is(result.success, false)
  t.is(result.reason, 'NO_WALLET')
})

test('CreditManager — min top-up enforced', async (t) => {
  const cm = new CreditManager()
  try {
    cm.topUp('app-1', 10) // Below 100 sat minimum
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('MIN_TOPUP'))
  }
})

test('CreditManager — max balance enforced', async (t) => {
  const cm = new CreditManager({ maxBalance: 10_000 })
  cm.topUp('app-1', 8000)
  try {
    cm.topUp('app-1', 5000)
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('MAX_BALANCE'))
  }
})

test('CreditManager — freeze blocks deductions', async (t) => {
  const cm = new CreditManager()
  cm.topUp('app-1', 5000)
  cm.freezeWallet('app-1', 'suspected abuse')

  const result = cm.deduct('app-1', 100, 'ai.infer')
  t.is(result.success, false)
  t.is(result.reason, 'WALLET_FROZEN')
})

test('CreditManager — freeze blocks top-ups', async (t) => {
  const cm = new CreditManager()
  cm.topUp('app-1', 5000)
  cm.freezeWallet('app-1', 'suspected abuse')

  try {
    cm.topUp('app-1', 1000)
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('WALLET_FROZEN'))
  }
})

test('CreditManager — unfreeze restores access', async (t) => {
  const cm = new CreditManager()
  cm.topUp('app-1', 5000)
  cm.freezeWallet('app-1', 'test')
  cm.unfreezeWallet('app-1')

  const result = cm.deduct('app-1', 100, 'ai.infer')
  t.is(result.success, true)
})

test('CreditManager — canAfford check', async (t) => {
  const cm = new CreditManager()
  cm.topUp('app-1', 500)

  t.is(cm.canAfford('app-1', 500), true)
  t.is(cm.canAfford('app-1', 501), false)
  t.is(cm.canAfford('unknown', 1), false)
})

test('CreditManager — transaction history', async (t) => {
  const cm = new CreditManager()
  cm.topUp('app-1', 5000)
  cm.deduct('app-1', 100, 'ai.infer')
  cm.deduct('app-1', 50, 'ai.embed')

  const { transactions, total } = cm.getTransactions('app-1')
  t.is(total, 3) // 1 deposit + 2 deductions
  // Newest first
  t.is(transactions[0].type, 'deduction')
  t.is(transactions[0].route, 'ai.embed')
})

test('CreditManager — wallet summary', async (t) => {
  const cm = new CreditManager()
  cm.topUp('app-1', 5000)
  cm.deduct('app-1', 200, 'ai.infer')

  const wallet = cm.getWallet('app-1')
  t.is(wallet.balance, 4800)
  t.is(wallet.totalDeposited, 5000)
  t.is(wallet.totalSpent, 200)
  t.is(wallet.frozen, false)
})

test('CreditManager — stats aggregation', async (t) => {
  const cm = new CreditManager()
  cm.topUp('app-1', 5000)
  cm.topUp('app-2', 3000)
  cm.deduct('app-1', 200, 'ai.infer')

  const stats = cm.stats()
  t.is(stats.totalWallets, 2)
  t.is(stats.totalDeposited, 8000)
  t.is(stats.totalSpent, 200)
  t.is(stats.totalBalance, 7800)
})

test('CreditManager — events emitted', async (t) => {
  t.plan(4)
  const cm = new CreditManager()

  cm.on('wallet-created', () => t.pass('wallet-created'))
  cm.on('credit-added', (data) => {
    t.is(data.amount, 1000)
    t.is(data.balance, 1000)
  })
  cm.on('credit-deducted', () => t.pass('credit-deducted'))

  cm.topUp('app-1', 1000)
  cm.deduct('app-1', 10, 'ai.infer')
})

test('CreditManager — save and load', async (t) => {
  const path = '/tmp/hiverelay-test-credits-' + Date.now() + '.json'
  const cm1 = new CreditManager({ storagePath: path })
  cm1.topUp('app-1', 5000)
  cm1.deduct('app-1', 100, 'ai.infer')
  await cm1.save()

  const cm2 = new CreditManager({ storagePath: path })
  await cm2.load()
  t.is(cm2.getBalance('app-1'), 4900)
  t.is(cm2.getWallet('app-1').totalSpent, 100)
})

// ──────────────────────────────────────────────
// PricingEngine Tests
// ──────────────────────────────────────────────

test('PricingEngine — free routes cost zero', async (t) => {
  const pe = new PricingEngine()
  t.is(pe.isFree('ai.list-models'), true)
  t.is(pe.isFree('identity.verify'), true)
  t.is(pe.isFree('schema.validate'), true)

  const result = pe.calculate('ai.list-models')
  t.is(result.cost, 0)
})

test('PricingEngine — AI inference token-based pricing', async (t) => {
  const pe = new PricingEngine()

  // 1000 input tokens, 500 output tokens
  const result = pe.calculate('ai.infer', { inputTokens: 1000, outputTokens: 500 })

  // base: 1 sat + input: 1000 * 0.001 = 1 sat + output: 500 * 0.002 = 1 sat = 3 sats
  t.is(result.cost, 3)
  t.ok(result.breakdown.base)
  t.ok(result.breakdown.inputTokens)
  t.ok(result.breakdown.outputTokens)
})

test('PricingEngine — AI inference minimum per-call cost', async (t) => {
  const pe = new PricingEngine()

  // Even with 0 tokens, base cost is 1 sat
  const result = pe.calculate('ai.infer', {})
  t.is(result.cost, 1)
})

test('PricingEngine — embeddings pricing', async (t) => {
  const pe = new PricingEngine()

  const result = pe.calculate('ai.embed', { inputTokens: 2000 })
  // base: 1 (ceil of 0.5) + input: 2000 * 0.0005 = 1 sat = ceil(1.5) = 2
  t.is(result.cost, 2)
})

test('PricingEngine — compute with duration pricing', async (t) => {
  const pe = new PricingEngine()

  // 3 second compute job
  const result = pe.calculate('compute.submit', { durationMs: 3000 })
  // base: 10 sats + duration: 3000 * 0.001 = 3 sats = 13 sats
  t.is(result.cost, 13)
})

test('PricingEngine — compute max charge cap', async (t) => {
  const pe = new PricingEngine()

  // Very long compute job — should be capped
  const result = pe.calculate('compute.submit', { durationMs: 2_000_000 })
  t.is(result.cost, 1000) // maxCharge cap
  t.is(result.breakdown.capped, true)
})

test('PricingEngine — storage write with bytes', async (t) => {
  const pe = new PricingEngine()

  // Write 10KB
  const result = pe.calculate('storage.drive-write', { bytes: 10240 })
  // base: 1 sat + bytes: 10 * 0.01 = 0.1 sat = ceil(1.1) = 2
  t.is(result.cost, 2)
})

test('PricingEngine — operator margin multiplier', async (t) => {
  const pe = new PricingEngine({ margin: 1.5 })

  const result = pe.calculate('ai.infer', { inputTokens: 1000, outputTokens: 500 })
  // Normal: 3 sats, with 1.5x margin: ceil(4.5) = 5
  t.is(result.cost, 5)
})

test('PricingEngine — rate card returns all routes', async (t) => {
  const pe = new PricingEngine()
  const card = pe.getRateCard()
  t.ok(card['ai.infer'])
  t.ok(card['ai.embed'])
  t.ok(card['compute.submit'])
  t.ok(card['storage.drive-write'])
  t.ok(card['identity.sign'])
})

test('PricingEngine — comparison generates valid output', async (t) => {
  const pe = new PricingEngine()
  const comp = pe.getComparison(60000)
  t.is(comp.btcPriceUsd, 60000)
  t.ok(comp.services['ai.infer'])
  t.ok(comp.services['ai.infer'].hiverelay)
  t.ok(comp.services['ai.infer'].claude)
  t.ok(comp.services['ai.infer'].openai)
})

test('PricingEngine — batch estimation', async (t) => {
  const pe = new PricingEngine()
  const estimate = pe.estimate([
    { route: 'ai.infer', meta: { inputTokens: 1000, outputTokens: 500 } },
    { route: 'ai.embed', meta: { inputTokens: 500 } },
    { route: 'storage.drive-write', meta: { bytes: 1024 } }
  ])
  t.ok(estimate.total > 0)
  t.is(estimate.items.length, 3)
})

test('PricingEngine — unknown route charges 1 sat', async (t) => {
  const pe = new PricingEngine()
  const result = pe.calculate('custom.unknown-route')
  t.is(result.cost, 1)
})

test('PricingEngine — custom rate overrides', async (t) => {
  const pe = new PricingEngine({
    rates: {
      'ai.infer': { perCall: 5 } // Override base cost
    }
  })
  const result = pe.calculate('ai.infer', {})
  t.is(result.cost, 5)
})

// ──────────────────────────────────────────────
// InvoiceManager Tests
// ──────────────────────────────────────────────

test('InvoiceManager — create invoice', async (t) => {
  const provider = new MockProvider()
  await provider.connect()
  const cm = new CreditManager()
  const im = new InvoiceManager({ provider, creditManager: cm })

  const inv = await im.createInvoice('app-1', 10_000)
  t.ok(inv.id.startsWith('inv_'))
  t.ok(inv.bolt11.startsWith('lnbc'))
  t.is(inv.amount, 10_000)
  t.is(inv.status, 'pending')
  t.ok(inv.expiresAt > Date.now())

  im.stop()
})

test('InvoiceManager — settle invoice credits wallet', async (t) => {
  const provider = new MockProvider()
  await provider.connect()
  const cm = new CreditManager()
  const im = new InvoiceManager({ provider, creditManager: cm })

  const inv = await im.createInvoice('app-1', 10_000)
  const result = await im.settleInvoice(inv.id)

  t.is(result.status, 'settled')
  t.ok(result.creditTx)
  t.is(cm.getBalance('app-1'), 10_500) // 10k + 5% bonus

  im.stop()
})

test('InvoiceManager — double settle is idempotent', async (t) => {
  const provider = new MockProvider()
  await provider.connect()
  const cm = new CreditManager()
  const im = new InvoiceManager({ provider, creditManager: cm })

  const inv = await im.createInvoice('app-1', 5000)
  await im.settleInvoice(inv.id)
  const result2 = await im.settleInvoice(inv.id)

  t.is(result2.alreadySettled, true)
  t.is(cm.getBalance('app-1'), 5000) // No double credit

  im.stop()
})

test('InvoiceManager — cancel invoice', async (t) => {
  const provider = new MockProvider()
  await provider.connect()
  const im = new InvoiceManager({ provider })

  const inv = await im.createInvoice('app-1', 5000)
  const result = im.cancelInvoice(inv.id)
  t.is(result.status, 'cancelled')

  // Cannot settle cancelled invoice
  try {
    await im.settleInvoice(inv.id)
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('NOT_PENDING'))
  }

  im.stop()
})

test('InvoiceManager — expired invoices', async (t) => {
  const provider = new MockProvider()
  await provider.connect()
  const im = new InvoiceManager({ provider, expiryMs: 1 }) // 1ms expiry

  const inv = await im.createInvoice('app-1', 5000)

  // Wait for expiry
  await new Promise(resolve => setTimeout(resolve, 10))
  im._expirePending()

  const status = im.getInvoice(inv.id)
  t.is(status.status, 'expired')

  im.stop()
})

test('InvoiceManager — minimum invoice amount', async (t) => {
  const provider = new MockProvider()
  await provider.connect()
  const im = new InvoiceManager({ provider })

  try {
    await im.createInvoice('app-1', 50) // Below 100 sat minimum
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('MIN_AMOUNT'))
  }

  im.stop()
})

test('InvoiceManager — get app invoices', async (t) => {
  const provider = new MockProvider()
  await provider.connect()
  const im = new InvoiceManager({ provider })

  await im.createInvoice('app-1', 1000)
  await im.createInvoice('app-1', 2000)
  await im.createInvoice('app-2', 3000)

  const app1Invoices = im.getAppInvoices('app-1')
  t.is(app1Invoices.length, 2)

  const app2Invoices = im.getAppInvoices('app-2')
  t.is(app2Invoices.length, 1)

  im.stop()
})

test('InvoiceManager — stats', async (t) => {
  const provider = new MockProvider()
  await provider.connect()
  const cm = new CreditManager()
  const im = new InvoiceManager({ provider, creditManager: cm })

  await im.createInvoice('app-1', 5000)
  const inv2 = await im.createInvoice('app-1', 10_000)
  await im.settleInvoice(inv2.id)

  const stats = im.stats()
  t.is(stats.total, 2)
  t.is(stats.pending, 1)
  t.is(stats.settled, 1)
  t.is(stats.totalSettledSats, 10_000)

  im.stop()
})

test('InvoiceManager — events', async (t) => {
  t.plan(2)
  const provider = new MockProvider()
  await provider.connect()
  const cm = new CreditManager()
  const im = new InvoiceManager({ provider, creditManager: cm })

  im.on('invoice-created', (data) => t.ok(data.id))
  im.on('invoice-settled', (data) => t.is(data.amount, 5000))

  const inv = await im.createInvoice('app-1', 5000)
  await im.settleInvoice(inv.id)

  im.stop()
})

// ──────────────────────────────────────────────
// Integration: Credits + FreeTier + Metering
// ──────────────────────────────────────────────

test('Integration — apps with credits auto-promote to standard tier', async (t) => {
  const cm = new CreditManager()
  cm.topUp('paid-app', 10_000)

  const ft = new FreeTierManager({ creditManager: cm })

  // paid-app should be standard (has credits)
  t.is(ft.getTier('paid-app'), 'standard')
  // unknown app should be free
  t.is(ft.getTier('free-app'), 'free')
})

test('Integration — app falls to free tier when credits depleted', async (t) => {
  const cm = new CreditManager()
  cm.topUp('app-1', 200)

  const ft = new FreeTierManager({ creditManager: cm })
  t.is(ft.getTier('app-1'), 'standard')

  // Deplete credits
  cm.deduct('app-1', 200, 'ai.infer')
  t.is(cm.getBalance('app-1'), 0)
  t.is(ft.getTier('app-1'), 'free')
})

test('Integration — full credit purchase flow', async (t) => {
  // 1. Create provider + credit manager + invoice manager
  const provider = new MockProvider()
  await provider.connect()
  const cm = new CreditManager()
  const im = new InvoiceManager({ provider, creditManager: cm })

  // 2. App requests invoice to buy credits
  const invoice = await im.createInvoice('app-1', 100_000)
  t.ok(invoice.bolt11)
  t.is(cm.getBalance('app-1'), 0) // Not credited yet

  // 3. App pays invoice externally, settlement detected
  await im.settleInvoice(invoice.id)

  // 4. Credits in wallet (100k + 10% bonus = 110k)
  t.is(cm.getBalance('app-1'), 110_000)

  // 5. App makes service calls, credits deducted
  const pricing = new PricingEngine()
  const price = pricing.calculate('ai.infer', { inputTokens: 2000, outputTokens: 1000 })
  const deduction = cm.deduct('app-1', price.cost, 'ai.infer')
  t.is(deduction.success, true)
  t.ok(cm.getBalance('app-1') < 110_000)

  im.stop()
})

test('Integration — metering + pricing + credits end-to-end', async (t) => {
  const cm = new CreditManager()
  cm.topUp('app-1', 50_000)

  const meter = new ServiceMeter()
  const pricing = new PricingEngine()
  const ft = new FreeTierManager({ creditManager: cm })

  // Simulate router middleware for 10 AI inference calls
  for (let i = 0; i < 10; i++) {
    const appKey = 'app-1'
    const route = 'ai.infer'
    const meta = { inputTokens: 500, outputTokens: 200 }

    // Check quota
    const quota = ft.check(appKey, route, meter)
    t.is(quota.allowed, true)

    // Calculate cost
    const price = pricing.calculate(route, meta)
    t.ok(price.cost > 0)

    // Deduct credits
    const deduction = cm.deduct(appKey, price.cost, route)
    t.is(deduction.success, true)

    // Record usage
    meter.record(appKey, route)
  }

  const usage = meter.getUsage('app-1')
  t.is(usage.totalCalls, 10)
  // Started with 50k + 5% bonus = 52,500. Should have spent some on 10 calls.
  t.ok(cm.getBalance('app-1') < 52_500)
  t.ok(cm.getBalance('app-1') > 0)
})

// ──────────────────────────────────────────────
// MockProvider enhancements
// ──────────────────────────────────────────────

test('MockProvider — lookupInvoice', async (t) => {
  const provider = new MockProvider()
  await provider.connect()

  const inv = await provider.createInvoice(5000, 'test')
  const lookup1 = await provider.lookupInvoice(inv.rHash)
  t.is(lookup1.settled, false)

  provider.settleInvoice(inv.rHash)
  const lookup2 = await provider.lookupInvoice(inv.rHash)
  t.is(lookup2.settled, true)
})

test('MockProvider — lookupInvoice unknown hash', async (t) => {
  const provider = new MockProvider()
  await provider.connect()

  const result = await provider.lookupInvoice('nonexistent')
  t.is(result, null)
})

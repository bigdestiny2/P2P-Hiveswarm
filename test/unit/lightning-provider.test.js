import test from 'brittle'
import { MockProvider } from 'p2p-hiverelay/incentive/payment/mock-provider.js'
import { PaymentManager } from 'p2p-hiverelay/incentive/payment/index.js'

// ─── MockProvider tests ────────────────────────────────────────────

test('MockProvider - connect and disconnect', async (t) => {
  const provider = new MockProvider()
  t.is(provider.connected, false, 'starts disconnected')

  await provider.connect()
  t.is(provider.connected, true, 'connected')

  await provider.disconnect()
  t.is(provider.connected, false, 'disconnected')
})

test('MockProvider - pay records payment and deducts balance', async (t) => {
  const provider = new MockProvider({ balance: 10000 })
  await provider.connect()

  const result = await provider.pay('lnbc1000...', 500)
  t.is(result.amount, 500, 'payment amount correct')
  t.ok(result.preimage, 'has preimage')
  t.is(provider.balance, 9500, 'balance deducted')
  t.is(provider.payments.length, 1, 'payment recorded')
})

test('MockProvider - pay fails on insufficient balance', async (t) => {
  const provider = new MockProvider({ balance: 100 })
  await provider.connect()

  try {
    await provider.pay('lnbc...', 500)
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('INSUFFICIENT_BALANCE'), 'correct error')
  }
})

test('MockProvider - pay fails when failNext is set', async (t) => {
  const provider = new MockProvider()
  await provider.connect()

  provider.failNext = true
  try {
    await provider.pay('lnbc...', 100)
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('MOCK_PAYMENT_FAILED'), 'simulated failure')
  }

  // Next payment should succeed
  const result = await provider.pay('lnbc...', 100)
  t.is(result.amount, 100, 'second payment succeeded')
})

test('MockProvider - createInvoice returns bolt11', async (t) => {
  const provider = new MockProvider()
  await provider.connect()

  const invoice = await provider.createInvoice(1000, 'test memo')
  t.ok(invoice.bolt11.startsWith('lnbc'), 'bolt11 format')
  t.is(invoice.amount, 1000, 'correct amount')
  t.is(invoice.memo, 'test memo', 'correct memo')
  t.is(provider.invoices.length, 1, 'invoice recorded')
})

test('MockProvider - getBalance returns configured balance', async (t) => {
  const provider = new MockProvider({ balance: 50000 })
  await provider.connect()

  const balance = await provider.getBalance()
  t.is(balance.confirmed, 50000, 'correct balance')
  t.is(balance.unconfirmed, 0, 'no unconfirmed')
})

test('MockProvider - getInfo returns node info', async (t) => {
  const provider = new MockProvider()
  await provider.connect()

  const info = await provider.getInfo()
  t.ok(info.pubkey, 'has pubkey')
  t.is(info.alias, 'mock-node', 'correct alias')
  t.ok(info.channels, 'has channels')
})

test('MockProvider - throws when not connected', async (t) => {
  const provider = new MockProvider()

  try {
    await provider.pay('lnbc...', 100)
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('not connected'), 'correct error')
  }
})

// ─── PaymentManager + MockProvider integration ─────────────────────

test('PaymentManager + MockProvider - full settlement flow', async (t) => {
  const provider = new MockProvider({ balance: 100_000 })
  await provider.connect()

  const pm = new PaymentManager({ paymentProvider: provider })

  // Register a relay that's been active for 10+ months (0% hold)
  const relay = 'a'.repeat(64)
  const account = pm.registerRelay(relay, 'lnbc_payment_addr')
  // Backdate registration to 10 months ago
  account.registeredAt = Date.now() - (10 * 30 * 24 * 3600 * 1000)

  // Record some earnings
  const earning = pm.recordEarnings(relay, 5000, 'bandwidth fees')
  t.is(earning.amountSats, 5000, 'earned 5000 sats')
  t.is(earning.heldAmount, 0, 'no hold after month 10')
  t.is(earning.payableAmount, 5000, 'all payable')

  // Settle
  const settlement = await pm.settle(relay)
  t.is(settlement.paid, 5000, 'paid 5000 sats')

  // Verify provider state
  t.is(provider.payments.length, 1, 'one payment made')
  t.is(provider.payments[0].amount, 5000, 'correct payment amount')
  t.is(provider.balance, 95000, 'provider balance reduced')

  // Settle again — nothing to pay
  const settlement2 = await pm.settle(relay)
  t.is(settlement2.paid, 0, 'nothing to settle')

  await provider.disconnect()
})

test('PaymentManager + MockProvider - settlement failure and retry', async (t) => {
  const provider = new MockProvider({ balance: 100_000 })
  await provider.connect()

  const pm = new PaymentManager({ paymentProvider: provider })
  const relay = 'b'.repeat(64)
  const account = pm.registerRelay(relay, 'lnbc_addr')
  account.registeredAt = Date.now() - (10 * 30 * 24 * 3600 * 1000)

  pm.recordEarnings(relay, 3000, 'relay fees')

  // Make first attempt fail
  provider.failNext = true
  try {
    await pm.settle(relay)
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('MOCK_PAYMENT_FAILED'), 'settlement failed')
  }

  // Verify nothing was paid
  const summary = pm.getAccountSummary(relay)
  t.is(summary.totalPaid, 0, 'nothing paid yet')

  // Retry should succeed
  const result = await pm.settle(relay)
  t.is(result.paid, 3000, 'retry succeeded')
  t.is(provider.payments.length, 1, 'one successful payment')

  await provider.disconnect()
})

test('PaymentManager + MockProvider - ledger records match payments', async (t) => {
  const provider = new MockProvider({ balance: 100_000 })
  await provider.connect()

  const pm = new PaymentManager({ paymentProvider: provider })
  const relay = 'c'.repeat(64)
  const account = pm.registerRelay(relay, 'lnbc_addr')
  account.registeredAt = Date.now() - (10 * 30 * 24 * 3600 * 1000)

  pm.recordEarnings(relay, 2000, 'storage')
  pm.recordEarnings(relay, 3000, 'bandwidth')
  await pm.settle(relay)

  const ledger = account.ledger
  t.is(ledger.length, 3, '2 earnings + 1 settlement')
  t.is(ledger[0].type, 'earning', 'first is earning')
  t.is(ledger[0].amount, 2000, 'first earning amount')
  t.is(ledger[1].type, 'earning', 'second is earning')
  t.is(ledger[1].amount, 3000, 'second earning amount')
  t.is(ledger[2].type, 'settlement', 'third is settlement')
  t.is(ledger[2].amount, 5000, 'settlement = sum of earnings')

  await provider.disconnect()
})

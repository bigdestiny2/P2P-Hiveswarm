import test from 'brittle'
import { PaymentManager } from 'p2p-hiverelay/incentive/payment/index.js'

test('PaymentManager - register and record earnings', async (t) => {
  const pm = new PaymentManager()
  pm.registerRelay('relay-1', 'lnbc1...')

  const result = pm.recordEarnings('relay-1', 1000, 'bandwidth')

  // Month 1: 75% held
  t.is(result.amountSats, 1000)
  t.is(result.heldAmount, 750)
  t.is(result.payableAmount, 250)
})

test('PaymentManager - held amount decreases over time', async (t) => {
  const pm = new PaymentManager()

  // Simulate a relay registered 5 months ago
  const account = pm.registerRelay('relay-2', 'lnbc2...')
  account.registeredAt = Date.now() - (5 * 30 * 24 * 3600 * 1000) // 5 months ago

  const result = pm.recordEarnings('relay-2', 1000, 'bandwidth')

  // Month 5: 50% held
  t.is(result.heldAmount, 500)
  t.is(result.payableAmount, 500)
})

test('PaymentManager - no hold after month 10', async (t) => {
  const pm = new PaymentManager()

  const account = pm.registerRelay('relay-3', 'lnbc3...')
  account.registeredAt = Date.now() - (11 * 30 * 24 * 3600 * 1000) // 11 months ago

  const result = pm.recordEarnings('relay-3', 1000, 'bandwidth')

  t.is(result.heldAmount, 0)
  t.is(result.payableAmount, 1000)
})

test('PaymentManager - slash reduces held amount', async (t) => {
  const pm = new PaymentManager()
  pm.registerRelay('relay-4', 'lnbc4...')

  pm.recordEarnings('relay-4', 1000, 'bandwidth')
  // 750 held

  const slash = pm.slash('relay-4', 500, 'served bad data')
  t.is(slash.slashed, 500)
})

test('PaymentManager - settlement calculation', async (t) => {
  const pm = new PaymentManager()

  const account = pm.registerRelay('relay-5', 'lnbc5...')
  account.registeredAt = Date.now() - (12 * 30 * 24 * 3600 * 1000) // no held amount

  pm.recordEarnings('relay-5', 5000, 'bandwidth')

  const summary = pm.getAccountSummary('relay-5')
  t.is(summary.totalEarned, 5000)
  t.is(summary.pendingPayout, 5000)
})

test('PaymentManager - pricing calculator', async (t) => {
  const storagePrice = PaymentManager.calculatePrice('storage', 10) // 10 GB
  t.ok(storagePrice > 0, 'storage has a price')

  const bwPrice = PaymentManager.calculatePrice('bandwidth', 5) // 5 GB
  t.ok(bwPrice > 0, 'bandwidth has a price')

  t.exception(() => PaymentManager.calculatePrice('invalid', 1), 'throws for unknown service')
})

/**
 * Contract tests for the formalized PaymentProvider interface and the
 * selectProvider helper. The existing LightningProvider and MockProvider
 * are duck-typed; this test pins the new base class's shape so that any
 * future provider (Tether over Lightning, Tether Wallet SDK, etc.)
 * inherits a consistent contract.
 */

import test from 'brittle'
import { PaymentProvider, selectProvider } from 'p2p-hiverelay/incentive/payment/provider.js'

test('PaymentProvider: base class throws on abstract methods', async (t) => {
  const p = new PaymentProvider()
  try { await p.connect(); t.fail('connect should throw') } catch (err) { t.ok(err.message.includes('connect')) }
  try { await p.pay('x', 100); t.fail('pay should throw') } catch (err) { t.ok(err.message.includes('pay')) }
  try { await p.createInvoice(100); t.fail('createInvoice should throw') } catch (err) { t.ok(err.message.includes('createInvoice')) }
  try { await p.getInvoiceStatus('r'); t.fail('getInvoiceStatus should throw') } catch (err) { t.ok(err.message.includes('getInvoiceStatus')) }
})

test('PaymentProvider: default capabilities shape', (t) => {
  const p = new PaymentProvider()
  const caps = p.capabilities()
  t.is(caps.name, 'PaymentProvider')
  t.alike(caps.assets, ['BTC'], 'BTC default asset for back-compat')
  t.alike(caps.rails, ['lightning'])
  t.is(caps.micropayments, true)
  t.is(caps.topUpModel, false)
  t.is(caps.connected, false)
})

// Minimal fakes to exercise selectProvider without touching real backends.
function makeFake (opts) {
  const p = new PaymentProvider()
  p.connected = opts.connected !== false
  p.capabilities = () => ({
    name: opts.name || 'fake',
    assets: opts.assets || ['BTC'],
    rails: opts.rails || ['lightning'],
    micropayments: opts.micropayments !== false,
    topUpModel: !!opts.topUpModel,
    connected: p.connected
  })
  return p
}

test('selectProvider: returns null when no provider supports the asset', (t) => {
  const btcOnly = makeFake({ name: 'btc', assets: ['BTC'] })
  const picked = selectProvider([btcOnly], { asset: 'USDT' })
  t.is(picked, null)
})

test('selectProvider: skips disconnected providers', (t) => {
  const disconnected = makeFake({ name: 'down', connected: false })
  const up = makeFake({ name: 'up' })
  const picked = selectProvider([disconnected, up], { asset: 'BTC' })
  t.is(picked.capabilities().name, 'up')
})

test('selectProvider: prefers micropayment-friendly provider for small amounts', (t) => {
  const ln = makeFake({ name: 'lightning', assets: ['BTC', 'USDT'], rails: ['lightning'], micropayments: true })
  const walletSdk = makeFake({ name: 'wallet', assets: ['USDT'], rails: ['wallet-sdk'], micropayments: false, topUpModel: true })

  // 5-cent call → micropayment path
  const smallPick = selectProvider([walletSdk, ln], { asset: 'USDT', amountUsd: 0.05 })
  t.is(smallPick.capabilities().name, 'lightning', 'micropayment-friendly provider wins')

  // $10 call → either is fine; we pick the first supporting one (wallet first in list)
  const largePick = selectProvider([walletSdk, ln], { asset: 'USDT', amountUsd: 10 })
  t.is(largePick.capabilities().name, 'wallet', 'top-up model OK for larger amount')
})

test('selectProvider: honors explicit rail requirement', (t) => {
  const ln = makeFake({ name: 'lightning', assets: ['USDT'], rails: ['lightning'] })
  const wallet = makeFake({ name: 'wallet', assets: ['USDT'], rails: ['wallet-sdk'], micropayments: false, topUpModel: true })
  const picked = selectProvider([ln, wallet], { asset: 'USDT', rail: 'wallet-sdk' })
  t.is(picked.capabilities().name, 'wallet', 'rail filter overrides micropayment preference')
})

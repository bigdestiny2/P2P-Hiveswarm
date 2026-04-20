/**
 * LND Lightning Payment Provider
 *
 * Connects to an LND node via gRPC to handle real Lightning payments.
 * Plugs into the PaymentManager for settlement of relay earnings.
 *
 * Requires:
 *   - Running LND node with gRPC enabled
 *   - Admin macaroon for payment operations
 *   - TLS certificate for secure connection
 */

import { EventEmitter } from 'events'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

export class LightningProvider extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.rpcUrl = opts.rpcUrl || 'localhost:10009'
    this.macaroonPath = opts.macaroonPath || null
    this.certPath = opts.certPath || null
    this.timeout = opts.timeout || 30_000
    this.network = opts.network || 'mainnet'
    this.client = null
    this.connected = false
  }

  async connect () {
    const grpc = await import('@grpc/grpc-js')
    const protoLoader = await import('@grpc/proto-loader')

    // Load LND proto definition
    // LND ships rpc.proto — we use the google proto path convention
    const protoPath = this._resolveProtoPath()

    const packageDef = protoLoader.loadSync(protoPath, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true
    })

    const lnrpc = grpc.loadPackageDefinition(packageDef).lnrpc

    // Build credentials
    const certData = this.certPath ? readFileSync(this.certPath) : null
    const sslCreds = certData
      ? grpc.credentials.createSsl(certData)
      : grpc.credentials.createInsecure()

    const macaroonData = this.macaroonPath
      ? readFileSync(this.macaroonPath).toString('hex')
      : null

    let creds = sslCreds
    if (macaroonData) {
      const macaroonCreds = grpc.credentials.createFromMetadataGenerator(
        (_, cb) => {
          const metadata = new grpc.Metadata()
          metadata.add('macaroon', macaroonData)
          cb(null, metadata)
        }
      )
      creds = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds)
    }

    this.client = new lnrpc.Lightning(this.rpcUrl, creds)

    // Verify connection
    await this._call('getInfo', {})
    this.connected = true
    this.emit('connected')
  }

  async pay (invoice, amount, opts = {}) {
    if (!this.connected) throw new Error('Provider not connected')

    const asset = opts.asset || 'BTC'
    if (asset !== 'BTC' && !this._taprootAssetsEnabled) {
      // USDt-over-Lightning lives on Taproot Assets. This provider doesn't
      // ship that integration yet; flag it clearly rather than silently
      // paying a BTC invoice. Wire in tapd/litd here when we integrate.
      throw new Error(
        `LightningProvider: asset '${asset}' requires Taproot Assets support ` +
        '(not yet enabled). Pay via BTC or use a provider that supports this asset.'
      )
    }

    const request = { paymentRequest: invoice }
    if (amount) request.amt = amount

    const response = await this._call('sendPaymentSync', request)

    if (response.paymentError) {
      const err = new Error(`Payment failed: ${response.paymentError}`)
      this.emit('payment-failed', { invoice, error: response.paymentError })
      throw err
    }

    const result = {
      invoice,
      amount,
      asset,
      preimage: response.paymentPreimage
        ? Buffer.from(response.paymentPreimage).toString('hex')
        : null,
      timestamp: Date.now()
    }

    this.emit('payment-sent', result)
    return result
  }

  async createInvoice (amount, memo = '', opts = {}) {
    if (!this.connected) throw new Error('Provider not connected')

    const asset = opts.asset || 'BTC'
    if (asset !== 'BTC' && !this._taprootAssetsEnabled) {
      throw new Error(
        `LightningProvider: asset '${asset}' invoice requires Taproot Assets support ` +
        '(not yet enabled).'
      )
    }

    const response = await this._call('addInvoice', {
      value: amount,
      memo
    })

    const result = {
      bolt11: response.paymentRequest,
      amount,
      asset,
      memo,
      rHash: response.rHash
        ? Buffer.from(response.rHash).toString('hex')
        : null,
      timestamp: Date.now()
    }

    this.emit('invoice-created', result)
    return result
  }

  /**
   * Advertise what this provider can do. Supports the new selectProvider()
   * helper in `./provider.js`. If/when Taproot Assets is wired in,
   * this will surface 'USDT' in `assets`.
   */
  capabilities () {
    return {
      name: 'LightningProvider',
      assets: this._taprootAssetsEnabled ? ['BTC', 'USDT'] : ['BTC'],
      rails: ['lightning'],
      micropayments: true,
      topUpModel: false,
      connected: this.connected
    }
  }

  async getBalance () {
    if (!this.connected) throw new Error('Provider not connected')

    const response = await this._call('channelBalance', {})
    return {
      confirmed: Number(response.balance || 0),
      unconfirmed: Number(response.pendingOpenBalance || 0)
    }
  }

  async getInfo () {
    if (!this.connected) throw new Error('Provider not connected')

    const response = await this._call('getInfo', {})
    return {
      pubkey: response.identityPubkey,
      alias: response.alias,
      channels: {
        active: response.numActiveChannels,
        inactive: response.numInactiveChannels,
        pending: response.numPendingChannels
      },
      blockHeight: response.blockHeight
    }
  }

  async disconnect () {
    if (this.client) {
      this.client.close()
      this.client = null
    }
    this.connected = false
    this.emit('disconnected')
  }

  /**
   * Promisify a gRPC unary call with timeout.
   */
  _call (method, request) {
    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + this.timeout)
      this.client[method](request, { deadline }, (err, response) => {
        if (err) reject(err)
        else resolve(response)
      })
    })
  }

  /**
   * Resolve the LND proto file path.
   * Looks for a bundled proto or falls back to a well-known location.
   */
  _resolveProtoPath () {
    // Check bundled proto first
    const bundled = join(dirname(fileURLToPath(import.meta.url)), 'lnrpc', 'lightning.proto')
    if (existsSync(bundled)) return bundled

    // Common LND install locations
    const candidates = [
      join(process.env.HOME || '', '.lnd', 'rpc.proto'),
      '/usr/local/share/lnd/rpc.proto',
      join(process.env.GOPATH || '', 'src', 'github.com', 'lightningnetwork', 'lnd', 'lnrpc', 'lightning.proto')
    ]

    for (const p of candidates) {
      if (existsSync(p)) return p
    }

    throw new Error(
      'LND proto file not found. Set GOPATH or place lightning.proto in ' +
      dirname(fileURLToPath(import.meta.url)) + '/lnrpc/'
    )
  }
}

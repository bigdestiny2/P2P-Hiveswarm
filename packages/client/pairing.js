/**
 * Pairing-over-swarm protocol for HiveRelay clients.
 *
 * Lets a user pair a second device by entering a short numeric code,
 * with no QR-code scanning or manual bundle copy required.
 *
 *   // Device A
 *   const { code } = await client.createPairingCode()
 *   // displays "123456" to the user
 *
 *   // Device B
 *   const result = await client.claimPairingCode('123456')
 *   // result.ok === true; client now uses the same identity as Device A
 *
 * Wire protocol — a Protomux channel `hiverelay-pair`. Every message in
 * the channel is a single length-prefixed UTF-8 JSON blob (Protomux
 * already gives us length framing per message; we just JSON-encode the
 * payload). The channel only opens when both ends have decided to
 * participate in pairing — non-pair connections (drives, relays, etc.)
 * silently ignore the protocol.
 *
 *   1. A → B   { type: 'challenge', nonce: <hex 32 bytes> }
 *   2. B → A   { type: 'challenge', nonce: <hex 32 bytes> }
 *   3. B → A   { type: 'proof', proof: HMAC-SHA256(code, A.nonce) }
 *   4. A → B   { type: 'proof', proof: HMAC-SHA256(code, B.nonce) }
 *   5. A → B   { type: 'identity', bundle: <exportIdentity()> }
 *   6. B → A   { type: 'ack' }
 *
 * The pair code itself is NEVER sent over the wire — only HMAC proofs.
 * The Hyperswarm Noise XK channel encrypts everything end-to-end, so
 * the relay (and any DHT peer that happens to learn the topic) cannot
 * read the bundle. The 32-byte topic is BLAKE2b(code) which still leaks
 * one bit of code-existence to anyone who guesses the topic — see
 * SECURITY NOTES at the bottom of this file.
 */

import b4a from 'b4a'
import sodium from 'sodium-universal'
import crypto from 'crypto'
import Protomux from 'protomux'
import c from 'compact-encoding'

export const PAIR_PROTOCOL = 'hiverelay-pair'
export const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes
export const DEFAULT_CLAIM_TIMEOUT_MS = 30_000 // 30 seconds
export const CODE_DIGITS = 6
export const MAX_FRAME_BYTES = 64 * 1024 // bundle is small (~200 bytes); cap frames

/**
 * Hash a pair code to a 32-byte swarm topic.
 *
 * @param {string} code
 * @returns {Buffer}
 */
export function deriveTopic (code) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.from('hiverelay-pair:' + code, 'utf8'))
  return out
}

/**
 * HMAC-SHA256 of a nonce keyed by the pair code.
 */
export function proofFor (code, nonce) {
  const h = crypto.createHmac('sha256', b4a.from(code, 'utf8'))
  h.update(nonce)
  return h.digest()
}

/**
 * Cryptographically random zero-padded numeric code, uniform over
 * 0..10**digits-1.
 */
export function generateCode (digits = CODE_DIGITS) {
  const max = Math.pow(10, digits)
  // 4 bytes = 32-bit unsigned. Reject above largest multiple of `max` to
  // keep the distribution uniform.
  const limit = Math.floor(0xffffffff / max) * max
  let n
  do {
    const buf = crypto.randomBytes(4)
    n = buf.readUInt32BE(0)
  } while (n >= limit)
  return String(n % max).padStart(digits, '0')
}

// JSON-over-bytes Protomux message encoding. Protomux already length-
// prefixes each message, so we wrap a UTF-8 JSON blob in c.string. The
// payload is small (<300 bytes for our protocol) so double-serializing
// in preencode/encode is cheap.
const jsonEncoding = {
  preencode (state, msg) {
    c.string.preencode(state, JSON.stringify(msg))
  },
  encode (state, msg) {
    c.string.encode(state, JSON.stringify(msg))
  },
  decode (state) {
    const s = c.string.decode(state)
    if (s.length > MAX_FRAME_BYTES) throw new Error('frame too large')
    return JSON.parse(s)
  }
}

/**
 * Build a pair-protocol Protomux channel on `conn` and return a
 * { send, recv, close } facade. recv() returns the next inbound
 * message or null on close. Returns null if a channel for this
 * protocol is already open on the conn.
 */
function openPairChannel (conn) {
  const mux = Protomux.from(conn)
  if (mux.opened({ protocol: PAIR_PROTOCOL })) return null

  const inbox = []
  let waiter = null
  let closed = false

  const deliver = (msg) => {
    if (waiter) {
      const w = waiter
      waiter = null
      w.resolve(msg)
    } else {
      inbox.push(msg)
    }
  }

  const failClose = () => {
    if (closed) return
    closed = true
    if (waiter) {
      const w = waiter
      waiter = null
      w.resolve(null)
    }
  }

  const channel = mux.createChannel({
    protocol: PAIR_PROTOCOL,
    id: null,
    onopen: () => {},
    onclose: () => failClose(),
    ondestroy: () => failClose()
  })
  if (!channel) return null

  const msg = channel.addMessage({
    encoding: jsonEncoding,
    onmessage: (m) => deliver(m)
  })

  channel.open()

  return {
    channel,
    send (m) {
      if (closed) return false
      try {
        msg.send(m)
        return true
      } catch (err) {
        failClose()
        return false
      }
    },
    async recv () {
      if (inbox.length) return inbox.shift()
      if (closed) return null
      return new Promise((resolve) => { waiter = { resolve } })
    },
    close () {
      try { channel.close() } catch (_) {}
      failClose()
    }
  }
}

/**
 * PairingManager — owns per-client pairing state.
 *
 * Attached to a HiveRelayClient via attachPairing(). Provides
 * createPairingCode() and claimPairingCode() methods.
 */
export class PairingManager {
  constructor (client, opts = {}) {
    this.client = client
    this.ttlMs = opts.ttlMs || DEFAULT_TTL_MS
    this.claimTimeoutMs = opts.claimTimeoutMs || DEFAULT_CLAIM_TIMEOUT_MS

    // code → { topic, expiresAt, ttlTimer, listener, claimed, complete }
    this._pending = new Map()

    // Per-peer rate limit on server-side pair attempts. A remote peer finding
    // our topic gets `maxAttemptsPerMinutePerPeer` chances per rolling minute
    // to open a pair channel. This caps online brute-force attempts against
    // the 6-digit code space (1M codes; with a 5-min default TTL and this
    // cap at 6/min/peer, a single peer gets ≤30 attempts per code window —
    // negligible success probability).
    this.maxAttemptsPerMinutePerPeer = opts.maxAttemptsPerMinutePerPeer ?? 6
    this.rateLimitWindowMs = opts.rateLimitWindowMs ?? 60_000
    // peerKey (hex) → { attempts, windowStart }
    this._peerAttempts = new Map()
  }

  /**
   * Token-bucket check for one pair-channel attempt from a given peer.
   * Returns true if allowed (and counts the attempt), false if blocked.
   */
  _checkPeerRateLimit (peerKey) {
    if (!peerKey || this.maxAttemptsPerMinutePerPeer <= 0) return true
    const now = Date.now()
    let bucket = this._peerAttempts.get(peerKey)
    if (!bucket || (now - bucket.windowStart) >= this.rateLimitWindowMs) {
      bucket = { attempts: 1, windowStart: now }
      this._peerAttempts.set(peerKey, bucket)
      return true
    }
    if (bucket.attempts >= this.maxAttemptsPerMinutePerPeer) return false
    bucket.attempts++
    return true
  }

  /**
   * Create a pair code. Spins up a swarm join on the derived topic.
   * Returns { code, expiresAt, topic }.
   */
  async createPairingCode (opts = {}) {
    const client = this.client
    if (!client._started) throw new Error('Client not started — call await app.start() first')
    if (!client.swarm) throw new Error('No swarm available')
    if (!client.keyPair || !client.keyPair.secretKey) throw new Error('No identity to share')

    const ttlMs = opts.ttlMs || this.ttlMs
    const code = opts.code || generateCode()
    if (!/^[0-9]{6}$/.test(code)) throw new Error('code must be 6 digits')

    const topic = deriveTopic(code)
    const expiresAt = Date.now() + ttlMs

    const state = {
      code,
      topic,
      expiresAt,
      claimed: false,
      complete: false,
      ttlTimer: null,
      listener: null,
      activeChannel: null
    }

    // Server-side: react when the REMOTE opens a pair channel. We
    // register a Protomux pair handler on every existing & future conn.
    // If we tried to open the channel proactively, an unrelated peer
    // would lock the per-conn channel slot and break later attempts.
    const muxsTouched = new WeakSet()

    const armConn = (conn) => {
      if (state.complete || state._cleaned) return
      if (muxsTouched.has(conn)) return
      muxsTouched.add(conn)
      const mux = Protomux.from(conn)
      mux.pair({ protocol: PAIR_PROTOCOL }, () => {
        if (state.complete || state._cleaned) return

        // Rate-limit on the remote swarm pubkey. Hyperswarm identity is
        // stabler than IP over a P2P net, and identifies a peer across
        // reconnects. Bucket is counted *before* we open the channel so a
        // rejected attempt never touches the handshake.
        const peerKey = conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex') : null
        if (!this._checkPeerRateLimit(peerKey)) {
          client.emit('pairing-rate-limited', { role: 'server', code, peerKey })
          return
        }

        const ch = openPairChannel(conn)
        if (!ch) return
        this._runServer(state, ch, conn).catch((err) => {
          client.emit('pairing-failed', { role: 'server', code, reason: err.message })
        })
      })
    }

    const onConnection = (conn, _peerInfo) => armConn(conn)
    state.listener = onConnection
    client.swarm.on('connection', onConnection)

    // TTL — if no successful claim happens, clean up.
    state.ttlTimer = setTimeout(() => {
      if (state.complete) return
      this._cleanup(state, 'expired').catch(() => {})
    }, ttlMs)
    if (state.ttlTimer.unref) state.ttlTimer.unref()

    // Join the swarm as server. We don't connect outward.
    client.swarm.join(topic, { server: true, client: false })
    client.swarm.flush().catch(() => {})

    // Arm any existing connections too — on a long-lived swarm the peer
    // for this topic may already be connected via another topic (e.g.
    // the relay-discovery topic). Hyperswarm doesn't fire a new
    // 'connection' event when an existing peer adds a topic.
    if (client.swarm.connections) {
      for (const conn of client.swarm.connections) armConn(conn)
    }

    state._armed = muxsTouched
    this._pending.set(code, state)

    return { code, expiresAt, topic }
  }

  /**
   * Claim a pair code (Device B side). Joins swarm as client, runs the
   * client side of the handshake, imports the identity if successful.
   *
   * Returns { ok: true, identity: { publicKey } } on success or
   * { ok: false, reason: '...' } on failure.
   */
  async claimPairingCode (code, opts = {}) {
    const client = this.client
    if (!client._started) throw new Error('Client not started — call await app.start() first')
    if (!client.swarm) throw new Error('No swarm available')

    if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) {
      return { ok: false, reason: 'invalid-code-format' }
    }

    const timeoutMs = opts.timeoutMs || this.claimTimeoutMs
    const topic = deriveTopic(code)

    let resolveResult
    let settled = false
    const result = new Promise((resolve) => { resolveResult = resolve })
    const settle = (value) => {
      if (settled) return
      settled = true
      resolveResult(value)
    }

    const tried = new WeakSet()
    const tryConn = (conn) => {
      if (settled) return
      if (tried.has(conn)) return
      tried.add(conn)
      const ch = openPairChannel(conn)
      if (!ch) return
      this._runClient(code, ch).then((res) => {
        if (res && res.ok) settle(res)
        else if (!settled) {
          // keep listening for other peers in case this conn was a stray;
          // but most likely there is only one.
          try { ch.close() } catch (_) {}
        }
      }).catch(() => {
        try { ch.close() } catch (_) {}
      })
    }

    // Open a pair channel on every existing AND future connection.
    // The server side uses Protomux `mux.pair` (reactive), so opening
    // proactively here is what kicks the handshake off. Conns that
    // belong to non-pairing peers will simply have an idle channel that
    // times out after the per-message recv timeout.
    const onConnection = (conn, _peerInfo) => tryConn(conn)
    client.swarm.on('connection', onConnection)

    const timer = setTimeout(() => {
      settle({ ok: false, reason: 'timeout' })
    }, timeoutMs)
    if (timer.unref) timer.unref()

    let discovery
    try {
      discovery = client.swarm.join(topic, { server: false, client: true })
      client.swarm.flush().catch(() => {})
    } catch (err) {
      clearTimeout(timer)
      client.swarm.removeListener('connection', onConnection)
      return { ok: false, reason: err.message }
    }

    // Open against existing connections — the responder may already be
    // connected via another topic so no fresh 'connection' will fire.
    if (client.swarm.connections) {
      for (const conn of client.swarm.connections) tryConn(conn)
    }

    let final
    try {
      final = await result
    } finally {
      clearTimeout(timer)
      client.swarm.removeListener('connection', onConnection)
      try { await client.swarm.leave(topic) } catch (_) {}
      void discovery
    }

    if (final.ok) {
      client.emit('pairing-completed', { role: 'client', publicKey: final.identity.publicKey })
    } else {
      client.emit('pairing-failed', { role: 'client', reason: final.reason })
    }
    return final
  }

  /**
   * Server-side handshake on one pair channel.
   */
  async _runServer (state, ch, conn) {
    const client = this.client
    state.activeChannel = ch

    try {
      // 1) Send our challenge.
      const myNonce = crypto.randomBytes(32)
      ch.send({ type: 'challenge', nonce: myNonce.toString('hex') })

      // 2) Receive their challenge.
      const theirChallenge = await this._recvWithTimeout(ch, 10_000)
      if (!theirChallenge || theirChallenge.type !== 'challenge' || typeof theirChallenge.nonce !== 'string') {
        throw new Error('bad-challenge')
      }
      const theirNonce = b4a.from(theirChallenge.nonce, 'hex')
      if (theirNonce.length !== 32) throw new Error('bad-challenge')

      // 3) Receive their proof.
      const proofMsg = await this._recvWithTimeout(ch, 10_000)
      if (!proofMsg || proofMsg.type !== 'proof' || typeof proofMsg.proof !== 'string') {
        throw new Error('bad-proof')
      }
      const expected = proofFor(state.code, myNonce)
      const got = b4a.from(proofMsg.proof, 'hex')
      if (got.length !== expected.length || !sodium.sodium_memcmp(got, expected)) {
        // Wrong code on the other side. Tear down this channel but keep
        // the pairing alive so the user can retry a typo.
        throw new Error('bad-proof')
      }

      // From this point on we trust the peer.
      state.claimed = true

      // 4) Send our proof.
      ch.send({ type: 'proof', proof: proofFor(state.code, theirNonce).toString('hex') })

      // 5) Send the identity bundle.
      const bundle = client.exportIdentity()
      ch.send({ type: 'identity', bundle })

      // 6) Wait for ack.
      const ack = await this._recvWithTimeout(ch, 10_000)
      if (!ack || ack.type !== 'ack') throw new Error('no-ack')

      state.complete = true
      client.emit('pairing-completed', { role: 'server', code: state.code, publicKey: bundle.publicKey })
      await this._cleanup(state, 'completed')
    } catch (err) {
      try { ch.close() } catch (_) {}
      if (state.claimed) {
        // Past point of no return — clean up.
        state.complete = true
        await this._cleanup(state, 'failed-after-claim')
      }
      // Don't tear down conn itself — other protocols (replication) may use it.
      void conn
      // Only emit on bad-proof / no-ack to avoid noise from non-pair peers
      // that never even opened the channel.
      if (err.message !== 'recv-timeout') {
        client.emit('pairing-failed', { role: 'server', code: state.code, reason: err.message })
      }
    }
  }

  /**
   * Client-side handshake on one pair channel.
   * Returns { ok, identity?, reason? }.
   */
  async _runClient (code, ch) {
    const client = this.client

    try {
      // 1) Receive their challenge.
      const theirChallenge = await this._recvWithTimeout(ch, 10_000)
      if (!theirChallenge || theirChallenge.type !== 'challenge' || typeof theirChallenge.nonce !== 'string') {
        return { ok: false, reason: 'bad-challenge' }
      }
      const theirNonce = b4a.from(theirChallenge.nonce, 'hex')
      if (theirNonce.length !== 32) return { ok: false, reason: 'bad-challenge' }

      // 2) Send our challenge.
      const myNonce = crypto.randomBytes(32)
      ch.send({ type: 'challenge', nonce: myNonce.toString('hex') })

      // 3) Send our proof of `code`.
      ch.send({ type: 'proof', proof: proofFor(code, theirNonce).toString('hex') })

      // 4) Receive their proof.
      const proofMsg = await this._recvWithTimeout(ch, 10_000)
      if (!proofMsg || proofMsg.type !== 'proof' || typeof proofMsg.proof !== 'string') {
        return { ok: false, reason: 'bad-proof' }
      }
      const expected = proofFor(code, myNonce)
      const got = b4a.from(proofMsg.proof, 'hex')
      if (got.length !== expected.length || !sodium.sodium_memcmp(got, expected)) {
        return { ok: false, reason: 'bad-proof' }
      }

      // 5) Receive identity bundle.
      const idMsg = await this._recvWithTimeout(ch, 15_000)
      if (!idMsg || idMsg.type !== 'identity' || !idMsg.bundle) {
        return { ok: false, reason: 'no-identity' }
      }

      // 6) Import & ack.
      try {
        client.importIdentity(idMsg.bundle)
      } catch (err) {
        ch.send({ type: 'nack', reason: err.message })
        return { ok: false, reason: 'invalid-identity' }
      }
      ch.send({ type: 'ack' })

      return { ok: true, identity: { publicKey: idMsg.bundle.publicKey } }
    } catch (err) {
      return { ok: false, reason: err.message || 'client-error' }
    }
  }

  async _recvWithTimeout (ch, ms) {
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), ms)
      if (timer.unref) timer.unref()
    })
    try {
      const r = await Promise.race([ch.recv(), timeout])
      if (r === '__timeout__') {
        const err = new Error('recv-timeout')
        throw err
      }
      return r
    } finally {
      clearTimeout(timer)
    }
  }

  async _cleanup (state, reason) {
    const client = this.client
    if (state._cleaned) return
    state._cleaned = true
    if (state.ttlTimer) {
      clearTimeout(state.ttlTimer)
      state.ttlTimer = null
    }
    if (state.listener) {
      try { client.swarm.removeListener('connection', state.listener) } catch (_) {}
      state.listener = null
    }
    // Best-effort: unpair from every conn we armed. We can't iterate
    // a WeakSet, so we walk the swarm's current connections.
    if (client.swarm && client.swarm.connections) {
      for (const conn of client.swarm.connections) {
        try {
          const mux = Protomux.from(conn)
          mux.unpair({ protocol: PAIR_PROTOCOL })
        } catch (_) {}
      }
    }
    try { if (state.activeChannel) state.activeChannel.close() } catch (_) {}
    try { await client.swarm.leave(state.topic) } catch (_) {}
    this._pending.delete(state.code)
    if (reason === 'expired') {
      client.emit('pairing-failed', { role: 'server', code: state.code, reason: 'expired' })
    }
  }

  /**
   * Drop all pending codes. Called on client.destroy().
   */
  async destroy () {
    const states = Array.from(this._pending.values())
    this._pending.clear()
    for (const state of states) {
      try { await this._cleanup(state, 'shutdown') } catch (_) {}
    }
    this._peerAttempts.clear()
  }

  /**
   * Evict stale rate-limit buckets whose windows have already elapsed.
   * Safe to call at any time. Intentionally not scheduled on a timer —
   * the bucket check does its own window-expiry check on access, so stale
   * entries don't affect correctness; this method only reclaims memory.
   */
  _prunePeerAttempts () {
    const now = Date.now()
    const staleThreshold = this.rateLimitWindowMs * 2
    for (const [key, bucket] of this._peerAttempts) {
      if ((now - bucket.windowStart) > staleThreshold) this._peerAttempts.delete(key)
    }
  }

  /** Test-only: snapshot of currently-pending codes. */
  _pendingCodes () {
    return Array.from(this._pending.keys())
  }
}

/**
 * Attach pairing methods to a HiveRelayClient instance. Idempotent.
 */
export function attachPairing (client, opts = {}) {
  if (client._pairing) return client._pairing
  const mgr = new PairingManager(client, opts)
  client._pairing = mgr
  return mgr
}

/* ─── SECURITY NOTES ────────────────────────────────────────────────
 *
 * 1. Topic leakage. The 32-byte swarm topic is BLAKE2b of the code.
 *    Anyone watching the DHT can guess 6-digit codes (a million
 *    possibilities) and check whether each topic has announcers. Today
 *    that just gives existence-of-active-pairing. They still cannot
 *    complete the handshake without the code (HMAC proof gates the
 *    bundle transfer). To raise this bar further, we could rate-limit
 *    announce churn or salt the topic with a fixed application string
 *    per deployment.
 *
 * 2. Online brute force. An attacker who guesses the topic AND has
 *    network capacity could try 1,000,000 candidate codes against an
 *    active pairing. Because the proof requires the responder's nonce
 *    (round trip), it is online and rate-limited by handshake setup
 *    (Hyperswarm Noise XK ~50ms minimum). 5 minutes / 50ms = 6000
 *    attempts maximum. Single-claim semantics close the window after
 *    one peer succeeds. For higher security, use a longer code or add
 *    server-side claim-attempt rate limiting.
 *
 * 3. HMAC alone vs PAKE. A proper Password-Authenticated Key Exchange
 *    (SPAKE2 / OPAQUE) would derive a session key from the code AND
 *    bind it to the channel, preventing offline-brute-force even if
 *    the transcript leaks. We get away with simple HMAC because the
 *    Hyperswarm channel is already Noise XK encrypted — an off-path
 *    attacker cannot see the proofs at all. An on-path active attacker
 *    impersonating both ends would have to know the code to forge
 *    proofs, so MITM is not viable without it.
 *
 * 4. Identity bundle exposure. The bundle is the raw private key. It
 *    is sent over the Noise XK channel which is forward-secret to
 *    third parties. Both endpoints obviously have the key after pairing.
 */

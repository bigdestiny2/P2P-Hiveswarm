# Cryptographic guarantees

What a HiveRelay operator can and cannot do, in terms of math rather than
trust. If you're an operator weighing what you're signing up for, or an app
developer choosing relays, this is the document to point at.

## TL;DR

A relay sees encrypted bytes, sees who connected, and can drop connections.
That is the entire trust surface. The relay cannot:

- Read app contents (Noise + hypercore-protocol encryption end-to-end)
- Forge an app or its updates (publisher signature required, verified by every reader)
- Lie about whether it served the bytes (proof-of-relay challenges with cryptographic responses)
- Decrypt a blind-mode app even if it stores the ciphertext forever (encryption key is never sent to relays)

This isn't a promise from the relay operator. It's enforced by the protocol;
a malicious operator who tried to violate any of the above would either fail
the cryptographic check or simply not produce the result. Apps and clients
verify, they don't trust.

## What's encrypted

### 1. The wire (Noise / hypercore-protocol)

Every Hyperswarm connection — peer-to-peer or peer-to-relay — is wrapped in
a Noise XK handshake (`hypercore-protocol`) before any application data
flows. The handshake provides:

| Property | Means |
|---|---|
| Confidentiality | A passive observer (including the relay forwarding the bytes) sees ciphertext only — random-looking bytes |
| Integrity | An active attacker can't tamper with bytes in flight without breaking the MAC; receiver detects and tears down the connection |
| Forward secrecy | If the long-term keys leak later, past sessions remain unreadable (ephemeral keys are discarded after handshake) |
| Mutual authentication | Both sides prove possession of their static keys; the connection is identity-pinned |

This applies to the Hypercore *replication* protocol and to every Protomux
sub-channel layered on top (seed-request, circuit-relay, proof-of-relay,
service-RPC, app-catalog). A relay sees Noise frames, period.

**Source:** [hypercore-protocol README](https://github.com/holepunchto/hypercore-protocol),
[Noise Protocol Framework spec](http://www.noiseprotocol.org/noise.html).

### 2. App content (Hypercore)

Hypercores are Merkle-tree-backed append-only logs. Each block is signed
by the publisher's keypair. Readers verify the signature against the
public key (the appKey) before accepting the block. A relay that stored
forged blocks would simply fail signature verification on the reader side
— forged content cannot enter the chain.

| Layer | Crypto |
|---|---|
| Block authenticity | Ed25519 signature over the Merkle root by the publisher key |
| Position integrity | Every block references the previous Merkle root — blocks cannot be reordered or omitted without detection |
| Write authority | Only the holder of the publisher private key can append |

**Implication for relays:** a relay cannot inject content into an app's
feed. The worst it can do is refuse to serve some blocks, which the reader
will route around by querying other peers.

### 3. Blind-mode apps

For apps that publish in blind mode (`client.publish(content, { encryptionKey })`),
content is encrypted with a 32-byte symmetric key *before* it enters the
Hypercore. The relay stores the encrypted blocks as opaque bytes and has
no way to decrypt them.

| What relays see | What they don't |
|---|---|
| Encrypted block ciphertext | Plaintext content |
| The appKey (Hypercore public key) | The encryption key (never transmitted to relays) |
| Block sizes and rough write timing | Block contents |
| Peer connection metadata (which pubkeys connected) | Reader identity beyond pubkey |

The encryption key is shared peer-to-peer (out of band, or through the app
itself once a reader authenticates). The relay never holds it.

**Concrete guarantee:** even an operator with full filesystem access to
their own relay storage holds nothing more than encrypted blocks they can't
decrypt. The HTTP gateway returns 403 for blind apps to enforce this at the
application layer too — there's no "view in browser" path that would
require decryption.

### 4. Identity & seed requests

Seed requests carry a signature from the app's publisher key over
`(appKey || 'seed' || timestamp || maxStorageBytes)`. Relays verify the
signature before honoring the request. This means:

- Anyone can ask a relay to seed an app, but only the app's publisher
  can authenticate the request as "I'm the one publishing this"
- Replay protection: timestamps must be within a 5-minute window of
  the relay's clock, and signatures are cached for dedup
- An unsigned seed request can still be accepted (depending on
  acceptMode), but it carries no publisher attestation — the operator is
  trusting the network's reputation system to surface bad actors

Unseed requests (the kill switch) require the same publisher signature.
A relay won't drop content on a third party's say-so.

## What proof-of-relay actually proves

A relay can be challenged to produce a Merkle proof for a specific block of
content it claims to be serving. The challenger picks a random block, the
relay returns the block + its inclusion proof, the challenger verifies
against the publisher's signed Merkle root.

What this proves:
- The relay actually has the bytes (otherwise it can't produce the proof)
- The bytes are the correct ones (otherwise the inclusion proof fails)

What this does *not* prove:
- That the relay will serve the bytes to a different peer at request time
  (it can selectively answer)
- That the relay holds the bytes *in memory* — it could fetch on demand
  from another peer and proxy

That's why proof-of-relay is paired with **bandwidth receipts** (signed
proofs of bytes actually transferred to a counterparty) for a richer
"this relay is serving" signal. See `core/protocol/proof-of-relay.js` and
`bandwidth-receipt.js`.

## Threat model — what a malicious operator can do

| Attack | What happens |
|---|---|
| Read app contents (non-blind) | Possible — the operator stores plaintext blocks. **Use blind mode if you don't want this.** |
| Read app contents (blind mode) | **Impossible** — they only have ciphertext, no key |
| Inject forged content into an app | **Impossible** — Ed25519 signature verification on every block |
| Modify blocks they're storing | Detectable — Merkle root mismatch |
| Refuse to serve content | Possible — but other relays / peers will serve it (this is why replication-factor matters) |
| Lie about serving in proof-of-relay | **Impossible** — they have to produce real Merkle proofs against real bytes |
| Surveil who connects | Possible — they see counterparty pubkeys (this is the network-metadata threat). Mitigations: Tor transport, ephemeral keys per session |
| Censor specific apps from their catalog | Possible — that's the whole *point* of accept-modes. The operator chooses what they carry. Other relays may still carry it. |

## Threat model — what a malicious *client* can do

| Attack | Impact |
|---|---|
| Submit floods of seed requests | Mitigated by accept-modes (Review queues, Closed rejects) and per-relay rate limits |
| Try to push forged content under someone else's appKey | Fails — signature check |
| Try to use a relay as an open DDoS amplifier via DHT-relay-WS | Mitigated by `maxConnections` per transport; future: per-IP rate limit |
| Try to read another app's blind content | Fails — they don't have the encryption key |

## How this compares to running on a centralized cloud

| Property | HiveRelay (blind mode) | Cloud (S3 / Lambda / Vercel) |
|---|---|---|
| Operator can read your data | No | Yes (or service role can) |
| Operator can subpoena your data | Only ciphertext available | Yes, plaintext |
| Operator can be coerced to forge content | No (signature) | Yes (vendor controls signing keys) |
| Operator visibility into who reads | Pubkeys only, can be ephemeral | IP addresses, often tied to identity |
| Single point of failure | No (multiple replicas) | Vendor outage |
| Compliance/data-residency claims | Operator chooses what to store | Vendor SLA |

This isn't an argument that HiveRelay is unconditionally better — there are
plenty of apps where vendor-managed makes more sense. It's an argument that
the *trust surface is genuinely smaller* for apps that fit the model.

## What we're explicitly *not* claiming

- **Anonymity.** A relay sees the pubkey of every peer that connects. That's a
  network-metadata leak. If you need anonymity, layer Tor (`transports/tor/`)
  or use ephemeral keypairs per session.
- **Censorship resistance against state actors.** A nation-state can
  fingerprint and block Hyperswarm DHT traffic. We provide the tools (Tor,
  blind mode, federation) but don't claim impunity against well-funded
  adversaries.
- **Long-term unbreakable encryption.** Curve25519 / Ed25519 / ChaCha20-Poly1305
  are state-of-the-art today. They could conceivably be broken in 30 years
  by quantum computers. Nothing in HiveRelay specifically addresses
  post-quantum, and that's an honest limitation.

## Source pointers

- `packages/core/core/protocol/seed-request.js` — signature scheme
- `packages/core/core/protocol/proof-of-relay.js` — challenge/response math
- `packages/core/core/protocol/bandwidth-receipt.js` — signed transfer proofs
- `packages/services/identity/attestation.js` — Schnorr attestations for dev-key → app-key bindings
- [hypercore docs](https://docs.holepunch.to/) — upstream cryptography
- [Noise Protocol XK pattern](http://www.noiseprotocol.org/noise.html#interactive-handshake-patterns) — wire encryption

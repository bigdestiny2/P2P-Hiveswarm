# HiveRelay Protocol Specification

**Version:** 1.0.0-draft
**Date:** April 2026
**Status:** Draft

---

## Table of Contents

1. [Overview](#1-overview)
2. [Transport Layer](#2-transport-layer)
3. [Wire Protocol Framing](#3-wire-protocol-framing)
4. [Message Types](#4-message-types)
5. [Seed Request Protocol](#5-seed-request-protocol)
6. [Circuit Relay Protocol](#6-circuit-relay-protocol)
7. [Proof-of-Relay Protocol](#7-proof-of-relay-protocol)
8. [Bandwidth Receipt Protocol](#8-bandwidth-receipt-protocol)
9. [Seeding Registry](#9-seeding-registry)
10. [Peer Discovery](#10-peer-discovery)
11. [Reputation Scoring](#11-reputation-scoring)
12. [Error Codes](#12-error-codes)
13. [Security Model](#13-security-model)
14. [Configuration Defaults](#14-configuration-defaults)

---

## 1. Overview

HiveRelay is a shared relay backbone for the Holepunch/Pear ecosystem. Relay nodes provide two primary services:

1. **Seeding** -- persistently storing and serving Hypercores and Hyperdrives on behalf of application publishers, so that apps remain available even when the original publisher is offline.
2. **Circuit relay** -- forwarding opaque, end-to-end encrypted bytes between peers when direct NAT hole-punching fails.

The protocol is built on top of Hyperswarm and HyperDHT. All HiveRelay messages are exchanged over protomux channels on Hyperswarm connections, encoded with `compact-encoding`.

### 1.1 Protocol Identifier

All HiveRelay protomux channels are registered under one of three protocol names:

| Protocol Name | Purpose |
|---|---|
| `hiverelay-seed` | Seed request and acceptance |
| `hiverelay-circuit` | Circuit relay reservation and data forwarding |
| `hiverelay-proof` | Proof-of-relay challenges and responses |

### 1.2 Versioning

The protocol uses semantic versioning. The current version is `1.0.0`. The version is exchanged as a JSON-encoded handshake payload on the `hiverelay-seed` channel:

```json
{ "major": 1, "minor": 0 }
```

Peers MUST reject connections with a different major version. Minor version differences are tolerated (backward compatible).

---

## 2. Transport Layer

### 2.1 Primary Transport

HiveRelay operates over Hyperswarm, which uses HyperDHT (a Kademlia-based DHT) for peer discovery and UDP hole-punching for direct connectivity. All peer connections are encrypted using the Noise protocol framework as implemented by HyperDHT.

- **DHT bootstrap nodes:** By default, the standard HyperDHT bootstrap nodes (`node1-3.hyperdht.org:49737`). Custom bootstrap nodes may be configured.
- **Maximum connections:** 256 per relay node (configurable).

### 2.2 Optional Transports (Phase 2+)

| Transport | Description |
|---|---|
| Tor | Hidden service transport for censorship resistance |
| I2P | Garlic routing for P2P-native anonymity |
| WebSocket | Browser peer support |

Optional transports are negotiated at the Hyperswarm layer and are transparent to the HiveRelay protocol.

---

## 3. Wire Protocol Framing

All HiveRelay messages are sent over protomux channels. Each channel carries typed messages registered with compact-encoding schemas. The general framing is:

```
[protomux channel header]
  [message type index (assigned by protomux at channel creation)]
  [compact-encoded message body]
```

Protomux handles multiplexing, flow control, and ordered delivery within each channel. HiveRelay does not define its own framing beyond protomux.

### 3.1 Encoding

All fields are encoded using `compact-encoding`:

| Encoding | Description |
|---|---|
| `c.fixed32` | 32-byte fixed buffer (public keys, discovery keys, nonces) |
| `c.fixed64` | 64-byte fixed buffer (Ed25519 signatures) |
| `c.uint` | Unsigned variable-length integer |
| `c.string` | UTF-8 string with length prefix |
| `c.buffer` | Variable-length byte buffer with length prefix |

Multi-byte integers use the compact-encoding varint format (little-endian, 7-bit groups).

---

## 4. Message Types

Messages are grouped into four functional ranges:

### 4.1 Seeding Registry Messages (0x01 - 0x0F)

| Code | Name | Direction | Description |
|---|---|---|---|
| `0x01` | `SEED_REQUEST` | Publisher -> Relay | Request a relay to seed Hypercores |
| `0x02` | `SEED_ACCEPT` | Relay -> Publisher | Accept a seed request |
| `0x03` | `SEED_REJECT` | Relay -> Publisher | Reject a seed request |
| `0x04` | `SEED_CANCEL` | Publisher -> Relay | Cancel a previously issued seed request |
| `0x05` | `SEED_HEARTBEAT` | Relay -> Publisher | Periodic heartbeat confirming active seeding |
| `0x06` | `SEED_STATUS` | Either | Query or report seeding status |

### 4.2 Circuit Relay Messages (0x10 - 0x1F)

| Code | Name | Direction | Description |
|---|---|---|---|
| `0x10` | `RELAY_RESERVE` | Peer -> Relay | Request a relay reservation |
| `0x11` | `RELAY_RESERVE_OK` | Relay -> Peer | Reservation granted |
| `0x12` | `RELAY_RESERVE_DENY` | Relay -> Peer | Reservation denied |
| `0x13` | `RELAY_CONNECT` | Peer -> Relay | Request circuit to a reserved peer |
| `0x14` | `RELAY_CONNECT_OK` | Relay -> Peer | Circuit established |
| `0x15` | `RELAY_CONNECT_DENY` | Relay -> Peer | Circuit denied |
| `0x16` | `RELAY_DATA` | Bidirectional | Opaque data forwarded through circuit |
| `0x17` | `RELAY_CLOSE` | Either | Close a circuit |
| `0x18` | `RELAY_UPGRADE` | Either | Signal direct connection upgrade (DCUtR) |

### 4.3 Proof-of-Relay Messages (0x20 - 0x2F)

| Code | Name | Direction | Description |
|---|---|---|---|
| `0x20` | `PROOF_CHALLENGE` | Verifier -> Relay | Challenge relay to prove block storage |
| `0x21` | `PROOF_RESPONSE` | Relay -> Verifier | Response with block data and Merkle proof |
| `0x22` | `BANDWIDTH_RECEIPT` | Peer -> Relay | Signed proof of data transfer |
| `0x23` | `RECEIPT_ACK` | Relay -> Peer | Acknowledgment of receipt |

### 4.4 Peer Discovery Messages (0x30 - 0x3F)

| Code | Name | Direction | Description |
|---|---|---|---|
| `0x30` | `PEER_ANNOUNCE` | Relay -> Network | Announce relay availability |
| `0x31` | `PEER_QUERY` | Any -> Any | Query for available relays |
| `0x32` | `PEER_RESPONSE` | Any -> Any | Response to relay query |

---

## 5. Seed Request Protocol

**Protocol name:** `hiverelay-seed`

The seed protocol allows app publishers to request that relay nodes persistently store and serve their Hypercores and Hyperdrives. Publishers broadcast seed requests; relays that have capacity and match the request's constraints accept them.

### 5.1 SEED_REQUEST Message

Sent by the publisher to request seeding.

| Field | Encoding | Size | Description |
|---|---|---|---|
| `appKey` | `fixed32` | 32 bytes | Public key of the Pear application |
| `discoveryKeys` | `fixed32[]` | 32 bytes each | Discovery keys of Hypercores to seed (length-prefixed array) |
| `replicationFactor` | `uint` | variable | Desired number of relay replicas (e.g. 3) |
| `geoPreference` | `string` (JSON) | variable | JSON array of preferred region codes (e.g. `["NA","EU"]`) |
| `maxStorageBytes` | `uint` | variable | Maximum storage the publisher expects the app to consume |
| `bountyRate` | `uint` | variable | Payment rate in sats/GB/month (0 in Phase 1) |
| `ttlSeconds` | `uint` | variable | How long the seed request remains valid |
| `publisherPubkey` | `fixed32` | 32 bytes | Ed25519 public key of the publisher |
| `publisherSignature` | `fixed64` | 64 bytes | Ed25519 signature over the request fields |

**Signature construction:**

The signature is computed over the concatenation of:
```
appKey || discoveryKey[0] || ... || discoveryKey[N] || metadata
```

Where `metadata` is a 24-byte buffer containing:
- Byte 0: `replicationFactor` (uint8)
- Bytes 8-15: `maxStorageBytes` (uint64, big-endian)
- Bytes 16-23: `ttlSeconds` (uint64, big-endian)

The signature uses `crypto_sign_detached` from libsodium.

### 5.2 SEED_ACCEPT Message

Sent by a relay node to accept a seed request.

| Field | Encoding | Size | Description |
|---|---|---|---|
| `appKey` | `fixed32` | 32 bytes | Public key of the application being seeded |
| `relayPubkey` | `fixed32` | 32 bytes | Ed25519 public key of the accepting relay |
| `region` | `string` | variable | Region code of the relay (e.g. `"NA"`) |
| `availableStorageBytes` | `uint` | variable | Storage the relay commits to this app |
| `relaySignature` | `fixed64` | 64 bytes | Signature over `appKey || relayPubkey || region` |

### 5.3 Seed Request Lifecycle

```
Publisher                          Relay
    |                                |
    |--- SEED_REQUEST ------------->|
    |   (signed, broadcast to all)  |
    |                                |
    |   [relay checks capacity,     |
    |    geo match, storage]        |
    |                                |
    |<----------- SEED_ACCEPT ------|  (if accepted)
    |<----------- SEED_REJECT ------|  (if denied)
    |                                |
    |   [relay joins Hyperswarm     |
    |    topics for discovery keys, |
    |    downloads all blocks,      |
    |    re-announces every 15 min] |
    |                                |
    |<--------- SEED_HEARTBEAT -----|  (periodic, confirms active seeding)
    |                                |
    |--- SEED_CANCEL -------------->|  (publisher cancels)
    |                                |
    |   [relay leaves topics,       |
    |    optionally purges data]    |
```

When a new protomux channel opens, the publisher automatically retransmits all pending seed requests to the new peer.

### 5.4 Seeding Behavior

Once a relay accepts a seed request, it:

1. Opens the Hypercore(s) using the discovery keys from the request.
2. Calls `core.download({ start: 0, end: -1 })` to download all blocks.
3. Joins the Hyperswarm topic for each core's `discoveryKey` with `{ server: true, client: true }`.
4. Re-announces on the DHT every 15 minutes (configurable via `announceInterval`).
5. Tracks bytes stored and bytes served per core.

---

## 6. Circuit Relay Protocol

**Protocol name:** `hiverelay-circuit`

The circuit relay provides NAT traversal when direct UDP hole-punching (via HyperDHT) fails. The relay forwards opaque, end-to-end encrypted bytes between two peers. The relay cannot read the content.

### 6.1 RELAY_RESERVE Message

Sent by a NAT-challenged peer to request a relay reservation.

| Field | Encoding | Size | Description |
|---|---|---|---|
| `peerPubkey` | `fixed32` | 32 bytes | Public key of the requesting peer |
| `maxDurationMs` | `uint` | variable | Requested maximum circuit duration |
| `maxBytes` | `uint` | variable | Requested maximum bytes per circuit |

### 6.2 RELAY_CONNECT Message

Sent by a peer wishing to connect to a reserved peer via the relay.

| Field | Encoding | Size | Description |
|---|---|---|---|
| `targetPubkey` | `fixed32` | 32 bytes | Public key of the target (reserved) peer |
| `sourcePubkey` | `fixed32` | 32 bytes | Public key of the connecting peer |

### 6.3 Status Response

Used by the relay to communicate reservation and connection outcomes.

| Field | Encoding | Size | Description |
|---|---|---|---|
| `code` | `uint` | variable | Error/status code (see Section 12) |
| `message` | `string` | variable | Human-readable status message |

### 6.4 Circuit Relay Lifecycle

```
Peer A (NAT'd)         Relay R              Peer B
    |                     |                     |
    |-- RELAY_RESERVE -->|                     |
    |                     |                     |
    |<- RELAY_RESERVE_OK-|                     |
    |   (or DENY)        |                     |
    |                     |                     |
    |                     |<-- RELAY_CONNECT ---|
    |                     |   (target = A)      |
    |                     |                     |
    |                     |--- RELAY_CONNECT_OK->|
    |                     |                     |
    |<===== RELAY_DATA =====>===== bidirectional forwarding =====|
    |   (opaque E2E      |   (relay sees only   |
    |    encrypted bytes) |    encrypted bytes)  |
    |                     |                     |
    |<-- RELAY_UPGRADE -->|                     |
    |   (optional DCUtR)  |                     |
    |                     |                     |
    |<----- direct connection (if upgrade succeeds) ----->|
    |                     |                     |
    |-- RELAY_CLOSE ---->|                     |
```

### 6.5 Circuit Limits

Each circuit is subject to the following limits (enforced by the relay):

| Parameter | Default | Description |
|---|---|---|
| Maximum duration | 10 minutes | Circuit is torn down after this duration |
| Maximum bytes | 64 MB | Circuit is torn down if this byte count is exceeded |
| Maximum circuits per peer | 5 | A single peer cannot hold more than 5 simultaneous circuits |
| Reservation TTL | 1 hour | Unused reservations expire after this period |

When a limit is exceeded, the relay destroys both sides of the circuit and emits a `circuit-closed` event with the reason (`BYTES_EXCEEDED`, `DURATION_EXCEEDED`, or `PEER_CLOSED`).

### 6.6 Reservation Cleanup

The relay runs a cleanup sweep every 60 seconds, removing expired reservations. When a protomux channel closes, all reservations held by that channel are immediately removed.

---

## 7. Proof-of-Relay Protocol

**Protocol name:** `hiverelay-proof`

Proof-of-relay provides cryptographic verification that relay nodes actually store and serve the data they claim to hold. Any peer (the "verifier") can challenge any relay to prove possession of a specific Hypercore block.

### 7.1 PROOF_CHALLENGE Message

Sent by a verifier to challenge a relay.

| Field | Encoding | Size | Description |
|---|---|---|---|
| `coreKey` | `fixed32` | 32 bytes | Public key of the Hypercore to challenge |
| `blockIndex` | `uint` | variable | Index of the block the relay must produce |
| `nonce` | `fixed32` | 32 bytes | Random nonce (prevents replay) |
| `maxLatencyMs` | `uint` | variable | Maximum allowed response time (default: 5000 ms) |

The nonce is generated using `sodium.randombytes_buf`.

### 7.2 PROOF_RESPONSE Message

Sent by the relay in response to a challenge.

| Field | Encoding | Size | Description |
|---|---|---|---|
| `coreKey` | `fixed32` | 32 bytes | Public key of the challenged Hypercore |
| `blockIndex` | `uint` | variable | Index of the block being proven |
| `blockData` | `buffer` | variable | The actual block data |
| `merkleProof` | `buffer` | variable | Hypercore Merkle tree proof for this block |
| `nonce` | `fixed32` | 32 bytes | Echo of the challenge nonce |

### 7.3 Verification Procedure

The verifier checks all of the following conditions:

1. **Correct core:** `response.coreKey` matches `challenge.coreKey`
2. **Correct index:** `response.blockIndex` matches `challenge.blockIndex`
3. **Data present:** `response.blockData.byteLength > 0`
4. **Nonce match:** `response.nonce` matches the challenge nonce (correlates request to response)
5. **Latency bound:** Response arrived within `maxLatencyMs` of the challenge being sent

A proof passes only if all five conditions are met. The result is recorded in the verifier's local score table for the challenged relay.

### 7.4 Scoring

Per-relay scores are maintained locally by each verifier:

| Metric | Description |
|---|---|
| `challenges` | Total challenges issued to this relay |
| `passes` | Number of challenges passed |
| `fails` | Number of challenges failed |
| `totalLatencyMs` | Sum of response latencies (successful only) |
| `avgLatencyMs` | `totalLatencyMs / passes` |

**Reliability** is defined as `passes / challenges`.

### 7.5 Challenge Interval

The default challenge interval is 5 minutes. Verifiers SHOULD randomize the exact timing and the block index selected to prevent relays from predicting and caching only challenged blocks.

---

## 8. Bandwidth Receipt Protocol

Bandwidth receipts provide cryptographically signed proof that a relay served data to a peer. Receipts are collected by relays as evidence of service for the reputation and incentive layers.

### 8.1 BANDWIDTH_RECEIPT Message

Created and signed by the receiving peer, then sent to the relay.

| Field | Encoding | Size | Description |
|---|---|---|---|
| `relayPubkey` | `fixed32` | 32 bytes | Public key of the relay that served data |
| `peerPubkey` | `fixed32` | 32 bytes | Public key of the receiving peer |
| `bytesTransferred` | `uint` | variable | Number of bytes transferred in this session |
| `timestamp` | `uint` | variable | Unix timestamp (seconds) of receipt creation |
| `sessionId` | `fixed32` | 32 bytes | Unique session identifier |
| `peerSignature` | `fixed64` | 64 bytes | Ed25519 signature by the receiving peer |

### 8.2 Signature Construction

The signature is computed over:

```
relayPubkey (32 bytes)
|| peerPubkey (32 bytes)
|| bytesTransferred (8 bytes, uint64 big-endian)
|| timestamp (4 bytes, uint32 big-endian)
|| sessionId (32 bytes)
```

Total signed payload: 108 bytes.

The signature uses `crypto_sign_detached` from libsodium.

### 8.3 Verification

Any party can verify a bandwidth receipt by:

1. Reconstructing the 108-byte payload from the receipt fields.
2. Calling `crypto_sign_verify_detached(peerSignature, payload, peerPubkey)`.

This allows third-party auditors, the reputation system, and future payment systems to independently verify that a peer attested to receiving data from a relay.

### 8.4 Receipt Collection

Relays collect receipts by verifying the signature and storing valid receipts. Invalid receipts (bad signature) are rejected. Relays can export collected receipts for submission to the incentive layer.

---

## 9. Seeding Registry

The seeding registry is a distributed, multi-writer data structure built on Autobase. It serves as the global directory of seed requests and acceptances.

### 9.1 Data Model

The registry stores JSON entries of the following types:

**seed-request:**
```json
{
  "type": "seed-request",
  "timestamp": 1712345678000,
  "appKey": "<hex>",
  "discoveryKeys": ["<hex>", ...],
  "replicationFactor": 3,
  "geoPreference": ["NA", "EU"],
  "maxStorageBytes": 1073741824,
  "bountyRate": 0,
  "ttlSeconds": 2592000,
  "publisherPubkey": "<hex>"
}
```

**seed-accept:**
```json
{
  "type": "seed-accept",
  "timestamp": 1712345700000,
  "appKey": "<hex>",
  "relayPubkey": "<hex>",
  "region": "NA"
}
```

**seed-cancel:**
```json
{
  "type": "seed-cancel",
  "timestamp": 1712346000000,
  "appKey": "<hex>",
  "publisherPubkey": "<hex>"
}
```

### 9.2 Replication

The registry Autobase is replicated over Hyperswarm. The Autobase's discovery key is used as the swarm topic. All peers join with `{ server: true, client: true }`.

### 9.3 Linearization

Autobase's `apply` function linearizes the causal DAG into a single ordered view. Each entry is parsed as JSON and appended to the view. Malformed entries are silently skipped.

### 9.4 Querying

Active seed requests can be filtered by:

- **TTL:** Requests whose `timestamp + ttlSeconds * 1000 < now` are expired and excluded.
- **Region:** If the request specifies `geoPreference` and the query includes a region filter, only matching requests are returned.
- **Storage:** Requests exceeding a relay's available storage can be filtered out.

---

## 10. Peer Discovery

Relay nodes discover peers and other relays through the standard Hyperswarm DHT. HiveRelay adds three additional messages for relay-specific discovery:

| Message | Purpose |
|---|---|
| `PEER_ANNOUNCE` (0x30) | A relay announces its availability, region, and capacity |
| `PEER_QUERY` (0x31) | A peer queries for available relays matching criteria |
| `PEER_RESPONSE` (0x32) | Response to a query with matching relay information |

Relays join the DHT topics for every Hypercore they seed, with `{ server: true, client: true }`, and re-announce every 15 minutes (configurable).

---

## 11. Reputation Scoring

The reputation system tracks relay node quality based on observable, verifiable metrics. It is used for relay selection (choosing which relays to seed an app) and for the future incentive layer.

### 11.1 Inputs

| Input | Weight | Description |
|---|---|---|
| Proof-of-relay pass | +10 points | Per passed challenge |
| Proof-of-relay fail | -20 points | Per failed challenge (2x penalty) |
| Bandwidth served | +0.001 points/MB | From verified bandwidth receipts |
| Uptime | +1 point/hour | Continuous presence on the DHT |
| Geographic diversity | +50 points (one-time) | Bonus for relays in underserved regions |

### 11.2 Score Decay

All scores decay daily by a factor of 0.995 (approximately 0.5% per day). This ensures that relays must remain actively contributing to maintain their ranking. A relay that ceases operation will see its score halve in approximately 139 days.

### 11.3 Minimum Ranking Threshold

A relay must have responded to at least 10 proof-of-relay challenges before it appears in the ranked leaderboard or is eligible for relay selection.

### 11.4 Composite Score for Relay Selection

When selecting relays for a seed request, the system computes a composite score:

```
composite = score * reliability * (1000 / avgLatencyMs)
```

Where:
- `score` is the raw reputation score
- `reliability` = `passedChallenges / totalChallenges`
- `avgLatencyMs` is the average proof-of-relay response latency

Relays are sorted by composite score. If the request specifies a geographic preference, relays in preferred regions are prioritized (but all relays are considered if insufficient candidates exist in the preferred region).

### 11.5 Geographic Diversity

Region codes follow a continent-level scheme:

| Code | Region |
|---|---|
| `NA` | North America |
| `SA` | South America |
| `EU` | Europe |
| `AF` | Africa |
| `AS` | Asia |
| `OC` | Oceania |

Relays in regions with fewer active relays than the median receive a one-time geographic diversity bonus of 50 points.

---

## 12. Error Codes

| Code | Name | Description |
|---|---|---|
| `0x00` | `NONE` | No error (success) |
| `0x01` | `CAPACITY_FULL` | Relay is at connection or storage capacity |
| `0x02` | `INVALID_REQUEST` | Malformed or invalid request |
| `0x03` | `NOT_FOUND` | Requested resource not found (e.g. no reservation for target peer) |
| `0x04` | `TIMEOUT` | Operation timed out |
| `0x05` | `STORAGE_EXCEEDED` | Storage limit exceeded |
| `0x06` | `BANDWIDTH_EXCEEDED` | Bandwidth limit exceeded |
| `0x07` | `DURATION_EXCEEDED` | Circuit or reservation duration exceeded |
| `0x08` | `PROOF_FAILED` | Proof-of-relay challenge failed |
| `0x09` | `UNAUTHORIZED` | Request not authorized (bad signature) |
| `0x0A` | `PROTOCOL_ERROR` | Protocol-level error (version mismatch, etc.) |
| `0xFF` | `INTERNAL_ERROR` | Internal relay error |

---

## 13. Security Model

### 13.1 Identity

All participants (publishers, relays, peers) are identified by Ed25519 key pairs. Public keys are 32 bytes. Signatures are 64 bytes. Key generation and signing use libsodium (`sodium-universal`).

### 13.2 Transport Encryption

All Hyperswarm connections are encrypted using the Noise protocol (specifically Noise_XX). HiveRelay does not add its own encryption layer -- it relies on the transport encryption provided by HyperDHT.

### 13.3 Message Authentication

- **Seed requests** are signed by the publisher's Ed25519 key. Relays MUST verify the signature before processing.
- **Seed acceptances** are signed by the relay's Ed25519 key. Publishers can verify which relays accepted their request.
- **Bandwidth receipts** are signed by the receiving peer's Ed25519 key. Relays (and anyone else) can verify the receipt is authentic.
- **Proof-of-relay challenges** use random nonces (32 bytes from `randombytes_buf`) to prevent replay attacks.

### 13.4 Circuit Relay Privacy

The circuit relay forwards opaque bytes. The relay:

- CANNOT read the content (it is E2E encrypted between the two peers at the Noise protocol layer).
- CAN observe the total byte count and duration of each circuit.
- CAN observe the public keys of the two connected peers.

For stronger anonymity, peers can use the optional Tor or I2P transports, which hide the IP addresses of participants from the relay.

### 13.5 Relay Verification

Relays cannot fake proof-of-relay challenges because:

1. The verifier selects a random block index and random nonce.
2. The relay must produce the actual block data within the latency bound.
3. The Merkle proof (from Hypercore's Merkle tree) cryptographically binds the block data to the Hypercore's public key.
4. Pre-fetching all possible challenge blocks is equivalent to actually storing the data, which is the desired behavior.

### 13.6 Bandwidth Receipt Non-Repudiation

A signed bandwidth receipt is a non-repudiable attestation from a peer that it received data from a relay. The peer cannot deny having received the data (assuming their key was not compromised), and the relay cannot forge a receipt (it lacks the peer's secret key).

### 13.7 Sybil Resistance

The proof-of-relay system provides natural Sybil resistance:

- A relay must actually store data to pass challenges.
- A relay must actually serve data to collect bandwidth receipts.
- The minimum challenge threshold (10 challenges) prevents newly created identities from immediately appearing in the leaderboard.
- Score decay (0.5%/day) means fake identities that stop operating quickly lose their ranking.

---

## 14. Configuration Defaults

| Parameter | Default | Description |
|---|---|---|
| `storage` | `./hiverelay-storage` | Local storage path |
| `maxConnections` | 256 | Maximum simultaneous connections |
| `enableSeeding` | `true` | Enable the seeding subsystem |
| `maxStorageBytes` | 50 GB | Maximum storage for seeded cores |
| `announceInterval` | 15 minutes | DHT re-announce interval |
| `enableRelay` | `true` | Enable the circuit relay subsystem |
| `maxRelayBandwidthMbps` | 100 | Maximum relay bandwidth |
| `maxCircuitDuration` | 10 minutes | Maximum circuit lifetime |
| `maxCircuitBytes` | 64 MB | Maximum bytes per circuit |
| `maxCircuitsPerPeer` | 5 | Maximum simultaneous circuits per peer |
| `reservationTTL` | 1 hour | Reservation expiration time |
| `proofMaxLatencyMs` | 5000 | Maximum proof-of-relay response time |
| `proofChallengeInterval` | 5 minutes | Interval between proof challenges |
| `reputationDecayRate` | 0.995 | Daily score decay multiplier |
| `minChallengesForRanking` | 10 | Minimum challenges before ranking eligibility |
| `enableMetrics` | `true` | Enable Prometheus metrics export |
| `metricsPort` | 9100 | Prometheus scrape port |
| `transports.udp` | `true` | UDP transport (always on) |
| `transports.tor` | `false` | Tor hidden service transport |
| `transports.i2p` | `false` | I2P garlic routing transport |
| `transports.websocket` | `false` | WebSocket transport for browsers |

---

## Appendix A: Region Codes

| Code | Region |
|---|---|
| `NA` | North America |
| `SA` | South America |
| `EU` | Europe |
| `AF` | Africa |
| `AS` | Asia |
| `OC` | Oceania |

## Appendix B: Cryptographic Primitives

| Primitive | Algorithm | Library |
|---|---|---|
| Key generation | Ed25519 | sodium-universal |
| Signing | `crypto_sign_detached` (Ed25519) | sodium-universal |
| Verification | `crypto_sign_verify_detached` | sodium-universal |
| Random nonces | `randombytes_buf` (32 bytes) | sodium-universal |
| Transport encryption | Noise_XX | HyperDHT (built-in) |
| Block integrity | Merkle tree (BLAKE2b) | Hypercore (built-in) |

## Appendix C: Sequence Diagram -- Full Seeding Flow

```
Publisher              DHT/Swarm             Relay Node
    |                     |                     |
    |-- join swarm ------>|                     |
    |                     |<---- join swarm ----|
    |                     |                     |
    |<--- connection -----|--- connection ----->|
    |                     |                     |
    |== open hiverelay-seed channel ==========>|
    |   (handshake: {"major":1,"minor":0})     |
    |                                           |
    |--- SEED_REQUEST (signed) --------------->|
    |                                           |
    |   [relay verifies signature]              |
    |   [relay checks capacity, region, TTL]    |
    |                                           |
    |<------------ SEED_ACCEPT (signed) -------|
    |                                           |
    |   [relay joins DHT topics for             |
    |    each discoveryKey]                     |
    |   [relay downloads all blocks]            |
    |   [relay re-announces every 15 min]       |
    |                                           |
    |== open hiverelay-proof channel =========>|
    |                                           |
    |--- PROOF_CHALLENGE (random block) ------>|
    |                                           |
    |<--------- PROOF_RESPONSE (block + proof) |
    |                                           |
    |   [verifier checks latency, data, nonce]  |
    |   [updates relay reputation score]        |
```

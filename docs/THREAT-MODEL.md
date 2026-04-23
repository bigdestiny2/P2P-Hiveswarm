# Hive: Threat Model & Defense Architecture

*Canonical source for the project's security thesis. Cite this when writing
security-relevant code or evaluating a new attack surface.*

## TL;DR

Hive is not a blockchain and doesn't need to be. It's a P2P substrate for
timestamped claims and reputation, built on Hyperswarm + hypercores.
Security model is **N-of-M trust with cryptographic append-only guarantees
at the data layer**, backed by **replica diversity** and **cross-client
verification** at the perception layer. Same pattern as Bitcoin/Ethereum
(node diversity + multiple client implementations), not the same
mechanism (no consensus state, no double-spend problem).

## Why no blockchain

Nakamoto consensus exists to solve double-spend — preventing the same
transferable asset from being committed twice. Hive has no transferable
asset. The threat model is:

1. Sybil resistance
2. Detection of dishonest reporting
3. Data integrity over time

None of these require global state agreement. They require signed
append-only logs plus observer diversity, which is cheaper and scales
further.

## Three categories of "app state"

Critical distinction. Attacks and defenses differ per category. Code
that treats them uniformly is the most common mistake in P2P security
papers.

### 1. Authored state

Entries you signed with your key. Your claims, your reputation entries
about others.

- **Attack vector:** key compromise
- **Defense:** standard key hygiene, hardware wallets for high-value
  identities, social-recovery + delegation per [P2P-Auth spec](#)
- **Cryptographic guarantee:** immutable once published, cannot be
  altered without the key

### 2. Observed state

Entries authored by others that your client displays to you.

- **Attack vector:** eclipse, selective withholding, malicious relay
  feeding you a curated subset
- **Defense:** replica diversity + fork detection
- **Note:** no key theft needed — attacker just controls your view

### 3. Derived state

Computed aggregations ("Alice has reputation 87") the client calculates
from many hypercores.

- **Attack vector:** compromised client binary, corrupted aggregation
  logic
- **Defense:** cross-client verification + reproducible builds
- **Note:** underlying data is canonical; the app is just a lens

## Defense mechanism 1: Replica diversity

Your client pulls from multiple independent relays across different
operators, jurisdictions, and network paths.

**Why it works:**

- Attacker must compromise 100% of your relays to feed a consistent lie
- One honest relay is enough to trigger hypercore's built-in fork
  detection
- Fork detection produces a cryptographic proof of equivocation (two
  different entries signed at the same position for the same pubkey)
- N-of-M security that degrades gracefully

**What it doesn't defend against:**

- Coordinated compromise across all chosen relays (choice of quorum
  matters)
- Bootstrap problem (before you've reached any honest relay)
- Real-time availability when no honest relay has latest data yet

**Implementation requirements:**

- Apps must pick geographically and organizationally diverse quorums
- Fork-detection gossip must be reliable and fast
- Client must handle quorum re-weighting per query

## Defense mechanism 2: Cross-client verification

Hypercore data is open and protocol-defined. Any client can read the raw
data and recompute derived state.

**Why it works:**

- Underlying hypercore bytes are canonical across all clients
- Deterministic aggregation means two honest clients must produce
  identical output from identical input
- Divergence between clients is proof of corruption in at least one
- Reproducible builds let technical users verify shipping binaries
  match public source

**What it doesn't defend against:**

- Monoculture risk when only one client exists (early-stage problem)
- Non-technical users who can't run a second client
- Ambiguous aggregation specs (disagreement isn't proof of corruption
  if rules are unclear)
- Fast smash-and-grab attacks before cross-verification catches up

**Implementation requirements:**

- Aggregation logic must be deterministic and specified
- Need at least 2-3 independent client implementations from day one
- Pear content-addressing for binary verification
- Public reference CLI for power-user spot checking

## How the two defenses compose

- **Replica diversity** protects the path from network → client
- **Cross-client verification** protects the path from client → user
- Together they cover both places an attacker can insert a lie
- Neither is cryptographic certainty — both are economic/social, making
  attacks **detectable and expensive** rather than impossible

## Network liveness

### Cannot reverse or corrupt data

- Hypercores are append-only and merkle-linked
- Rewriting history requires breaking SHA-256
- As long as one replica survives anywhere, data survives
- No consensus state means no fork risk when nodes reconnect

### Can experience availability degradation

- Individual relays go offline constantly (expected)
- Regional DHT firewalling (China-style)
- Coordinated failure of an app's chosen quorum
- Publisher key holder offline = no new app versions

**Key property:** the network can degrade in *availability* but cannot
*corrupt, reverse, or fork* the data. Harm in the data-integrity sense is
structurally prevented by append-only crypto plus replica diversity.

## Centralization gravity (open architectural question)

High-value workloads pull toward trusted, high-reputation operators.
Economic gravity toward concentration is real and structural.

**Current position:**

- Concentration at the app quorum layer is acceptable **if exit costs
  stay low**
- No protocol-level moat (no ASICs, no minimum stake, no licensing)
- Apps re-weight their trust graph per-query
- High-value apps pick tight validator sets; low-value apps use the
  long tail
- Selectively permissioned at app layer, permissionless at protocol
  layer

**Open problem:** who pays relay operators and alt-client developers in
year one, before reputation has monetary value?

Bitcoin/Ethereum solve this with block rewards and staking yield. Hive
needs an answer that isn't "token launch" but also isn't "VC-funded teams
forever."

→ See [`OPERATOR-INCENTIVES-Y1.md`](OPERATOR-INCENTIVES-Y1.md) for the
   project's specific answer to this problem.

## Known attacks we do NOT currently prevent

Listed honestly so we can address them with code, documentation, and
operational guidance — not pretend they don't exist.

| # | Attack | Status | Mitigation in our architecture |
|---|---|---|---|
| 1 | **Equivocation in real-time** — author signs two different entry Ns to different subsets | Detectable post-facto via fork proofs, not prevented | Replica diversity + fork-detection gossip |
| 2 | **Eclipse attacks** — adversary controlling enough DHT routing poisons your peer discovery | Mitigated, not prevented | Diverse bootstrap nodes, multiple discovery paths |
| 3 | **Data withholding** — valid relay serves entry N but hides N+1 that exists | Mitigated, not prevented | Multiple relays + length attestation |
| 4 | **Key compromise** — stolen private key can publish divergent forks to unsynced peers | Mitigated, not prevented | Hardware keys, social recovery, fast revocation in P2P-Auth spec |
| 5 | **App-layer attacks** — compromised client binary lies about what hypercores contain | Mitigated, not prevented | Cross-client verification + reproducible builds + reference CLI |
| 6 | **Publisher key compromise** — attacker pushes malicious app updates via Pear | Mitigated, not prevented | Multi-sig publisher keys, capability-bounded delegation, reproducible builds |

All mitigated by the defense mechanisms above; none eliminated. This is
the same class of residual risk as every non-PoW system including
Chainlink, every wallet, every node client.

## The honest framing

**Don't claim** "structurally impossible" or "cannot be attacked." That
framing loses to any adversary who knows the literature.

**Do claim:**

- Authored history is cryptographically immutable
- Attack surface is strictly smaller than centralized/federated systems
- Comparable to or better than blockchain systems for Hive's actual
  threat model
- Defense mechanisms are battle-tested at $1T+ scale in
  Bitcoin/Ethereum
- Residual risks are named, bounded, and mitigated in depth

## How this maps to current code

| Threat-model concept | Module / artifact | Status |
|---|---|---|
| Authored state immutability | `packages/core/core/delegation.js` (signed certs), Hyperdrive append-only | ✅ shipped |
| Hypercore append-only Merkle | upstream `hypercore` v10 | ✅ shipped |
| Replica diversity at infrastructure | `packages/core/core/federation.js` (per-relay catalog mirroring) | ✅ shipped (primitive); ⚠️ not yet wired into client quorum selection |
| Quorum selection UX | `packages/client/index.js` (`HiveRelayClient`) | ✅ shipped v0.6.0 (`selectQuorum`, `queryQuorumWithComparison`) |
| Fork-detection during local replication | `client.open()` attaches listeners to `drive.core.on('truncate' / 'verification-error')`; auto-reports to `ForkDetector` | ✅ shipped v0.6.0 (catches local fork-detected events, NOT silent multi-replica equivocation) |
| Fork-proof gossip across federation | not implemented | ❌ to build in M2 |
| Capability-doc signature | server signs with relay identity key; client verifies on fetch | ✅ shipped v0.6.0 |
| LNbits admin key encryption at rest | AES-256-GCM, key from `$APP_SEED` | ✅ shipped v0.6.0 |
| Quarantine bypass audit trail | `forkDetector.recordBypass` + persisted `bypassLog` | ✅ shipped v0.6.0 |
| Cross-client verification | one client (`@hive/client`) — needs `@hive/verifier` | ❌ to build in v0.6.0 |
| Deterministic aggregation rules | required for Operator Score | ❌ to spec in M2 |
| Capability advertisement | `/.well-known/hiverelay.json` (v0.5.1) | ✅ shipped — surfaces region/operator metadata for diverse quorum selection |
| Sybil defense layers (3-tier) | brief §6.4 spec, no code | ❌ to build in M2 alongside founder bootstrap |
| Operator Score | brief §6.5 spec, no code | ❌ to build in M2 |
| Reputation system | `packages/core/incentive/reputation/` | ⚠️ basic, needs deterministic-aggregation rewrite |

## Action items

The threat-model PDF specified six action items. Mapping each to a
roadmap milestone and owner:

| # | Action | Milestone | Owner | Status |
|---|---|---|---|---|
| 1 | Rewrite security section around 3 state categories | Now (this doc) | docs | ✅ done |
| 2 | Spec deterministic aggregation rules for Operator Score | M2 | spec council | ⏳ scheduled |
| 3 | Reference CLI for cross-client verification | v0.6.0 | engineering | ⏳ in flight |
| 4 | Quorum selection UX so apps pick diverse relays by default | v0.6.0 | engineering | ⏳ in flight |
| 5 | Operator incentives clarity before token talk | Now (`OPERATOR-INCENTIVES-Y1.md`) | strategy | ✅ done |
| 6 | Document named attacks explicitly (see table above) | Now (this doc) | docs | ✅ done |

## Companion documents

- [`MANIFESTO.md`](MANIFESTO.md) — non-negotiable architectural values
- [`Hive_Engineering_Brief.md`](Hive_Engineering_Brief.md) — architectural and business decisions; this document refines its security treatment
- [`OPERATOR-INCENTIVES-Y1.md`](OPERATOR-INCENTIVES-Y1.md) — closes the "open problem" of operator economics in year one
- [`CRYPTO-GUARANTEES.md`](CRYPTO-GUARANTEES.md) — concrete cryptographic primitives used, audit chain

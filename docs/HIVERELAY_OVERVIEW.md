# HiveRelay: Infrastructure for the Peer-to-Peer Internet

## The Problem

Peer-to-peer apps disappear when the developer closes their laptop. End users see "offline." Data goes dark. The app that worked in the demo fails in production.

HiveRelay fixes this. Five lines of code, and your app is always on.

```js
import { HiveRelayClient } from 'p2p-hiverelay/client'
const app = new HiveRelayClient('./storage')
await app.start()
const drive = await app.publish([{ path: '/index.html', content: '<h1>Always On</h1>' }])
// Your app is now available 24/7 from relay nodes. Close your laptop.
```

No servers. No accounts. No cloud vendor. Just more peers that happen to be always online.

## What HiveRelay Is

HiveRelay is an always-on relay backbone for the Holepunch/Pear ecosystem. A relay node is a Hyperswarm peer that joins the same DHT, speaks the same protocols, and replicates the same Hypercores. There is no separate network, no gateway, no proxy.

The system has four core functions:

1. **Content Seeding** -- Relay nodes accept and replicate Hyperdrives so app data stays available when the original publisher is offline.

2. **Circuit Relay** -- NAT-blocked peers forward encrypted bytes through relay nodes when direct hole-punching fails. The relay sees only opaque ciphertext.

3. **Proof-of-Relay** -- Cryptographic hash challenges verify that relay nodes actually store and serve the data they claim to. No proof, no reputation.

4. **Application Router** -- A fast dispatch layer that routes requests to services, enables pub/sub event streams, and offloads heavy compute to worker threads.

---

## Architecture

```
                   Pear App / Client SDK
                          |
                 Hyperswarm DHT (discovery)
                          |
              +-----------+-----------+
              |                       |
         Relay Node A            Relay Node B
              |                       |
    +---------+---------+    +--------+--------+
    |         |         |    |        |        |
  Seeder   Relay    Router  Seeder  Relay   Router
    |       Circuit    |      |     Circuit    |
  Hyper-   (NAT     PubSub  Hyper-  (NAT    Services
  drive    bypass)  Workers  drive   bypass)  (storage,
  repli-     |        |     repli-    |       identity,
  cation   Proof-of   |    cation  Proof-of   compute,
           Relay    Service        Relay      AI, ZK)
             |      Registry         |
         Reputation               Reputation
             |                       |
         Payment (Lightning)     Payment
```

### Discovery Flow

All relay nodes announce on a well-known DHT topic (`hiverelay-discovery-v1`). Client SDKs join this topic and the DHT connects them to relays within 2-5 seconds. No central registry, no hardcoded URLs, no accounts.

### Data Flow

1. Developer publishes content via the SDK -- creates a Hyperdrive, writes files, announces on DHT
2. SDK broadcasts a signed seed request over Protomux to connected relays
3. Relays with capacity accept and begin replicating
4. Developer goes offline -- data remains available from relay nodes
5. End users open the app by key -- the DHT finds peers (relays and other users) and replicates

### Privacy Model

Apps declare their own privacy tier:

| Tier | What the Relay Sees | Where Data Lives | Example Use |
|------|-------------------|-----------------|-------------|
| Public | Everything | Relay (cached, indexable) | Marketplaces, docs, public content |
| Local-First | App code only | Device (encrypted at rest) | POS systems, wallets, personal tools |
| P2P-Only | Nothing | Device only (encrypted, P2P sync) | Medical records, financial data, messaging |

Blind mode allows encrypted app replication where the relay stores ciphertext it cannot decrypt. Peers discover the app via the relay catalog, then connect directly with the encryption key.

**Enforcement is fail-safe.** Privacy tiers are not advisory — they are enforced by **PolicyGuard**, a single-purpose guardrail on every relay node. If a `local-first` app's user data attempts to reach the relay, or a `p2p-only` app attempts to be served by a relay, the app is immediately suspended. No warnings, no grace period. The three-layer privacy stack:

1. **Privacy Tiers** (app manifest) — Developer declares intent
2. **PolicyGuard** (relay core) — Relay enforces the tier's relay exposure rules at seeding, storage writes, and manifest indexing
3. **AccessControl** (HomeHive mode) — Operator controls which devices can connect at all

---

## Use Cases

### Today (Implemented)

**Always-on Pear apps.** A developer publishes a Pear app, closes their laptop, and the app continues to be available from relay nodes. End users never know they are talking to a relay instead of the developer.

**NAT traversal fallback.** When two peers behind NATs cannot hole-punch, the relay forwards encrypted bytes between them. Max 64MB per circuit, 10-minute duration, bidirectional with backpressure.

**Keet and Pear POS availability.** Any Pear-ecosystem app benefits from shared relay infrastructure. One relay node serves the entire ecosystem, not a single app.

**Local-first private nodes (HomeHive).** Private or hybrid mode relay nodes serve a household or small business. mDNS broadcasts on the LAN for zero-config discovery. Device pairing with time-limited tokens. Encrypted backups of the device allowlist.

**Tor-accessible relays.** Operators can expose relay nodes via Tor hidden services. Peers connect via .onion addresses without revealing IP addresses on either side.

**Agent-operated infrastructure.** The HTTP API is designed for AI agent integration. Agents can monitor, seed, unseed, scale, and optimize relay fleets via simple HTTP calls.

### Near-Term (Enabled by the Router + Services Layer)

**Decentralized compute.** The compute service accepts task submissions with a job queue. Apps can offload CPU-heavy work (data processing, ML inference) to relay nodes running worker threads, paying per-task via Lightning.

**AI inference at the edge.** The AI service wraps local or remote models (Ollama, OpenAI-compatible endpoints). A Pear app can call `infer()` on a relay node running a local LLM, keeping data within the P2P network.

**Zero-knowledge proofs as a service.** The ZK service provides commitments, Merkle membership proofs, and range proofs. Privacy-preserving applications can delegate proof generation to relay nodes.

**Real-time event streams.** Pub/sub enables apps to subscribe to topics (new content, peer events, service updates) and receive pushed data. Over P2P via Protomux or over HTTP via Server-Sent Events.

**Unified service dispatch.** The router lets apps call any service on any relay node through a single interface, whether the request arrives via P2P or HTTP. Apps never need to know which relay hosts which service.

### Future (What the Architecture Enables)

**Decentralized CDN.** Relay nodes in multiple regions can serve Hyperdrive content over HTTP via the Hyper Gateway. Combined with geo-preference in seed requests, this creates a P2P content delivery network where popular apps are replicated to nodes closest to users.

**Marketplace infrastructure.** A public relay network with reputation scoring and Lightning payments creates a two-sided market: app developers pay for availability, relay operators earn for uptime and bandwidth. The held-amount schedule (Storj-inspired) incentivizes long-term participation.

**Identity and credential services.** The identity service already provides signing, verification, and peer resolution. This can be extended to verifiable credentials, attestations, and trust graphs -- all routed through the relay network without a central identity provider.

**Cross-app data portability.** Because all apps use the same Hyperdrive/Hypercore primitives and the same relay infrastructure, data can flow between apps. A POS system and an accounting app can share encrypted transaction records via the same relay network.

**Autonomous infrastructure scaling.** With agent integration, reputation scoring, and payment settlement, the network can self-scale: agents monitor demand, spin up relay nodes in underserved regions, and earn revenue proportional to service quality.

**Privacy-preserving analytics.** ZK proofs enable relay nodes to prove aggregate statistics (total users, bandwidth served) without revealing individual user data. Useful for app developers who need usage metrics without compromising user privacy.

**Federated mesh networks.** Private relay nodes (HomeHive) connected to the public relay network via tunnels create a federated architecture: homes and businesses run their own infrastructure but can bridge to the global network when needed.

---

## Economics for Relay Operators

### Revenue Streams

The payment system uses Bitcoin Lightning micropayments with four pricing tiers:

| Service | Rate | Unit |
|---------|------|------|
| Storage | 100 sats | per GB per month |
| Bandwidth | 50 sats | per GB transferred |
| Circuit Relay | 75 sats | per GB relayed |
| Availability | 10 sats | per hour of guaranteed uptime |

At current Bitcoin prices (~$100,000/BTC as of early 2026), these translate roughly to:

| Service | Approximate USD |
|---------|----------------|
| 50GB storage/month | $0.50/month |
| 1TB bandwidth/month | $5.00/month |
| Availability (24/7) | $7.20/month |
| **Total for a moderate node** | **~$12-15/month** |

Revenue scales with demand. A relay node in a high-traffic region seeding popular apps earns proportionally more.

### Held-Amount Schedule

New operators have earnings partially held back to discourage hit-and-run behavior:

| Months Active | Held Back | Payable |
|--------------|-----------|---------|
| 1-3 | 75% | 25% |
| 4-6 | 50% | 50% |
| 7-9 | 25% | 75% |
| 10+ | 0% | 100% |

Held amounts are returned after 15 months of good standing. Failed proof-of-relay challenges or data corruption triggers slashing of held funds.

### Reputation and Earnings

Revenue is directly tied to reputation. Higher-reputation nodes are selected first for seeding requests, meaning they handle more traffic and earn more. Reputation is built through:

- Passing proof-of-relay challenges (+10 points per pass, -20 per fail)
- Serving bandwidth (+0.001 points per MB, verified via signed receipts)
- Maintaining uptime (+1 point per hour)
- Serving underserved regions (+50 point bonus)
- Daily decay (x0.995/day -- operators must stay active)

A relay that goes offline for a week loses ~3.5% of its score. One that fails challenges loses much more. This creates a natural incentive toward reliable operation.

### Cost Structure

**Minimum viable setup:**

| Component | Cost | Notes |
|-----------|------|-------|
| $5/month VPS | $60/year | 1 vCPU, 1GB RAM, 25GB SSD (DigitalOcean, Hetzner) |
| Domain (optional) | $12/year | For HTTPS via Caddy |
| **Total** | **~$72/year** | |

At moderate utilization (~$12-15/month revenue), a $5 VPS operator breaks even or earns a small margin. The economics improve significantly at scale.

**Raspberry Pi / home hardware:**

| Component | Cost | Notes |
|-----------|------|-------|
| Raspberry Pi 4/5 | $35-80 (one-time) | 4GB+ RAM recommended |
| SD card or SSD | $15-40 (one-time) | 64GB+ for meaningful seeding capacity |
| Electricity | ~$5/year | Pi draws 3-5W |
| **Total** | **~$55-125 one-time + $5/year** | |

Home hardware has near-zero marginal cost after initial purchase, making it the most profitable long-term setup for operators who already have internet connectivity.

**Dedicated server (high-capacity):**

| Component | Cost | Notes |
|-----------|------|-------|
| Dedicated server | $30-50/month | 8+ vCPU, 16GB RAM, 500GB+ NVMe |
| **Projected revenue** | $50-100+/month | At high utilization in underserved region |

The economic model rewards geographic diversity. An operator running a relay in Southeast Asia or Africa, where fewer relays exist, earns the region bonus and handles proportionally more traffic.

---

## Hardware Requirements

### Minimum (Hobbyist / Testing)

- **CPU:** 1 vCPU (ARM or x86)
- **RAM:** 1 GB
- **Disk:** 10 GB
- **Network:** UDP outbound (no inbound ports required for basic operation)
- **OS:** Linux, macOS, or Windows with Node.js 20+

Runs on: Raspberry Pi 3/4/5, any $5 VPS, old laptops

### Recommended (Production)

- **CPU:** 2+ vCPU
- **RAM:** 2-4 GB
- **Disk:** 50-100 GB SSD
- **Network:** 100 Mbps+ with UDP and TCP access
- **OS:** Ubuntu 22.04/24.04 or Debian 12

Runs on: Standard VPS ($10-20/month), small dedicated servers

### High-Capacity (Fleet / Professional)

- **CPU:** 4-8+ vCPU
- **RAM:** 8-16 GB
- **Disk:** 500 GB - 1 TB NVMe
- **Network:** 1 Gbps+ symmetric
- **Worker threads:** 2-4 (for compute/AI/ZK services)
- **Optional:** LND node for Lightning payments

Runs on: Dedicated servers ($30-50/month), bare metal

### Worker Thread Sizing

The router's worker pool is configured via `routerWorkers` in the config. Guidelines:

| Workload | Workers | Notes |
|----------|---------|-------|
| Relay + seeding only | 0 | No workers needed, all I/O-bound |
| Storage + identity services | 0-1 | Light CPU, mostly I/O |
| Compute tasks | 2-4 | Scales with concurrent jobs |
| AI inference (local models) | 2-4 | CPU-bound, benefits from parallelism |
| ZK proof generation | 2-4 | CPU-intensive, benefits from dedicated threads |

---

## Token and Payment Model

### Current State

Phase 1 (implemented) provides all the accounting infrastructure without requiring actual payments:

- **PaymentManager** tracks earnings, held amounts, and settlement ledgers per relay
- **BandwidthReceipt** creates signed, replay-protected receipts for data transfers
- **MockProvider** simulates payments for development and testing
- **ReputationSystem** scores relays based on proof-of-relay challenges, uptime, and bandwidth

### Phase 2: Lightning Micropayments

The payment layer is designed for Bitcoin Lightning Network integration:

- **LightningProvider** connects to an LND node via gRPC with macaroon authentication
- Daily settlement cycle: accumulated earnings are paid out when balance exceeds threshold (default: 1000 sats)
- Held-amount schedule creates economic alignment between short-term and long-term participants
- Slashing mechanism punishes provably bad behavior

### Token Considerations

HiveRelay does not require its own token. The payment model uses Bitcoin (satoshis) via Lightning, which provides:

- **No token issuance overhead** -- operators earn real BTC, not a speculative asset
- **Instant settlement** -- Lightning payments settle in seconds
- **Low fees** -- Micropayment channels minimize per-transaction cost
- **Universal liquidity** -- Operators can spend earnings immediately

If the ecosystem grows to require more sophisticated coordination (governance, staking, service-level agreements), a token model could be layered on top of the existing infrastructure. But the current design intentionally avoids it to reduce barriers to entry.

### Alternative Payment Rails

The PaymentManager is provider-agnostic. The `paymentProvider` interface requires only:

```javascript
{
  connect()       // Initialize provider
  pay(address, amount)  // Send payment
  createInvoice(amount) // Receive payment
  disconnect()    // Clean up
}
```

This can be implemented for Cashu ecash, on-chain Bitcoin, stablecoins, or traditional payment processors without changing the accounting logic.

---

## Strategic Roadmap: From Infrastructure to Platform

The following additions represent the evolution from a relay network to a self-governing, premium infrastructure platform. Each builds on components already implemented in the codebase.

### What's Built: The Services + Router Layer (Complete)

The following are fully implemented and tested (201 unit tests passing):

**Application-Layer Router** -- the central dispatch layer for all services across all transports.
- O(1) Map-based route dispatch with automatic registration from service manifests
- Transaction orchestration: multi-step service chains (e.g., `storage.read -> compute.run -> zk.prove`) with atomic rollback on failure
- Trace IDs propagated through every dispatch for observability
- Per-route rate limiting (token bucket per peer per route)
- Named worker thread pools (`cpu` and `io`) preventing heavy compute from starving I/O
- Pub/Sub engine: exact O(1) topic matching + glob patterns, delivered over P2P (Protomux) and HTTP (Server-Sent Events)
- Middleware chain for auth, metering, and policy enforcement

**SLA Contracts** (`sla` service) -- staked performance guarantees with automated enforcement.
- Operators create contracts staking collateral against reliability and latency guarantees
- Enforcement is fully automated: 60-second check interval reads proof-of-relay scores and reputation data
- Violations trigger immediate collateral slashing via PaymentManager
- Auto-termination after 3 violations with remaining collateral seized
- All lifecycle events published to pub/sub (`sla/created`, `sla/violation`, `sla/terminated`, `sla/expired`)

**Schema Registry** (`schema` service) -- cross-app data interoperability.
- Register versioned JSON Schema definitions with publisher attribution
- Multi-version support per schema ID
- Inline JSON Schema validator (type checking, required fields, min/max, enum, array items, nested properties)
- Optional persistence to seeding registry Hypercore log as `schema-register` entries
- No external dependencies -- matches codebase pattern of inline implementations

**Decentralized Arbitration** (`arbitration` service) -- peer-adjudicated dispute resolution.
- Submit disputes with evidence: bandwidth receipts, proof-of-relay results, SLA contract data
- Arbitrator eligibility gated by reputation (score > 100, reliability > 95%, 50+ challenges, no conflict of interest)
- Majority-vote resolution when minimum vote threshold reached
- Winners gain reputation (+10), losers penalized (-20), respondent slashed if claimant wins
- Evidence verification via `BandwidthReceipt.verify()` for cryptographic proof validation

### Next Phases

**Phase 3: Enterprise Readiness**
- OpenAPI specification for router dispatch interface
- Anchor partner program with time-limited regional reputation multipliers
- Public testnet for developer onboarding before production deployment
- Distributed tracing integration (OpenTelemetry) for enterprise observability

**Phase 4: Economic Layer**
- Lightning micropayment settlement (LND gRPC integration built, settlement logic ready)
- Fee splitting (operator/burn/pool) with deflationary mechanics
- Staking tiers gating service access and reward share
- Proof-of-Contribution reward halving schedule

**Phase 5: Scale**
- I2P transport for garlic-routed anonymity
- Cross-region relay routing with geographic optimization
- Predictive load balancing from historical performance data
- Governance mechanism for protocol parameter changes

### Growth Strategy: Solving the Cold Start Problem

A decentralized network with no nodes has no value. The following strategies bootstrap the initial network effect:

**1. Anchor Partner Program.** Identify 2-3 partners in geographically diverse, underserved regions (Southeast Asia, Africa, Latin America). Offer a time-limited reputation multiplier (2x region bonus for the first 12 months) and co-marketing. These anchors create instant network presence and flagship case studies.

**2. Developer-First Onboarding.** Lead every interaction with the outcome ("your app stays online"), not the architecture. The SDK's 5-line integration is the product. Everything else is infrastructure the developer never sees.

**3. Public API Specification.** Formalize the router's dispatch interface as an OpenAPI spec. This makes the API -- not the underlying Hyperswarm protocol -- the stable contract. Protocol internals can evolve; the API surface remains constant. Third-party tools, dashboards, and integrations can build against the spec without coupling to implementation details.

**4. Testnet-to-Mainnet Pipeline.** The existing `hiverelay testnet` command creates isolated local networks for development. Extend this with a public testnet where developers can experiment with seed requests, circuit relay, and service calls against real relay nodes before committing to production deployment.

---

## What HiveRelay Enables for the Ecosystem

### For App Developers

- **5 lines of code** to make any Pear app always-available
- No servers, no accounts, no cloud vendor lock-in
- Privacy tiers let developers choose the right tradeoff per app
- Blind mode for applications that must never expose user data
- 8 services accessible via single dispatch: storage, identity, compute, AI, ZK, SLA, schema, arbitration
- Multi-step transaction orchestration with atomic rollback
- Real-time event streams via pub/sub (P2P or SSE)
- Schema registry for cross-app data interoperability without shared code
- SLA contracts for guaranteed availability on production apps

### For Relay Operators

- Earn Bitcoin for running infrastructure
- Reputation system rewards reliability over time
- Low barrier to entry ($5/month VPS or a Raspberry Pi)
- Premium revenue tiers: commodity bandwidth -> compute/AI/ZK services -> SLA guarantees
- Geographic diversity bonuses incentivize global coverage
- Named worker pools let high-end hardware (Mac Studio, GPU rigs) serve AI inference and ZK proofs
- Agent-friendly API enables automated fleet management
- Arbitration participation for high-reputation operators

### For the Holepunch/Pear Ecosystem

- Shared infrastructure that serves all apps, not just one
- Discovery and availability without a central registry
- A path from "cool demo" to "production-ready" for P2P applications
- Circuit relay makes P2P apps work in restrictive network environments
- Economic model that sustains infrastructure long-term

### For the Broader P2P Space

- Proof that P2P infrastructure can be economically self-sustaining
- A working implementation of verifiable relay (proof-of-relay, bandwidth receipts)
- Privacy tiers as a design pattern for tiered data sovereignty
- A services layer that makes P2P nodes more than just file servers
- Router + worker pool pattern for hybrid I/O + compute workloads in P2P systems

---

## Technical Summary

| Component | Implementation | Status |
|-----------|---------------|--------|
| Content Seeding | Hyperdrive/Hypercore replication over Hyperswarm | Production |
| Circuit Relay | Bidirectional stream forwarding with backpressure | Production |
| Proof-of-Relay | BLAKE2b hash challenges + Merkle proof verification | Production |
| Bandwidth Receipts | Ed25519 signed receipts with 50K nonce replay buffer | Production |
| Reputation System | Score/decay/leaderboard with composite relay selection | Production |
| Application Router | O(1) Map dispatch, transaction orchestration, trace IDs, per-route rate limits | Production |
| Pub/Sub | Two-tier (exact O(1) + glob), SSE + P2P delivery via Protomux | Production |
| Worker Pool | Named pools (cpu/io), auto-respawn, task queue with backpressure | Production |
| Services Layer | Storage, Identity, Compute, ZK, AI (pluggable) | Production |
| SLA Contracts | Automated proof-of-relay enforcement, collateral staking + slashing | Production |
| Schema Registry | JSON Schema registration, inline validation, multi-version, Hypercore persistence | Production |
| Decentralized Arbitration | Peer-adjudicated disputes, reputation-gated voting, evidence verification | Production |
| Privacy Tiers | Public / Local-First / P2P-Only + blind mode | Production |
| Tor Transport | Hidden service inbound + SOCKS5 outbound | Production |
| WebSocket Transport | Browser peer connectivity | Production |
| Lightning Payments | LND gRPC integration | Phase 2 |
| I2P Transport | SAM bridge connectivity | Phase 2 |
| OpenAPI Specification | Formal router dispatch contract | Phase 3 |

### Codebase

- ~12,000 lines of application code across 60+ files
- ESM modules, Node.js 20+, Apache 2.0 license
- Dependencies: Hyperswarm, Hypercore, Hyperdrive, Protomux, sodium-universal, pino
- Test suite: 201 unit tests (brittle framework)
- Deployment: npm package, Docker, systemd service, Raspberry Pi

---

## Strategic Position

HiveRelay occupies a unique position: it is both the lowest layer (data availability, NAT traversal) and a higher-order platform (compute, AI, ZK services) for the P2P ecosystem. This vertical integration is the strategic moat.

**Layer 1 -- Infrastructure:** Seeding, circuit relay, proof-of-relay. This is the utility that every Pear app needs. It creates baseline demand.

**Layer 2 -- Services:** Storage, identity, compute, AI, ZK. This is the value-add that makes relay nodes more than dumb pipes. It creates differentiation and premium revenue.

**Layer 3 -- Trust:** Reputation, SLA contracts, arbitration, schema interoperability. This is the governance layer that makes the network trustworthy enough for enterprise adoption. It creates lock-in through reliability guarantees.

Each layer builds on the one below it. A relay node running all three layers earns the most, serves the widest range of applications, and has the strongest reputation. The economic model naturally drives operators toward full-stack participation.

The end state is not a relay network. It is a decentralized, self-governing, economically self-sustaining compute and data fabric for the peer-to-peer internet.

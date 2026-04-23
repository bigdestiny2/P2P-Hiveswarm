# Relay Operator Economics

> **Where this doc stands.** Written *after* the Compute removal and Core/Services
> split. The pre-refactor version of this doc modeled compute jobs as the
> dominant revenue driver — that revenue line no longer exists. Numbers
> quoted below are framework-level, not promises. Lightning settlement is
> not yet live, so all current operation is on the bootstrap reputation
> phase. See [REFACTOR-NOTES.md](REFACTOR-NOTES.md) for the architecture.

## Who earns

| Participant | How | What they bring |
|---|---|---|
| **Core operators** (`p2p-hiverelay`) | Storage seeded × time + bandwidth relayed + proof-of-relay reputation | Hardware, bandwidth, uptime |
| **Services operators** (`p2p-hiveservices`) | Per-call fees on AI inference / identity / storage CRUD / SLA / ZK | Same as Core + GPU/CPU + opinionated trust |
| **Arbitrators** | Reputation for resolving disputes | Stake at risk + judgment |
| **App developers** | Indirectly — their apps stay online, so they can monetize them downstream | Content published to the network |

**Cannot earn.** No passive holders, no speculators, no referral middlemen, no token pre-mine, no airdrop. This is a physical-infrastructure economy.

## Two operator products, two trust surfaces

The Core/Services split is also an economics split. Operators choose one:

### Core-only operators (`p2p-hiverelay`)

What they run: seeding (including blind-encrypted), circuit relay, HTTP gateway, proof-of-relay challenges. **Trust surface: small.** They see encrypted bytes, can drop connections, can decide what to seed at accept-time. They cannot see app contents.

What they earn:
- **Phase 1 (now):** Proof-of-relay reputation. No money, no token. Bootstrap.
- **Phase 2 (when Lightning lands):** Storage-byte-month + bandwidth-GB fees, paid per-relay by the apps using them. **Low margin, high volume.** Commodity bandwidth pricing.

Hardware profile: a $5/month VPS, a Raspberry Pi, an old laptop. The bar is intentionally low — availability should be cheap and widely distributed.

### Services operators (`p2p-hiveservices`)

What they run: everything Core does, plus AI inference, identity (LNURL-auth), schemas, SLA contracts, storage CRUD helpers, ZK, arbitration.

**Trust surface: large.** They see request payloads (LLM prompts, schema data), process them, charge for them. Different operator profile — closer to a cloud provider.

What they earn:
- **Phase 1 (now):** Free during beta. No rate card live.
- **Phase 2 (when Lightning lands):** Per-call fees on AI inference and identity ops. **High margin, variable volume.** AI inference is the flagship.

Hardware profile: GPU or Apple Silicon for AI inference. Can also host identity / schema / SLA on lower-spec hardware if AI is disabled.

## Revenue mix — what to expect at maturity (Phase 2+)

These are framework expectations, not commitments. Numbers depend on what
the rate card looks like when Lightning ships and on actual app adoption.

| Operator type | Likely revenue mix |
|---|---|
| Core-only on a $5 VPS | 100% storage + bandwidth (commodity) |
| Core-only on a home server | Storage + bandwidth + proof-of-relay reputation premium |
| Services on Apple Silicon | ~70-90% AI inference, ~10-20% identity/schema, ~5-10% storage/bandwidth |
| Services on dedicated GPU | ~85-95% AI inference, rest split across other services |

**The asymmetry is the whole point of the split.** Core operators run a low-margin commodity business. Services operators run a higher-margin specialized business that depends on Core operators existing. The economics shouldn't be bundled because the rate cards aren't comparable.

## What you can earn today (Phase 1, reputation-only)

No money. The current network runs on:
- Operators get a public reputation score derived from passed proof-of-relay challenges
- Higher reputation → more inbound seed requests routed to your node
- The reputation is cryptographically verifiable (challenge-response over signed bandwidth receipts)

This is the bootstrap. The point is to prove operators show up reliably *before* introducing money — so when Lightning ships, the network already has a curated set of high-reputation operators who've been earning trust by doing the job.

## Operator scale tiers (qualitative)

| Tier | Hardware | Bandwidth | Realistic role |
|---|---|---|---|
| **Hobbyist** | Raspberry Pi, home laptop, $5 VPS | Whatever the home connection gives | Community Core operator. Reputation builder. |
| **Prosumer** | Mid-tier desktop or Apple Silicon Mac mini | Residential gigabit or basic VPS | Core + light Services (AI on local model, no SLA staking). |
| **Small operator** | Mac Studio, dedicated GPU box, or rented bare-metal | Datacenter gigabit | Full Services. Multiple AI models. SLA contracts when Phase 2 lands. |
| **Large operator** | Multi-GPU rack | Multi-Gbps datacenter | Inference farm. Treats this like a cloud business. |

## Why no token

Two reasons.

**1. Tokens before product is a trap.** A token launch puts the operator economy in front of working infrastructure. The token becomes the product, attention shifts to price action, and the network's actual job (keeping P2P content available) gets neglected. We do the inverse: prove the network works first, then add money via Lightning, then revisit whether a token adds anything.

**2. Lightning is enough to start.** Per-call sat-denominated payments are exactly the granularity HiveRelay needs. No ICO, no pre-mine, no governance theater — just operators getting paid for service rendered. If a token shows up later, it should solve a specific problem (programmatic SLA collateral, cross-relay credit pooling) rather than be the funding mechanism.

## Settlement timeline

| Phase | Status | What's earned | How it's paid |
|---|---|---|---|
| 1 — Reputation bootstrap | **Live** | Reputation score | Not paid (proof of work, no money) |
| 2 — Lightning per-call | Pending LND/CLN integration | Per-call sats per the rate card | Lightning invoices, settled per node |
| 3 — SLA contracts with collateral | Pending Phase 2 | Premium for guaranteed availability | Held collateral, slashed on miss |
| 4 — Cross-relay credit pooling | Hypothetical | Operators earn from apps that use multiple nodes | Not designed yet |

**Phase 2 is gated on Lightning settlement actually landing**, not announced timelines. If you're an operator running Phase 1 today: you're investing time and bandwidth in reputation. The rate card lives in [ECONOMICS.md](ECONOMICS.md) as the proposed Phase-2 starting point, but it isn't live and it'll change before launch.

## What changed from the old version of this doc

| Old assumption | Reality post-refactor |
|---|---|
| Compute jobs are the primary revenue driver (10-15k jobs/day) | Compute service removed entirely. Re-introduction would be a new product line with its own threat model. |
| Worker pool sizing dominates hardware planning | Worker pool stays for I/O offload, but isn't a revenue-bearing service surface. |
| `compute.submit` rate of 5-10 sats/job × thousands of jobs/day was the path to profitability | Path to profitability is AI inference + storage byte-month. Different math, different hardware profile. |
| All operators run all services | Most operators will run Core only. Services operators are a deliberate subset with bigger hardware and higher trust commitments. |

If you're modelling earnings, throw out the old numbers from this doc's prior version and start from the actual rate card in [ECONOMICS.md](ECONOMICS.md), with the Phase-2 caveat in mind.

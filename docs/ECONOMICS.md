# HiveRelay: Token Economics and Incentive Design

**Version:** 0.1.0-draft
**Date:** April 2026
**Status:** Request for Comments

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Design Principles](#3-design-principles)
4. [Three-Phase Rollout Model](#4-three-phase-rollout-model)
5. [Proof-of-Relay Economics](#5-proof-of-relay-economics)
6. [Anti-Gaming Analysis](#6-anti-gaming-analysis)
7. [Market Dynamics](#7-market-dynamics)
8. [Game Theory Analysis](#8-game-theory-analysis)
9. [Risk Analysis](#9-risk-analysis)
10. [Comparison to Existing Models](#10-comparison-to-existing-models)
11. [Governance](#11-governance)
12. [Open Questions](#12-open-questions)

---

## 1. Executive Summary

HiveRelay is a shared peer-to-peer relay backbone for the Holepunch/Pear ecosystem. Relay nodes seed Pear applications (Hypercores and Hyperdrives) and forward connections for NAT-challenged peers. This paper describes an incentive system designed to sustain that infrastructure without centralizing it.

The core economic model is built on three commitments:

1. **Real demand precedes token issuance.** No token is minted until a functioning marketplace proves that developers will pay for relay service. This avoids the emission death spiral that has plagued pure-incentive networks.
2. **Skin in the game without exclusion.** Operators demonstrate commitment through held earnings and stake, not through expensive hardware. A Raspberry Pi or a $5/month VPS is a valid relay.
3. **Honest behavior is the cheapest strategy.** The cost of gaming the system exceeds the cost of operating honestly, at every level of the protocol.

The rollout proceeds in three phases:

- **Phase 1 (Community Relay Network):** No token, no payments. Operators earn reputation through cryptographically verifiable proofs of relay service. Duration: 6-12 months minimum. Purpose: establish baseline metrics, prove the protocol works, build a real operator community.
- **Phase 2 (Direct Payment Marketplace):** App developers pay relay operators directly via Bitcoin Lightning micropayments. A held-amount schedule (inspired by Storj) ensures operator commitment. Market-based pricing establishes the real cost of relay service. Duration: 12-18 months.
- **Phase 3 (Optional HIVE Token + Delegation):** Launched only if Phase 2 demonstrates sustained organic demand. A work-token model ties staking to actual service provision. Quadratic staking curves prevent whale domination. Geographic diversity multipliers incentivize coverage in underserved regions. Retroactive distribution rewards Phase 1 and Phase 2 operators.

**Key design principles:**

- No VC allocation. No ICO. No "number go up" narrative.
- Fixed token supply with no inflation.
- Every unit of reward is backed by a cryptographically verifiable unit of work.
- The system must be profitable for operators *before* any token subsidy exists.

---

## 2. Problem Statement

### 2.1 The Cold-Start Problem

Every peer-to-peer network faces a bootstrapping dilemma: the network is only valuable when it has sufficient participants, but rational participants only join valuable networks. For relay infrastructure, this problem is acute. A Pear application developer needs relays *today* to serve their users. They cannot wait for the network to reach critical mass organically.

Traditional solutions to the cold-start problem include:

- **Altruism:** Rely on volunteers. This is the Tor model.
- **Subsidy:** Pay operators with newly minted tokens. This is the Helium model.
- **Central provision:** Run the infrastructure yourself. This is the Web2 model.

Each of these approaches fails in a distinct way.

### 2.2 Why Altruism Alone Does Not Scale

The Tor network has operated on volunteer bandwidth since 2002. As of 2025, the network carries approximately 20 Gbps of aggregate traffic across roughly 7,000 relays. While this is a remarkable achievement of volunteerism, it represents a tiny fraction of global internet capacity. Tor has persistent bandwidth bottlenecks, and the network's growth has been roughly linear over two decades rather than exponential.

The fundamental issue is that altruistic contribution follows a power-law distribution: a small number of institutional operators (universities, privacy-focused organizations, hobbyists with disposable income) provide the majority of capacity. This creates three problems:

1. **Capacity ceiling.** The total capacity is bounded by the altruistic budget of the ecosystem, which does not scale with demand.
2. **Geographic concentration.** Altruistic operators cluster in wealthy, tech-literate regions (Western Europe, North America), leaving users in the Global South underserved.
3. **Quality inconsistency.** Without economic incentive, there is no mechanism to ensure uptime, bandwidth quality, or long-term commitment.

### 2.3 Why Pure Token Emission Fails

Helium (HNT) launched in 2019 with a model that paid hotspot operators in newly minted tokens for providing wireless coverage. The initial growth was extraordinary: over 900,000 hotspots deployed by mid-2023. But the economics were hollow:

- **Revenue mismatch.** At peak deployment, Helium hotspots generated roughly $6,500/day in data transfer revenue while distributing approximately $2.5 million/day in token emissions. The ratio of real demand to subsidy was approximately 1:385.
- **Gaming.** Because rewards were based on claimed coverage rather than actual usage, operators spoofed locations, clustered hotspots, and deployed units with no real users nearby. An estimated 30-50% of deployed hotspots served no actual data traffic.
- **Death spiral.** When token price declined, marginal operators shut down, reducing network quality, which reduced demand, which further depressed price. The emission schedule continued regardless, diluting remaining holders.

The lesson: **emitting tokens to subsidize infrastructure that nobody is paying to use creates a speculative bubble, not a network.**

### 2.4 The Challenge

HiveRelay must solve a four-sided optimization problem:

1. **Bootstrap infrastructure** before demand exists (cold-start).
2. **Sustain infrastructure** through real economic incentives once demand arrives.
3. **Prevent gaming** of the incentive mechanism without requiring trust in any central authority.
4. **Keep barriers low** enough that a hobbyist with a Raspberry Pi can participate.

These constraints are in tension. Low barriers invite Sybils. Economic incentives invite gaming. Decentralized verification is expensive. This paper describes a design that navigates these tradeoffs by staging the rollout so that each phase provides the information and infrastructure needed for the next.

---

## 3. Design Principles

The following principles govern every design decision in this paper. When tradeoffs arise, earlier principles take precedence.

### Principle 1: Real Demand Must Precede Token Issuance

No token is created until a functioning, token-free marketplace demonstrates that application developers will pay real money (BTC via Lightning) for relay services. The purpose of a token is to improve the efficiency of an existing market, not to create the illusion of a market that does not exist.

**Implication:** Phase 3 has explicit, quantitative success criteria that Phase 2 must satisfy before any token is minted.

### Principle 2: Skin in the Game

Every participant must have something at risk that is proportional to the trust the network places in them. For operators, this means either held earnings (Phase 2) or staked tokens (Phase 3). The cost of defection must always exceed the benefit.

**Formally:** For any cheating strategy `S` with expected gain `G(S)`, the system must ensure that the expected penalty `P(S)` satisfies:

```
P(S) > G(S) + ε
```

where `ε` accounts for the risk premium a rational actor requires.

### Principle 3: Low Barrier to Entry, High Barrier to Sybil

Running a single honest relay should be cheap. Running many dishonest relays should be expensive. The mechanism that achieves this is *stake-per-unit-capacity*: operating one relay requires a small stake, but claiming to offer 100x the capacity requires 100x the stake, and the system verifies that the claimed capacity exists through cryptographic challenges.

### Principle 4: Predictable Returns with Upside Potential

Operators should be able to estimate their monthly earnings with reasonable confidence. Unpredictable returns attract speculators and repel infrastructure operators. The base earnings model is deterministic: `earnings = f(verified_work, reputation, stake)`. Upside comes from market dynamics (increased demand) and geographic scarcity bonuses, not from token price volatility.

### Principle 5: Privacy-Preserving Verification

The verification mechanism must prove that a relay performed its duties without revealing *what* data was relayed or *who* requested it. HiveRelay uses:

- **Blind relay challenges:** Verifiers request content by Hypercore discovery key without learning the content semantics.
- **Bandwidth receipts:** Signed attestations between relay and client that prove data transfer occurred without revealing payloads.
- **Aggregate reporting:** Individual relay statistics are aggregated before publication to prevent traffic analysis.

### Principle 6: Geographic Diversity as a First-Class Objective

A relay network concentrated in `us-east-1` is barely better than a CDN. The incentive mechanism must actively reward operators in underserved regions. This is achieved through a geographic diversity multiplier that increases rewards for operators in regions with low relay density.

---

## 4. Three-Phase Rollout Model

### 4.1 Phase 1: Community Relay Network (No Token)

**Duration:** 6-12 months minimum (no maximum; Phase 2 launches only when criteria are met)

**Goal:** Prove the protocol works. Build a community of relay operators. Establish baseline performance metrics.

#### 4.1.1 Participation Model

Anyone can run a relay node. There is no economic barrier to entry. Operators are motivated by:

- Contributing to the Pear/Holepunch ecosystem
- Building reputation that will have value in later phases
- Grants and sponsorships (see Section 4.1.4)
- Learning the system before economic stakes are introduced

#### 4.1.2 Reputation System

Each relay operator accumulates a reputation score `R` computed as:

```
R = w_u * U + w_p * P + w_b * B + w_g * G + w_a * A
```

Where:

| Variable | Description | Weight | Measurement |
|----------|-------------|--------|-------------|
| `U` | Uptime score | 0.30 | Fraction of time online over trailing 30 days |
| `P` | Proof-of-relay score | 0.25 | Fraction of challenges passed over trailing 30 days |
| `B` | Bandwidth score | 0.20 | Normalized bandwidth served (log scale) |
| `G` | Geographic diversity score | 0.15 | Inverse of relay density in the operator's region |
| `A` | Age score | 0.10 | `min(1, months_active / 12)` |

Scores are normalized to [0, 1] and the weights sum to 1.0.

**Reputation decay:** An inactive relay loses reputation at a rate of 10% per month of inactivity. This prevents operators from accumulating reputation and then abandoning their relay while retaining their score.

```
R_decayed = R * (0.9 ^ months_inactive)
```

#### 4.1.3 Proof-of-Relay Challenges

The protocol issues periodic challenges to verify that relays are performing their claimed function. Challenges are of three types:

1. **Seed verification:** A verifier requests a random block from a Hypercore that the relay claims to seed. The relay must respond within a latency bound. The verifier checks the block's Merkle proof against the Hypercore's public key.

2. **Relay forwarding:** A verifier initiates a connection through the relay to a cooperating peer. The verifier measures round-trip latency and throughput.

3. **Availability ping:** Simple liveness check. The relay must respond within 5 seconds.

Challenge frequency scales with claimed capacity:

| Claimed Capacity | Challenges per Day |
|------------------|--------------------|
| < 100 GB storage | 6 |
| 100 GB - 1 TB | 12 |
| 1 TB - 10 TB | 24 |
| > 10 TB | 48 |

Challenges are issued by a rotating set of verifier nodes selected from high-reputation peers. No single verifier can target a specific relay repeatedly, preventing griefing.

#### 4.1.4 Funding Model

Phase 1 is funded through:

- **Protocol grants:** The HiveRelay project allocates a grants budget (target: $50,000-$200,000 over 12 months) funded by ecosystem sponsors, foundation grants, or development funds.
- **Direct sponsorships:** Pear application developers who need relay infrastructure can sponsor specific relay operators.
- **Community contributions:** Operators contribute capacity voluntarily.

Grant distribution follows reputation: higher-reputation operators receive proportionally larger grants. This creates a soft economic incentive without requiring a token.

#### 4.1.5 Public Dashboard

A public dashboard displays:

- Active relay count and total capacity
- Geographic distribution map
- Aggregate uptime and proof-of-relay pass rates
- Bandwidth served (aggregate)
- Operator leaderboard (opt-in, pseudonymous)

This dashboard serves dual purposes: it builds community engagement and it generates the baseline metrics needed to design Phase 2 pricing.

#### 4.1.6 Success Criteria for Phase 2

Phase 2 launches only when ALL of the following criteria are met:

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Active relays | >= 50 | Minimum viable network size |
| Median uptime | >= 95% | Demonstrates operator reliability |
| Geographic regions | >= 10 countries | Minimum diversity |
| Proof-of-relay pass rate | >= 98% | Proves verification system works |
| Active Pear apps being seeded | >= 20 | Demonstrates real demand |
| Duration at above thresholds | >= 3 consecutive months | Stability, not a spike |

---

### 4.2 Phase 2: Direct Payment Marketplace (BTC/Lightning)

**Duration:** 12-18 months (Phase 3 launches only when criteria are met)

**Goal:** Establish real market pricing. Prove that relay service has measurable economic demand. Build the payment infrastructure that Phase 3 will extend.

#### 4.2.1 Payment Infrastructure

Payments flow directly from app developers (demand side) to relay operators (supply side) via Bitcoin Lightning Network. There is no intermediary, no protocol fee in Phase 2 (fees are introduced in Phase 3 to fund the treasury).

Lightning is chosen because:

- **Micropayment-native:** Channels support payments as small as 1 sat (~$0.001 at current exchange rates).
- **Streaming payments:** Per-second or per-megabyte payment is technically feasible.
- **No new token risk:** Operators are paid in BTC, a liquid, widely-accepted asset.
- **Bidirectional:** Payment channels can be rebalanced, reducing on-chain costs.

#### 4.2.2 Pricing Model

HiveRelay defines four billable service types. Pricing is market-determined within protocol-defined bounds.

| Service | Unit | Suggested Starting Price | Min Floor | Max Ceiling |
|---------|------|--------------------------|-----------|-------------|
| **Storage (seeding)** | per GB/month | 50 sats | 10 sats | 500 sats |
| **Bandwidth (transfer)** | per GB transferred | 100 sats | 20 sats | 1,000 sats |
| **Relay forwarding** | per GB relayed | 150 sats | 30 sats | 1,500 sats |
| **Availability guarantee** | per hour of guaranteed uptime | 5 sats | 1 sat | 50 sats |

*Note: At BTC = $100,000, 100 sats = $0.001. These prices are denominated in sats and float against fiat.*

Price floors and ceilings are governance parameters (see Section 11). The floor prevents a race to the bottom that would drive out honest operators. The ceiling prevents monopolistic pricing by operators in underserved regions.

**Operators set their own prices** within these bounds. Clients select operators based on a composite score:

```
selection_score = w_price * normalize(1/price) + w_rep * reputation + w_latency * normalize(1/latency)
```

Default weights: `w_price = 0.4, w_rep = 0.35, w_latency = 0.25`. Clients may override these weights.

#### 4.2.3 Held-Amount Schedule (Storj-Inspired)

New operators have their earnings partially held by the protocol as a commitment mechanism. Held funds are returned in full after the vesting period, provided the operator maintains good standing.

```
         Held Percentage Over Time

  100% |
   75% |████████████
   50% |            ████████████
   25% |                        ████████████
    0% |                                    ████████████████████
       +----+----+----+----+----+----+----+----+----+----+----+----> months
            3    6    9   12   15   18
                                 ^
                          Full held amount
                          returned here
```

| Month | Held Percentage | Rationale |
|-------|-----------------|-----------|
| 1-3 | 75% | High held amount filters out uncommitted operators |
| 4-6 | 50% | Reduced after demonstrating initial reliability |
| 7-9 | 25% | Approaching full payout |
| 10+ | 0% | Fully vested; earnings paid immediately |
| 15 | -- | All previously held amounts returned if good standing maintained |

**Good standing** requires:

- Uptime >= 90% in each calendar month
- Proof-of-relay pass rate >= 95%
- No slashing events
- No unexplained downtime exceeding 72 consecutive hours

**If an operator exits before month 15**, held amounts are forfeited and redistributed to the remaining operator pool. This creates a strong incentive for long-term commitment and raises the cost of hit-and-run attacks.

#### 4.2.4 Slashing

Slashing (permanent forfeiture of held amounts) is triggered only by **cryptographically provable** misbehavior:

1. **Serving incorrect data:** A relay returns a block that fails Merkle proof verification against the Hypercore's public key. Since Hypercore blocks are signed into a Merkle tree by the author, serving wrong data is always provable.

2. **Double-claiming:** A relay submits bandwidth receipts for the same data transfer to multiple payers. Receipts contain nonces that make duplication detectable.

3. **Challenge evasion with uptime claims:** A relay claims high uptime but fails more than 20% of challenges within a 7-day window. Statistical tests distinguish bad luck from dishonesty (see Section 6).

Slashing does NOT apply to:

- Honest downtime (operator goes offline and does not claim otherwise)
- Slow responses (penalized via reputation, not slashing)
- Low bandwidth (not a commitment violation)

This conservative slashing policy is deliberate. Aggressive slashing regimes discourage participation by risk-averse operators, which are exactly the operators you want.

#### 4.2.5 Reputation Continuity

Phase 1 reputation carries forward into Phase 2 with a conversion:

```
R_phase2_initial = R_phase1 * 0.8
```

The 20% haircut prevents Phase 1 operators from resting on accumulated reputation. They must continue earning it.

Phase 2 reputation adds an economic component:

```
R_phase2 = w_u * U + w_p * P + w_b * B + w_g * G + w_a * A + w_e * E
```

Where `E` is an economic reliability score based on:
- Payment disputes (lower is better)
- Service level agreement adherence
- Held-amount completion rate

Weights are rebalanced: `w_u = 0.25, w_p = 0.20, w_b = 0.15, w_g = 0.15, w_a = 0.10, w_e = 0.15`.

#### 4.2.6 Success Criteria for Phase 3

Phase 3 launches only when ALL of the following criteria are met:

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Monthly payment volume | >= 10M sats (~$1,000) | Real economic demand exists |
| Paying app developers | >= 30 distinct payers | Demand is not concentrated |
| Active paid relays | >= 100 | Supply-side health |
| Median operator tenure | >= 6 months | Operator commitment |
| Held-amount completion rate | >= 80% | Operators stay long-term |
| Monthly payment growth | >= 0% over 6 months | Not declining |
| Geographic regions with active relays | >= 15 countries | Diversity |

---

### 4.3 Phase 3: Optional HIVE Token + Delegation

**Precondition:** Phase 2 success criteria are met. Community governance vote (Phase 2 operators, weighted by reputation) approves token launch with >= 67% supermajority.

**Goal:** Improve capital efficiency, enable delegation, and establish decentralized governance for protocol parameters.

#### 4.3.1 Token Overview

| Parameter | Value |
|-----------|-------|
| Name | HIVE |
| Total supply | 1,000,000,000 (fixed, no inflation) |
| Smallest unit | 1 nHIVE (10^-9 HIVE) |
| Consensus | N/A (not a blockchain; HIVE is a ledger token on a suitable L1 or L2) |
| Transfer | Standard token transfer on chosen settlement layer |

#### 4.3.2 Distribution

```
  Initial Token Distribution

  ┌──────────────────────────────────────────────────────────────┐
  │                                                              │
  │  ████████████████████████████████████████  Community         │
  │  ████████████████████████████████████████  Treasury (40%)    │
  │                                                              │
  │  █████████████████████████                 Early Relay       │
  │  █████████████████████████                 Operators (25%)   │
  │                                                              │
  │  ████████████████████                      Development       │
  │  ████████████████████                      Fund (20%)        │
  │                                                              │
  │  ███████████████                           Grants &          │
  │  ███████████████                           Ecosystem (15%)   │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

| Allocation | Percentage | Tokens | Vesting |
|------------|------------|--------|---------|
| Community treasury | 40% | 400,000,000 | Governed by token holders; 5% unlock per quarter max |
| Early relay operators | 25% | 250,000,000 | 24-month linear vest with 6-month cliff |
| Development fund | 20% | 200,000,000 | 36-month linear vest with 12-month cliff |
| Grants & ecosystem | 15% | 150,000,000 | Disbursed by grants committee; 3-year budget |

**No VC allocation. No ICO. No team pre-mine beyond development fund.**

**Retroactive distribution to Phase 1-2 operators:** The 25% early relay operator allocation is distributed proportionally to cumulative reputation scores earned during Phases 1 and 2. An operator's share is:

```
operator_share = (cumulative_reputation_i / sum(all_cumulative_reputations)) * 250,000,000
```

This retroactive reward structure means that operators who contributed during the unpaid and low-paid phases are the largest token holders. This aligns long-term incentives: the people who built the network govern it.

#### 4.3.3 Work-Token Model

HIVE is a **work token**: holding it does not generate passive income. Staking it to an active relay node generates rewards proportional to verified work performed.

```
reward_i = base_emission_rate * (work_i / total_work) * stake_modifier_i * geo_modifier_i
```

Where:

- `work_i` = verified bandwidth + verified storage + verified relay forwarding (normalized to a common unit)
- `total_work` = sum of all verified work across the network
- `stake_modifier_i` = quadratic staking function (see 4.3.4)
- `geo_modifier_i` = geographic diversity multiplier (see 4.3.6)

**Base emission rate:** Since total supply is fixed, rewards come from two sources:

1. **Protocol fees:** Phase 3 introduces a 5% protocol fee on all relay payments. This fee accrues to staked operators as additional rewards.
2. **Community treasury disbursement:** The governance process can vote to release treasury tokens as supplementary rewards, but this is capped at 5% of treasury per quarter.

The critical difference from emission-based models: **the majority of rewards come from protocol fees on real transactions, not from newly created tokens.** Treasury disbursement is a bootstrapping mechanism with a hard cap, not a perpetual money printer.

#### 4.3.4 Quadratic Staking

To prevent whale domination, staking rewards follow a quadratic (square-root) curve:

```
stake_modifier = sqrt(stake_i) / sqrt(reference_stake)
```

Where `reference_stake` is the median stake across all active operators.

This means:

| Stake (relative to median) | Effective Weight | Efficiency |
|---|---|---|
| 0.25x | 0.50x | 2.00x |
| 1x (median) | 1.00x | 1.00x |
| 4x | 2.00x | 0.50x |
| 16x | 4.00x | 0.25x |
| 100x | 10.00x | 0.10x |

A whale staking 100x the median gets only 10x the reward weight. The capital efficiency of additional stake decreases sharply. This creates a strong economic incentive to distribute stake across multiple operators (via delegation) rather than concentrating it.

#### 4.3.5 Delegation

Token holders who do not operate relays can delegate their HIVE to operators they trust. Delegation mechanics:

- Delegator selects an operator and stakes HIVE to them.
- Operator's effective stake = own stake + delegated stake (subject to quadratic curve).
- Rewards are split: operator keeps a commission (operator-set, typically 10-20%), remainder returned to delegators proportionally.
- Delegators can withdraw with a 7-day unbonding period.
- If an operator is slashed, delegators' stake is also slashed (proportionally). **Delegators bear real risk and should choose operators carefully.**

This design avoids the principal-agent problem of liquid staking derivatives by making delegation a direct, bilateral relationship with real consequences.

#### 4.3.6 Geographic Diversity Multiplier

The world is divided into geographic cells (approximately 100km x 100km, using a grid system like H3 at resolution 3). Each cell has a relay density:

```
density_c = relays_in_cell_c / total_relays
```

The geographic modifier for an operator in cell `c` is:

```
geo_modifier_c = max(1.0, target_density / density_c)
```

Capped at 3.0x to prevent abuse.

Where `target_density = 1 / total_cells` represents uniform global distribution.

**Example:** If 50% of relays are in US East Coast cells but those cells represent 1% of global cells, operators there receive a `geo_modifier` near 1.0x. An operator in Sub-Saharan Africa where relay density is 0.1% of what uniform distribution would predict receives up to 3.0x rewards.

This does not penalize operators in dense regions (they still receive 1.0x). It increases the reward for operators willing to serve underserved areas.

#### 4.3.7 Minimum Stake Requirements

To operate a relay in Phase 3, an operator must stake a minimum amount that scales with claimed capacity:

| Claimed Capacity | Minimum Stake |
|------------------|---------------|
| Tier 1 (< 1 TB, < 10 Mbps) | 1,000 HIVE |
| Tier 2 (1-10 TB, 10-100 Mbps) | 5,000 HIVE |
| Tier 3 (> 10 TB, > 100 Mbps) | 25,000 HIVE |

These thresholds are governance parameters and should be calibrated so that the minimum stake for Tier 1 is approximately equal to 2 months of expected Tier 1 earnings. This ensures that even the smallest operator has meaningful skin in the game without creating an insurmountable barrier.

---

## 5. Proof-of-Relay Economics

### 5.1 How Proofs Translate to Earnings

Every unit of payment in HiveRelay must be backed by a verifiable proof of service. The mapping is:

| Service Type | Proof Mechanism | Verification Cost |
|---|---|---|
| Storage (seeding) | Random block request + Merkle proof validation | ~1 KB per challenge |
| Bandwidth (transfer) | Signed bandwidth receipts between relay and client | ~100 bytes per receipt |
| Relay forwarding | End-to-end latency measurement through relay | ~500 bytes per test |
| Availability | Liveness ping with cryptographic nonce | ~64 bytes per ping |

#### Bandwidth Receipts

When a relay serves data to a client, both parties sign a bandwidth receipt:

```
receipt = {
  relay_id: <public key>,
  client_id: <public key>,
  timestamp: <unix_ms>,
  bytes_transferred: <uint64>,
  direction: <upload|download>,
  nonce: <random_32_bytes>,
  relay_signature: <ed25519_sig>,
  client_signature: <ed25519_sig>
}
```

Both signatures are required. The client will not sign a receipt for data it did not receive (because the nonce is derived from the transferred data). The relay will not sign a receipt for data it did not send (because that would require forging the client's signature on a receipt with matching nonce).

### 5.2 Challenge Frequency and Cost

The verification overhead must be small relative to the value of the work being verified.

**Target:** Verification overhead < 1% of bandwidth served.

For a Tier 2 relay serving 1 TB/month:

- Storage challenges: 12/day * 30 days * 1 KB = 360 KB/month
- Bandwidth receipts: ~10,000 transfers * 100 bytes = ~1 MB/month
- Relay challenges: 12/day * 30 days * 500 bytes = 180 KB/month
- Availability pings: 288/day * 30 days * 64 bytes = 553 KB/month

**Total verification overhead: ~2 MB/month** on 1 TB served = 0.0002%. Well within target.

### 5.3 Expected Earnings Per Tier

The following projections assume Phase 2 market pricing and are denominated in sats (at reference rate: 1 BTC = $100,000, 1 sat = $0.001).

#### Tier 1: Raspberry Pi (1 TB storage, 20 Mbps home internet)

| Revenue Source | Calculation | Monthly (sats) |
|---|---|---|
| Storage (seeding) | 500 GB avg utilized * 50 sats/GB | 25,000 |
| Bandwidth | 200 GB/month * 100 sats/GB | 20,000 |
| Relay forwarding | 50 GB/month * 150 sats/GB | 7,500 |
| Availability | 720 hrs * 5 sats/hr | 3,600 |
| **Total gross** | | **56,100** |
| Held amount (month 1-3 avg) | 75% held | 14,025 net |
| Held amount (month 10+) | 0% held | 56,100 net |

**Cost:** ~$5-8/month electricity. At 56,100 sats/month = ~$0.56/month.

**Tier 1 assessment:** At Phase 2 launch pricing, a Raspberry Pi relay is **not profitable on its own.** Tier 1 operators are subsidized by reputation value and future token allocation. This is acceptable: Tier 1 is the entry ramp for community operators, not a business.

#### Tier 2: VPS ($5-20/month, 2 TB storage, 100 Mbps)

| Revenue Source | Calculation | Monthly (sats) |
|---|---|---|
| Storage (seeding) | 1.5 TB avg utilized * 50 sats/GB | 75,000 |
| Bandwidth | 2 TB/month * 100 sats/GB | 200,000 |
| Relay forwarding | 500 GB/month * 150 sats/GB | 75,000 |
| Availability | 720 hrs * 5 sats/hr | 3,600 |
| **Total gross** | | **353,600** |
| Held amount (month 1-3 avg) | 75% held | 88,400 net |
| Held amount (month 10+) | 0% held | 353,600 net |

**Cost:** $5-20/month VPS. At 353,600 sats/month = ~$3.54/month.

**Tier 2 assessment:** Marginal at $5/month VPS, unprofitable at $20/month VPS, at initial pricing. **Tier 2 becomes profitable when network demand increases prices above the initial suggested floor, or when Phase 3 token rewards supplement earnings.** This is by design: we want organic demand to drive pricing, not subsidized profitability.

#### Tier 3: Dedicated Server ($50-100/month, 20 TB storage, 1 Gbps)

| Revenue Source | Calculation | Monthly (sats) |
|---|---|---|
| Storage (seeding) | 15 TB avg utilized * 50 sats/GB | 750,000 |
| Bandwidth | 20 TB/month * 100 sats/GB | 2,000,000 |
| Relay forwarding | 5 TB/month * 150 sats/GB | 750,000 |
| Availability | 720 hrs * 5 sats/hr | 3,600 |
| **Total gross** | | **3,503,600** |
| Held amount (month 10+) | 0% held | 3,503,600 net |

**Cost:** $50-100/month. At 3,503,600 sats/month = ~$35.04/month.

**Tier 3 assessment:** Approaches break-even at $50/month hosting cost with full utilization. Profitable with modest price increases or Phase 3 token rewards.

### 5.4 Sensitivity Analysis

```
  Monthly Earnings vs. Demand Multiplier (Tier 2, post-vesting)

  sats     |
  800k     |                                                    *
           |                                               *
  600k     |                                          *
           |                                     *
  400k     |                           *    *
           |                      *
  200k     |                 *
           |            *
  100k     |       *
           |  *
       0   +--+----+----+----+----+----+----+----+----+----> demand
           0.5x   1x   1.5x  2x  2.5x  3x  3.5x  4x       multiplier
```

| Demand Multiplier | Tier 1 Monthly | Tier 2 Monthly | Tier 3 Monthly |
|---|---|---|---|
| 0.5x (demand halves) | 28,050 sats ($0.28) | 176,800 sats ($1.77) | 1,751,800 sats ($17.52) |
| 1.0x (baseline) | 56,100 sats ($0.56) | 353,600 sats ($3.54) | 3,503,600 sats ($35.04) |
| 2.0x (demand doubles) | 112,200 sats ($1.12) | 707,200 sats ($7.07) | 7,007,200 sats ($70.07) |
| 4.0x | 224,400 sats ($2.24) | 1,414,400 sats ($14.14) | 14,014,400 sats ($140.14) |

**Key observation:** At 2x demand, Tier 2 becomes reliably profitable even at $10/month VPS pricing. At 4x demand, Tier 3 dedicated servers are highly profitable. The economics scale naturally with demand, and price discovery ensures that operators are compensated at market rates.

**Supply-side response:** As demand increases, new operators join (drawn by higher prices), which increases supply, which moderates prices. This is a standard supply-demand equilibrium. The held-amount schedule acts as a damper on supply-side volatility: new entrants cannot immediately capture full earnings, preventing rapid supply floods.

---

## 6. Anti-Gaming Analysis

### 6.1 Sybil Attack Cost Analysis

**Attack:** An adversary creates `N` fake relay identities to capture a disproportionate share of rewards.

**Phase 2 cost:**

- Each identity must pass proof-of-relay challenges, requiring real bandwidth and storage.
- Each identity enters the held-amount schedule independently (75% held for months 1-3).
- Each identity requires a Lightning payment channel with sufficient liquidity.

For `N` Sybil relays claiming Tier 1 capacity:

```
Cost per Sybil = VPS_cost + bandwidth_cost + channel_liquidity
               = ~$5/month + ~$2/month (for real bandwidth) + ~$10 (channel deposit)
               = ~$17 first month, ~$7/month ongoing
```

Revenue per Sybil (months 1-3, 75% held):

```
Revenue = 56,100 sats * 0.25 = 14,025 sats = ~$0.14/month
```

**Break-even for a Sybil in Phase 2: approximately month 18**, assuming the attacker maintains all nodes and eventually recovers held amounts. But held amounts are forfeited if any node fails good-standing requirements. The attacker must operate `N` real nodes for 15 months to recover held amounts.

**Critical insight:** In Phase 2, a Sybil attack is economically equivalent to operating real relays. The held-amount schedule ensures that the only way to extract value is to provide real service for an extended period. At that point, the "attack" is indistinguishable from honest operation.

**Phase 3 additional cost:**

- Each Sybil requires minimum stake (1,000 HIVE for Tier 1).
- Quadratic staking means `N` Sybils with `S/N` stake each earn roughly `sqrt(N)` times what a single node with stake `S` would earn, but they must also do `N` times the work.
- Net result: Sybil splitting provides no economic advantage under quadratic staking.

**Formal result:** Under quadratic staking, the reward for `N` nodes each with stake `S/N` and work `W/N` is:

```
N * base_rate * (W/N) / total_work * sqrt(S/N) / sqrt(ref)
= base_rate * W / total_work * sqrt(S) / (sqrt(N) * sqrt(ref))
```

Compare to a single node with stake `S` and work `W`:

```
base_rate * W / total_work * sqrt(S) / sqrt(ref)
```

The Sybil configuration earns `1/sqrt(N)` of the single-node configuration. **Sybil splitting is strictly penalized.**

### 6.2 Collusion Scenarios

**Scenario: Operator-Verifier Collusion**

An operator and a verifier collude so the verifier always passes the operator's challenges.

**Mitigation:** Verifiers are selected randomly from a pool of high-reputation nodes. The probability of being assigned a specific verifier is:

```
P(assigned colluding verifier) = 1 / |verifier_pool|
```

With 50+ verifiers, and challenges issued by multiple verifiers per day, sustained collusion requires corrupting a significant fraction of the verifier pool. Moreover, cross-checking (the same challenge issued independently by multiple verifiers) detects inconsistencies.

**Scenario: Operator-Client Collusion (fake demand)**

An operator also controls client identities and generates fake traffic to inflate bandwidth receipts.

**Mitigation:**
- In Phase 2, fake traffic requires real Lightning payments. The operator pays themselves, losing transaction fees with no net gain.
- In Phase 3, the protocol fee (5%) means self-dealing costs 5% of the transacted amount. The operator would need to generate $X in fake traffic and lose $0.05X in fees to earn the proportional staking reward. For this to be profitable:

```
staking_reward_from_fake_work > 0.05 * fake_payment_volume + opportunity_cost_of_capital
```

The quadratic staking curve limits the marginal reward from additional work, making this equation unprofitable for any reasonable self-dealing volume.

### 6.3 Geographic Spoofing Prevention

**Attack:** An operator claims to be in an underserved region to earn the geographic diversity multiplier.

**Mitigations (layered, no single point of failure):**

1. **Latency triangulation:** Multiple geographically distributed verifiers measure round-trip time to the relay. The measured latencies must be consistent with the claimed location, within physics constraints (speed of light in fiber ~ 200 km/ms round-trip). A relay claiming to be in Nairobi but responding in 2ms to a verifier in Virginia is detectable.

2. **IP geolocation cross-check:** While spoofable on its own, IP geolocation adds a signal. Persistent disagreement between IP location and claimed location triggers additional verification.

3. **Regional challenge nodes:** In regions that trigger high diversity multipliers, the protocol deploys lightweight challenge nodes (possibly operated by ecosystem partners) that issue local-latency challenges. A relay must consistently demonstrate low latency to its claimed region.

4. **Multiplier cap (3.0x):** Even if spoofing succeeds, the maximum gain is 3x rewards. Combined with the cost of maintaining VPN/proxy infrastructure to fake latency, the economics of spoofing are marginal.

### 6.4 Bandwidth Inflation Attacks

**Attack:** A relay and a cooperating client exchange garbage data to inflate bandwidth receipts.

**Mitigations:**

1. **Content-addressed verification:** Storage proofs require returning data that validates against a Hypercore's Merkle tree. You cannot inflate storage earnings with garbage data because verifiers check Merkle proofs.

2. **Bandwidth receipts require matching nonces:** The nonce in a bandwidth receipt is derived from the hash of the transferred data blocks. Manufacturing valid nonces requires knowing the actual data, which means the relay must have actually stored and served it.

3. **Statistical anomaly detection:** If a relay's bandwidth profile deviates significantly from network norms (e.g., extremely high bandwidth but very few unique Hypercore keys served), it is flagged for increased challenge frequency.

### 6.5 The Helium Problem

Helium's core failure was incentivizing the *existence* of infrastructure rather than the *use* of infrastructure. A hotspot earned tokens by proving it was online and in a valid location, regardless of whether anyone used it.

HiveRelay avoids this by design:

- **Phase 1:** No payment. Cannot game what does not pay.
- **Phase 2:** Payment is peer-to-peer from actual clients. No protocol emission. Revenue = real demand.
- **Phase 3:** Staking rewards are proportional to *verified work performed*, not to *capacity claimed*. A relay that is online but serves no traffic earns no staking rewards beyond a minimal availability payment (which is capped and serves as a keep-alive signal, not a primary revenue source).

The formula `reward = f(work, stake, geography)` cannot be gamed by idle infrastructure. The `work` variable requires signed bandwidth receipts from independent clients.

---

## 7. Market Dynamics

### 7.1 Supply-Side: What Determines How Many Relays Join?

The relay supply function depends on:

```
S = f(expected_earnings, operating_cost, reputation_value, token_price_if_phase3, risk)
```

**Key factors:**

1. **Expected earnings vs. operating cost:** The most direct driver. When `expected_earnings > operating_cost` for a given tier, new operators at that tier enter.

2. **Held-amount schedule as supply damper:** New entrants receive only 25% of earnings for the first 3 months. This dampens supply-side responses to short-term demand spikes, preventing the boom-bust cycle seen in other networks.

3. **Reputation as entry barrier:** While not an economic cost, reputation takes time to build. New operators cannot immediately compete with established ones for premium clients. This creates an effective moat for early operators without requiring explicit barriers.

4. **Phase 3 token appreciation:** If HIVE token value increases, the minimum stake requirement (denominated in HIVE) becomes more expensive in fiat terms, slowing new entry. Conversely, if HIVE declines, entry becomes cheaper, encouraging new supply. This is a natural stabilizer.

### 7.2 Demand-Side: What Determines How Many Apps Need Seeding?

Demand for relay services is derived from:

1. **Pear application adoption:** The primary demand driver. Each new Pear app needs seeding.
2. **NAT traversal needs:** As more users are behind CG-NAT (an increasing trend), relay forwarding demand grows.
3. **Availability requirements:** Apps that need high availability require more relays for redundancy.
4. **Data volume:** Apps with large datasets (media, databases) drive storage and bandwidth demand.

The demand curve is largely exogenous to HiveRelay's economics: it depends on the success of the Pear/Holepunch ecosystem. This is why the phased rollout is critical: we do not design economic incentives around hoped-for demand. We wait for demand to materialize and then build incentives around measured reality.

### 7.3 Price Discovery

Phase 2 uses a simple market mechanism:

1. **Operators post prices** (within protocol-defined bounds).
2. **Clients select operators** based on price, reputation, and latency.
3. **Market price emerges** from the intersection of supply and demand.

There is no centralized price oracle. The protocol defines floor and ceiling bounds as safety rails but does not set prices.

**Expected equilibrium pricing:** In a competitive market, price converges to marginal cost + reasonable margin. For relay services, marginal cost is approximately:

```
marginal_cost_per_GB ≈ (VPS_cost / monthly_capacity_GB) + (bandwidth_cost / GB) + amortized_setup
```

For a $5/month VPS with 2 TB capacity and 2 TB bandwidth:

```
storage_marginal = $5 / 2000 GB = $0.0025/GB/month = 250 sats/GB/month
bandwidth_marginal ≈ $0/GB (included in VPS cost)
```

This suggests the initial suggested price of 50 sats/GB/month for storage is below marginal cost for small VPS operators, indicating that Phase 2 prices will settle higher than the suggested starting price. This is fine; the suggested prices are floors, not targets.

### 7.4 Network Effects and Tipping Points

HiveRelay exhibits two-sided network effects:

- **More relays** -> better coverage, lower latency, higher redundancy -> **more apps choose HiveRelay**
- **More apps** -> more demand, higher earnings -> **more operators join**

The critical tipping point is when:

```
operator_expected_earnings > operator_opportunity_cost
```

for a sufficient number of potential operators to sustain the network. Based on the Tier 2 analysis, this occurs when demand reaches approximately 2-3x the Phase 2 baseline, which we estimate requires 50-100 active Pear applications using relay services.

### 7.5 Competitive Landscape

| Service | Storage Cost | Bandwidth Cost | Key Difference |
|---------|-------------|----------------|----------------|
| IPFS pinning (Pinata) | ~$0.15/GB/month | Free (limited) | Centralized, IPFS-only |
| Filecoin storage | ~$0.0001/GB/month | High retrieval cost | Extremely cheap storage, slow retrieval |
| AWS S3 | ~$0.023/GB/month | $0.09/GB transfer | Centralized, not P2P |
| VPS (Hetzner) | ~$0.004/GB/month | Included | Self-hosted, no relay |
| HiveRelay (projected) | ~$0.005/GB/month | ~$0.001/GB | Decentralized, Hypercore-native |

HiveRelay does not compete on raw storage cost (Filecoin wins there). Its value proposition is **Hypercore-native seeding + relay forwarding**, which no existing service provides. The competitive benchmark is "what would a Pear app developer pay to avoid running their own always-on seed server?"

---

## 8. Game Theory Analysis

### 8.1 Nash Equilibria for Relay Operators

Consider a simplified game with `N` relay operators, each choosing between strategies:

- **Honest (H):** Operate a reliable relay, serve correct data, maintain uptime.
- **Lazy (L):** Claim to operate but minimize actual service (respond to challenges, ignore regular traffic).
- **Malicious (M):** Serve incorrect data, fake bandwidth receipts.

**Payoff matrix (simplified, per operator):**

In Phase 2 with held amounts:

| Strategy | Expected Revenue | Expected Penalty | Net Payoff |
|----------|-----------------|------------------|------------|
| Honest | `R` | 0 | `R` |
| Lazy | `0.3R` (challenge-only) | `-0.5R` (reputation loss -> fewer clients) | `-0.2R` |
| Malicious | `1.2R` (inflated receipts) | `-2R` (slashing of held amount) | `-0.8R` |

**Result:** Honest operation is the strictly dominant strategy. The lazy strategy earns less because clients observe low quality and switch operators. The malicious strategy triggers slashing that exceeds the marginal gain.

**Nash equilibrium:** All operators play Honest. This is a dominant-strategy equilibrium, not merely a Nash equilibrium -- it does not depend on what other operators do.

### 8.2 Cooperative vs. Competitive Strategies

Operators may consider forming cartels to fix prices above competitive levels. However:

1. **Low entry barriers** mean that supra-competitive pricing attracts new entrants.
2. **Client-side operator selection** means clients route around expensive operators.
3. **No geographic monopoly** because any VPS provider offers global presence.
4. **Protocol price ceiling** caps the maximum extractable rent.

Cartel formation is unstable because any member can defect by slightly undercutting the cartel price, capturing disproportionate demand. This is a classic prisoner's dilemma where defection dominates.

### 8.3 Free-Rider Analysis

**Client-side free riding:** A Pear app developer uses the relay network without paying.

In Phase 1, all usage is free. This is intentional: Phase 1 is funded by grants and altruism.

In Phase 2, free riding is prevented by the payment protocol: relays only serve clients who maintain active payment channels. Unpaid relay forwarding requests are dropped. Unpaid seeding requests are deprioritized below paid requests.

**Operator-side free riding:** An operator benefits from network reputation without contributing proportionally.

This is handled by the reputation system: operators who serve less traffic earn lower reputation, receive fewer client connections, and earn less. The system self-corrects.

### 8.4 Reputation as a Coordination Mechanism

Reputation serves a game-theoretic function beyond individual incentives: it is a **focal point** (Schelling point) for coordination.

When a client must choose among operators, reputation provides a shared, public signal that coordinates client behavior. This coordination is self-reinforcing: operators expect clients to use reputation as a selection criterion, so they invest in reputation. Clients expect operators to invest in reputation, so they use it as a selection criterion.

This creates a reputation equilibrium where:

- High-reputation operators earn more
- Earning reputation requires honest service
- Therefore, the equilibrium strategy is honest service

The equilibrium is robust to small perturbations (a few dishonest operators) because their low reputation makes them non-competitive.

### 8.5 Why Honest Behavior is the Dominant Strategy

Summarizing the game-theoretic analysis:

1. **Cryptographic verification** makes dishonesty detectable (Merkle proofs, signed receipts).
2. **Economic penalties** (held-amount forfeiture, stake slashing) make detected dishonesty costly.
3. **Reputation effects** make even undetected poor service costly (fewer clients, lower earnings).
4. **Quadratic staking** makes Sybil attacks unprofitable.
5. **Low barriers to honest entry** make cartel formation unstable.

The unique equilibrium across all phases is honest operation. This result holds as long as:

```
P(detection) * penalty > (1 - P(detection)) * gain_from_cheating
```

Given that Merkle proof verification has `P(detection) ≈ 1.0` for serving wrong data, and challenge-based uptime verification has `P(detection) > 0.95` for extended downtime, this inequality holds with substantial margin.

---

## 9. Risk Analysis

### 9.1 Token Price Volatility (Phase 3)

**Risk:** HIVE token price collapses, making minimum stake requirements trivially cheap (lowering Sybil costs) and reducing operator earnings in real terms.

**Impact:** High. A 90% token price decline would reduce the fiat-equivalent minimum stake by 90%, potentially inviting Sybil attacks.

**Mitigation:**
- Minimum stake is denominated in HIVE tokens, but governance can adjust the nominal requirement. A 90% price decline could trigger a governance proposal to increase the minimum stake (e.g., from 1,000 to 10,000 HIVE).
- The held-amount system (Phase 2's legacy) continues in Phase 3 as a secondary defense. Even with cheap stake, the 15-month held-amount schedule deters hit-and-run attacks.
- Phase 3 is optional. If the token fails, the network can revert to Phase 2 (Lightning payments only) with no loss of functionality. This is the escape hatch that most token-based networks lack.

### 9.2 Regulatory Risks

**Risk:** Operating a relay node could be classified as operating a money services business (MSB) in certain jurisdictions if it processes Lightning payments.

**Impact:** Medium. Could prevent operators in regulated jurisdictions from participating.

**Mitigation:**
- Phase 2 payments are peer-to-peer. The relay operator is providing a service and receiving payment, analogous to a freelance hosting provider. This is more likely classified as self-employment income than MSB activity.
- Phase 3 token staking is analogous to a security deposit, not a financial service.
- The protocol does not custody funds. Held amounts are implemented via time-locked Lightning contracts, not custodial accounts.
- Legal analysis should be commissioned before Phase 2 launch. This is an open item (see Section 12).

**Risk:** HIVE token classified as a security.

**Impact:** High if it occurs. Token distribution and governance would need restructuring.

**Mitigation:**
- HIVE is a work token, not an investment contract. It has no passive yield -- staking rewards require active relay operation.
- No ICO, no presale, no VC allocation. Distribution is based on work performed (retroactive airdrop to operators).
- These properties strengthen a utility-token classification under most frameworks, but legal certainty cannot be guaranteed. Formal legal opinion should be obtained before Phase 3.

### 9.3 Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Proof-of-relay bypass discovered | Medium | High | Bug bounty program; conservative slashing (only slash on cryptographic proof) |
| Lightning payment channel failures | Medium | Medium | Support multiple payment channels; fallback to on-chain BTC for settlement |
| Hypercore protocol vulnerability | Low | Critical | HiveRelay inherits Holepunch's security properties; monitor upstream |
| Eclipse attacks on relay discovery | Medium | Medium | Multiple independent DHT bootstrap nodes; relay list pinned to well-known locations |
| Key compromise of high-reputation operator | Low | High | Key rotation mechanism; reputation cooldown after key change |

### 9.4 Market Risks

**Risk:** Insufficient demand. The Pear/Holepunch ecosystem does not grow enough to sustain a relay marketplace.

**Impact:** Critical. Without demand, the entire economic model fails.

**Mitigation:**
- The phased approach means we *know* whether demand exists before committing to a token. Phase 2 success criteria explicitly measure demand.
- If demand is insufficient, the network remains in Phase 1 or Phase 2 indefinitely. No harm done; no token to crash.
- HiveRelay can expand scope to serve other Hypercore-based applications beyond Pear, increasing the addressable market.

**Risk:** A well-funded competitor offers free or subsidized relay services, undercutting HiveRelay.

**Impact:** Medium. Would suppress HiveRelay operator earnings.

**Mitigation:**
- Subsidized services are unsustainable. HiveRelay's phased approach means it only scales with real economics, so it survives the end of a competitor's subsidy.
- Decentralization is a feature that centralized competitors cannot replicate. Developers who value censorship resistance and redundancy will prefer a decentralized relay network.

---

## 10. Comparison to Existing Models

### 10.1 Comparison Table

| Feature | HiveRelay | Filecoin | Storj | Helium | Tor | HOPR | Mysterium | Nym |
|---------|-----------|----------|-------|--------|-----|------|-----------|-----|
| **Primary service** | Relay + seeding | Storage | Storage | Wireless coverage | Anonymity routing | Mixnet relay | VPN/proxy | Mixnet |
| **Token required to operate** | Phase 3 only | Yes (FIL) | No (STORJ optional) | Yes (HNT) | No | Yes (HOPR) | No (MYST optional) | Yes (NYM) |
| **Revenue source** | Client payments | Client payments + block rewards | Client payments | Token emission (95%+) | Donations | Token emission + fees | Client payments | Token emission + fees |
| **Cold-start solution** | Phased (altruism -> payments -> token) | Block rewards | Reputation + held amounts | Token emission | Altruism | Token emission | Client payments | Token emission |
| **Sybil resistance** | Held amounts + quadratic staking | Collateral (hardware-heavy) | Held amounts + reputation | Location proof (gameable) | Directory authority (centralized) | Staking | Reputation + payments | Staking + reputation |
| **Minimum hardware** | Raspberry Pi | Mining rig (~$10K+) | Consumer hardware | Helium hotspot (~$300-500) | Any | VPS | Consumer hardware | VPS |
| **Slashing** | Cryptographic proof only | Complex (sector faults) | Held-amount forfeiture | None | N/A | Stake slashing | None | Stake slashing |
| **Geographic incentives** | Diversity multiplier (up to 3x) | None | Test for geographic spread | Hex-based density rules (heavily gamed) | None | None | None | Mix topology |
| **Governance** | Reputation-weighted operator vote | FIL holder vote | Centralized (Storj Labs) | HIP process (token-weighted) | Tor Project (centralized) | HOPR Association | Centralized | Nym SA |

### 10.2 What We Borrowed

**From Storj: Held-amount schedule.** Storj's held-amount model is the most successful operator commitment mechanism in production. It filters out uncommitted operators cheaply and returns funds to honest operators. We adopted the graduated schedule with slight modifications (longer total hold period, stricter good-standing requirements).

**From Filecoin: Cryptographic verification of storage.** Filecoin's proof-of-replication and proof-of-spacetime demonstrated that storage can be verified without trust. HiveRelay's proof-of-relay challenges are simpler (we verify content-addressed data via Merkle proofs rather than proving unique replication), but the principle is the same.

**From Bitcoin/Lightning: Payment infrastructure.** Rather than creating a new token for payments, Phase 2 uses an existing, liquid, widely-accepted payment network. This eliminates the bootstrapping problem of "who accepts our token?" and allows operators to receive income in a stable, fungible asset.

**From Ethereum's quadratic funding: Quadratic staking curve.** Vitalik Buterin and Glen Weyl's work on quadratic mechanisms inspired the staking curve. Quadratic staking achieves a similar goal to quadratic funding: it favors broad participation over concentrated wealth.

### 10.3 What We Deliberately Avoided

**Helium's emission-first model.** Helium proved that token emission without real demand creates phantom infrastructure. HiveRelay's phased approach ensures that no token exists until real demand is measured and verified.

**Filecoin's hardware barrier.** Filecoin mining requires specialized hardware costing $10,000+. This excludes individual operators and concentrates the network among well-funded mining companies. HiveRelay is designed to run on a $5/month VPS.

**Helium's location-based rewards.** Hex-based location rewards were massively gamed through GPS spoofing and hotspot clustering. HiveRelay's geographic multiplier is capped at 3x and verified through latency triangulation, making it much less profitable to spoof.

**HOPR/Nym's immediate token requirement.** Both HOPR and Nym require staking tokens before an operator can participate. This creates a chicken-and-egg problem and concentrates early participation among speculators. HiveRelay's Phase 1 and Phase 2 require no token at all.

**Tor's pure-altruism model.** While admirable, pure altruism results in chronic underfunding and geographic concentration. HiveRelay uses altruism as a bootstrapping phase, not a permanent operating model.

---

## 11. Governance

### 11.1 Protocol Parameter Governance

The following parameters are subject to governance votes:

| Parameter | Current Value | Governance Scope |
|-----------|---------------|------------------|
| Price floor/ceiling (per service type) | See Section 4.2.2 | Adjustable by vote |
| Held-amount schedule | 75/50/25/0 over 9 months | Adjustable by vote |
| Minimum stake per tier | 1K/5K/25K HIVE | Adjustable by vote |
| Protocol fee | 5% | Adjustable by vote (0-10% range) |
| Geographic multiplier cap | 3.0x | Adjustable by vote |
| Treasury disbursement rate | Max 5%/quarter | Adjustable by vote (0-10% range) |
| Challenge frequency per tier | See Section 4.1.3 | Adjustable by vote |
| Reputation weights | See Section 4.1.2 | Adjustable by vote |

### 11.2 Voting Mechanism

**Phase 1-2:** Governance is informal (community discussion + rough consensus among active operators). Formal votes use reputation-weighted polling where each operator's vote weight equals their reputation score.

**Phase 3:** Governance transitions to token-weighted voting with a quadratic mechanism:

```
vote_weight = sqrt(staked_HIVE)
```

This mirrors the quadratic staking curve: large holders have influence but not dominance. A holder with 100x the median stake has 10x the vote weight, not 100x.

**Quorum:** 25% of staked HIVE must participate for a vote to be valid.

**Supermajority:** Parameter changes require 60% approval. Fundamental changes (token supply, distribution changes) require 80%.

**Timelock:** Approved parameter changes take effect after a 7-day timelock, during which operators can adjust their operations.

### 11.3 Upgrade Mechanism

Protocol upgrades follow a fork-based model:

1. **Proposal:** Published specification with rationale and impact analysis.
2. **Discussion:** Minimum 30-day comment period.
3. **Vote:** Quadratic-weighted vote with 60% threshold.
4. **Implementation:** Code published and audited.
5. **Activation:** Operators upgrade at their discretion. Minimum 80% network adoption required before old protocol version is deprecated.

There is no mechanism to force operators to upgrade. If a proposal fails to achieve 80% adoption, it is either modified or abandoned. This is slower than centralized upgrades but prevents governance capture.

### 11.4 Emergency Procedures

**Scenario: Critical security vulnerability discovered.**

- A security council (5-7 members elected by operators, serving 6-month terms) can issue an emergency parameter change (e.g., pause slashing, increase challenge frequency) without a full governance vote.
- Emergency changes are temporary (30-day maximum) and must be ratified by a full governance vote to become permanent.
- The security council cannot modify token supply, distribution, or minimum stake requirements under emergency powers.

**Scenario: HIVE token price crashes (>80% decline in 30 days).**

- Automatic circuit breaker: minimum stake requirements are frozen at their pre-crash fiat-equivalent value (using a 30-day trailing average price) for 90 days.
- Protocol fee is temporarily reduced to 2% to improve operator economics.
- Governance can vote to increase treasury disbursement rate to stabilize operator earnings.
- If sustained (>6 months at >80% decline), governance can vote to revert to Phase 2 (Lightning-only) operation, effectively deprecating the token.

**Scenario: Sustained demand collapse.**

- Phase 3 can revert to Phase 2 by governance vote. Token staking requirements are lifted; Lightning payments continue.
- Phase 2 can revert to Phase 1 by governance vote. Payment requirements are lifted; reputation-only model resumes.
- At each reversion, existing commitments (held amounts, stakes) are honored according to their original terms. The protocol does not confiscate assets during an orderly wind-down.

---

## 12. Open Questions

The following design questions remain unresolved. They are listed here transparently because honest acknowledgment of uncertainty is more valuable than false confidence.

### 12.1 Unresolved Design Questions

1. **Optimal challenge frequency.** The current challenge schedule (Section 4.1.3) is based on engineering judgment, not simulation. Higher frequency improves security but increases verification overhead. What is the optimal tradeoff? **Needed:** Monte Carlo simulation of various challenge frequencies against attack models.

2. **Held-amount duration.** The 15-month full vesting period is long. Is 12 months sufficient? Is 18 months better? What is the empirical relationship between held-amount duration and operator retention? **Needed:** Empirical data from Phase 1 operators on commitment patterns.

3. **Quadratic staking exponent.** We use `sqrt` (exponent 0.5). Would exponent 0.6 or 0.4 better balance Sybil resistance and capital efficiency? **Needed:** Game-theoretic simulation of staking equilibria under different exponents.

4. **Geographic cell resolution.** H3 resolution 3 (~100 km cells) is a rough starting point. Finer resolution (smaller cells) increases diversity incentives but also increases the potential for geographic gaming. **Needed:** Analysis of relay distribution under different resolutions.

5. **Lightning channel management.** Who bears the cost of opening and maintaining Lightning channels? How does this affect small operators? Is submarine swaps or LSP (Lightning Service Provider) integration needed? **Needed:** UX research and Lightning infrastructure cost analysis.

6. **Cross-phase reputation conversion.** The 0.8 multiplier for Phase 1 -> Phase 2 reputation is arbitrary. What is the right conversion rate? Should Phase 2 -> Phase 3 reputation carry over at all, or should Phase 3 reputation start fresh? **Needed:** Modeling of reputation dynamics across phase transitions.

7. **Protocol fee level.** The 5% protocol fee in Phase 3 is a starting point. Too high discourages demand; too low underfunds the treasury. What is the revenue-maximizing level? What is the welfare-maximizing level? **Needed:** Laffer curve analysis for protocol fees in two-sided markets.

8. **Token settlement layer.** HIVE must exist on some ledger. Which L1 or L2 is appropriate? Candidates include Bitcoin (via RGB or Taproot Assets), Ethereum L2s, or a purpose-built ledger. Each has different tradeoff profiles for cost, decentralization, and ecosystem compatibility. **Needed:** Technical evaluation of settlement layer options.

### 12.2 Areas Requiring Simulation

The following aspects of the design should be tested through agent-based simulation before Phase 2 launch:

- **Market dynamics:** Simulate supply and demand curves under varying Pear ecosystem growth rates. Identify parameter configurations that lead to death spirals or price instability.
- **Sybil resistance:** Simulate adaptive adversaries with varying budgets against the held-amount + quadratic staking defense. Identify the budget threshold at which the system becomes gameable.
- **Geographic diversity:** Simulate the diversity multiplier's effect on relay distribution. Does it actually incentivize global coverage, or does it create perverse incentives (e.g., operators deploying VPS in rare regions rather than serving local users)?
- **Reputation dynamics:** Simulate reputation accumulation and decay under various operator behavior profiles. Identify conditions where reputation scores become uninformative.

### 12.3 OpenClaw Integration (Proposed)

A natural distribution mechanism for HiveRelay: any VPS or dedicated local agent running agentic frameworks like **OpenClaw** or **Hermes** could automatically host a relay node and earn by boosting the P2P network. This creates a built-in operator base from existing agentic communities.

**Why agentic frameworks are ideal relay operators:**
- They already run on always-on infrastructure (VPS, dedicated machines, local agents)
- They have spare compute and bandwidth capacity
- The relay daemon is lightweight and non-competing with agent workloads
- Agent operators are technically sophisticated and already manage infrastructure
- Multiple popular frameworks (OpenClaw, Hermes, and others) collectively represent a large potential operator base

**Critical requirement:** If a token is introduced, network usage must create **demand or burn** for the token — not just emission. Without a consumption mechanism, the token becomes speculation-only, which is precisely the failure mode we are designing against. Possible burn/demand mechanisms:

- **Fee burn:** A percentage of relay fees paid in HIVE are burned (deflationary pressure).
- **Staking lock-up:** Operators must lock HIVE proportional to capacity offered (demand from supply side).
- **App developer burn:** Apps that request seeding burn HIVE as a "priority fee" (demand from demand side).
- **Bandwidth credits:** HIVE is consumed per GB of relay/seeding used (direct utility consumption).

Until a robust demand/burn mechanism is designed and validated, the project should remain in Phase 1-2 (no token). **This is not blockchain for the sake of blockchain — the token phase only proceeds when it solves a problem that Lightning micropayments cannot.**

### 12.4 Community Input Needed

- **Operator economics:** Are the projected earnings (Section 5.3) realistic? What are actual VPS costs in different regions? What bandwidth pricing do operators actually face?
- **Regulatory landscape:** What are the legal requirements for relay operation in major jurisdictions (US, EU, Singapore, Japan)? Are there jurisdictions where receiving Lightning payments for relay service would be problematic?
- **UX requirements:** What is the maximum acceptable complexity for an operator to set up payment receipt? If Lightning channel management is too complex, will operators participate?
- **Demand validation:** Are there Pear app developers willing to commit to paying for relay service in Phase 2? What would they pay? What service levels do they require?
- **Alternative payment rails:** Should Phase 2 support stablecoins (e.g., USDT on Lightning/Liquid) as an alternative to BTC-denominated payments? This would eliminate BTC price volatility for operators but adds complexity.

---

## Appendix A: Notation Reference

| Symbol | Meaning |
|--------|---------|
| `R` | Reputation score [0, 1] |
| `U` | Uptime score [0, 1] |
| `P` | Proof-of-relay pass rate [0, 1] |
| `B` | Normalized bandwidth score [0, 1] |
| `G` | Geographic diversity score [0, 1] |
| `A` | Age score [0, 1] |
| `E` | Economic reliability score [0, 1] |
| `S` | Stake (in HIVE tokens) |
| `W` | Verified work (normalized units) |
| `N` | Number of relay operators |

## Appendix B: Revision History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0-draft | April 2026 | Initial draft for community review |

---

*This document is a living specification. It will be revised based on community feedback, simulation results, and empirical data from Phase 1 operations. All parameters are provisional and subject to governance.*

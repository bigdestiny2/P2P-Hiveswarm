# HiveRelay Token Model: RELAY

## Why Consider a Token At All

The Bitcoin-native model is simpler and more credible. But a native token unlocks three capabilities that sats alone cannot provide:

1. **Programmatic governance.** Token-weighted voting on protocol parameters (fee splits, halving schedule, slashing thresholds) without trusting a core team to set them.
2. **Capital formation for operators.** Staking requirements in a native token create a closed-loop economy where relay operators have a vested interest in network health, not just short-term extraction.
3. **Fee denomination independence.** If the network's unit of account is its own token, fee stability doesn't depend on BTC volatility. A storage fee of "100 RELAY/GB/month" is predictable in network terms regardless of BTC/USD swings.

The risk: every token project in history has had to fight the perception (often justified) that the token exists to enrich insiders. The model below is designed to make that structurally impossible.

---

## Token: RELAY

### Core Properties

| Property | Value |
|----------|-------|
| Name | RELAY |
| Total supply | 100,000,000 (100M) — fixed, never inflationary |
| Smallest unit | 1 micro-RELAY (0.000001 RELAY) |
| Initial distribution | 0 tokens in circulation at genesis |
| Minting | Earned only through Proof-of-Contribution — no pre-mine, no ICO, no VC allocation |
| Settlement | Bilateral Lightning-style payment channels or on-chain (L2) |

### The Critical Design Choice: Zero Pre-Mine

No tokens are allocated to founders, investors, or a foundation at genesis. Every RELAY in existence was earned by a relay operator who proved service to the network. This is the single strongest defense against "token exists to enrich insiders."

Investors participate by running relay infrastructure or funding operators who do — not by holding tokens they received for free.

---

## Token Distribution: Emission Schedule

Tokens are emitted from a fixed supply of 100M RELAY over approximately 20 years, following a halving curve modeled on Bitcoin but calibrated to relay economics.

### Emission Epochs

| Epoch | Period | Emission per Epoch | Cumulative | % of Supply |
|-------|--------|-------------------|------------|-------------|
| 1 | Years 1-2 | 25,000,000 RELAY | 25,000,000 | 25% |
| 2 | Years 3-4 | 12,500,000 RELAY | 37,500,000 | 37.5% |
| 3 | Years 5-6 | 6,250,000 RELAY | 43,750,000 | 43.75% |
| 4 | Years 7-8 | 3,125,000 RELAY | 46,875,000 | 46.875% |
| 5 | Years 9-10 | 1,562,500 RELAY | 48,437,500 | 48.4% |
| ... | Continues halving | ... | Asymptotic | Approaches 50M |

**50% of supply is emitted as Proof-of-Contribution rewards.** The other 50% comes from fee recycling (explained below).

### Why Only 50% via Emission

The remaining 50M RELAY enter circulation exclusively through the fee cycle — operators earn RELAY through fees, fees are partially burned, partially pooled. This means the second half of supply enters circulation much more slowly and is directly proportional to actual network usage. If the network has low usage, most of the supply never enters circulation — natural deflation.

---

## The Fee Economy

### Fee Structure: Three-Way Split

Every service call through the router carries a RELAY-denominated fee. The fee is split:

| Component | % of Fee | Destination | Purpose |
|-----------|----------|-------------|---------|
| Operator payment | 70% | Direct to service provider | Compensation for work |
| Protocol burn | 15% | Destroyed permanently | Deflationary pressure |
| Contribution pool | 15% | Distributed to stakers via PoC | Rewards reliable operators |

### Fee Schedule

| Service | Fee (RELAY) | Notes |
|---------|------------|-------|
| Storage seeding | 0.10 RELAY/GB/month | Base rate, operator can set premium |
| Bandwidth served | 0.05 RELAY/GB | Per bandwidth receipt |
| Circuit relay | 0.075 RELAY/GB | Per circuit, metered |
| Compute task | Market-set | Auction among qualified relays |
| AI inference | Market-set | Auction among qualified relays |
| ZK proof | Market-set | Auction among qualified relays |
| SLA guarantee | 3-5x base rates | Premium for guaranteed QoS |
| Schema validation | 0.001 RELAY/call | Micro-fee for data interop |
| Arbitration filing | 1.0 RELAY | Anti-spam, refunded if claimant wins |

### Fee Discovery

For market-set services (compute, AI, ZK), relays advertise their rates in their service catalog. The router selects the cheapest qualified relay (meeting minimum reputation + DoA thresholds). This creates a natural price discovery mechanism without a centralized order book.

---

## Staking: Proof-of-Commitment

Operators must stake RELAY to activate service tiers. Staked tokens are locked and subject to slashing.

### Staking Tiers

| Tier | Stake | Services Unlocked | Challenge Freq | Pool Share | Governance Weight |
|------|-------|-------------------|----------------|------------|-------------------|
| Observer | 0 | None (read-only network participant) | N/A | 0x | 0 |
| Seed | 100 RELAY | Content seeding only | Every 5 min | 1x | 1 |
| Relay | 1,000 RELAY | Seeding + circuit relay | Every 3 min | 2x | 2 |
| Service | 5,000 RELAY | Full services (compute, AI, ZK) | Every 2 min | 4x | 4 |
| SLA | 25,000 RELAY | SLA contracts + arbitration voting | Every 60s | 8x | 8 |
| Anchor | 100,000 RELAY | All services + protocol governance proposals | Every 30s | 16x | 16 |

**Higher stake = more services = more scrutiny = more reward = more governance power.**

The stake is not "spent" — it remains the operator's property unless slashed. It can be withdrawn after a cooldown period (7 days) during which the operator's relay must maintain full uptime. If uptime drops below 95% during cooldown, the withdrawal is delayed.

### Slashing Conditions

| Violation | Slash % | Evidence |
|-----------|---------|----------|
| Failed proof-of-relay (single) | 0.1% of stake | Challenge response timeout or wrong hash |
| SLA violation (single) | 1% of stake | Automated detection from proof scores |
| SLA termination (3+ violations) | 10% of stake | Cumulative failures |
| Arbitration loss (claimant wins) | Dispute penalty amount | Peer-adjudicated |
| Prolonged downtime (>24h while staked) | 0.5% per day | Health monitor reports |

Slashed tokens are **burned** — not redistributed. This ensures slashing is punitive to the operator, not profitable for other operators (which would create perverse incentives to attack competitors).

---

## Difficulty of Assurance (DoA): The Reward Multiplier

DoA determines how much of the contribution pool each operator earns. It replaces Bitcoin's mining difficulty with a measure of how hard and valuable the service is.

### DoA Formula

```
DoA = regionScarcity * serviceWeight * slaMultiplier * uptimeBonus
```

| Factor | Range | Derivation |
|--------|-------|-----------|
| regionScarcity | 1.0 - 10.0 | `10 / max(1, relaysInRegion)` — fewer relays = higher scarcity |
| serviceWeight | 1.0 - 5.0 | Storage=1.0, Relay=1.5, Compute=2.0, AI=3.0, ZK=3.0, SLA=5.0 |
| slaMultiplier | 1.0 - 3.0 | 1.0 if no SLA, 2.0 for standard SLA, 3.0 for premium SLA |
| uptimeBonus | 0.5 - 2.0 | `uptimeHours / (uptimeHours + 720)` * 2 — logarithmic, rewards consistency |

**Example calculations:**

| Scenario | Region | Service | SLA | Uptime | DoA |
|----------|--------|---------|-----|--------|-----|
| Public blog seeder in Virginia (50 relays) | 0.2 | 1.0 | 1.0 | 1.5 | 0.30 |
| Circuit relay in Singapore (5 relays) | 2.0 | 1.5 | 1.0 | 1.8 | 5.40 |
| AI inference SLA in Lagos (1 relay) | 10.0 | 3.0 | 3.0 | 1.2 | 108.0 |
| ZK proof service in Sao Paulo (3 relays) | 3.3 | 3.0 | 2.0 | 1.6 | 31.7 |

The Lagos AI inference relay earns 360x the pool share of the Virginia blog seeder. This is the economic engine that drives geographic diversity and premium service quality.

### Pool Distribution

Every epoch (daily), the contribution pool is divided among all staked operators proportional to:

```
operatorShare = (operatorDoA * stakeTierMultiplier) / sum(allOperatorDoA * allStakeTierMultipliers)
```

This is a proportional split, not winner-take-all. Every contributing operator earns something. But operators with higher DoA and higher stake earn dramatically more.

---

## Governance: Token-Weighted Protocol Decisions

### What Can Be Governed

| Parameter | Current Default | Governance Scope |
|-----------|----------------|-----------------|
| Fee burn percentage | 15% | 5-25% range |
| Pool contribution percentage | 15% | 5-25% range |
| Staking tier thresholds | See table above | Adjustable per tier |
| Slashing percentages | See table above | Adjustable per violation type |
| Epoch duration | 2 years | 1-4 year range |
| Pioneer bonus multiplier | 3x | 1-5x range |
| Minimum DoA for pool eligibility | 0.1 | 0.01 - 1.0 range |

### Governance Mechanism

1. **Proposal.** Any Anchor-tier operator (100,000 RELAY staked) can submit a protocol parameter change proposal. Cost: 100 RELAY filing fee (burned if proposal fails, refunded if it passes).

2. **Discussion.** 7-day discussion period. Proposal is published to the pub/sub topic `governance/proposals`. All staked operators can comment.

3. **Voting.** 7-day voting window. Each staked operator votes with weight equal to their governance weight (see staking tiers table). Voting is on-chain (appended to a governance Hypercore log).

4. **Threshold.** Requires 67% supermajority of participating vote weight AND participation from at least 10% of total staked RELAY.

5. **Execution.** If passed, the parameter change takes effect at the next epoch boundary. No instant changes — operators have time to adjust.

### Anti-Plutocracy Measures

- **Square root voting option.** For contentious proposals, governance can switch to quadratic voting: vote weight = `sqrt(staked RELAY)`. This reduces whale dominance. A 100,000 RELAY staker gets 316 votes, not 100,000.
- **Minimum participation threshold.** Proposals need 10% of staked supply participating to be valid. Prevents small cabals from passing changes while the network sleeps.
- **Parameter ranges.** Governance can only adjust parameters within defined bounds (see table). It cannot, for example, set the burn rate to 100% or the slash rate to 0%.

---

## The Deflationary Cycle

### Sources of Deflation

| Mechanism | Magnitude | Trigger |
|-----------|-----------|---------|
| Fee burning | 15% of all fees | Every service call |
| Slash burning | Variable | Operator violations |
| Arbitration filing fees | 1 RELAY per dispute (if loser) | Dispute resolution |
| Governance proposal fees | 100 RELAY per failed proposal | Governance spam prevention |
| Stake lockup | Not burned, but illiquid | Active staking |
| Withdrawal cooldown | 7-day lockup | Unstaking |

### Deflationary Math (Steady State)

Assume Year 3, network processing 1M RELAY in monthly fees:

```
Monthly fee volume:           1,000,000 RELAY
Operator payment (70%):         700,000 RELAY (circulates)
Burned (15%):                   150,000 RELAY (destroyed permanently)
Pool distribution (15%):        150,000 RELAY (earned by stakers, partially re-staked)

Monthly net deflation:          ~150,000 RELAY minimum
                                + slashing burns
                                + failed governance proposals
                                + arbitration fees

Annualized burn:                ~1,800,000+ RELAY
```

With 50M RELAY in circulation at Year 3, the annual burn rate is ~3.6% of circulating supply. Combined with stake lockup (operators keeping tokens staked to maintain tier), effective circulating supply could be 30-40% below total issued supply.

### The Equilibrium

As tokens are burned, remaining tokens become more valuable (assuming constant or growing demand for network services). This increases the USD-equivalent value of staking rewards, attracting more operators. More operators = more capacity = more services = more fees = more burns. The cycle is self-reinforcing until equilibrium is reached where:

```
token_burn_rate ≈ new_emission_rate + network_growth_rate
```

At this point, circulating supply stabilizes and the token functions as a stable medium of exchange for network services.

---

## Token Launch Mechanics (No ICO, No Pre-Mine)

### Phase 0: Testnet (Months 1-3)
- Network runs on testnet RELAY (no value)
- Operators practice staking, governance, fee mechanics
- DoA weights calibrated based on real network topology

### Phase 1: Genesis (Month 4)
- Emission begins: Epoch 1, ~1M RELAY/month distributed via PoC
- No tokens sold, no tokens given away
- First RELAY earned by first relay operators who pass proof-of-contribution
- Operators earn tokens by running infrastructure — this IS the token distribution event

### Phase 2: Market Formation (Months 4-12)
- As operators accumulate RELAY, they can trade peer-to-peer or via Lightning-based DEX
- Price discovery is organic — driven by demand for network services
- No exchange listings sought. Let the market come to the token, not the other way around.

### Phase 3: Maturity (Year 2+)
- Fee volume drives token utility (you need RELAY to pay for services)
- Governance activates when 10M RELAY is staked (safety threshold)
- Exchange listings pursued only if organic trading volume justifies it

### What Investors Get

Investors do not get tokens. They get:

1. **Equity in the protocol development company** that builds tooling, SDKs, and enterprise integrations
2. **Priority operator agreements** — first access to high-DoA regions with pioneer bonuses
3. **Revenue share on enterprise SLA contracts** brokered through the company

The company earns revenue from enterprise sales and tooling. The token economy is independent and self-sustaining. This separation is critical: the token has utility value (paying for services), not speculative value (hoping the company succeeds).

---

## Risk Analysis: Why This Could Fail

### 1. Regulatory Classification
If RELAY is classified as a security by regulators (because it has governance rights and potential for appreciation), the project faces compliance overhead. **Mitigation:** Zero pre-mine, no ICO, no founder allocation. Tokens are earned, not sold. This is the strongest possible argument for utility classification, but not guaranteed.

### 2. Low Adoption = Low Fee Volume = Low Token Utility
If the network doesn't attract enough paying users, fee volume is insufficient to make staking profitable, and operators leave. **Mitigation:** The BTC-native model runs in parallel. RELAY is an overlay, not a replacement. If the token model fails, the network falls back to pure BTC micropayments with no disruption.

### 3. Governance Capture
Large operators could accumulate enough tokens to control governance. **Mitigation:** Quadratic voting option, parameter bounds, participation thresholds, and the fact that tokens are earned through service (not purchased) — concentration requires actual infrastructure investment.

### 4. Token Price Volatility
Fee-paying users need price stability. If RELAY swings 50% in a week, developers can't budget. **Mitigation:** Fees can be denominated in USD-equivalent and settled in RELAY at spot price. Or: maintain a BTC fee option alongside RELAY, letting the market choose.

---

## Comparison: BTC-Native vs RELAY Token

| Dimension | BTC-Native Model | RELAY Token Model |
|-----------|-----------------|-------------------|
| Simplicity | High — one unit, one settlement layer | Medium — two units, token management overhead |
| Credibility | Very high — "no token" is a differentiator | Medium — must overcome "another token" skepticism |
| Governance | Reputation-based only | Token-weighted with quadratic option |
| Capital formation | External (VCs fund operators) | Internal (staking creates committed operators) |
| Fee stability | Tied to BTC volatility | Can be insulated via USD-peg or dual denomination |
| Deflationary mechanics | Burn + held amounts | Burn + stake lockup + halving (stronger) |
| Regulatory risk | Minimal | Moderate (security classification risk) |
| Cold start | Harder (need BTC to pay operators) | Easier (tokens emitted to early operators for free) |
| Long-term sustainability | Depends on BTC fee market | Self-contained economy |

### Recommendation

Run both models in parallel. BTC-native for immediate credibility and adoption. RELAY token as an opt-in overlay for operators who want governance participation and exposure to network value appreciation. Services accept payment in either. The market decides which wins.

---

## Mapping to Existing Codebase

| Token Concept | Implementation Path |
|--------------|-------------------|
| RELAY emission | New `EpochManager` in `incentive/` — tracks epoch, calculates emission rate |
| Fee three-way split | Modify `PaymentManager.recordEarnings()` to split operator/burn/pool |
| Staking tiers | New `StakingManager` — account field for stake, tier calculation, withdrawal cooldown |
| DoA calculation | New method in `ReputationSystem` using `NetworkDiscovery` region data + `SLAService` contract data |
| Governance | New `GovernanceService` extending `ServiceProvider` — proposals, voting, execution |
| Burn mechanism | Modify `PaymentManager.slash()` to track cumulative burns |
| Pioneer bonus | Config-driven multiplier in `ReputationSystem` with expiry timestamp |
| Dual denomination | Router middleware converts RELAY/BTC at dispatch time based on caller preference |

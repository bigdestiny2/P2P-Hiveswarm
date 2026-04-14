# Relay Operator Economics: Real-World Simulation

## Who Earns Money on HiveRelay

### The Earning Participants

| Participant | How They Earn | What They Provide |
|------------|---------------|-------------------|
| **Relay operators** | Service fees + PoC rewards | Hardware, bandwidth, uptime, storage |
| **App developers** | Indirectly — their apps work 24/7, enabling their own revenue | Content published to the network |
| **Protocol development company** | Enterprise SLA brokering, SDK licensing, managed deployment | Tooling, support, enterprise integrations |
| **Arbitrators** | Reputation rewards for fair dispute resolution | Judgment, stake at risk |

Relay operators are the primary economic actors. Everything else depends on them running infrastructure.

### Who CANNOT Earn

- **Passive token holders** — no delegation, no "staking from a wallet." You must run infrastructure.
- **Speculators** — no pre-mine, no ICO, no airdrop. Tokens are earned through proven service.
- **Middlemen** — no referral fees, no reselling capacity you don't operate.

This is a physical infrastructure economy. You earn by running machines.

---

## Simulation: 2x Mac Studio M3 Ultra, Full Service Operator

### Hardware Profile

| Spec | Mac Studio M3 Ultra (x2) |
|------|-------------------------|
| CPU | 24-core (per unit), 48 cores total |
| GPU | 76-core (per unit), 152 GPU cores total |
| Unified Memory | 192 GB (per unit), 384 GB total |
| Storage | 2 TB SSD (per unit), 4 TB total |
| Network | 10Gb Ethernet (per unit) |
| Power draw | ~120W peak each, ~80W typical |
| Purchase price | ~$8,000 each, $16,000 total |

### Operating Costs (Monthly)

| Cost | Amount | Notes |
|------|--------|-------|
| Electricity | $25/month | 160W avg * 24h * 30d = 115 kWh @ $0.22/kWh |
| Internet | $80/month | Symmetric gigabit (residential business tier) |
| Domain + TLS | $1/month | Amortized annual cost |
| IP / DNS | $0/month | Dynamic DNS or Caddy auto-HTTPS |
| **Total monthly opex** | **$106/month** | |
| **Amortized hardware** | **$267/month** | $16,000 / 60 months (5-year life) |
| **Total cost of operation** | **$373/month** | Fully loaded |

### Service Configuration

Both Mac Studios run as a single logical relay with the router's named worker pools:

```
Machine 1: Primary relay node
  - Seeding (50+ apps, ~500 GB allocated)
  - Circuit relay (256 concurrent circuits)
  - Router dispatch (main thread)
  - PubSub engine
  - SLA enforcement
  - Schema registry
  - Arbitration service

Machine 2: Compute worker pool
  - 4 CPU worker threads (ZK proofs, compute tasks)
  - AI inference via Ollama (llama3, mistral, codellama)
  - 192 GB unified memory = can load 70B parameter models
  - GPU acceleration for inference
```

### Staking Tier: SLA (25,000 RELAY or equivalent 250,000 sats)

At SLA tier, this operator provides all services including guaranteed SLA contracts and arbitration voting.

---

## Revenue Simulation: Three Scenarios

### Scenario 1: Year 1 — Early Network (Conservative)

Network has ~500 active relays. This operator is one of few offering AI + ZK + SLA in their region.

**Assumptions:**
- Region: North America (moderate saturation, ~50 relays)
- 20 apps seeded (~100 GB total)
- 500 GB bandwidth served/month
- 50 circuit relay sessions/day (avg 10 MB each)
- 10 compute jobs/day (avg 30 sec each)
- 5 AI inference requests/day (avg 2,000 tokens each)
- 2 ZK proof jobs/day
- 1 active SLA contract ($50 premium/month equivalent)
- DoA multiplier: moderate (regionScarcity=0.2, serviceWeight varies, slaMultiplier=2.0)

| Revenue Stream | Volume | Rate | Monthly Revenue |
|---------------|--------|------|----------------|
| **Storage seeding** | 100 GB | 100 sats/GB/month | 10,000 sats |
| **Bandwidth served** | 500 GB | 50 sats/GB | 25,000 sats |
| **Circuit relay** | 15 GB | 75 sats/GB | 1,125 sats |
| **Compute tasks** | 300 jobs | 500 sats/job | 150,000 sats |
| **AI inference** | 150 requests | 1,000 sats/req | 150,000 sats |
| **ZK proofs** | 60 proofs | 2,000 sats/proof | 120,000 sats |
| **SLA premium** | 1 contract | 50,000 sats/month | 50,000 sats |
| **PoC pool rewards** | DoA-weighted share | ~8x multiplier | 100,000 sats |
| **Proof-of-relay rewards** | ~8,640 challenges/month (every 60s) | 100 sats/pass (Epoch 1) | 864,000 sats |
| **Subtotal (gross)** | | | **1,470,125 sats** |
| **Fee burn (-15%)** | | | -220,519 sats |
| **Pool contribution (-15%)** | | | -220,519 sats |
| **Operator net (70%)** | | | **1,029,088 sats** |

**At $100,000/BTC:** 1,029,088 sats = **$1,029/month**

| | Amount |
|--|--------|
| Gross revenue | $1,470/month |
| Operator take (70%) | $1,029/month |
| Operating cost | $373/month |
| **Net profit** | **$656/month** |
| **Annual profit** | **$7,872** |
| **ROI on hardware** | **49% annually** |
| **Payback period** | **24 months** |

**Note:** Proof-of-relay rewards dominate Year 1 revenue (84%). This is by design — Epoch 1 rewards bootstrap the network. The operator is profitable from month 1 but heavily dependent on protocol rewards.

---

### Scenario 2: Year 2 — Growing Network (Moderate)

Network has ~5,000 active relays. More apps, more users, more demand. Epoch 2 halves proof-of-relay rewards, but fee volume has grown 10x.

**Assumptions:**
- 100 apps seeded (~500 GB)
- 5 TB bandwidth/month
- 200 circuit sessions/day
- 100 compute jobs/day
- 50 AI inference requests/day
- 20 ZK proofs/day
- 5 active SLA contracts
- Pioneer bonus expired (was in Year 1)
- Proof-of-relay rewards halved (50 sats/pass)

| Revenue Stream | Volume | Rate | Monthly Revenue |
|---------------|--------|------|----------------|
| **Storage seeding** | 500 GB | 100 sats/GB/month | 50,000 sats |
| **Bandwidth served** | 5,000 GB | 50 sats/GB | 250,000 sats |
| **Circuit relay** | 60 GB | 75 sats/GB | 4,500 sats |
| **Compute tasks** | 3,000 jobs | 400 sats/job (competition) | 1,200,000 sats |
| **AI inference** | 1,500 requests | 800 sats/req (competition) | 1,200,000 sats |
| **ZK proofs** | 600 proofs | 1,500 sats/proof (competition) | 900,000 sats |
| **SLA premiums** | 5 contracts | 40,000 sats/month each | 200,000 sats |
| **PoC pool rewards** | Larger pool, more competition | | 200,000 sats |
| **Proof-of-relay rewards** | 8,640 challenges | 50 sats/pass (Epoch 2) | 432,000 sats |
| **Subtotal (gross)** | | | **4,436,500 sats** |
| **Operator net (70%)** | | | **3,105,550 sats** |

**At $100,000/BTC:** 3,105,550 sats = **$3,106/month**

| | Amount |
|--|--------|
| Gross revenue | $4,437/month |
| Operator take (70%) | $3,106/month |
| Operating cost | $373/month |
| **Net profit** | **$2,733/month** |
| **Annual profit** | **$32,796** |
| **ROI on hardware** | **205% annually** |

**Revenue mix shift:** Proof-of-relay rewards are now 14% of gross (was 84%). Compute + AI + ZK are now 74% of gross. The operator has transitioned from reward-dependent to fee-dependent. This is the healthy equilibrium.

---

### Scenario 3: Year 3 — Mature Network (Optimistic)

Network has ~20,000 active relays. Enterprise adoption. The Mac Studio operator has earned a strong reputation and attracts premium SLA contracts.

**Assumptions:**
- 200 apps seeded (~1 TB, near capacity)
- 10 TB bandwidth/month
- 500 circuit sessions/day
- 500 compute jobs/day
- 200 AI inference requests/day (premium models, longer context)
- 50 ZK proofs/day
- 10 active SLA contracts (3 enterprise-grade)
- Proof-of-relay rewards: 25 sats/pass (Epoch 3)
- Enterprise SLA contracts command 5x premium

| Revenue Stream | Volume | Rate | Monthly Revenue |
|---------------|--------|------|----------------|
| **Storage seeding** | 1,000 GB | 100 sats/GB/month | 100,000 sats |
| **Bandwidth served** | 10,000 GB | 50 sats/GB | 500,000 sats |
| **Circuit relay** | 150 GB | 75 sats/GB | 11,250 sats |
| **Compute tasks** | 15,000 jobs | 300 sats/job | 4,500,000 sats |
| **AI inference** | 6,000 requests | 600 sats/req | 3,600,000 sats |
| **ZK proofs** | 1,500 proofs | 1,200 sats/proof | 1,800,000 sats |
| **SLA premiums** | 7 standard + 3 enterprise | avg 80,000 sats/month | 800,000 sats |
| **Schema validation** | 100,000 calls | 1 sat/call | 100,000 sats |
| **Arbitration voting** | 10 disputes/month | reputation rewards | 50,000 sats |
| **PoC pool rewards** | | | 300,000 sats |
| **Proof-of-relay rewards** | 8,640 challenges | 25 sats/pass (Epoch 3) | 216,000 sats |
| **Subtotal (gross)** | | | **11,977,250 sats** |
| **Operator net (70%)** | | | **8,384,075 sats** |

**At $100,000/BTC:** 8,384,075 sats = **$8,384/month**

| | Amount |
|--|--------|
| Gross revenue | $11,977/month |
| Operator take (70%) | $8,384/month |
| Operating cost | $373/month |
| **Net profit** | **$8,011/month** |
| **Annual profit** | **$96,132** |
| **ROI on hardware** | **601% annually** |

**Revenue mix at maturity:** Compute + AI + ZK = 83%. SLA premiums = 7%. Storage + bandwidth = 5%. Protocol rewards = 4%. The operator is running a profitable edge compute business, not depending on protocol subsidies.

---

## Revenue Mix Evolution

```
Year 1:  [████████████████████░░░] 84% rewards, 10% compute, 6% storage/bw
Year 2:  [███░░░░░░░░░░░░░░░░░░░░] 14% rewards, 74% compute, 12% other
Year 3:  [██░░░░░░░░░░░░░░░░░░░░░]  4% rewards, 83% compute, 13% other
```

This transition from protocol-subsidized to fee-driven is the key indicator of a sustainable economy. By Year 3, if all protocol rewards stopped entirely, this operator would still earn $7,800/month.

---

## Sensitivity Analysis: What Could Go Wrong

### BTC Price Sensitivity

All revenue is denominated in sats. USD value depends on BTC price:

| BTC Price | Year 1 Net Profit | Year 2 Net Profit | Year 3 Net Profit |
|-----------|-------------------|-------------------|-------------------|
| $50,000 | $142/month | $1,180/month | $3,819/month |
| $75,000 | $399/month | $1,956/month | $5,915/month |
| **$100,000** | **$656/month** | **$2,733/month** | **$8,011/month** |
| $150,000 | $1,171/month | $4,286/month | $12,203/month |
| $200,000 | $1,685/month | $5,839/month | $16,395/month |

At $50K BTC, Year 1 is barely profitable ($142/month on $373/month costs). The model requires BTC > ~$45K to be viable for this hardware profile in Year 1. By Year 3, it's profitable down to ~$6K BTC.

### Demand Sensitivity

| Demand Level | Year 2 Monthly Revenue | Notes |
|-------------|----------------------|-------|
| 10% of projection | $311/month | Unprofitable — operator should downgrade to single Mac Mini |
| 25% of projection | $777/month | Break-even at $373 cost |
| 50% of projection | $1,553/month | Moderate profit |
| **100% (baseline)** | **$3,106/month** | Strong profit |
| 200% of projection | $6,212/month | Excellent — consider adding hardware |

### Competition Sensitivity

As more operators join, per-operator revenue drops (same fee pool split more ways). But the Mac Studio's advantage is AI inference speed — M3 Ultra with 192GB unified memory can run 70B models that a $5 VPS cannot. This creates a natural moat for high-end operators.

| Network Size | This Operator's Share | Monthly Revenue (Year 2) |
|-------------|----------------------|-------------------------|
| 1,000 relays (few AI-capable) | Large share of compute fees | $4,500/month |
| 5,000 relays (moderate AI) | **Baseline** | **$3,106/month** |
| 20,000 relays (many AI) | Smaller share, but fee volume higher | $2,200/month |
| 50,000 relays (saturated) | Minimal share, needs differentiation | $1,100/month |

Even in the saturated scenario, the operator is profitable ($1,100 - $373 = $727/month). The Mac Studio's AI capability is the differentiator that prevents commoditization.

---

## Comparison: What Else Could You Do With 2 Mac Studios

| Alternative | Monthly Revenue | Effort | Risk |
|-------------|----------------|--------|------|
| **HiveRelay (Year 2)** | **$2,733 net** | Set up once, maintain | Network adoption |
| Ollama API hosting (direct) | $500-2,000 | Per-customer sales | Customer acquisition |
| Mac Mini colocation rental | $200-400 | Marketing, support | Price competition |
| RunPod/Vast.ai GPU rental | Not applicable (no NVIDIA) | N/A | Platform takes 20-30% |
| Sitting idle | $0 | None | Depreciation |

HiveRelay's advantage: no customer acquisition. The network brings demand to you. You plug in, stake, and the router dispatches work based on your capability and reputation. The higher your DoA score, the more work you get.

---

## Operator Playbook: Month-by-Month

### Month 1: Setup
- Install HiveRelay on both Mac Studios
- Configure Machine 1 as primary relay, Machine 2 as compute worker
- Install Ollama with llama3-70b, mistral-7b, codellama-34b
- Stake minimum for SLA tier
- Join the network, start passing proof-of-relay challenges

### Months 2-3: Establish Reputation
- Pass 5,000+ challenges (100% pass rate target)
- Seed 10-20 popular apps to build bandwidth served metrics
- DoA score climbs from the SLA multiplier + service diversity

### Months 4-6: Activate Premium Services
- Enable AI inference endpoint (advertise llama3-70b capability)
- Enable ZK proof service
- Accept first SLA contract
- Revenue shifts from rewards toward compute fees

### Months 7-12: Optimize and Scale
- Monitor DoA score — optimize for highest-value services
- Participate in arbitration (requires reputation > 100, 50+ challenges)
- Consider pioneer bonus in underserved region (if geographic arbitrage possible via VPN/tunnel)
- Evaluate: is demand sufficient to justify a third machine?

### Year 2+: Mature Operation
- Revenue is 80%+ fee-driven
- Governance participation (vote on protocol parameters)
- Enterprise SLA contracts provide predictable monthly revenue
- Hardware ROI achieved; subsequent years are nearly pure profit

---

## Summary

| Metric | Year 1 | Year 2 | Year 3 |
|--------|--------|--------|--------|
| Monthly gross | $1,470 | $4,437 | $11,977 |
| Monthly net profit | $656 | $2,733 | $8,011 |
| Annual net profit | $7,872 | $32,796 | $96,132 |
| Revenue from rewards | 84% | 14% | 4% |
| Revenue from fees | 16% | 86% | 96% |
| ROI on $16K hardware | 49% | 205% | 601% |
| Break-even BTC price | ~$45K | ~$14K | ~$6K |

The 2x Mac Studio operator is profitable from Year 1 across all but the most pessimistic scenarios. By Year 3, the hardware has paid for itself 6x over and the operation generates near-six-figure annual income from a $373/month operating cost. The key driver is AI inference capability that commodity VPS operators cannot match.

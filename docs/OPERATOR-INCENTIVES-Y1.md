# Operator Incentives, Year One

*This document closes the "open problem" flagged in
[`THREAT-MODEL.md`](THREAT-MODEL.md): how do we pay relay operators and
alt-client developers in year one, before reputation has monetary value
— without launching a token, and without becoming dependent on
VC-funded teams indefinitely?*

## The problem in one sentence

A new P2P substrate has chicken-and-egg economics: paid demand for
relay capacity comes from app developers using the network; app
developers won't use the network unless reliable relay capacity exists;
operators won't supply reliable capacity unless paid demand exists.

Bitcoin solved this with block rewards. Ethereum with staking yield.
Most other substrates (Filecoin, Storj, Helium) solved it with token
issuance. Hive's manifesto explicitly excludes token issuance as a
non-negotiable architectural constraint. The operator-economics gap has
to be closed without one.

## The three-pronged answer

This is the project's specific solution. It composes three independent
mechanisms, none of which require a token, each of which has been costed
and has independent strategic justification.

### Prong 1: Marginal-cost-zero supply (the trojan horse)

The largest cost barrier for new operators is hardware + setup time.
We eliminate both by targeting installations that **already paid for
the box**.

**Channel: Umbrel App Store**

- Umbrel install base: ~120,000 globally (best estimate)
- Tier 1 conversion (Bitcoin/LN-active operators): 40-60%
- Tier 2 conversion (self-hosted enthusiasts with LN): 15-25%
- Tier 3 conversion (casual installers): 2-5%

**Year-one funnel (Umbrel App Store inclusion + one-click install +
sane defaults):**

| Time after launch | Active relays |
|---|---|
| Week 1 | ~150 |
| Month 1 | ~800 |
| Month 6 | ~4,500 |
| Year 1 | **~5,000 – 8,000 active** |

Because operators have **zero marginal cost** (already paid for
hardware, already paying for power and internet), even modest sat
flow > $0 is a positive ROI from week one. This dissolves the operator
chicken-and-egg problem from the supply side.

Adjacent platforms (Start9, BTCPay Server, Synology, custom Pi
self-hosters) plausibly add another 10-15k Year 1 relays through the
same one-click install pattern.

→ Detailed funnel math in conversation history; will be canonicalized
   into `docs/UMBREL-FUNNEL.md` when the App Store launch goes live.

### Prong 2: Direct cash subsidy (the founder bootstrap)

Per [Engineering Brief §12](Hive_Engineering_Brief.md), the founder
commits **1 BTC** (denominated value, not pinned to a price) as a
direct subsidy for operator participation during the cold-start period.

**Properties:**

- **Not a token.** Payouts are made in BTC or USDT at the operator's
  choice, denominated in USD-equivalent.
- **Transparent.** Public dashboard shows operators enrolled, total
  paid, BTC remaining, organic-revenue-crossover tracking.
- **Time-bounded.** Designed to bridge year 1 only. Sunsets as organic
  paid demand grows.
- **Guarded.** Sybil defense gates from Engineering Brief §6.4 (3-layer
  enrollment) prevent capture by fake operators. Acceptable leakage:
  5-10% of bootstrap budget.
- **Quality-conditioned.** Operator Score (Engineering Brief §6.5)
  hard-gates payout — uptime ≥95% rolling 30 days, challenge-success
  ≥95%, version currency, etc.

**Distribution:** quarterly payouts, USD-equivalent denomination,
operator chooses BTC or USDT, integrated with LNbits streaming
extension once that ships in v0.6.0+.

**Why this works without becoming a permanent dependency:**

The subsidy is structured so that it crowds itself out. Operators are
paid for verifiable work (uptime, challenge success, data served).
As app-developer demand grows under the Engineering Brief's dev-pays
model (§4.1), each operator earns more from real demand and less from
the subsidy. When organic earnings exceed subsidy contribution at
median, the subsidy ends. Honest telemetry on the public dashboard
makes the crossover predictable, not fragile.

### Prong 3: Operator-of-last-resort (the foundation network)

Six properties owned by the founder, each running an Umbrel Home 4TB
with a HiveRelay (Blindspark) install, all federated with each other.

**Coverage:** Japan, Australia, Argentina, Portugal, Sri Lanka, UAE.

**Costs:** ~$8,200 capex one-time, ~$4,100/year ongoing (Starlink Mini
subscriptions × 6 + power).

**Strategic role:**

1. **Insurance against operator churn.** Even if the trojan-horse
   funnel underperforms and the bootstrap subsidy is exhausted, the
   network has 24 TB of always-on, mutually-federated, multi-region
   capacity. Apps can credibly say "your content is seeded across 6
   continents from day one" because these 6 nodes guarantee it.
2. **Premium regional pricing anchor.** Three of the six sites
   (Argentina, Sri Lanka, UAE) are in regions that no other major P2P
   storage network covers. They earn at premium rates, generating
   revenue back to the foundation that helps fund operations.
3. **Credibility for developers.** Without proof of multi-region
   uptime, the dev-pays model can't get its first customers.

→ Detailed plan in conversation history; will be canonicalized into
   `docs/FOUNDATION-NETWORK.md` when the build ships.

## How the three prongs compose into a complete answer

Each prong by itself is partial. Together they close the loop:

| Year-one risk | Mitigated by |
|---|---|
| No operators show up | Trojan horse — 5-8k pre-installed Umbrel users with zero marginal cost |
| Operators show up but lose money | Founder bootstrap — quarterly USD-equivalent subsidy |
| Network has gaps in regions or capacity | Foundation network — guaranteed always-on coverage from 6 founder-owned nodes |
| Subsidy creates dependency | Crossover model — subsidy sunsets as paid demand grows; quality gates prevent gaming |
| No trust in operator quality | Operator Score (M2) — public composite metric with hard-gates |
| Sybil attacks on subsidy | 3-layer Sybil defense (M2) — ASN+region uniqueness, signed Nostr notes, LN channel maturity, escrowed bonds |

## Crossover math (the honest projection)

The bootstrap subsidy ends when organic demand exceeds it at the
median operator. Some napkin math to size the crossover horizon:

**Assumptions:**

- BTC = $60,000
- 1 BTC subsidy = $60,000 — sized to last 2-3 quarters at startup pace
- Median operator at Year 1: 1 TB egress/month, mid-tier pricing →
  ~25,000 sats/month = ~$15/month organic
- ~5,000 active operators at Year 1 (low end of trojan-horse projection)
- Founder pays ~$5/month subsidy per qualifying operator quarterly

**Quarterly subsidy outlay (low-end):** 5,000 ops × $15 quarterly =
$75,000/quarter. So 1 BTC ≈ $60,000 covers ~0.8 quarters at peak
operator count.

**Tighter sizing:** subsidize only the ~1,000 highest-Operator-Score
nodes per quarter, $15 each, $15k/quarter. 1 BTC then covers ~4
quarters. That's the 1-year bridge.

**Crossover trigger:** when median operator's organic monthly earnings
× 3 (a quarter) exceed the per-operator subsidy share, the subsidy is
no longer the marginal motivator. At ~$45 organic per operator per
quarter and a $15 subsidy share, that's a 3:1 organic:subsidy ratio.
Flip the subsidy off; operators continue under organic economics.

These numbers are illustrative — real numbers depend on demand growth
rate from the dev-pays side. The key property is the model has a
**clearly-defined sunset criterion**, not a "we'll figure it out
later" handwave.

## Comparison to alternatives we explicitly rejected

| Alternative | Why we rejected it |
|---|---|
| **Token issuance** | Manifesto §4 — non-negotiable architectural exclusion. Tokens introduce regulatory exposure, speculative dynamics, and coordinate the wrong incentive (price appreciation, not service quality). |
| **Permanent foundation grants to all operators** | Creates dependency on the foundation, doesn't scale, contradicts the "no required infrastructure" principle. |
| **Permanent VC funding for operator subsidies** | Bridges year 1 but kicks the dependency problem to year 2. Same shape as crypto-VC-funded "decentralized" projects whose foundations still control operations five years later. |
| **Block rewards (synthetic asset tied to participation)** | A token by another name. Same regulatory + dynamics problems. |
| **Mandatory subscription pricing for app developers** | Contradicts the PAYG model in Engineering Brief §4.2. Forces small apps off the network. |

## What this means for code

Several v0.6.0+ deliverables are downstream of this incentive model.
Engineers should know the model when implementing them:

- **`LNbitsPaymentProvider`** must support both organic dev-paid streams
  AND foundation subsidy payouts. Same provider, two senders.
- **Operator Score** must be live before any subsidy disbursement
  (M2 deliverable). No score means no payout.
- **Sybil defense gates** are a hard prerequisite for the bootstrap
  enrollment workflow. Without them, the subsidy gets captured.
- **Public transparency dashboard** is required by the bootstrap
  program design. Operators enrolled, total paid, success rates, BTC
  remaining, crossover tracking — all public.
- **Operator-Score-weighted subsidy distribution** — subsidy budget
  flows toward higher-scoring operators, both rewarding quality and
  reducing the budget required to bootstrap.
- **Cross-payment-rail support** (BTC + USDT) is required from v1
  per Engineering Brief §4.9 Pillar 1. The bootstrap doesn't pin
  operators to a single asset.

## Open follow-up work

- [ ] Spec the subsidy disbursement workflow (`docs/BOOTSTRAP-SUBSIDY-SPEC.md`)
- [ ] Spec the public transparency dashboard surface
- [ ] Spec the crossover-detection algorithm (when does subsidy auto-sunset?)
- [ ] Operator Score must reach v1 before subsidy starts
- [ ] Sybil defense gates must be enforceable before enrollment opens

## Companion documents

- [`THREAT-MODEL.md`](THREAT-MODEL.md) — flags this open problem; this
  document is the answer
- [`Hive_Engineering_Brief.md`](Hive_Engineering_Brief.md) — §6.4
  (Sybil defense), §6.5 (Operator Score), §12 (founder bootstrap
  operational details)
- [`MANIFESTO.md`](MANIFESTO.md) — the no-token constraint that this
  model has to satisfy

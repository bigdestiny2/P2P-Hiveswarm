# M2 Roadmap — what's still required

*Tracker for security-relevant work specced in the Engineering Brief
that's NOT yet implemented. v0.6.0 closes the immediate threat-model
gaps; M2 closes the long-tail items that depend on multi-week
engineering or external dependencies.*

## Status snapshot (post-v0.6.0)

| Item | Status | Engineering effort | Dependencies |
|---|---|---|---|
| **Operator Score module + public dashboard** | ❌ scoped, no code | 3-4 weeks | Engineering Brief §6.5; needed before Sybil defense gates can score-weight |
| **Sybil defense gates (3-layer)** | ❌ scoped, no code | 2-3 weeks | Engineering Brief §6.4; ASN/region uniqueness, signed Nostr notes, LN channel maturity, escrowed bonds |
| **Independently-authored alt-client** | ❌ outreach not started | 1-3 months elapsed | Threat model action #3; cannot be done in-house — requires different team |
| **Merkle proof-of-retrievability challenges** | ❌ scoped, no code | 2 weeks | Engineering Brief §6.5; verifier-node infrastructure |
| **Geographic attestation (cryptographic, not self-reported)** | ❌ scoped, no code | 3-4 weeks | Engineering Brief §6.5; ASN-based + latency triangulation |
| **Bandwidth receipts that get challenged + verified** | ⚠️ logged but unverified | 2 weeks | Engineering Brief §6.5; randomized challenge system |
| **P2P-Auth v1 spec (mnemonic + social-recovery + hardware-key + PQ)** | ⚠️ delegation primitive only | 1 month spec + council review | Engineering Brief §3.3 |
| **Push specification (no metadata leak)** | ❌ research+spec | 1 month | Engineering Brief §3.5 |
| **Moderation/labeler protocol** | ❌ scoped, no code | 1 month spec + ref impl | Engineering Brief §3.5 |
| **Foundation address routing for 1.5% protocol fee** | ❌ no Foundation entity yet | 0.5 day code, blocked on legal entity | Engineering Brief §4.3 |
| **HiveProject SDK primitive (dev-pays model)** | ❌ no code | 1 week | Engineering Brief §4.1 |
| **Stream-fee split (60/25/15) routing** | ❌ no code | 1 week | Engineering Brief §11; depends on LNbits streaming extension |

## Operator Score (Engineering Brief §6.5) — preliminary spec

**Hard-gate metrics** (any below threshold = zero payout from bootstrap subsidy):

| Metric | Threshold | Source |
|---|---|---|
| Uptime | ≥95% rolling 30d (7-day floor 90%) | Health monitor / federation peer pings |
| Data-serving challenge success | ≥95% rolling 7d | Verifier-node challenge system |
| Storage integrity | 100% pass rate on Merkle proof-of-retrievability | Merkle PoR challenges |
| Software version currency | Within 2 minor versions of stable, no known-critical CVEs | Capability doc `version` + CVE feed |

**Soft-gate metrics** (affect score, influence quorum priority):

| Metric | Weight | Notes |
|---|---|---|
| Latency (p50/p99) | 0.15 | Per-region; quorum ranking input |
| Bandwidth capacity | 0.15 | Self-reported in capability doc, cross-checked against served-bytes |
| NAT traversal success rate | 0.10 | ≥90% target |
| Peer connectivity count | 0.10 | Rolling 7-day sustained |
| Geographic attestation consistency | 0.10 | Self-reported region vs IP-geo + latency triangulation |
| Data-served volume | 0.20 | Vs network median |
| Churn resistance | 0.20 | Penalize frequent short-duration offline windows |

**Implementation path:**

1. `OperatorScore` module — pure calculation (takes metrics history, returns 0-1 score)
2. `OperatorScoreCollector` — ingests live metrics from health monitor, federation pings, challenge system
3. Public dashboard endpoint `/api/operator-score/<pubkey>` returning current score + breakdown
4. Federation pull cycle adds operator scores from peers
5. QuorumSelector uses score field (already exists in selector inputs) to rank
6. 30-day public comment period for any algorithm change (per brief)

## Sybil defense (Engineering Brief §6.4) — preliminary spec

**Layer 1 — soft gates (all operators):**

```js
// SybilGuard — blocks enrollment if these fail
const layer1 = {
  minUptimeBeforeFirstPayout: 48 * 60 * 60 * 1000, // 48 hours
  uniquePerASN: true,                              // one operator per ASN per region
  uniquePerSubnet: '/24',
  enrollmentRateLimit: { perMonth: 100 },
  challengeSuccessRate: { minimum: 0.95, windowDays: 7 }
}
```

**Layer 2 — medium gates (claimants > $0/mo or > 100 GB stored):**

```js
const layer2 = {
  signedNostrNote: { required: true, kind: 30078 }, // operator signs a relay declaration
  lnChannelMaturity: { minAgeDays: 30, requiredFor: { monthlyClaimsAbove: 100 } },
  communityMembershipSignal: { acceptedSources: ['nostr-vouch', 'github-org-membership'] }
}
```

**Layer 3 — strong gates (dispute cases or > $500 cumulative):**

```js
const layer3 = {
  lightningEscrowedBond: { amountSats: 500_000 }, // ~$50 at 60k BTC
  manualReview: { triggeredAt: { cumulativePayoutsUsd: 500 } }
}
```

**Acceptable leakage:** 5–10% of bootstrap budget (per brief §6.4).

**Implementation path:**

1. `SybilGuard` module exposes `canEnroll(operatorAttrs)`, `recordEnrollment(operator, attrs)`, `isPayoutEligible(operator)`
2. Wraps the bootstrap-subsidy disbursement so no payment goes out without passing the gates
3. ASN lookup via existing GeoIP databases (MaxMind etc.)
4. Nostr-note verification via existing identity-service infrastructure
5. LN channel maturity via LNbits API (LNbits exposes channel age)

## What v0.6.0 has shipped that closes the immediate gaps

| Threat-model item | v0.6.0 status |
|---|---|
| Replica diversity (QuorumSelector) | ✅ shipped |
| Local fork detection during replication | ✅ shipped (auto via Hypercore events) |
| Cross-replica fork detection (queryQuorumWithComparison) | ✅ shipped |
| Reference verifier package | ✅ shipped (@hive/verifier) |
| LNbits admin key encryption at rest | ✅ shipped (AES-256-GCM) |
| Capability doc signing + verification | ✅ shipped |
| Quarantine of forked drives in open() | ✅ shipped |
| Audit trail for force:true bypasses | ✅ shipped |
| Fork-proof federation gossip | ✅ shipped (federation pulls /api/forks/proofs every cycle) |
| Pubkey pinning via knownRelays registry | ✅ shipped (pinRelay + auto-injection in fetchCapabilities) |
| Operator Score | ❌ M2 |
| Sybil defense gates | ❌ M2 |
| Cryptographic geographic attestation | ❌ M2 |
| Independent alt-client | ❌ M2 (outreach) |

## Sequencing recommendation for M2

1. **OperatorScore first** — it's an input to everything else (Sybil gates, quorum selection, payout eligibility). Without scores, "diverse" quorum selection has no quality signal.
2. **Sybil defense second** — depends on OperatorScore for Layer 1 challenge-success metric
3. **Merkle PoR challenges third** — depends on OperatorScore (it's the source of the challenge-success metric)
4. **Geographic attestation parallel to Sybil** — independent track
5. **P2P-Auth spec parallel** — pure spec work, not blocked by code
6. **External alt-client outreach parallel** — non-engineering, independent

Estimated total M2 elapsed time: **3-4 months engineering + 1-3 months elapsed for alt-client outreach**.

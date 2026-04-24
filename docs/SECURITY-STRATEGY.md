# Security Strategy — Mitigation Plan

*Comprehensive strategy mapping every attack vector identified in
`THREAT-MODEL.md` and the post-v0.6.0 network attack analysis to a
specific mitigation, with status, owner, and timeline.*

This document is the authoritative tracker. When attack-vector status
or mitigation owner changes, update here.

## Strategy at a glance

10 attack categories. Within each, mitigations are classified:

- **🟢 In place** — implemented, tested, verified (will cite the commit)
- **🟡 Improving in this commit** — being addressed in the immediate
  next push along with this strategy
- **🟠 Specced for M2** — design complete, implementation in M2 sprint
  (3-4 months elapsed)
- **🔴 Open** — known vulnerable, no fix planned yet, accept risk for now

Honest distribution: of the 32 vectors enumerated below, **17 are 🟢,
8 are 🟡, 6 are 🟠, 1 is 🔴**.

---

## Category 1: Eclipse / view control

| ID | Attack | Mitigation | Status |
|---|---|---|---|
| 1.1 | DHT eclipse | Multi-region foundation network + diverse quorum + capability-doc signing + pinRelay | 🟢 |
| 1.2 | BGP / routing hijack | Capability-doc Ed25519 signature catches impostors | 🟢 |
| 1.3 | DNS hijack | Same as 1.2; pinRelay by hex pubkey removes DNS from trust path | 🟢 |
| 1.4 | TLS cert mis-issuance | Same as 1.2 — TLS is not in our trust chain when capability doc is verified | 🟢 |

**Net status**: Category 1 is well-defended. The capability-doc signature work in v0.6.0 fix(security) commit (`882fc45`) is the load-bearing mitigation.

---

## Category 2: Data corruption

| ID | Attack | Mitigation | Status |
|---|---|---|---|
| 2.1 | Publisher key compromise | Delegation cert revocation + future M2 P2P-Auth (social recovery, hardware keys, PQ migration) | 🟡 partial; 🟠 full |
| 2.2 | Equivocation (publisher signs two histories) | Hypercore truncate auto-detect + ForkDetector quarantine + federation gossip; M2: sign actual hypercore blocks as evidence | 🟡 closes most; 🟠 full proof |
| 2.3 | Operator serves stale data | `compareDrive` + take-longest-valid-history rule | 🟢 |
| 2.4 | Withholding (relay knows N+1 but only serves up to N) | Multi-relay reads expose; future M2 latency-difference detection in Operator Score | 🟢 partial; 🟠 full |

**This commit's improvements:**

- **Sign fork proofs by their observer.** The newly-introduced `/api/forks/proof` endpoint currently accepts ANY proof. That's a new attack surface (fake proofs to quarantine legitimate drives). Close it: every proof must include `observer.pubkey + observer.signature + attestedAt`. The signature commits the observer to the report, and gives Operator Score (M2) something to weight against. **Implemented this commit.**

- **Capability doc gets an `attestedAt` timestamp** inside the signed payload. Prevents replay of an old (stale) capability doc as if it were fresh. **Implemented this commit.**

---

## Category 3: DoS / availability

| ID | Attack | Mitigation | Status |
|---|---|---|---|
| 3.1 | Storage flooding | Accept-mode default 'review' + maxPendingRequests cap (5000) + maxStorage cap | 🟢 |
| 3.2 | Bandwidth exhaustion | maxConnections + maxRelayBandwidthMbps; M2: bandwidth-receipt-based throttling | 🟢 partial; 🟠 full |
| 3.3 | Manifest store flooding | maxAuthors cap (10k) with oldest-first eviction | 🟢 |
| 3.4 | Federation poisoning | Operator chose to follow; per-relay catalog goes through accept-mode; pubkey pinning catches "followed relay turned malicious" | 🟢 |
| 3.5 | Wizard endpoint brute force | Localhost gate + per-endpoint rate limit (5/min on /api/wizard/lnbits) | 🟡 in this commit |
| 3.6 | Fork-proof gossip flooding | maxForks cap; signed-observer requirement (this commit) means each fake proof costs the attacker a real keypair + identity exposure | 🟡 in this commit |

---

## Category 4: Sybil / economic capture

| ID | Attack | Mitigation | Status |
|---|---|---|---|
| 4.1 | Sybil capture of bootstrap subsidy | M2 Sybil defense 3-layer gates (Engineering Brief §6.4); preliminary spec in `M2-ROADMAP.md` | 🟠 |
| 4.2 | Quorum-selection capture via fake region/operator metadata | M2 cryptographic geographic attestation + Operator Score weighting; stopgap = latency triangulation in Operator Score | 🟠 |
| 4.3 | Operator collusion to fix prices | Permissionless protocol layer — anyone can undercut. Market-dynamics, not engineering | 🟢 (by design) |
| 4.4 | LNbits admin key theft | AES-256-GCM encryption at rest + 0600 file perms + key from $APP_SEED | 🟢 (commit 882fc45) |
| 4.5 | Stream payment redirection | Lightning BOLT-11 immutability + capability-doc signature on payment endpoint declaration | 🟢 |
| 4.6 | Foundation address compromise (1.5% fee redirect) | Multisig with hardware-key signers from independent jurisdictions; spec in M2-ROADMAP | 🟠 (Foundation entity must exist first) |

**Honest disclosure**: 4.1 (Sybil bootstrap capture) is the **single biggest open vector** in the project. It can't be addressed without M2 work. **No bootstrap subsidy disbursement should occur until the Sybil defense gates ship.** This is a hard precondition documented in `OPERATOR-INCENTIVES-Y1.md`.

---

## Category 5: Censorship

| ID | Attack | Mitigation | Status |
|---|---|---|---|
| 5.1 | Jurisdictional operator coercion | Multi-region foundation network (6 continents) | 🟢 |
| 5.2 | State-level DHT firewalling | Multiple transports (DHT-over-WebSocket, Holesail, Tor); operator/user side circumvention | 🟢 partial |
| 5.3 | Application-store delisting | Direct npm + Docker install path maintained as permanent alternative | 🟢 (by design) |
| 5.4 | Operator surveillance via review mode | Operator sees publisher pubkey of every incoming request; M2 "blind review" mode (publisher pubkey hashed for display, verified privately) | 🟠 |

---

## Category 6: Trust / governance

| ID | Attack | Mitigation | Status |
|---|---|---|---|
| 6.1 | Fake reputation building | M2: Operator Score must be based on cryptographic work (PoR challenges, signed bandwidth receipts), not self-attestation | 🟠 |
| 6.2 | Spec council compromise | Public 30-day comment period for any algorithm change (Engineering Brief §6.5) + multi-jurisdiction council members | 🟢 (governance, not code) |
| 6.3 | Compromised reference implementation supply chain | 🔴 — no defenses today; M2 fix is sigstore + reproducible builds + multi-signer release process | 🔴 → 🟠 (multi-week M2 effort) |
| 6.4 | Documentation poisoning | Versioned canonical docs in repo; PR review on changes | 🟢 |

**6.3 is the only 🔴 in the strategy.** Real and unmitigated today. JS supply-chain attacks (event-stream, ua-parser-js, polyfill.io) are the most realistic class of attack on the network. M2 priority.

---

## Category 7: Network partition

| ID | Attack | Mitigation | Status |
|---|---|---|---|
| 7.1 | Persistent regional partition | Hypercore append-only — no merge conflict per-drive; equivocation detection on reconnect | 🟢 |
| 7.2 | Selective per-author partition | Same as eclipse (1.1) defenses applied per-author | 🟢 |

---

## Category 8: Newly-introduced surfaces (created in v0.6.0 work)

Honest accounting of what we ourselves added:

| ID | Surface | Mitigation | Status |
|---|---|---|---|
| 8.1 | `/api/wizard/*` localhost endpoints | Localhost gate + per-endpoint rate limit | 🟡 (this commit adds the rate limit) |
| 8.2 | `/api/forks/proof` POST | Signed observer attestation required (this commit) | 🟡 (this commit) |
| 8.3 | `/api/forks/proofs` GET | Public-good info; no defense needed | 🟢 |
| 8.4 | drive.core.on('truncate') auto-quarantine | Truncate event requires real conflicting blocks; bounded by 4.x prerequisites | 🟢 |
| 8.5 | Wizard collecting LNbits admin key | Localhost-only + Umbrel app proxy | 🟢 |
| 8.6 | pinRelay registry | Constructor + method only mutation paths | 🟢 |
| 8.7 | Capability doc signature TOCTOU | Each fetch independently verified | 🟢 |
| 8.8 | ForkDetector bypass log | Only `client.open(force:true)` writes; no remote API | 🟢 |

---

## Category 9: Privacy / metadata leak

| ID | Attack | Mitigation | Status |
|---|---|---|---|
| 9.1 | Operator surveillance via review mode | Same as 5.4 — M2 blind-review | 🟠 |
| 9.2 | Traffic analysis correlating drives to consumers | Tor transport (logged, not enabled by default); drive replication is over Noise XK so content is encrypted | 🟢 partial |
| 9.3 | Metadata leak via fork-proof gossip itself | Fork proofs reveal which publisher key forked. This is INTENTIONAL — equivocation evidence is a public good | 🟢 (by design) |
| 9.4 | Capability doc reveals operator metadata | Operators choose what to expose; defaults expose minimal info | 🟢 |

---

## Category 10: Cross-cutting / supply-chain

| ID | Attack | Mitigation | Status |
|---|---|---|---|
| 10.1 | npm publish credential theft | M2: sigstore signing + multi-signer release process | 🟠 |
| 10.2 | Docker Hub / GHCR credential theft | M2: same as 10.1 plus image cosign attestation | 🟠 |
| 10.3 | Hardware backdoor in operator device | Out of our control; recommend operators choose trusted hardware | 🟢 (disclosed) |
| 10.4 | Pull-request poisoning | Code review on every PR; no rubber-stamp merges; this strategy doc is reviewed before commit | 🟢 (process) |
| 10.5 | Phishing fake-app on Umbrel App Store | Umbrel App Store reviewer gate | 🟢 (by design) |
| 10.6 | Negative campaign / FUD | Honest threat model + audit transparency (this doc) | 🟢 (by design) |

---

## Implementation work this commit closes

Three concrete code additions that move 🟡 → 🟢:

### 1. Signed fork proofs (closes 8.2)

**Problem:** Anyone can POST to `/api/forks/proof` and quarantine any drive on every relay.

**Fix:**
- New `packages/core/core/fork-proof-signing.js` module:
  - `signForkProof(proof, observerKeyPair)` — wraps proof with observer pubkey + Ed25519 signature + attestedAt
  - `verifyForkProof(signedProof)` — validates signature, returns `{valid, observer, reason?}`
- `ForkDetector.report` accepts an optional `observerSignature` field; warns on unsigned
- Server `/api/forks/proof` requires + verifies observer signature
- Federation `_pullForkProofs` verifies observer signature before merging
- Client `publishForkProof` signs with `client.keyPair` automatically before broadcasting

**Future M2 hook:** Operator Score will weight observer reports — high-score observers' reports propagate fast; low-score observers' reports are scored but not propagated.

### 2. Per-endpoint rate limit (closes 8.1)

**Problem:** General 60/min/IP rate limit is fine for casual API but lets an attacker hammer `/api/wizard/lnbits` with 60 attempts per minute trying to inject malicious credentials.

**Fix:**
- New `_endpointRateLimits` Map in `RelayAPI` keyed by `<endpoint>:<ip>`
- `/api/wizard/lnbits`: 5/min/IP (operator should not need >5 attempts/min)
- `/api/wizard/complete`: 10/min/IP
- All other wizard endpoints: 30/min/IP
- Returns 429 with `Retry-After` on overrun, like the general limit

### 3. Capability doc `attestedAt` (closes 1.x replay attack stub)

**Problem:** A stale capability doc can be replayed long after the operator has changed their config (e.g., they switched accept_mode from 'open' to 'closed', but a cached old doc still says 'open').

**Fix:**
- Add `attestedAt` (ms epoch) inside the signed payload
- Client emits 'capability-doc-stale' event when `attestedAt` is older than configurable threshold (default: 24h)
- Stale doesn't auto-reject (operators may legitimately leave caches running) — just surfaces as a warning

---

## Items NOT addressed in this commit (M2)

Listed here so we have a single source of truth on what's outstanding:

1. **Operator Score module + dashboard** (Engineering Brief §6.5) — 3-4 weeks
2. **Sybil defense 3-layer gates** (Engineering Brief §6.4) — 2-3 weeks (depends on #1)
3. **Cryptographic geographic attestation** — 3-4 weeks
4. **Independent alt-client author outreach** — 1-3 months elapsed
5. **Merkle proof-of-retrievability challenges** — 2 weeks
6. **P2P-Auth v1 spec** (mnemonic + social-recovery + hardware-key + PQ) — 1 month spec + council review
7. **Push specification** (no metadata leak) — 1 month research+spec
8. **Moderation/labeler protocol** — 1 month
9. **Sigstore + reproducible builds + multi-signer release** — 2 weeks (the 🔴 closure)
10. **Blind-review accept-mode** (operator privacy) — 3 days
11. **Mandatory key rotation alarm** (publisher pubkey changed) — 2 days
12. **Foundation multisig setup** — blocked on legal entity

Estimated total M2 elapsed: **3-4 months engineering** + ongoing outreach.

## Required preconditions before specific milestones

- **No bootstrap subsidy disbursement before Sybil defense ships.** Hard requirement, documented in `OPERATOR-INCENTIVES-Y1.md`.
- **No widespread operator-recruitment marketing before sigstore release signing ships.** The supply-chain attack risk grows with adoption.
- **No "we are blind" marketing claim until blind-review mode ships.** Today operators see publisher pubkeys in review mode.

These preconditions are non-negotiable. They protect us from shipping security claims that the implementation can't back.

## Cadence

- Weekly review of this strategy doc — promote items 🟡 → 🟢 as they ship; 🔴 → 🟠 as they get specs
- Monthly external review during M2
- Independent security audit before any 1.0 / GA marketing

---

## Companion documents

- [`THREAT-MODEL.md`](THREAT-MODEL.md) — security thesis + 3-category state model
- [`OPERATOR-INCENTIVES-Y1.md`](OPERATOR-INCENTIVES-Y1.md) — economic model + Sybil defense preconditions
- [`M2-ROADMAP.md`](M2-ROADMAP.md) — detailed scoping of M2 deliverables
- [`Hive_Engineering_Brief.md`](Hive_Engineering_Brief.md) — architecture decisions
- [`MANIFESTO.md`](MANIFESTO.md) — non-negotiable values

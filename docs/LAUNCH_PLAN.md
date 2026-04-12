# HiveRelay Launch Plan

## Starting Position

Three relay nodes are running. A real Pear app has been seeded and replicated across them. DHT discovery works. Content is served when the publisher goes offline. The core promise — "your app stays online" — is proven.

Everything below builds on that foundation, one layer at a time.

---

## Phase 1: Prove the Core (Weeks 1-4)

**Goal:** 3 relays, 5 seeded apps, 3 external developers using the SDK. Prove that seeding is reliable enough for someone else to depend on.

### What to do

**Week 1-2: Harden what's running**
- Run the 3 relays continuously for 14 days with zero manual intervention
- Log uptime, proof-of-relay pass rates, memory usage, connection counts
- Fix any crash or restart that occurs — every one is a launch blocker
- Verify self-healing works under real conditions (kill a relay, confirm the other two still serve the app)
- Enable Prometheus metrics scraping on all 3 nodes, set up a simple Grafana dashboard or just curl `/metrics` daily

**Week 2-3: Onboard 3 developers**
- Find 3 people building Pear apps (Keet community, Holepunch Discord, existing contacts)
- Give them the SDK. Their task: `npm install p2p-hiverelay`, call `publish()`, close their laptop, confirm the app stays live
- Track their experience: what confused them, what broke, what they expected to work differently
- Fix every friction point they report. This is the real product feedback loop.

**Week 3-4: Seed 5 real apps**
- Get those 3 developers to seed their actual apps (not test content)
- Add 2 more apps from the ecosystem (open-source Pear apps, community projects)
- Run the catalog: `curl https://relay.example.com/catalog.json` should show 5 real apps with real manifests

### What NOT to do
- Do not enable services layer (compute, AI, ZK)
- Do not enable payments
- Do not build new features
- Do not write about tokenomics

### Exit criteria
- 14 days continuous uptime across all 3 relays
- 5 apps seeded with real content
- 3 developers have used the SDK without the core team holding their hand
- Zero data loss events
- Proof-of-relay pass rate > 99%

---

## Phase 2: Grow the Operator Base (Weeks 5-10)

**Goal:** 10 relay nodes across 3+ regions, operated by 5+ independent people. Prove that someone other than the core team can run a relay.

### What to do

**Week 5-6: Write the operator guide**
- Create a single-page "Run a relay in 10 minutes" guide
- Cover: VPS setup (DigitalOcean/Hetzner one-click), Docker, systemd, Caddy HTTPS
- Include: what to expect (bandwidth usage, storage growth, connection counts)
- Include: what it costs ($5-10/month VPS) and what it will earn (nothing yet — be honest)
- Post to Holepunch community channels

**Week 7-8: Recruit 5 operators**
- Offer the first 5 external operators a "Founding Operator" designation (visible on the network dashboard leaderboard)
- Help them set up. Document every problem they hit.
- Target geographic diversity: at least 1 node in EU, 1 in Asia
- Verify cross-region discovery works (a developer in NA sees relays in EU and Asia)

**Week 9-10: Stress test the 10-node network**
- Seed 20+ apps across the network
- Test publisher-offline scenarios from multiple regions
- Test circuit relay between NAT-blocked peers through multiple relays
- Run the comprehensive benchmark script (`node scripts/comprehensive-test.js`) against the live network
- Monitor reputation scores — do they converge? Do reliable nodes score higher?

### What NOT to do
- Do not enable payments. Operators are volunteering for reputation and early-mover advantage.
- Do not enable SLA contracts. There's nothing to guarantee yet.
- Do not enable AI/compute services. The network is proving relay, not compute.

### Exit criteria
- 10 relay nodes online, 5+ independent operators
- 3+ geographic regions represented
- 20+ seeded apps
- Cross-region discovery and replication verified
- No operator needed help from the core team in the last 7 days
- Circuit relay tested and working between at least 2 NAT-blocked peers

---

## Phase 3: Enable the Services Layer (Weeks 11-16)

**Goal:** Operators with capable hardware can offer compute, AI, and ZK services. Developers can call services through the router. The network does more than store files.

### What to do

**Week 11-12: Enable the router on all nodes**
- `enableRouter: true` becomes the default (it already is unless overridden)
- Verify `/api/v1/dispatch` works across all 10 nodes
- Verify pub/sub SSE endpoint delivers events to a subscriber
- Test transaction orchestration with a real multi-step workflow: `storage.drive-read` -> `compute.submit` -> result

**Week 13-14: Recruit 2 high-capability operators**
- Find 2 operators with serious hardware (Mac Studio, GPU server, 32GB+ RAM)
- Help them configure worker pools (`routerWorkers: 4` or named pools)
- Enable AI service with a local Ollama instance (llama3-7b or similar)
- Enable ZK service
- Test: a developer calls `ai.infer` via the SDK, the request routes to the capable relay, result returns

**Week 15-16: Developer integration**
- Work with 2-3 developers to integrate service calls into their apps
- Example: a Pear app that uses `schema.register` + `schema.validate` for shared data formats
- Example: a Pear app that calls `compute.submit` for background processing
- Document the service calling pattern: SDK -> router -> dispatch -> worker -> result

### What NOT to do
- Do not enable payments. Services are free during this phase. The goal is proving the dispatch works, not monetizing it.
- Do not enable SLA contracts. There's no payment to stake against.

### Exit criteria
- Router dispatch verified across all nodes
- At least 2 nodes offering AI inference
- At least 1 developer app using a service call in production
- Service dispatch latency < 100ms for in-process routes, < 500ms for worker-offloaded routes
- Pub/sub delivers events to at least 1 subscriber reliably

---

## Phase 4: Turn on Payments (Weeks 17-24)

**Goal:** Operators earn real satoshis for the services they provide. The economic model starts generating data.

### What to do

**Week 17-18: Payment infrastructure**
- Help 3 operators set up LND nodes (or connect to existing ones)
- Enable `lightning.enabled: true` on those nodes
- Test: `PaymentManager.recordEarnings()` -> `settle()` -> Lightning payment arrives
- Test the held-amount schedule: verify that month-1 operators see 75% held back
- Monitor bandwidth receipts: are they being generated and collected correctly?

**Week 19-20: Fee activation**
- Set base rates: storage 100 sats/GB/month, bandwidth 50 sats/GB, compute market-rate
- Enable fee collection on service dispatch (router middleware that meters and charges)
- First real payment: a developer pays a relay for seeding their app
- Track: how much does a relay earn per day? Per week? Is it covering VPS costs?

**Week 21-24: Economic tuning**
- Monitor the fee market for compute/AI services — are prices finding equilibrium?
- Adjust rates if needed based on actual demand
- Track operator revenue vs costs — is the model viable?
- Publish a transparent "State of the Network" report: nodes, apps, revenue, uptime

### What NOT to do
- Do not enable SLA contracts until base payments are proven stable
- Do not enable the burn mechanism. Keep 100% of fees flowing to operators during bootstrap.
- Do not discuss tokens. The system runs on sats.

### Exit criteria
- At least 3 operators receiving real Lightning payments
- At least 5 developers paying for services (even tiny amounts)
- Settlement works without manual intervention for 30 days
- Total network revenue > $0 (any amount — proving the loop works matters more than the number)
- Held-amount accounting verified correct

---

## Phase 5: Trust Layer (Weeks 25-36)

**Goal:** SLA contracts, arbitration, and schema registry create the premium tier. Enterprise-grade reliability guarantees backed by staked collateral.

### What to do

**Week 25-28: SLA contracts go live**
- Enable SLA service on high-uptime nodes (99%+ proven track record from Phase 2-4)
- First SLA contract: a developer stakes collateral for guaranteed availability on a production app
- Verify automated enforcement: create a test SLA, deliberately fail a proof-of-relay challenge, confirm slashing occurs
- Price SLA at 3x base rates. Track demand.

**Week 29-32: Arbitration activation**
- Enable arbitration on nodes with reputation > 100 (should be 5-10 nodes by now)
- File a test dispute with real evidence (bandwidth receipts from Phase 4)
- Verify voting, resolution, reputation adjustment, and slashing all work end-to-end
- Document the dispute process for operators and developers

**Week 33-36: Schema registry adoption**
- Work with 2+ developers building interoperable apps
- Register shared schemas (transaction records, user profiles, content metadata)
- Verify cross-app data consumption: App A writes, App B reads using the schema
- This is the "Data Mesh" proof-of-concept

### Exit criteria
- At least 3 active SLA contracts with real collateral
- At least 1 arbitration dispute filed and resolved
- At least 2 shared schemas in use by different apps
- SLA enforcement has triggered at least 1 real slashing event
- Network revenue from SLA premiums exceeds base-rate revenue

---

## Phase 6: Scale (Months 9-18)

**Goal:** 50+ relay nodes, 100+ seeded apps, sustainable revenue, governance beginning.

### What to do

- Open operator onboarding (self-serve, no core team hand-holding needed)
- Launch the Pioneer Bonus program for underserved regions
- Enable the fee burn mechanism (start at 5%, increase to 15% as volume grows)
- Begin governance discussions (what parameters should operators control?)
- Publish the OpenAPI specification for the router dispatch interface
- Build or commission a public network explorer (stats, leaderboard, app catalog)
- Evaluate: is the BTC-native model sufficient, or does the network need a native token? Let the data decide.

### Exit criteria
- 50+ nodes across 5+ regions
- Positive unit economics for median operator (revenue > costs)
- At least 1 enterprise or institutional SLA contract
- Governance proposal mechanism tested (even if not binding yet)
- $10K+ monthly network revenue

---

## Timeline Summary

| Phase | Weeks | Focus | Key Metric |
|-------|-------|-------|-----------|
| 1. Prove the Core | 1-4 | Reliability + first developers | 5 apps, 3 devs, 14 days uptime |
| 2. Grow Operators | 5-10 | Independent operators + regions | 10 nodes, 5 operators, 3 regions |
| 3. Services Layer | 11-16 | Router + compute + AI live | 1 dev app using services |
| 4. Payments | 17-24 | Real sats flowing | Any revenue > $0 |
| 5. Trust Layer | 25-36 | SLA + arbitration + schema | 3 SLA contracts, 1 dispute resolved |
| 6. Scale | 36-72 | 50+ nodes, sustainable revenue | $10K/month network revenue |

---

## What's Already Done

| Item | Status |
|------|--------|
| 3 relay nodes running | Done |
| Real app seeded and replicated | Done |
| DHT discovery working | Done |
| Publisher-offline availability proven | Done |
| SDK published | Done |
| CLI working (init, start, testnet, seed, status) | Done |
| Dashboard live | Done |
| 201 tests passing | Done |
| Self-healing implemented | Done |
| Services layer implemented (8 services) | Done |
| Router with dispatch, pub/sub, orchestration | Done |
| SLA, Schema, Arbitration services | Done |
| Payment accounting (mock) | Done |
| HomeHive wifi + LAN | Done |

Phase 1 is already partially complete. The 14-day uptime clock and developer onboarding are the remaining gates.

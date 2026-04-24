# Changelog

All notable changes to `p2p-hiverelay`, `p2p-hiveservices`,
`p2p-hiverelay-client`, and (from v0.6.0) `p2p-hiverelay-verifier` are
documented here. Dates in YYYY-MM-DD.

The packages are versioned in lockstep.

## [0.6.0] — Unreleased (in `feat/umbrel-app` branch)

The v0.6.0 pipeline. Three thematic chunks: Umbrel App Store packaging
(consumer brand: Blindspark), threat-model security infrastructure, and
audit-driven hardening that addresses every issue from a comprehensive
post-implementation security audit.

**~10,000 lines added across 9 commits, 354 new tests, all passing.**

### Added — Umbrel App Store package

- `umbrel-app/` directory with submission-ready `umbrel-app.yml`,
  `docker-compose.yml`, `README.md`, `SUBMISSION-CHECKLIST.md`,
  placeholder icon + gallery
- Consumer brand: **Blindspark** (internal package names stay
  `p2p-hiverelay` until v0.7.0 dedicated rebrand)
- 5-step setup wizard module (`packages/core/core/wizard.js`):
  welcome → relay name → LNbits connect → accept-mode → done
- Wizard front-end UI (`dashboard/wizard.html`) — self-contained,
  no framework deps, dark theme, server-side state machine sync
- Smart `/` route: first-run users → `/wizard`, returning operators
  → `/dashboard`
- Updated `Dockerfile` for monorepo paths post-v0.5.0 split; switched
  to Alpine for Pi-class image size
- CI: `docker-publish.yml` publishes to BOTH `ghcr.io/.../p2p-hiverelay`
  AND `ghcr.io/.../blindspark` during transition
- `umbrel-app-validate.yml` CI catches submission breakage on every PR
- ToS compliance: `category: bitcoin` (lightning isn't valid Umbrel
  category), 256×256 SVG icon spec, 1440×900 PNG gallery

### Added — Threat-model security infrastructure

- New module: `packages/core/core/quorum-selector.js` —
  pure-functional diverse-quorum selection with 4 strategies
  (`diverse` / `foundation` / `pinned` / `wide`); diversity warnings
  when minRegions can't be satisfied
- New module: `packages/core/core/fork-detector.js` — persists
  cryptographic equivocation evidence; quarantine API; resolution
  workflow; atomic write pattern; max-forks cap with oldest-first
  eviction
- New top-level workspace package: `packages/verifier/` — standalone
  reference verifier independent of `p2p-hiverelay` for cross-client
  verification; CLI (`hive-verify`) + library API; documented exit
  codes (0 agree / 1 diverge / 2 all-failed / 3 usage)
- `HiveRelayClient` integration: `refreshCapabilityCache()`,
  `selectQuorum()`, `describeQuorum()`, `queryQuorum()`,
  `queryQuorumWithComparison()`, `isDriveQuarantined()`,
  `publishForkProof()`, `pinRelay()`, `unpinRelay()`, `pinnedRelays()`
- New events: `capability-fetch-error`, `quorum-warning`,
  `quorum-divergence`, `fork-detected`, `fork-resolved`,
  `capability-doc-stale`, `capability-pubkey-mismatch`,
  `capability-verify-error`, `quarantine-bypassed`
- Quarantine-aware `client.open()`: refuses drives with unresolved
  forks unless `force: true` is passed (throws `code: 'DRIVE_QUARANTINED'`)
- Auto fork-detection during replication: `client.open()` attaches
  Hypercore `truncate` + `verification-error` listeners that
  auto-report to ForkDetector
- Federation gossip: `_pullForkProofs()` pulls fork-proof list from
  each followed peer per cycle (~5 min latency)
- Stream-fee endpoint scaffolding (Foundation 1.5% routing pending
  Foundation entity creation)

### Added — Audit-driven security hardening

- LNbits admin key encryption at rest (AES-256-GCM with key derived
  from `$APP_SEED` via HMAC-SHA256; v1→v2 migration auto-encrypts on
  next save; file chmod 0600)
- Capability doc Ed25519 signing by relay's identity key; client
  verification on fetch; tamper attempts caught
- Capability doc `attestedAt` timestamp inside signed payload
  (prevents stale-doc replay); client emits `capability-doc-stale`
  event when older than `maxAgeMs` (default 24h)
- Audit trail for `force:true` quarantine bypasses
  (`forkDetector.bypassLog()`, capped at 500 entries, persisted)
- Pubkey pinning via `client.pinRelay(url, pubkey)`; auto-injection in
  `fetchCapabilities`; constructor `knownRelays` config
- Signed fork proofs: new `fork-proof-signing.js` module; Ed25519
  observer signature with `attestedAt`; 7-day freshness window for
  replay protection; 5-min skew tolerance for clock drift
- Server `/api/forks/proof` endpoint REQUIRES signed envelope; rejects
  bare unsigned proofs with bad-request
- Per-endpoint rate limits for sensitive paths
  (5/min on `/api/wizard/lnbits`, 10/min on `/complete`,
   20/min on `/api/forks/proof`); 429 responses include
  `errorCode: 'rate-limited'`

### Added — Strategic documentation

- `docs/THREAT-MODEL.md` — three-category state model
  (authored / observed / derived), defense mechanisms, 6 named
  attacks with mitigation status, honest-framing principles
- `docs/SECURITY-STRATEGY.md` — authoritative attack-vector tracker,
  32 vectors across 10 categories tagged 🟢/🟡/🟠/🔴, three
  operational preconditions documented as non-negotiable
- `docs/OPERATOR-INCENTIVES-Y1.md` — closes the "open problem" of
  operator economics in year one with the trojan-horse + 1 BTC
  bootstrap + foundation network triad
- `docs/M2-ROADMAP.md` — explicitly scoped M2 deliverables with
  effort estimates and sequencing
- `umbrel-app/SUBMISSION-CHECKLIST.md` — full compliance audit + PR
  template ready to paste into the upstream Umbrel App Store repo

### Notes for operators

- v0.6.0 includes meaningful security upgrades but is **not yet
  deployed to live relays**. PR #5 against `release/v0.5.1`.
- No bootstrap subsidy disbursement should occur until M2 Sybil
  defense gates ship (documented as non-negotiable precondition).
- Wizard collects LNbits admin key — encrypted on disk via AES-GCM
  but operators on shared filesystems should still treat the key
  carefully.

---

## [0.5.1] — 2026-04-20

Additive release — zero breaking changes, safe to hot-deploy on top of 0.5.0.
Introduces three features focused on client/relay interoperability: a
machine-readable capability document, a machine-readable error prefix
convention, and an author-published seeding manifest.

See [`docs/v0.5.1-CAPABILITIES.md`](docs/v0.5.1-CAPABILITIES.md) for the
full spec with examples.

### Added

**Capability advertisement**
- `GET /.well-known/hiverelay.json` — returns a JSON document describing
  the relay's identity, version, accept policy, transports, features,
  limits, federation counts, catalog counts, and fees. Served at
  `/api/capabilities` as a mirror for CDNs / proxies that hide
  `/.well-known`. Built lazily per-request in <1ms, `Cache-Control:
  public, max-age=60`.
- Implemented for both Node (`RelayAPI`) and Bare (`BareHttpServer`)
  runtimes with identical payloads — one client code path works against
  either runtime.
- `client.fetchCapabilities(relayUrl)` helper in the SDK — scan many
  relays for the right accept mode / version / feature set without
  opening a Hyperswarm connection.

**Machine-readable error prefixes**
- New `p2p-hiverelay/core/error-prefixes.js` module exporting `ERR`
  (frozen map of 12 stable prefix strings), `formatErr(kind, message)`,
  `classifyErr(err)` and `isErr(err, kind)`. Clients can branch on
  failure type (`AUTH_REQUIRED`, `PAYMENT_REQUIRED`, `ACCEPT_QUEUED`,
  `DELEGATION_REVOKED`, etc.) without string-matching human messages.
- Management-API auth-failure responses now include a new `errorCode`
  field (`"auth-required"`) alongside the legacy `error` string. Legacy
  clients string-matching on `Unauthorized` keep working.

**Author seeding manifest**
- New `p2p-hiverelay/core/seeding-manifest.js` — Ed25519-signed
  "these are the relays you should fetch my drives from" document.
  Canonical signable payload sorts JSON keys so verification is
  deterministic across encoders. 5-min timestamp-skew window for
  replay protection. Max 32 relays / 512 drives per manifest.
- New `p2p-hiverelay/core/manifest-store.js` — persistent cache of
  author manifests, atomic-write to `storage/manifests.json`. Cap:
  10k authors, oldest-first evicted. Newer-timestamp wins within a
  given pubkey.
- `POST /api/authors/seeding.json` — publish a signed manifest
  (signature IS the authorization; no API key needed). `GET /api/authors/
  <pubkey>/seeding.json` — fetch the cached manifest for a pubkey
  (404 when none cached).
- Client helpers: `createSeedingManifest(args)`, `publishSeedingManifest(
  relayUrl, manifest)`, `fetchSeedingManifest(relayUrl, pubkey)`.
- `ManifestStore` lifecycle integrated into `RelayNode.start()` and
  `RelayNode.stop()` (atomic persistence on shutdown).

### Fixed

- `RelayAPI` honors `apiPort: 0` (OS-selected port for tests) instead
  of silently falling back to the default 9100. The old `||` coalesce
  was discarding `0` as falsy.
- `RelayAPI._rateLimitCleanup` interval is now `unref()`'d so a forgotten
  `api.stop()` in a test no longer pins the Node event loop open.

### Notes for operators upgrading from 0.5.0

All changes are additive. No config migration required. Restart the
relay; hit `/.well-known/hiverelay.json` to verify the new surface
is live. See the deploy guide in `docs/v0.5.1-CAPABILITIES.md`.

---

## [0.5.0] — 2026-04-20

Large refactor + feature release. The headline is **Core / Services split**
(two products with distinct trust surfaces), **first-class Bare/Pear runtime
support**, **per-relay catalog with accept modes** (replaces the old
auto-sync story), a **DHT-over-WebSocket transport** (so browser clients
can do real HyperDHT through any participating node), and **multi-device
pairing with delegation certs + revocation**. Plus a lot of hardening.

Backward-compatible at the wire and (mostly) at the public API. Safe to
upgrade from 0.4.x — but read the "Changed behavior" section below,
because defaults moved in two places.

### Added

**Architecture**
- Monorepo split into three packages (`packages/core`, `packages/services`,
  `packages/client`) shipped as `p2p-hiverelay`, `p2p-hiveservices`,
  `p2p-hiverelay-client`. Core no longer pulls in service-layer deps; most
  operators only need Core. ([REFACTOR-NOTES.md](docs/REFACTOR-NOTES.md))
- Runtime-conditional exports: `"bare": "./pear-entry.js", "default":
  "./core/index.js"`. Two runtimes (Node and Bare/Pear) from one source
  tree; Node and Bare relays fully interoperate on the wire.

**Runtime**
- `BareRelay` — stripped-down relay for Bare/Pear runtimes. No vm, no DNS,
  no Lightning, no Pino. Keeps: Hyperswarm + DHT + Corestore + Hyperdrive
  + Seeder + circuit relay + ProofOfRelay + service protocol channel +
  app registry + federation.
- `pear-entry.js` + `bare-http-server.js` (minimal `bare-http1` surface).
- Shared policy helpers (`core/accept-mode.js`, `core/delegation.js`) so
  Node and Bare apply identical rules to identical inputs.

**Catalog (per-relay, no auto-sync)**
- Four accept modes: `open` | `review` | `allowlist` | `closed`
  (replacing the old boolean `registryAutoAccept`).
- Bounded pending queue (`maxPendingRequests`, default 5000) with
  oldest-first eviction and `'pending-evicted'` events.
- Federation module (`core/federation.js`): explicit `follow(url)`,
  `mirror(url, {pubkey})`, `republish(appKey, {sourceUrl, channel,
  note})`, `unfollow(url)`, `unrepublish(appKey)`. Persisted to
  `<storage>/federation.json` with atomic write+rename; reloads across
  restarts.
- Federation URL validation rejects `javascript:`, `file:`, `data:`,
  oversized, and malformed URLs.
- `/catalog.json` now includes `acceptMode` and `federation:
  {followed, mirrored, republished}`.
- 13 new `/api/manage/*` endpoints + 12 new `hiverelay` CLI subcommands
  (`hiverelay catalog mode/approve/reject/remove/pending`,
  `hiverelay federation list/follow/mirror/unfollow/republish/unrepublish`).

**Transports**
- **DHT-over-WS** (`transports/dht-relay-ws/`) — wraps
  `@hyperswarm/dht-relay` so browser clients can tunnel HyperDHT lookups
  through a relay. Per-IP rate limiting at WS upgrade time (10/min/IP,
  5 concurrent/IP default). Closes the "no DHT-relay WS out of the box"
  reviewer feedback.

**Gateway**
- Streaming via `drive.createReadStream()` (was buffering entire files
  into memory).
- HTTP Range support (206 + `Content-Range`), `Accept-Ranges: bytes`,
  Content-Type by extension, HEAD method.

**Client SDK**
- Per-source `getAvailableApps()` — one row per `(app, source-relay)`
  pair tagged with `source.relayPubkey`. `{groupBy: 'app'}` restores the
  legacy merged shape. New `getAvailableAppsBySource()` helper.
- Replication as first-class math: `getReplicationStatus`,
  `getReplicationOverview`, `enableReplicationMonitor`.
- Reader-as-replica (Keet-style room redundancy): `client.mirror(driveKey)`
  / `unmirror(driveKey)`; `open({ seedAsReader: true })`; opt-in
  only, never automatic.
- **Community-replica manifest**: `registerCommunityReplicas(drives)` +
  `enableCommunityReplicas({driveKey?})` / `disableCommunityReplicas`.
  Apps declare which drives their users can volunteer to help seed;
  users opt in once.
- **Multi-device identity**: `exportIdentity` / `importIdentity` for
  direct transfer; `createDeviceAttestation` / `verifyDeviceAttestation`
  for signed, TTL'd delegation certs; `createCertRevocation` for early
  invalidation.
- **Pairing-over-swarm**: `createPairingCode()` + `claimPairingCode(code)`
  — 6-digit zero-knowledge HMAC handshake with identity transfer over
  Noise-encrypted Hyperswarm channel. Per-peer rate limit
  (6 attempts/min/peer) against online brute-force.
- **Durability helpers**: `getDurableStatus(driveKey)` and
  `waitForDurable(driveKey, {timeoutMs, minPeers})` distinguish "relay
  accepted the seed request" from "bytes are actually being replicated."
- `publish()` now attaches `drive.replicas = {target, accepted, healthy,
  relays: [{pubkey, region}]}` so callers get acceptance visibility
  without a follow-up call.

**Server-side delegation**
- RelayNode and BareRelay both verify `delegationCert` on inbound seed
  requests (both the registry scan path and the Protomux direct path).
  On success, seeds are attributed to the primary identity. On failure,
  emit `delegation-rejected`.
- Revocation store + periodic sweep; operators publish signed revocations
  via `/api/manage/delegation/revoke`.

**Payment interface (staged)**
- Formal `PaymentProvider` base class + `selectProvider(providers,
  {asset, rail, amountUsd})`.
- Asset-aware `pay()` and `createInvoice()` on LightningProvider +
  MockProvider. Default `'BTC'` preserves all existing behavior; non-BTC
  throws until Taproot Assets integration lands (see roadmap).

**Documentation (6 new)**
- `docs/REFACTOR-NOTES.md` — source of truth for the refactor
- `docs/CRYPTO-GUARANTEES.md` — what operators can / cannot do, in math
- `docs/REVERSE-PROXY.md` — nginx + TLS + Let's Encrypt operator guide
- `docs/PEARBROWSER-INTEGRATION-BRIEF.md` — PearBrowser integration contract
- `docs/IDENTITY-AND-STORAGE.md` — anti-pattern warning for
  Corestore primaryKey tied to identity seed (reproducible data loss trap)
- `docs/QVAC-INTEGRATION-ANALYSIS.md` — strategic analysis for the
  qvac + Tether direction (no code yet, read-ahead for a future decision)
- `docs/OPERATOR_ECONOMICS.md` — rewritten without compute-revenue
  assumptions
- 16 older docs banner-deprecated with pointers to REFACTOR-NOTES

### Changed

- **Default `acceptMode` is now `'review'`** (was effectively `'open'`
  via `registryAutoAccept: true`). Inbound seed requests queue for
  operator approval unless explicitly configured otherwise. Operators
  upgrading from 0.4.x who want the old behavior: set
  `acceptMode: 'open'` or keep `registryAutoAccept: true` (honored as
  a deprecated alias).
- **HomeHive profile now defaults to `acceptMode: 'allowlist'`** — the
  right conservative default for always-on household hardware.
- `RelayNode` no longer hardcodes service constructors. Services load
  dynamically via `PluginLoader` when `config.plugins` is set and
  `p2p-hiveservices` is installed alongside Core.
- Protomux `app-catalog` auto-seed is now gated behind explicit mirror
  opt-in; was unconditional in 0.4.x.
- `rate-limited` DHT-over-WS connections are rejected at the `verifyClient`
  stage (HTTP 429/503), not after the WebSocket upgrade. Clients no
  longer see `'open'` followed by an immediate close.
- Per-relay catalog local view only — no more background cross-relay
  sync. Operators explicitly follow / mirror / republish.

### Fixed

- **`client.seed()` computed the wrong discoveryKey** (plain BLAKE2b of the
  pubkey, should be keyed BLAKE2b per hypercore-crypto). The signed
  seed-request advertised a DHT topic that didn't match the drive.
  Relays consuming `msg.discoveryKeys` looked in the wrong spot; peers
  never connected. Surfaced by a PearBrowser integration report
  ("relays accept seed but `drive.core.peers` stays at 0"). Fix uses
  `hypercore-crypto.discoveryKey(pubkey)`; callers can also pass
  `opts.discoveryKey` to pin `drive.discoveryKey` explicitly.
- **`federation.json` save was not atomic** — single `writeFile` could
  corrupt under SIGKILL mid-write. Now writes to `.tmp` and renames
  (POSIX-atomic).
- **Test suite silently skipped ~160 tests** — a `setTimeout(() =>
  process.exit(0), 500)` in `test/unit/private-mode.test.js` worked
  around dangling MDNS sockets but killed the brittle process mid-run,
  hiding every test file alphabetically after `private-mode`. Proper
  teardowns added; hack removed. Real test count jumped from 425 to 594.
- Test-runner timeout bumped to 120s globally to tolerate slow
  Corestore/swarm teardowns in a handful of integration-style unit tests.
- `@grpc/grpc-js` + `@grpc/proto-loader` moved back from
  `p2p-hiveservices` to `p2p-hiverelay` (Lightning provider lives in
  Core's incentive module; the initial split misplaced these).

### Removed

- **Compute service deleted entirely.** `core/services/builtin/compute-service.js`,
  `core/services/builtin/js-sandbox-worker.js`. Not "coming soon" —
  gone. Pre-refactor versions shipped a stub marked as "sandboxed JS
  execution" that didn't actually sandbox. Re-introduction would be a
  dedicated product line with its own threat model (WASM + resource
  quotas + tenant isolation).
- Rate-card entries, dashboard sliders, CLI profile toggles, and pricing
  engine rows for compute.
- `catalog-sync.js` — dead module exported but never instantiated
  anywhere; semantics replaced by the new `federation.js` module.

### Breaking changes

Short list. None affect the wire protocol — 0.5.0 and 0.4.x relays
interoperate on the same network.

1. **Compute routes gone.** Any code calling `compute.submit`,
   `compute.status`, `compute.result` will fail. If you used compute,
   nothing in the 0.5.0 surface replaces it; you'll need a separate
   design.
2. **Service class imports moved.** `AIService`, `IdentityService`, etc.
   no longer re-exported from `p2p-hiverelay`. Import from
   `p2p-hiveservices/builtin/ai-service.js` or use `PluginLoader` via
   `config.plugins`.
3. **`acceptMode: 'review'` is the new default.** Seed requests queue
   instead of auto-accepting. To preserve 0.4.x behavior explicitly:
   ```js
   new RelayNode({ acceptMode: 'open' })  // or: registryAutoAccept: true
   ```
4. **`examples/{pear-app,node-app}/package.json`** now reference
   `file:../../packages/core` instead of `file:../../`. Only affects
   code that linked against the examples.

### Notes for operators upgrading

- If you run a public relay on 0.4.x: the new `acceptMode: 'review'`
  default means you'll accumulate a pending queue instead of auto-
  accepting. Either set `acceptMode: 'open'` for pre-upgrade behavior,
  or start draining the pending queue via `hiverelay catalog pending`
  and `hiverelay catalog approve <appKey>`.
- The new `hiverelay` CLI (`packages/core/cli/index.js`) knows about the
  new subcommands; `hiverelay --help` enumerates them.
- `docs/REVERSE-PROXY.md` is a worked nginx + TLS + Let's Encrypt config
  for operators exposing the three ports (8765 Hypercore-WS, 8766
  DHT-over-WS, 9100 HTTP). Highly recommended before going public.
- If you tied Corestore's `primaryKey` to an app-managed identity seed
  in your own integration, read `docs/IDENTITY-AND-STORAGE.md` — it's a
  reproducible data-loss trap and the doc walks through the safe pattern.

### Roadmap hint (not in 0.5.0)

- **Tether-over-Lightning** (USDt via Taproot Assets) is staged behind
  the new `PaymentProvider` interface but the tapd integration isn't
  wired yet. Expected in a future 0.5.x.
- **Qvac integration** — analysis complete in
  `docs/QVAC-INTEGRATION-ANALYSIS.md`, implementation awaiting a
  product decision on how deep to integrate (wrap vs. delegate to vs.
  replace our AIService).
- Revocation list propagation via federation (currently revocations are
  per-relay submissions; no auto-broadcast).

---

## [0.4.2] and earlier

No structured changelog was kept prior to 0.5.0. See git history.

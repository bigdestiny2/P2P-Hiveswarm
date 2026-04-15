# HiveRelay Audit Roadmap

**Generated:** April 2026 | **Based on:** 6-agent codebase audit (architecture, protocol, security, code quality, performance, alternatives)

---

## Completed (this session)

- [x] **S1** Management API auth — API key via `HIVERELAY_API_KEY` env var or localhost-only fallback
- [x] **S2** Unauthenticated `/unseed` — now requires API key
- [x] **S3** Unauthenticated `/seed` — now requires API key
- [x] **S4** HTTP dispatch `caller: 'api'` → `caller: 'remote'` — blocks `identity.sign` from HTTP
- [x] **S5** Service protocol OOM — 1MB max message size + try/catch on JSON.parse
- [x] **S6** Dashboard XSS — `escapeHtml()` on all user-supplied data in index.html, network.html, leaderboard.html
- [x] **Q1** `_proofOfRelay.destroy()` called on shutdown — prevents timer leak
- [x] **Q2** `chmod 0o600` on `relay-identity.json` — protects secret key
- [x] **Q3** Error message leak — catch-all returns generic "Internal server error"

---

## Phase 1: Remaining Security (Priority: Critical — do this week)

### 1.1 Unseed replay protection
- **File:** `core/protocol/seed-request.js`
- **Issue:** 5-minute timestamp window has no nonce/dedup — intercepted unseed replayable within window
- **Fix:** Add random nonce to unseed message, maintain seen-nonces set (similar to BandwidthReceipt pattern at `bandwidth-receipt.js:80-82`)
- **Effort:** 2-3 hours

### 1.2 Legacy unseed accepts any signature
- **File:** `core/relay-node/index.js:712-717`
- **Issue:** Apps with `publisherPubkey === null` accept any valid Ed25519 signature
- **Fix:** Reject unseed for apps with no recorded publisher. Log a warning suggesting operator backfill publisher keys
- **Effort:** 30 minutes

### 1.3 Catalog sync rate limiting
- **File:** `core/relay-node/index.js:343-361`
- **Issue:** Malicious relay can broadcast catalog with thousands of bogus apps, forcing all connected relays to seed them
- **Fix:** Cap at 10 new apps per catalog event per peer. Throttle to max 1 catalog event per peer per 30 seconds
- **Effort:** 1 hour

### 1.4 Service RPC access control
- **File:** `core/services/protocol.js:236-268`
- **Issue:** Any connected peer can call any service method with arbitrary params
- **Fix:** Add per-service access level (public/authenticated/admin). Default sensitive methods (identity.sign, compute.submit) to authenticated
- **Effort:** 3-4 hours

### 1.5 WebSocket dashboard auth
- **File:** `core/relay-node/ws-feed.js:32-41`
- **Issue:** No origin validation or auth on WebSocket feed — anyone can get real-time telemetry
- **Fix:** Validate Origin header, optionally require token parameter
- **Effort:** 1 hour

### 1.6 Content-Type validation on POST
- **File:** `core/relay-node/api.js:738-762`
- **Issue:** Parses any POST body as JSON regardless of Content-Type — CSRF risk
- **Fix:** Reject requests without `Content-Type: application/json`
- **Effort:** 15 minutes

### 1.7 Config update bounds checking
- **File:** `core/relay-node/api.js:770-809`
- **Issue:** `parseInt()` without validation — can set `maxConnections` to 0, negative, or NaN
- **Fix:** Validate all numeric config values are positive integers within sane ranges
- **Effort:** 30 minutes

---

## Phase 2: Performance & Stability (Priority: High — this month)

### 2.1 Gateway duplicate P2P stack
- **File:** `compute/gateway/hyper-gateway.js:156-167`
- **Issue:** Gateway creates its own Corestore + Hyperswarm, doubling memory on 512MB boxes
- **Fix:** Share relay's Corestore with a namespace. Pass store reference into HyperGateway constructor
- **Effort:** 3-4 hours
- **Impact:** ~30-50MB memory savings on Utah box

### 2.2 Gateway file streaming
- **File:** `compute/gateway/hyper-gateway.js:258-290`
- **Issue:** `drive.get()` buffers entire file in memory before sending — 50MB file = 50MB spike
- **Fix:** Replace with `drive.createReadStream()` piped to response. Add Range request support
- **Effort:** 2-3 hours

### 2.3 Reduce DriveCache on small boxes
- **File:** `compute/gateway/hyper-gateway.js`
- **Issue:** Default 50 cached drives × ~5-10MB each can blow the memory budget
- **Fix:** Make configurable, default to 10. On boxes < 1GB RAM, auto-set to 5
- **Effort:** 30 minutes

### 2.4 Debounce catalog broadcasts
- **File:** `core/relay-node/index.js:339-340`
- **Issue:** Every seed/unseed fires immediate full catalog broadcast to all peers
- **Fix:** 5-second debounce window — rapid changes during startup only trigger one broadcast
- **Effort:** 1 hour

### 2.5 Delta catalog sync
- **File:** `core/services/protocol.js:159-167`
- **Issue:** Full JSON catalog sent on every exchange — breaks at ~500 apps
- **Fix:** Send diffs (added/removed) over service protocol. Full catalog on initial connect only
- **Effort:** 4-6 hours

### 2.6 AppRegistry save debouncing
- **File:** `core/app-registry.js:306`
- **Issue:** Every mutation (including bytesServed counter) triggers full JSON.stringify + disk write
- **Fix:** Separate hot counters (bytesServed) from cold state. Debounce saves to max once per 5 seconds
- **Effort:** 2 hours

### 2.7 Circuit relay pending-connect bounds
- **File:** `core/protocol/relay-circuit.js:165`
- **Issue:** No cap on pending connects — flood attack grows queue unboundedly
- **Fix:** Check `_maxPendingConnects` before enqueue, reject with error if full
- **Effort:** 30 minutes

### 2.8 BandwidthReceipt nonce eviction
- **File:** `core/protocol/bandwidth-receipt.js:118-130`
- **Issue:** O(n) iteration over 50K nonces during eviction
- **Fix:** Time-bucketed structure (Map of minute-buckets, drop entire old buckets)
- **Effort:** 1-2 hours

---

## Phase 3: Architecture Refactoring (Priority: Medium — next month)

### 3.1 Extract RelayNode into composed managers
- **File:** `core/relay-node/index.js` (1,233 lines)
- **Issue:** God class with ~30 responsibilities
- **Extract:**
  - `TransportManager` — WebSocket, Tor, Holesail lifecycle
  - `ProtocolManager` — SeedProtocol, CircuitRelay, ProofOfRelay, BandwidthReceipt wiring
  - `AppSeedingManager` — seedApp, unseedApp, eviction, eager replication, manifest indexing
  - `RegistryScanner` — _scanRegistry, approveRequest, rejectRequest
- **Target:** RelayNode under 400 lines, focused on lifecycle orchestration
- **Effort:** 2-3 days

### 3.2 Split API into route modules
- **File:** `core/relay-node/api.js` (1,017 lines)
- **Issue:** Single 600-line if/else chain, 102 references to private node internals
- **Fix:**
  - Route table: `{ path, method, handler, auth }` array
  - Route modules: `routes/manage.js`, `routes/apps.js`, `routes/registry.js`, `routes/services.js`
  - Node query interface: expose needed state through public getters instead of private field access
- **Effort:** 2-3 days

### 3.3 Plugin architecture for services
- **File:** `core/relay-node/index.js:27-33` (hardcoded imports), `core/relay-node/index.js:298-314` (registration)
- **Issue:** All 8 services loaded regardless of operating mode
- **Fix:**
  - New `core/plugin-loader.js` (~100 lines)
  - Config-driven: `config.plugins = ['@hiverelay/ai-service', './my-custom-service']`
  - Built-in services move to `plugins/builtin/` but remain bundled as defaults
  - Operating modes become preset plugin configurations
- **Foundation:** `ServiceProvider` base class already defines the interface — `manifest()`, `start()`, `stop()`
- **Effort:** 1-2 days

### 3.4 Shared constants module
- **Issue:** Discovery topic, protocol names, hex validation duplicated 6+ times
- **Fix:** Create `core/constants.js` exporting:
  - `RELAY_DISCOVERY_TOPIC`
  - Protocol names (`'hiverelay-seed'`, `'hiverelay-circuit'`, `'hiverelay-services'`)
  - `isValidHexKey()`
  - `compareVersions()`
  - `uint64ToBuffer()`
- Replace all 6+ duplicate definitions with imports
- **Effort:** 2-3 hours

### 3.5 Share protocol code between client and server
- **File:** `client/index.js` (reimplements seed protocol channel setup)
- **Issue:** Client duplicates server protocol logic instead of importing `SeedProtocol`
- **Fix:** Make `SeedProtocol` usable from both sides, or extract shared `ProtocolChannels` class
- **Effort:** 1-2 days

---

## Phase 4: Testing (Priority: Medium — ongoing)

### 4.1 HTTP API tests (highest priority gap)
- **Coverage:** 0 tests for 25+ routes
- **Target:** Test the 10 most critical routes including auth checks, error handling, rate limiting
- **Effort:** 1-2 days

### 4.2 Protocol layer tests
- **Coverage:** SeedProtocol, CircuitRelay, ServiceProtocol — all untested
- **Target:** Message encoding/decoding, signature verification, error handling
- **Effort:** 1-2 days

### 4.3 Adversarial testing
- **Coverage:** No tests for malformed messages, spoofed signatures, oversized payloads, rate limiting
- **Target:** At least one adversarial test per protocol
- **Effort:** 1-2 days

### 4.4 Unseed verification tests
- **Coverage:** `verifyUnseedRequest()` signature verification untested
- **Target:** Valid signatures, invalid signatures, expired timestamps, wrong publisher
- **Effort:** 2-3 hours

---

## Phase 5: Future Architecture (Priority: Low — when needed)

### 5.1 Lightweight service supervision
- Replace `SelfHeal` with per-service restart capability
- Add `restart(serviceName)` to ServiceRegistry
- Wrap each `dispatch()` in try/catch that marks failed services and triggers restart
- **Depends on:** 3.3 (plugin architecture)

### 5.2 Federated reputation
- Shared Hypercore for relay reputation scores (gossip-based)
- Each relay appends proof-of-relay results to shared core
- Others replicate and merge scores
- **Foundation:** `SeedingRegistry` already uses shared Hypercore pattern

### 5.3 Fix proof-of-relay Merkle verification
- **File:** `core/protocol/proof-of-relay.js:367-399`
- **Issue:** Custom Merkle verifier incompatible with Hypercore's flat tree layout — never succeeds
- **Fix:** Integrate with Hypercore's `core.audit()` or remove the custom verifier
- **Depends on:** Hypercore API stability

### 5.4 Service protocol migration to compact-encoding
- **File:** `core/services/protocol.js:62-78`
- **Issue:** JSON over Protomux with redundant length prefix — acknowledged in code comments
- **Fix:** Define proper compact-encoding message types
- **Effort:** 4-6 hours (breaking protocol change — needs version negotiation)

---

## Dependency Cleanup

| Item | Effort | Impact |
|------|--------|--------|
| Remove `@grpc/grpc-js` + `@grpc/proto-loader` (unused, ~15MB) | 5 min | Smaller installs |
| Lazy-load `@inquirer/prompts` (only for CLI setup wizard) | 30 min | Faster startup |
| Lazy-load `@noble/secp256k1` + `@noble/hashes` (only for ZK) | 30 min | Smaller non-ZK footprint |
| Read version from `package.json` instead of hardcoded strings | 5 min | Correct version bumps |

---

## Architecture Decision Record

**Recommended long-term architecture:** Hybrid approach

1. **Plugin system** — convert hardcoded services to config-driven (lowest risk, highest value)
2. **Lightweight supervision** — per-service restart without full actor model
3. **Federated reputation** — shared Hypercore for scores (not credits)
4. **Selective isolation** — worker threads for AI inference only

**What NOT to change:**
- Protomux multiplexing over single connections
- DHT-based discovery (no central registry)
- Dual transport (P2P + HTTP) through unified Router
- Atomic disk persistence with write-coalescing
- Single-process deployment model (critical for home operators)

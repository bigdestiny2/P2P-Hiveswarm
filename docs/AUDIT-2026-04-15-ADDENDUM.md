> [!WARNING]
> **Doc may be partially out of date.** This file was written before the Compute removal, Core/Services split, and Catalog auto-sync removal. See [REFACTOR-NOTES.md](REFACTOR-NOTES.md) for current architecture.

# HiveRelay Audit Addendum (Post-Hardening)
Date: 2026-04-15  
Scope: changes after `da29316` in this working branch

## What Was Implemented

### 1) Distributed seeding registry behavior
- Registry moved to multi-log sync model with:
  - peer log key exchange over Protomux metadata channel,
  - remote log discovery + replication + incremental indexing,
  - timestamp-aware conflict handling for requests/accepts/cancels.
- Added integration coverage for cross-relay request replication.

### 2) Privacy tier/runtime enforcement
- `seedApp` now enforces `PolicyGuard` on the relay data path:
  - default mode uses `replicate-user-data` (strict fail-closed),
  - optional operator override (`strictSeedingPrivacy=false`) relaxes to `serve-code`.
- `privacyTier` is normalized/persisted in registry + app metadata paths.
- Gateway now enforces `gatewayPublicOnlyPrivacyTier` (default on) and blocks non-public tiers via HTTP.

### 3) HomeHive/private mode operational completeness
- Added `applyMode()` profile application path and wired management mode switch to it.
- Added authenticated management endpoints for:
  - `/api/manage/devices` (list/add/remove),
  - `/api/manage/pairing` (status/start/stop).
- Access control sync remains active on runtime mode changes.

### 4) Catalog trust and sync hardening
- Service protocol now supports signed catalog envelope fields:
  - `relayPubkey`, `catalogTimestamp`, `signature`.
- Relay verifies envelope freshness/signature (optional strict mode via config).
- Added staleness filtering for old catalog entries.

### 5) Replication health/repair loop
- Added replication monitor with:
  - periodic health checks against active registry requests,
  - under-replication tracking,
  - optional auto-repair seeding + acceptance recording.

### 6) Multi-tenant safety controls (AI/compute)
- Compute service now enforces:
  - per-caller active job limits,
  - owner-based job access control,
  - input/output payload size caps,
  - execution timeout.
- AI service now enforces:
  - admin/local model registration/removal by default,
  - per-caller queue limits,
  - input/output size caps.

### 7) Authorization model tightening
- Router remains explicit policy-driven.
- Default unknown service route class changed to `authenticated-user` (secure-by-default).
- HTTP dispatch now derives admin role from route policy (not fixed static list).

## Current Reality vs Website-Style Claims

### Strongly supported now
- “Keeps P2P apps available/reachable when peer availability fails.”
- “Private/HomeHive modes enforce allowlist admission.”
- “Registry is distributed across relays, not local-only.”

### Supported but still cautious wording
- Privacy guarantees: materially improved, but still rely on app metadata correctness and policy wiring.
- Catalog trust: signed envelopes available; strict signed-only mode is opt-in.
- AI/compute safety: guardrails added, but not full OS/process-level tenant isolation.

### Still not production-strong claims
- Payments/operator economics as reliable default behavior (still optional/backend dependent and explicitly marked experimental in runtime stats/warnings).
- SLA/trust layer as buyer-grade production guarantee.

## Highest-Value Remaining Gaps

1. Move AI/compute execution to stronger runtime isolation (process/VM/WASM sandboxing).
2. Add end-to-end integration tests for private-tier data paths beyond storage RPC.
3. Add explicit production profiles + deployment docs (TLS/reverse proxy/auth key rotation).
4. Clarify docs/website language for optional economics and SLA maturity.
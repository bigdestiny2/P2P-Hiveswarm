> [!WARNING]
> **Doc may be partially out of date.** This file was written before the Compute removal, Core/Services split, and Catalog auto-sync removal. See [REFACTOR-NOTES.md](REFACTOR-NOTES.md) for current architecture.

# HiveRelay Focus Execution Plan

**Date:** April 15, 2026  
**Product Wedge:** HiveRelay keeps P2P apps available and reachable when normal peer availability fails.

This plan turns the current audit direction into execution checkpoints with clear acceptance criteria.

---

## 1) Fix First (Blocking Public Claims)

| Item | Current Status | Acceptance Criteria |
|---|---|---|
| Lock down `/api/v1/dispatch` and registry mutation endpoints | Partial | `POST /api/v1/dispatch` and `POST /registry/*` require explicit auth. Unauthorized requests return `401` and are covered by tests. |
| Default CORS to deny, not `*` | Partial | Default `corsOrigins` is deny-by-default (or strict allowlist). Browser-origin abuse tests pass for denied origins. |
| Restrict operator-only methods (`ai.register-model`, etc.) | Partial | Operator-only methods require admin context. Remote unauthenticated calls are denied in HTTP and P2P. |
| Wire PolicyGuard + `privacyTier` through runtime | Partial | Seeded app metadata persists `privacyTier`. Storage and relay operations enforce guardrails for each tier with explicit rejection paths and tests. |
| Implement true distributed seeding registry behavior OR reduce claims | Partial | Either: peer logs are replicated + indexed + merged with consistency tests; or docs/website explicitly downgrade to local/experimental registry behavior. |
| Wire AccessControl into real connection admission (HomeHive) | Not complete | Incoming connections are checked before protocol attach/replication in HomeHive/private mode. Unauthorized devices are dropped and tested. |
| Fix catalog-sync throttle wiring bug + fail-closed service startup | Partial | Catalog throttle uses correct peer key field end-to-end. Service startup failures do not leave services advertised as healthy. |

---

## 2) Build Next (Stabilization + Product Integrity)

| Item | Current Status | Acceptance Criteria |
|---|---|---|
| Authorization model for service routes (`public`, `authenticated-user`, `relay-admin`, `local-only`) | Not implemented | Route manifests include access level and enforcement is centralized. Tests prove route-level policy in HTTP and P2P paths. |
| Integration tests for auth, registry sync, privacy enforcement, abuse paths | Partial | New suites cover: auth gates, registry convergence behavior, privacy-tier enforcement, SSRF/operator-method abuse attempts. |
| Release hardening pass (lint, CI gates, prod profiles, TLS guidance) | Partial | CI blocks merge on lint/tests, documented production profiles exist, reverse-proxy/TLS docs match actual threat model. |
| Product focus (relay availability as default, advanced features as opt-in/experimental) | Partial | Docs + website + defaults emphasize relay availability first. AI/compute/payments/SLA are clearly marked opt-in or experimental unless fully production-proven. |

---

## 3) Suggested Execution Order (2-Week Sprint)

1. **Control Plane Lockdown**
   - Auth on dispatch + registry mutations.
   - CORS default-deny.
   - Operator-only service method protections.

2. **Truth-in-Behavior Alignment**
   - PolicyGuard + privacy tier wiring.
   - AccessControl admission enforcement.
   - Catalog throttle field fix.
   - Fail-closed service startup behavior.

3. **Verification and Shipping Guardrails**
   - Add integration abuse-path tests.
   - Enforce lint/CI gates.
   - Update production deployment docs for TLS/reverse proxy.

4. **Positioning and Defaults**
   - Website/docs wording aligned to implemented behavior.
   - Advanced subsystems moved to explicit opt-in/experimental posture.

---

## 4) “Ready to Claim” Checklist

Use this before publishing strong website claims:

- [ ] Public control plane is authenticated and deny-by-default.
- [ ] Privacy enforcement is active in runtime, not only documented.
- [ ] HomeHive/private mode enforces device admission.
- [ ] Registry claims match implemented distributed behavior.
- [ ] Service authorization model is explicit and tested.
- [ ] Production docs reflect actual deployment security posture.

If any are unchecked, avoid “guarantee-level” wording in public copy.
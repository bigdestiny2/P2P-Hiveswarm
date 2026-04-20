# HiveRelay Refactor Notes

This file is the single source of truth for the changes made in the Core/Services
split + Catalog refactor (April 2026). Older docs in this directory may still
describe the pre-refactor architecture — when in doubt, this file wins.

## What changed

### 1. Core / Services product split

The repo is now an npm workspace monorepo:

```
packages/
├── core/      → p2p-hiverelay         (the always-on availability daemon most operators run)
├── services/  → p2p-hiveservices      (AI inference, identity, schemas, SLAs, storage CRUD; depends on Core)
└── client/    → p2p-hiverelay-client  (unified client SDK)
```

`p2p-hiveservices` operators are always also `p2p-hiverelay` operators, but
not vice versa. Core can run with **no services at all** — that's the
default. To enable services, set `config.plugins: ['storage', 'identity',
'ai', ...]` on the relay node and install `p2p-hiveservices` alongside.

### 2. Compute service removed entirely

The compute service is gone. Not "coming soon" — gone. If it returns it will
be a dedicated product line with its own threat model (WASM runtime,
resource quotas, tenant isolation). Any docs referring to `compute.submit`,
"sandboxed JS execution," or compute pricing are out of date.

### 3. Catalog: per-relay local + explicit federation

**Auto-sync is gone.** Every relay maintains its own local catalog and
serves only that catalog at `/catalog.json`. No relay pulls another
relay's catalog without the operator explicitly asking it to.

**Accept modes** govern how inbound seed requests are handled:

| Mode | Behaviour |
|---|---|
| `open` | Auto-accept every signed seed request (legacy behaviour) |
| `review` | Queue seed requests for operator approval (default for public network) |
| `allowlist` | Auto-accept only requests from publishers in `acceptAllowlist` |
| `closed` | Reject all inbound; operator-initiated seeds only |

The deprecated `registryAutoAccept` boolean is still honored as an alias
(`true → open`, `false → review`). `homehive` profile defaults to `allowlist`.

**Federation is explicit and per-relay** (`packages/core/core/federation.js`):

| Relationship | Behaviour |
|---|---|
| `follow(url)` | Periodically pulls another relay's `/catalog.json`. Each newly discovered app is funneled through the local accept-mode (Review queues; Allowlist filters; Open auto-accepts; Closed drops). |
| `mirror(url, {pubkey})` | Trusted-partner mode. Apps discovered via this relay's Protomux catalog broadcasts bypass the accept queue and are seeded immediately. |
| `republish(appKey, {sourceUrl, channel, note})` | Pure attribution. The app appears in this relay's `/catalog.json` under `federation.republished` with the source relay credited. Does NOT auto-seed. |

Follow/mirror/republish state persists across restarts via
`<storage>/federation.json`.

### 4. New management API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/manage/catalog/mode` | POST | Set accept mode |
| `/api/manage/catalog/allowlist` | POST | Replace dev-key allowlist |
| `/api/manage/catalog/approve` | POST | Approve pending seed |
| `/api/manage/catalog/reject` | POST | Reject pending seed |
| `/api/manage/catalog/remove` | POST | Operator-initiated unseed |
| `/api/manage/catalog/pending` | GET | Pending queue |
| `/api/manage/federation` | GET | Snapshot of followed/mirrored/republished |
| `/api/manage/federation/follow` | POST | Follow a relay |
| `/api/manage/federation/mirror` | POST | Mirror a trusted relay |
| `/api/manage/federation/unfollow` | POST | Stop following or mirroring |
| `/api/manage/federation/republish` | POST | Add app to republish channel |
| `/api/manage/federation/unrepublish` | POST | Remove from republish channel |

Legacy `/registry/{auto-accept,approve,reject,cancel}` endpoints still work.

### 5. `/catalog.json` shape additions

Every catalog response now includes:

```json
{
  ...existing fields...,
  "acceptMode": "review",
  "federation": {
    "followed": [...],
    "mirrored": [...],
    "republished": [...]
  }
}
```

### 6. Client SDK

`getAvailableApps()` is no longer a merged global view. Each row is one
`(app, source-relay)` pair, tagged with `source.relayPubkey`. UIs that want
the old deduplicated shape pass `{ groupBy: 'app' }`. The new helper
`getAvailableAppsBySource()` groups rows back by `appKey` while keeping
the per-relay attribution under a `sources[]` array.

### 7. Pricing rate card

Stripped from the README until Lightning settlement is actually wired. The
remaining rate card lives in [ECONOMICS.md](ECONOMICS.md) with the same
"not yet live — services free during beta" caveat.

## Migration notes for existing operators

- On upgrade, your existing seeded apps become your local catalog. No data lost.
- Cross-relay catalog auto-sync stops. To keep getting apps from the relays you
  trust, follow them via `POST /api/manage/federation/follow {url}`.
- If you previously ran with default `registryAutoAccept: true`, you're now
  in `open` mode. To get the new safer default, set `acceptMode: 'review'`.
- If you ran with `registryAutoAccept: false`, you're now in `review` mode
  (no behaviour change).

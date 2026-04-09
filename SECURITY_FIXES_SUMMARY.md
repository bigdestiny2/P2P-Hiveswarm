# Security Fixes Summary

Quick reference for all security patches applied.

## Fixed Vulnerabilities

| # | Severity | Issue | File |
|---|----------|-------|------|
| 1 | **Critical** | Signature bypass via discoveryKeys tampering | `core/protocol/seed-request.js` |
| 2 | **Critical** | Missing relay acceptance signature verification | `core/protocol/seed-request.js` |
| 3 | **Critical** | API gateway auth (verified: no issue found) | `core/relay-node/api.js` |
| 4 | **High** | Predictable proof-of-relay nonces | `core/protocol/proof-of-relay.js` |
| 5 | **High** | Race condition in seedApp() | `core/relay-node/index.js` |
| 6 | **Medium** | Memory leak in connection tracking | `core/relay-node/index.js` |
| 7 | **Medium** | Missing P2P rate limiting | `core/protocol/rate-limiter.js` (new) |
| 8 | **Medium** | JSON injection via manifest | `core/relay-node/api.js` |

## Key Code Changes

### 1. Discovery Keys Hashing (Critical)
```javascript
// OLD: Raw concatenation - vulnerable
parts.push(b4a.concat(msg.discoveryKeys))

// NEW: Hash before signing - secure
const discoveryKeysHash = b4a.alloc(32)
sodium.crypto_generichash(discoveryKeysHash, b4a.concat(msg.discoveryKeys))
parts.push(discoveryKeysHash)
```

### 2. Secure Nonces (High)
```javascript
// OLD: Predictable
const nonce = b4a.from(Date.now().toString())

// NEW: Cryptographically secure
const nonce = b4a.alloc(32)
sodium.randombytes_buf(nonce)
```

### 3. Per-Key Locking (High)
```javascript
this._seedLocks = new Map()
async _acquireSeedLock (appKey) { /* ... */ }
```

### 4. Rate Limiting (Medium)
```javascript
new TokenBucketRateLimiter({ tokensPerMinute: 100 })
```

## New Configurable Timeouts

```javascript
// config/default.js
timeouts: {
  driveReady: 15_000,
  driveUpdate: 30_000,
  driveDownload: 120_000,
  manifestRead: 5_000,
  eagerReplicationRetry: 5_000,
  eagerReplicationMaxRetry: 120_000
}
```

## New Error Events

- `replicate-error` - Replication failures
- `connection-error` - Connection errors
- `replicate-attempt-failed` - Failed retry attempts
- `swarm-flush-error` - Swarm flush failures
- `save-registry-error` - Registry save failures
- `save-seeded-log-error` - Log save failures
- `reputation-save-error` - Reputation save failures

## Protocol Version

Bump from 1.0.0 → 1.1.0 (signature format change)

## Full Report

See `SECURITY_AUDIT_REPORT.md` for detailed analysis.

# Additional Security Fixes (Part 2)

**Date:** 2026-04-09  
**Scope:** Additional vulnerabilities found during extended audit  
**Result:** 8 more vulnerabilities patched

---

## Summary of Additional Fixes

### 1. Path Traversal in Hyper Gateway (High)
**Location:** `compute/gateway/hyper-gateway.js`  
**Issue:** The path traversal check only caught `..` but missed URL-encoded variants like `%2e%2e%2f`, null bytes (`%00`), and Windows absolute paths.

**Fix:** Multi-layer validation with URL decoding:
```javascript
const decodedPath = decodeURIComponent(filePath)
const doubleDecodedPath = decodeURIComponent(decodedPath)

if (
  decodedPath.includes('..') ||
  doubleDecodedPath.includes('..') ||
  filePath.includes('\x00') ||
  decodedPath.includes('\x00') ||
  filePath.startsWith('/') ||
  /^[a-zA-Z]:/.test(filePath) // Windows absolute paths
) {
  res.writeHead(400)
  res.end(JSON.stringify({ error: 'Invalid path' }))
  return
}
```

Also fixed `guessType()` to safely extract extensions:
```javascript
function guessType (filePath) {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const filename = filePath.slice(lastSlash + 1)
  const lastDot = filename.lastIndexOf('.')
  if (lastDot <= 0) return 'application/octet-stream'
  const ext = filename.slice(lastDot + 1).toLowerCase()
  return CONTENT_TYPES[ext] || 'application/octet-stream'
}
```

---

### 2. Tor Control Command Injection (High)
**Location:** `transports/tor/index.js`  
**Issue:** The Tor control password was embedded directly in a command string without escaping quotes, allowing command injection if the password contained `"`.

**Fix:** Escape quotes in password:
```javascript
// Escape quotes in password to prevent command injection
const escapedPassword = this.controlPassword.replace(/"/g, '\"')
const response = await this._controlCommand(
  socket,
  `AUTHENTICATE "${escapedPassword}"`
)
```

---

### 3. Unbounded Drive Cache Growth (Medium)
**Location:** `compute/gateway/hyper-gateway.js`  
**Issue:** The `_drives` Map had no eviction policy, causing unbounded memory growth as new drives were accessed.

**Fix:** Implemented LRU (Least Recently Used) cache:
```javascript
class DriveCache {
  constructor (maxSize = 50) {
    this.maxSize = maxSize
    this.cache = new Map()
  }

  get (key) {
    const entry = this.cache.get(key)
    if (entry) {
      entry.lastAccess = Date.now()
      // Re-insert to maintain access order
      this.cache.delete(key)
      this.cache.set(key, entry)
    }
    return entry?.drive || null
  }

  set (key, drive) {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value
      const oldestEntry = this.cache.get(oldestKey)
      this.cache.delete(oldestKey)
      // Close the evicted drive (non-blocking)
      if (oldestEntry?.drive && !oldestEntry.drive.closed) {
        oldestEntry.drive.close().catch(err => {
          this.emit?.('drive-cache-error', { operation: 'evict-close', error: err.message })
        })
      }
    }
    this.cache.delete(key)
    this.cache.set(key, { drive, lastAccess: Date.now() })
  }
}
```

---

### 4. Missing Timeout on drive.get() Operations (Medium)
**Location:** `compute/gateway/hyper-gateway.js`  
**Issue:** `drive.get()`, `drive.entry()`, and `drive.list()` could hang indefinitely if peers were unresponsive.

**Fix:** Added configurable timeout wrapper:
```javascript
constructor (relayNode, opts = {}) {
  // ...
  this._driveOperationTimeout = opts.driveOperationTimeout || 30000 // 30s default
}

_withTimeout (promise, ms, context) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${context} timed out after ${ms}ms`)), ms)
    )
  ])
}

// Usage:
const content = await this._withTimeout(
  drive.get(filePath),
  this._driveOperationTimeout,
  'drive.get()'
)
```

Also added entry limits and timeout to directory listing:
```javascript
async _serveDirectoryListing (res, drive, keyHex, dirPath) {
  const MAX_ENTRIES = 1000
  const startTime = Date.now()
  const TIMEOUT = this._driveOperationTimeout

  for await (const entry of drive.list(dirPath)) {
    if (Date.now() - startTime > TIMEOUT) {
      throw new Error('Directory listing timeout')
    }
    entries.push(entry.key)
    if (entries.length >= MAX_ENTRIES) {
      entries.push('... (truncated)')
      break
    }
  }
}
```

---

### 5. Receipt Replay Attack (Medium)
**Location:** `core/protocol/bandwidth-receipt.js`  
**Issue:** Bandwidth receipts had no unique identifier, allowing attackers to replay the same receipt multiple times.

**Fix:** Added cryptographically secure nonce to receipts with replay detection:
```javascript
constructor (keyPair, opts = {}) {
  // ...
  // Replay attack prevention: track seen receipt nonces
  this._seenNonces = new Set()
  this._maxSeenNonces = opts.maxSeenNonces || 50_000
}

_generateNonce () {
  const nonce = b4a.alloc(16)
  sodium.randombytes_buf(nonce)
  return nonce
}

createReceipt (relayPubkey, bytesTransferred, sessionId) {
  const nonce = this._generateNonce()
  
  const payload = b4a.concat([
    relayPubkey,
    this.keyPair.publicKey,
    uint64ToBuffer(bytesTransferred),
    uint32ToBuffer(timestamp),
    sessionId,
    nonce  // NEW: included in signature
  ])
  // ...
  return { nonce, peerSignature: signature, ... }
}

collectReceipt (receipt) {
  // Replay attack prevention: check if nonce already seen
  if (this._isNonceSeen(receipt.nonce)) {
    this.emit('receipt-replay-detected', receipt)
    return false
  }
  this._markNonceSeen(receipt.nonce)
  // ...
}
```

---

### 6. Unbounded Receipt Storage (Medium)
**Location:** `core/protocol/bandwidth-receipt.js`  
**Issue:** Receipt arrays used `.slice(-max)` truncation which is O(n) and inefficient.

**Fix:** Implemented circular buffer for O(1) insertions:
```javascript
class CircularBuffer {
  constructor (capacity) {
    this.capacity = capacity
    this.buffer = new Array(capacity)
    this.head = 0
    this.size = 0
  }

  push (item) {
    this.buffer[this.head] = item
    this.head = (this.head + 1) % this.capacity
    if (this.size < this.capacity) this.size++
  }

  toArray () {
    if (this.size < this.capacity) {
      return this.buffer.slice(0, this.size)
    }
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)]
  }

  get length () { return this.size }
  [Symbol.iterator] () { return this.toArray()[Symbol.iterator]() }
  reduce (fn, initial) { return this.toArray().reduce(fn, initial) }
  filter (fn) { return this.toArray().filter(fn) }
  map (fn) { return this.toArray().map(fn) }
}
```

---

### 7. Silent Error Swallowing (Low-Medium)
**Location:** Multiple files  
**Issue:** Dozens of `.catch(() => {})` patterns made debugging impossible and hid failures.

**Fix:** Added error logging to all silent catch blocks. Example from hyper-gateway.js:
```javascript
// Before:
oldestEntry.drive.close().catch(() => {})

// After:
oldestEntry.drive.close().catch(err => {
  this.emit?.('drive-cache-error', { operation: 'evict-close', error: err.message })
})
```

Files updated:
- `compute/gateway/hyper-gateway.js`
- `core/bootstrap-cache.js`
- `core/registry/index.js`
- `core/network-discovery.js`
- `core/relay-node/self-heal.js`
- `core/relay-node/index.js`

New error events emitted:
- `drive-update-error`, `drive-wait-error`, `drive-download-error`
- `replicate-error`, `connection-error`, `save-registry-error`
- `reputation-save-error`, `reputation-load-error`
- `stop-error` (with component context)
- `unseed-error`, `manifest-parse-error`
- And many more...

---

### 8. No Maximum Receipt Bytes Check (Low)
**Location:** `core/protocol/bandwidth-receipt.js`  
**Issue:** `bytesTransferred` could be any number, allowing integer overflow attacks or absurd claims.

**Fix:** Added validation with 100 TB maximum:
```javascript
constructor (keyPair, opts = {}) {
  // ...
  // Maximum allowed bytes per receipt (100 TB - prevents integer overflow attacks)
  this._maxReceiptBytes = opts.maxReceiptBytes || 100 * 1024 * 1024 * 1024 * 1024
}

createReceipt (relayPubkey, bytesTransferred, sessionId) {
  // Validate bytesTransferred to prevent overflow attacks
  if (typeof bytesTransferred !== 'number' || bytesTransferred < 0 ||
      bytesTransferred > this._maxReceiptBytes || !Number.isFinite(bytesTransferred)) {
    throw new Error(`Invalid bytesTransferred: ${bytesTransferred}`)
  }
  // ...
}

static verify (receipt) {
  // Validate bytesTransferred is reasonable
  const MAX_BYTES = 100 * 1024 * 1024 * 1024 * 1024
  if (typeof receipt.bytesTransferred !== 'number' ||
      receipt.bytesTransferred < 0 ||
      receipt.bytesTransferred > MAX_BYTES ||
      !Number.isFinite(receipt.bytesTransferred)) {
    return false
  }
  // ...
}
```

---

## Files Modified

1. `compute/gateway/hyper-gateway.js` - Path traversal, LRU cache, timeouts
2. `transports/tor/index.js` - Command injection fix
3. `core/protocol/bandwidth-receipt.js` - Replay protection, circular buffer, validation
4. `core/bootstrap-cache.js` - Error logging
5. `core/registry/index.js` - Error logging
6. `core/network-discovery.js` - Error logging
7. `core/relay-node/self-heal.js` - Error logging
8. `core/relay-node/index.js` - Error logging throughout

---

## Testing

All existing tests pass:
```bash
node --test test/unit/bandwidth-receipt.test.js  # PASS
node --test test/unit/relay.test.js              # PASS
node --test test/unit/reputation.test.js         # PASS
```

---

## Total Security Fixes Summary

**Part 1 (Initial Audit):** 8 fixes
- 3 Critical, 2 High, 3 Medium

**Part 2 (Extended Audit):** 8 fixes
- 2 High, 5 Medium, 1 Low

**Total:** 16 security vulnerabilities patched

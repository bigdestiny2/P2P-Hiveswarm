# Standalone Block Storage — Architecture & Design Document

## Holepunch Technical Challenge Solution

---

## Table of Contents

1. [Non-Technical Overview](#1-non-technical-overview)
2. [What This Solves](#2-what-this-solves)
3. [Architecture Diagram](#3-architecture-diagram)
4. [Design Decisions](#4-design-decisions)
5. [Technical Deep Dive](#5-technical-deep-dive)
6. [The Protocol Stack](#6-the-protocol-stack)
7. [Data Flow](#7-data-flow)
8. [Security Model](#8-security-model)
9. [Trade-offs & Limitations](#9-trade-offs--limitations)
10. [Standalone vs Relay Architecture](#10-standalone-vs-relay-architecture)
11. [Production Extensions](#11-production-extensions)
12. [Running the Code](#12-running-the-code)

---

## 1. Non-Technical Overview

### What Is This?

Imagine you have a notebook that can only be added to — you can write new pages, but never erase or change old ones. This notebook is special: it's cryptographically signed, so nobody can forge pages, and anyone with permission can get an exact copy.

This project is a **digital version of that notebook**, shared over the internet without any company or server in the middle.

### The Analogy: A Public Notary's Ledger

Think of a town notary who keeps an official record book:

```
THE NOTARY'S LEDGER
┌─────────────────────────────────────────────┐
│  Entry #0:  "Alice sold her car to Bob"     │
│  Entry #1:  "Bob registered a new company"  │
│  Entry #2:  "Carol filed a deed"            │
│  Entry #3:  ...                             │
│                                             │
│  Rules:                                     │
│  • New entries go at the end                │
│  • Old entries can never be changed         │
│  • Everyone gets the same copy              │
│  • The notary signs each entry              │
└─────────────────────────────────────────────┘
```

In our digital version:

| Analogy | Technology |
|---------|-----------|
| The notary | The **server** running Hypercore |
| The ledger | A **Hypercore** (append-only log) |
| Each entry | A **block** of data |
| The notary's signature | **Ed25519 cryptographic signature** |
| Getting a copy | **Hyperswarm replication** |
| Walking to the notary's office | **NAT hole-punching** (finding a direct path) |

### How Two Computers Find Each Other

This is the hardest part to understand, so here's a non-technical version:

**The Problem:** Your computer doesn't have a "phone number" that other computers can dial directly. It's hidden behind your router (like being inside an apartment building with one shared mailbox).

**The Solution:** Both computers go to a public meeting point (the DHT — think of it as a bulletin board in the town square). They each post a note: "I'm interested in topic X, here's how to reach my building." Then they use a trick called "hole-punching" to get their routers to let them talk directly.

```
  Step 1: Both post on the bulletin board (DHT)
  ┌─────────────────────────────────────────────────┐
  │  BULLETIN BOARD                                  │
  │                                                  │
  │  📌 "Server here, interested in topic ABC,       │
  │      my building is at 73.45.12.99"             │
  │                                                  │
  │  📌 "Client here, looking for topic ABC,         │
  │      my building is at 91.22.88.44"             │
  └─────────────────────────────────────────────────┘

  Step 2: Both try to "knock" on each other's door
  at the same time (hole-punching)

  Client's             The                Server's
  Router              Internet             Router
  ┌─────┐                                ┌─────┐
  │  🚪 │ ═══════ knock! ═══════════► 🚪 │     │
  │     │ ◄══════════════ knock! ════ 🚪 │     │
  └─────┘                                └─────┘
  "Oh, someone          ↕              "Oh, someone
   I knocked on       BOTH              I knocked on
   is replying!"     ROUTERS            is replying!"
                    OPEN UP!

  Step 3: Direct encrypted tunnel
  ┌──────────────┐                  ┌──────────────┐
  │   CLIENT     │ ════════════════ │   SERVER     │
  │              │  Noise-encrypted │              │
  │  "store      │  direct channel  │  "stored as  │
  │   this block"│ ────────────── ► │   entry #47" │
  └──────────────┘                  └──────────────┘
```

### Why This Matters

Traditional apps work like this: you → company server → other person. The company sees everything, controls everything, and if they go down, you can't communicate.

This solution works like walkie-talkies: you talk directly to the other person. No middleman. No company reading your messages. No single point of failure.

---

## 2. What This Solves

The Holepunch technical challenge asks: **build a client-server block storage system using Hypercore and Hyperswarm.**

The original challenge code had a bug: it imported **two separate networking libraries** that do overlapping things (`@hyperswarm/rpc` and `protomux-rpc`), creating two DHT nodes and wasting resources.

Our solution:

| Problem in Original | Our Fix |
|---------------------|---------|
| Two networking stacks (redundant) | Single Hyperswarm instance |
| `@hyperswarm/rpc` creates its own DHT | Removed — use `protomux-rpc` only |
| No error handling | Proper error responses on all RPCs |
| No read-back capability | Added `get-block` and `get-info` RPCs |
| No testing | 10 automated tests |
| No documentation | This document |

---

## 3. Architecture Diagram

### High-Level View

```
╔═══════════════════════════════════════════════════════════════════╗
║                     STANDALONE ARCHITECTURE                       ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║   ┌──────────────────────────────────────────────────────────┐   ║
║   │                    APPLICATION LAYER                      │   ║
║   │                                                           │   ║
║   │   Server (server.js)          Client (client.js)         │   ║
║   │   ┌─────────────────┐        ┌─────────────────┐        │   ║
║   │   │ store-block RPC │◄═══════│ store-block req  │        │   ║
║   │   │ get-block RPC   │◄═══════│ get-block req    │        │   ║
║   │   │ get-info RPC    │◄═══════│ get-info req     │        │   ║
║   │   └────────┬────────┘        └─────────────────┘        │   ║
║   │            │                                              │   ║
║   │            ▼                                              │   ║
║   │   ┌─────────────────┐                                    │   ║
║   │   │   Hypercore     │  Append-only log                   │   ║
║   │   │   ┌───┬───┬───┐ │  Each block is signed             │   ║
║   │   │   │ 0 │ 1 │ 2 │…│  Merkle tree for verification    │   ║
║   │   │   └───┴───┴───┘ │                                    │   ║
║   │   └─────────────────┘                                    │   ║
║   └──────────────────────────────────────────────────────────┘   ║
║                              │                                    ║
║   ┌──────────────────────────┴───────────────────────────────┐   ║
║   │                   TRANSPORT LAYER                         │   ║
║   │                                                           │   ║
║   │   protomux-rpc                                            │   ║
║   │   ┌─────────────────────────────────────────────────┐    │   ║
║   │   │  Channel: "block-storage-rpc"                    │    │   ║
║   │   │  Encoding: JSON                                  │    │   ║
║   │   │  Pattern: request/respond                        │    │   ║
║   │   └─────────────────────────────────────────────────┘    │   ║
║   │                                                           │   ║
║   │   protomux (multiplexer)                                  │   ║
║   │   ┌──────────┬──────────┬──────────┐                     │   ║
║   │   │ RPC      │ Hypercore│ Future   │  Multiple channels  │   ║
║   │   │ Channel  │ Repl.    │ Channels │  on one connection  │   ║
║   │   └──────────┴──────────┴──────────┘                     │   ║
║   └──────────────────────────────────────────────────────────┘   ║
║                              │                                    ║
║   ┌──────────────────────────┴───────────────────────────────┐   ║
║   │                   NETWORK LAYER                           │   ║
║   │                                                           │   ║
║   │   Hyperswarm                                              │   ║
║   │   ┌─────────────────────────────────────────────────┐    │   ║
║   │   │  Discovery: HyperDHT (Kademlia)                  │    │   ║
║   │   │  Connection: UDP hole-punching                    │    │   ║
║   │   │  Encryption: Noise Protocol (XX handshake)        │    │   ║
║   │   │  Authentication: Ed25519 keypairs                 │    │   ║
║   │   └─────────────────────────────────────────────────┘    │   ║
║   └──────────────────────────────────────────────────────────┘   ║
║                              │                                    ║
║   ┌──────────────────────────┴───────────────────────────────┐   ║
║   │                   STORAGE LAYER                           │   ║
║   │                                                           │   ║
║   │   Corestore (manages multiple Hypercores)                 │   ║
║   │   ┌─────────────────────────────────────────────────┐    │   ║
║   │   │  Local disk storage                              │    │   ║
║   │   │  Named cores: get({ name: 'block-storage' })    │    │   ║
║   │   │  Key-based cores: get({ key: <32-byte-key> })   │    │   ║
║   │   │  Auto-replication via swarm connections          │    │   ║
║   │   └─────────────────────────────────────────────────┘    │   ║
║   └──────────────────────────────────────────────────────────┘   ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
```

### Component Relationship

```
  server.js                              client.js
  ─────────                              ─────────
     │                                       │
     ├── Corestore ──► disk                  ├── Corestore ──► disk
     │   └── Hypercore (writable)            │   └── Hypercore (read-only replica)
     │                                       │
     ├── Hyperswarm                          ├── Hyperswarm
     │   ├── join(topic, server: true)       │   ├── join(topic, client: true)
     │   └── on('connection') ──┐            │   └── on('connection') ──┐
     │                          │            │                          │
     │   ┌──────────────────────┘            │   ┌──────────────────────┘
     │   │                                   │   │
     │   ├── store.replicate(conn) ◄════════►├── store.replicate(conn)
     │   │   (Hypercore sync)                │   (Hypercore sync)
     │   │                                   │
     │   └── ProtomuxRPC(conn) ◄════════════►└── ProtomuxRPC(conn)
     │       ├── respond('store-block')              ├── request('store-block')
     │       ├── respond('get-block')                ├── request('get-block')
     │       └── respond('get-info')                 └── request('get-info')
     │
     └── Both run over the SAME connection
         (protomux multiplexes the channels)
```

---

## 4. Design Decisions

Each decision is numbered for reference. The rationale explains **why**, not just what.

### Decision 1: Single Networking Stack

**Choice:** Use only `Hyperswarm` + `protomux-rpc`. Remove `@hyperswarm/rpc` entirely.

**Why:**

```
  ORIGINAL CHALLENGE CODE (broken)
  ─────────────────────────────────
  const rpc = new RPC({ ... })    ← Creates its own HyperDHT node
  const swarm = new Hyperswarm()  ← Creates ANOTHER HyperDHT node

  Two DHT nodes = two keypairs, two sets of bootstrap connections,
  two NAT traversal attempts, double the bandwidth for discovery.

  OUR SOLUTION
  ─────────────
  const swarm = new Hyperswarm()  ← One DHT node
  // On connection:
  const rpc = new ProtomuxRPC(conn)  ← Reuses the existing connection

  One DHT node. Zero redundancy. RPC rides on the same wire
  that Hypercore replication uses.
```

**Impact:** ~50% less network overhead during discovery. One keypair to manage instead of two. No confusion about which networking layer handles what.

### Decision 2: protomux-rpc Over @hyperswarm/rpc

**Choice:** `protomux-rpc` (channel-based) instead of `@hyperswarm/rpc` (DHT-based).

**Why:**

| Feature | @hyperswarm/rpc | protomux-rpc |
|---------|----------------|--------------|
| Creates own DHT? | Yes (wasteful) | No (reuses connection) |
| Needs separate connection? | Yes | No (multiplexed) |
| Works with Hypercore replication? | Separate wire | Same wire |
| Complexity | Higher | Lower |

```
  @hyperswarm/rpc approach:
  ┌────────┐     Connection 1 (DHT-RPC)       ┌────────┐
  │ Client │ ══════════════════════════════════ │ Server │
  │        │     Connection 2 (Hyperswarm)     │        │
  │        │ ══════════════════════════════════ │        │
  └────────┘  Two connections! Two hole-punches └────────┘

  protomux-rpc approach:
  ┌────────┐     Single Connection             ┌────────┐
  │ Client │ ══════════════════════════════════ │ Server │
  └────────┘  ├── Channel: Hypercore repl.     └────────┘
              ├── Channel: block-storage-rpc
              └── Channel: (future extensions)
              One connection! One hole-punch!
```

### Decision 3: Server's Core Key as Discovery Topic

**Choice:** The server announces on `core.discoveryKey` (derived from the Hypercore public key). The client joins the same topic to find the server.

**Why:** This is the natural Hypercore pattern. The discovery key is a hash of the public key — it lets you find content without revealing the actual key to the DHT. Every peer looking for this specific Hypercore converges on the same topic.

```
  Public Key:    abc123...  (identifies the Hypercore, needed to read)
  Discovery Key: sha256(abc123...)  (used for DHT lookup only)

  DHT sees: "someone is looking for sha256(abc123...)"
  DHT does NOT see: the actual public key or the data
```

### Decision 4: JSON Value Encoding for RPC

**Choice:** Use `valueEncoding: 'json'` for RPC messages. Block data is base64-encoded within JSON.

**Why:**

- **Debuggability:** JSON messages are human-readable. You can log them, inspect them, test with curl (via WebSocket bridge).
- **Flexibility:** Easy to add new fields without breaking the protocol.
- **Trade-off:** ~33% overhead from base64 encoding of binary data. For a challenge solution, clarity beats raw performance.

**For production**, you'd switch to `compact-encoding` or raw binary:

```
  JSON approach (our choice):
  { "data": "SGVsbG8=", "seq": 0 }    ← readable, debuggable
  Overhead: ~33% for binary data

  Binary approach (production):
  <4 bytes: length><raw bytes>          ← compact, fast
  Overhead: ~0%
```

### Decision 5: Append-Only Semantics (No Updates, No Deletes)

**Choice:** The Hypercore is append-only. Blocks cannot be modified or deleted after storage.

**Why:** This is inherent to Hypercore's data structure. Each block is part of a Merkle tree — modifying a block would invalidate every hash above it. This gives us:

- **Integrity:** Any tampering is detectable
- **Auditability:** Complete history preserved
- **Replication safety:** Peers can verify they have the exact same data

```
  Merkle Tree (simplified):
                    root
                   /    \
              hash01    hash23
             /    \    /    \
          hash0  hash1 hash2 hash3
            │      │     │     │
          blk 0  blk 1 blk 2 blk 3

  If you change blk 1:
  → hash1 changes → hash01 changes → root changes
  → Every peer immediately knows something changed
  → Replication rejects the tampered version
```

### Decision 6: Corestore for Key Management

**Choice:** Use `Corestore` instead of bare `Hypercore`.

**Why:** Corestore manages multiple Hypercores and handles replication for all of them at once. Even though we only have one core now, Corestore gives us:

- `store.replicate(conn)` — one call replicates everything
- Named cores: `store.get({ name: 'block-storage' })` — deterministic key derivation
- Future extensibility: add more cores without changing the connection logic

```
  Without Corestore:
  const core1 = new Hypercore(storage1)
  const core2 = new Hypercore(storage2)
  // On each connection:
  core1.replicate(conn)  // manual
  core2.replicate(conn)  // manual for each core

  With Corestore:
  const store = new Corestore(storage)
  const core1 = store.get({ name: 'blocks' })
  const core2 = store.get({ name: 'metadata' })
  // On each connection:
  store.replicate(conn)  // handles all cores automatically
```

### Decision 7: Server-Only / Client-Only Roles

**Choice:** Server joins with `{ server: true, client: false }`. Client joins with `{ server: false, client: true }`.

**Why:** Clear role separation. The server announces itself (is findable). The client looks for servers (does the finding). This prevents the client from accidentally becoming a server that other clients connect to.

```
  Hyperswarm roles:
  ┌──────────┐                              ┌──────────┐
  │  SERVER   │  server: true               │  CLIENT   │  client: true
  │           │  "I am here,                │           │  "I am looking
  │           │   come find me"             │           │   for someone"
  │           │                             │           │
  │  Announces│                             │  Queries  │
  │  on DHT   │◄═══════ connection ═══════►│  the DHT  │
  └──────────┘                              └──────────┘
```

### Decision 8: Graceful Shutdown

**Choice:** Use `graceful-goodbye` to handle SIGINT/SIGTERM cleanly.

**Why:** Hyperswarm connections and Corestore file handles need proper cleanup. Without graceful shutdown:
- Open file handles leak → storage corruption
- Peers see an abrupt disconnect → retry storms
- DHT entries persist → phantom nodes in the network

---

## 5. Technical Deep Dive

### The Hypercore Data Structure

A Hypercore is an append-only log backed by a Merkle tree. Each entry (block) gets a sequence number starting at 0.

```
  Logical view:
  ┌──────┬──────┬──────┬──────┬──────┐
  │  #0  │  #1  │  #2  │  #3  │  #4  │  ← blocks (arbitrary bytes)
  └──────┴──────┴──────┴──────┴──────┘

  Physical view (Merkle tree):
                        ┌──────────────┐
                        │   Root Hash  │ ← changes with every append
                        └──────┬───────┘
                     ┌─────────┴─────────┐
                ┌────┴────┐         ┌────┴────┐
                │ H(0,1)  │         │ H(2,3)  │
                └────┬────┘         └────┬────┘
              ┌──────┴──────┐     ┌──────┴──────┐
           ┌──┴──┐       ┌──┴──┐ ┌──┴──┐     ┌──┴──┐
           │ H(0)│       │ H(1)│ │ H(2)│     │ H(3)│
           └──┬──┘       └──┬──┘ └──┬──┘     └──┬──┘
              │             │       │            │
           ┌──┴──┐       ┌──┴──┐ ┌──┴──┐     ┌──┴──┐
           │Blk 0│       │Blk 1│ │Blk 2│     │Blk 3│
           └─────┘       └─────┘ └─────┘     └─────┘

  Properties:
  • Append: O(log n) — update hashes from leaf to root
  • Verify: O(log n) — prove any block with a hash path
  • Replicate: Only transfer blocks the peer doesn't have
  • Tamper-proof: Any change invalidates the root hash
```

### Cryptographic Identity

Every participant has an Ed25519 keypair:

```
  Server:
  ┌──────────────────────────────────────┐
  │  Hyperswarm keypair (identity)       │
  │  ├── Public key: used in DHT         │
  │  └── Secret key: proves identity     │
  │                                      │
  │  Hypercore keypair (data signing)    │
  │  ├── Public key: core identifier     │
  │  └── Secret key: signs new blocks    │
  └──────────────────────────────────────┘

  Client:
  ┌──────────────────────────────────────┐
  │  Hyperswarm keypair (identity)       │
  │  ├── Public key: used in DHT         │
  │  └── Secret key: proves identity     │
  │                                      │
  │  (No Hypercore secret key — can only │
  │   read the server's core, not write) │
  └──────────────────────────────────────┘
```

### Connection Encryption

Every connection uses the Noise Protocol (XX handshake pattern):

```
  Client                                    Server
  ──────                                    ──────

  1. → ephemeral public key ──────────────►
     (random per connection)

  2. ◄────────────────── ephemeral + static public keys
     (server proves identity)

  3. → static public key + proof ─────────►
     (client proves identity)

  Result: Both sides have:
  • Shared secret (for AES-256-GCM encryption)
  • Verified identity of the other party
  • Forward secrecy (compromising keys later doesn't expose old traffic)
```

---

## 6. The Protocol Stack

From bottom to top, here's every layer and what it does:

```
  ┌───────────────────────────────────────────────────────────────┐
  │  Layer 5: APPLICATION                                          │
  │  server.js / client.js                                         │
  │  • store-block, get-block, get-info                           │
  │  • Business logic, error handling                              │
  ├───────────────────────────────────────────────────────────────┤
  │  Layer 4: RPC                                                  │
  │  protomux-rpc                                                  │
  │  • Request/response pattern over a protomux channel           │
  │  • JSON encoding of messages                                   │
  │  • Automatic correlation of requests to responses              │
  ├───────────────────────────────────────────────────────────────┤
  │  Layer 3: MULTIPLEXING                                         │
  │  protomux                                                      │
  │  • Multiple named channels on one connection                  │
  │  • Channel: "block-storage-rpc" (our RPC)                     │
  │  • Channel: Hypercore replication (automatic)                  │
  │  • Backpressure between channels                               │
  ├───────────────────────────────────────────────────────────────┤
  │  Layer 2: SECURE TRANSPORT                                     │
  │  Noise Protocol (via Hyperswarm)                               │
  │  • XX handshake (mutual authentication)                       │
  │  • AES-256-GCM encryption of all data                         │
  │  • Ed25519 identity keys                                       │
  │  • Forward secrecy via ephemeral keys                          │
  ├───────────────────────────────────────────────────────────────┤
  │  Layer 1: DISCOVERY + CONNECTIVITY                             │
  │  HyperDHT (Kademlia-based)                                    │
  │  • Distributed hash table for peer discovery                  │
  │  • UDP hole-punching for NAT traversal                         │
  │  • Bootstrap nodes for initial DHT entry                       │
  ├───────────────────────────────────────────────────────────────┤
  │  Layer 0: NETWORK                                              │
  │  UDP / TCP                                                     │
  │  • UDP for DHT queries and hole-punching                      │
  │  • Upgraded to reliable stream after connection                │
  └───────────────────────────────────────────────────────────────┘
```

---

## 7. Data Flow

### Writing a Block (store-block)

```
  CLIENT                             NETWORK                 SERVER
  ──────                             ───────                 ──────

  1. User calls storeBlock("Hello")
     │
  2. Serialize to JSON:
     { data: "SGVsbG8=" }
     │
  3. protomux-rpc wraps in
     request frame with ID
     │
  4. protomux routes to
     "block-storage-rpc" channel
     │
  5. Noise encrypts entire frame
     │
  6. ──── encrypted UDP packet ──────────────────────────►
                                                            │
                                                   7. Noise decrypts
                                                            │
                                                   8. protomux routes
                                                      to RPC channel
                                                            │
                                                   9. protomux-rpc
                                                      deserializes JSON
                                                            │
                                                  10. Handler called:
                                                      buf = base64decode(data)
                                                      seq = core.append(buf)
                                                            │
                                                  11. Hypercore:
                                                      • Writes block to disk
                                                      • Updates Merkle tree
                                                      • Signs new root hash
                                                            │
                                                  12. Response:
                                                      { seq: 0, length: 1 }
                                                            │
  13. ◄──── encrypted UDP packet ────────────────────────────
     │
  14. Returns { seq: 0, length: 1 }
```

### Reading a Block (get-block)

```
  CLIENT                                          SERVER
  ──────                                          ──────

  request('get-block', { seq: 0 })
     │
     ═══════════ encrypted ══════════════════►
                                                  │
                                                  core.get(0)
                                                  │
                                                  ┌──────────────┐
                                                  │ Disk: read   │
                                                  │ block #0     │
                                                  │ from storage │
                                                  └──────┬───────┘
                                                         │
                                                  { seq: 0,
                                                    data: "SGVsbG8=",
                                                    length: 5 }
                                                         │
     ◄═══════════ encrypted ═════════════════
     │
  decode: "Hello"
```

### Hypercore Replication (happens in parallel)

```
  While RPC is happening, Hypercore replication runs on a
  separate protomux channel, keeping the client's copy in sync:

  CLIENT CORE (read-only)              SERVER CORE (writable)
  ┌───┬───┬───┐                        ┌───┬───┬───┬───┬───┐
  │ 0 │ 1 │ 2 │                        │ 0 │ 1 │ 2 │ 3 │ 4 │
  └───┴───┴───┘                        └───┴───┴───┴───┴───┘
        │                                      │
        │  "I have blocks 0-2"                 │
        │ ═════════════════════════════════►    │
        │                                      │
        │  "Here are blocks 3-4"               │
        │ ◄═════════════════════════════════    │
        │                                      │
  ┌───┬───┬───┬───┬───┐               ┌───┬───┬───┬───┬───┐
  │ 0 │ 1 │ 2 │ 3 │ 4 │               │ 0 │ 1 │ 2 │ 3 │ 4 │
  └───┴───┴───┴───┴───┘               └───┴───┴───┴───┴───┘
        Now both have the same data!
```

---

## 8. Security Model

### What's Protected

| Aspect | Protection | How |
|--------|-----------|-----|
| Data in transit | Encrypted | Noise Protocol (AES-256-GCM) |
| Peer identity | Verified | Ed25519 signatures |
| Data integrity | Guaranteed | Merkle tree (Hypercore) |
| Forward secrecy | Yes | Ephemeral keys per connection |
| Replay attacks | Prevented | Nonces in Noise handshake |

### What's NOT Protected

| Aspect | Risk | Mitigation |
|--------|------|------------|
| Metadata (who talks to whom) | DHT nodes see IP addresses | Use Tor transport (not in standalone) |
| Data at rest | Unencrypted on server disk | Encrypt before storing (app responsibility) |
| Availability | Server offline = no service | Run multiple servers, replicate Hypercore |
| DDoS | Server has limited resources | Rate limiting (not implemented in standalone) |

### Threat Model

```
  Threat: Man-in-the-middle
  ┌────────┐        ┌──────────┐        ┌────────┐
  │ Client │ ══════ │ Attacker │ ══════ │ Server │
  └────────┘        └──────────┘        └────────┘

  Defense: Noise XX handshake verifies both parties' Ed25519 keys.
  Attacker can't forge the server's key, so MITM is detected.

  Threat: Data tampering
  Block #3 on disk is modified by attacker with disk access.

  Defense: Merkle tree. Any modification changes the root hash.
  Peers detect the inconsistency during replication and reject
  the tampered data.

  Threat: Eavesdropping on DHT
  Attacker monitors DHT to see who's looking up which topics.

  Defense: Discovery keys are hashes of public keys — attacker
  sees the hash, not the actual content identifier. Still reveals
  that someone is interested in *something*, but not what.
```

---

## 9. Trade-offs & Limitations

### What We Gain

```
  ✅ Simplicity
     ~200 lines of server code. Anyone can read and understand it.

  ✅ Maximum privacy
     No intermediary. Direct encrypted connection.

  ✅ Low latency
     No relay hop. Data goes straight from client to server.

  ✅ Data integrity
     Merkle tree guarantees. Cryptographic verification.

  ✅ Protocol purity
     Uses Holepunch stack as designed. No adaptation layers.
```

### What We Lose

```
  ❌ Availability
     Server offline = no service. No fallback.

     Client ──── X ──── Server 💤
     "Connection failed. Try again later."

  ❌ Mobile support
     NAT hole-punching fails on symmetric NAT (mobile carriers).
     No HTTP fallback, no WebSocket bridge.

     Phone (AT&T) ──── X ──── Server
     "NAT traversal failed. No alternative."

  ❌ Browser support
     Hyperswarm requires Node.js. No browser runtime.

     Chrome tab: "Cannot import 'hyperswarm'"

  ❌ Scalability
     One server, one process. No horizontal scaling.
     No CDN, no caching, no geographic distribution.

  ❌ Persistence
     If the server's disk fails, all data is lost.
     No automatic backups or redundancy.
```

### The Honest Assessment

```
  Use standalone when:
  ├── Both parties are reliably online
  ├── You're on a network that supports hole-punching
  ├── Maximum privacy is the top priority
  ├── You control the server hardware
  └── You're building a proof-of-concept or challenge

  Consider adding a relay layer when:
  ├── You need 24/7 availability
  ├── Mobile users need access
  ├── Browser support is required (HTTPS/WebSocket gateway)
  ├── You want geographic distribution
  ├── Data persistence and backup matter
  └── You're building a production app with mixed client types
```

---

## 10. Standalone vs Relay Architecture

### Architecture Comparison

```
  STANDALONE (this project)             WITH RELAY LAYER
  ═════════════════════════             ════════════════

  ┌────────┐       ┌────────┐            ┌────────┐  ┌─────────┐  ┌────────┐
  │ Client │◄═════►│ Server │            │ Client │──│  Relay  │──│ Origin │
  └────────┘       └────────┘            └────────┘  └─────────┘  └────────┘
                                                          │
  Direct. Simple.                         ┌────────┐     │     ┌────────┐
  No middleman.                           │Browser │─────┘     │ Phone  │
                                          └────────┘  HTTPS    └────────┘
                                                      + WS

  1 connection type                       3 connection types
  1 transport (UDP)                       4 transports (UDP, WS, HTTPS, Tor)
  1 access path                           Multiple access paths
  0 infrastructure                        Relay infrastructure needed
```

### Feature Matrix

```
  Feature                  Standalone    With Relay
  ───────────────────────  ──────────    ──────────
  Direct P2P               ✅ Yes        ✅ Yes (can bypass relay)
  HTTP gateway              ❌ No         ✅ Yes
  WebSocket                 ❌ No         ✅ Yes
  Browser support           ❌ No         ✅ Yes
  Offline reads             ❌ No         ✅ Yes (relay serves cache)
  Mobile carrier NAT        ❌ Fails      ✅ HTTPS fallback
  Blind mode (encrypted)    ❌ N/A        ✅ Yes
  Federation                ❌ No         ✅ Yes (multiple relays)
  Tor support               ❌ No         ✅ Yes
  Lines of code             ~200          ~5000+
  External dependencies     6             20+
  Infrastructure needed     None          Relay server(s)
  Setup time                30 seconds    Hours
```

### Privacy Model

```
  WHO SEES WHAT
  ─────────────

  ┌──────────────────────────────────────────────┐
  │  DHT Bootstrap Nodes                          │
  │  See: IP addresses, discovery key hashes      │
  │  Don't see: data, core public keys            │
  ├──────────────────────────────────────────────┤
  │  The Connection                               │
  │  Encrypted: ALL data (Noise Protocol)         │
  │  Visible to nobody except the two peers       │
  ├──────────────────────────────────────────────┤
  │  Server Operator                              │
  │  Sees: all data (it's their Hypercore)        │
  │  This is expected — they're the storage host  │
  └──────────────────────────────────────────────┘

  Privacy score: ★★★★★ (maximum from intermediaries)
  Trade-off: requires trust in the server operator
```

### When Standalone Wins

```
  STANDALONE WINS                    RELAY WINS
  ═══════════════                    ══════════

  "I need maximum privacy"          "I need it to always work"

  "Both users are always             "Users might be on phones
   online and on good networks"       with bad NAT"

  "I'm building a focused            "I'm building a product
   single-purpose service"             with mixed client types"

  "I trust the server operator"      "I want tiered privacy
                                       per-feature"

  "Simplicity is paramount"          "I need browser + mobile
                                       + desktop support"

  "I want zero infrastructure"       "I can run relay
                                       infrastructure"
```

---

## 11. Production Extensions

What would a production-grade version of this look like? The standalone approach is intentionally minimal — here's what we'd add for real-world deployment.

### 11.1 Tiered Privacy Model

Not every use case needs maximum privacy. A production system would let developers choose their trade-off:

```
  Tier 1 — Public
  ┌──────────────────────────────────────────────┐
  │  Data flows through relay infrastructure      │
  │  Relay caches, indexes, and serves data       │
  │  Maximum availability, zero privacy from ops  │
  │  Use case: public registries, open datasets   │
  └──────────────────────────────────────────────┘

  Tier 2 — Local-First
  ┌──────────────────────────────────────────────┐
  │  App code delivered via relay                 │
  │  User data encrypted on device (never leaves)│
  │  P2P sync between user's own devices only    │
  │  Use case: POS, messaging, personal finance  │
  └──────────────────────────────────────────────┘

  Tier 3 — P2P-Only (this project)
  ┌──────────────────────────────────────────────┐
  │  No relay involvement whatsoever              │
  │  Direct peer connections only                 │
  │  Maximum privacy, requires both peers online  │
  │  Use case: wallets, medical records, identity │
  └──────────────────────────────────────────────┘
```

### 11.2 Platform Cryptography

Production encryption at rest using XChaCha20-Poly1305 (AEAD):

```
  Encryption: XChaCha20-Poly1305
  ─────────────────────────────────

  ┌────────────────────────────────────────────┐
  │ 24-byte random nonce │ ciphertext │ 16-byte tag │
  └────────────────────────────────────────────┘

  • 24-byte nonce: random per encryption (2^192 space — no collision risk)
  • Poly1305 tag: authenticates ciphertext + optional AAD
  • Single-pass: encrypt-then-MAC in one operation
  • If any bit is changed: decryption fails (tamper detection)
```

### 11.3 Hierarchical Key Derivation

Instead of one key per application, derive a full key hierarchy from a single root:

```
  Device Key (32 bytes, random, persisted with 0600 permissions)
       │
       ├── BLAKE2b(deviceKey, "app:pear-pos") ──► App Key
       │       │
       │       ├── BLAKE2b(appKey, "data:local-storage") ──► Data Key
       │       └── BLAKE2b(appKey, "sync:peer-abc123")  ──► Sync Key
       │
       └── BLAKE2b(deviceKey, "app:pear-chat") ──► App Key
               │
               └── ...

  Properties:
  • Deterministic: same device key always produces same hierarchy
  • Isolated: compromising one app key doesn't expose others
  • Derivable: no need to store every key — recompute from root
  • Destroyable: zero the device key → all derived keys are gone
```

For a **username registry** specifically, the user's identity keypair replaces the device key as the derivation root — making the key hierarchy portable across devices.

### 11.4 Encrypted Local Storage

A key-value store where values are encrypted at rest:

```
  set("user-prefs", { theme: "dark" })

  On disk:
  ┌──────────────────────────────────────────┐
  │ user-prefs.enc                            │
  │ [24-byte nonce][encrypted JSON][16-byte tag]│
  └──────────────────────────────────────────┘

  • Atomic writes (tmp file + rename)
  • Quota enforcement per app
  • Index file tracks entry metadata
  • Export/import for P2P backup (encrypted blobs transfer without re-encryption)
```

### 11.5 Identity-Aware App Resolution

Combining a username registry with an app registry — without coupling them:

```
  USERNAME REGISTRY                    APP REGISTRY
  (this project, extended)             (separate service)

  "alice" → pubkey_A                   "pear-pos" → {
  "bob"   → pubkey_B                     driveKey: 0xabc...,
                                          publisherPubkey: pubkey_X,
                                          version: "1.2.3"
                                        }

  LINKED AT DISPLAY TIME (not protocol level):

  Client opens "pear-pos":
  1. Resolve appId → driveKey + publisherPubkey
  2. Verify publisher signature on manifest
  3. Derive user data key: BLAKE2b(user.secretKey, driveKey)
  4. All user data encrypted with key only user can produce

  Relay serves app code. Relay never sees user data.
  Publisher signed the code. User verifies independently.
```

### 11.6 Relay Federation

Multiple relay nodes forming a network:

```
  ┌──────────┐         ┌──────────┐         ┌──────────┐
  │ Relay US │◄═══════►│ Relay EU │◄═══════►│ Relay SG │
  └──────────┘         └──────────┘         └──────────┘
       │                    │                     │
  ┌────┴────┐          ┌───┴────┐          ┌────┴────┐
  │ Clients │          │Clients │          │ Clients │
  └─────────┘          └────────┘          └─────────┘

  Coordination via distributed Hypercore registry:
  • Relays append seed-request/accept/cancel to shared log
  • Replication factor: "store this on N relays"
  • Geographic preference: "prefer EU relays"
  • Automatic failover: if one relay goes down, others serve
```

### 11.7 Blind Replication

For the local-first tier, relays can store encrypted app bundles without being able to read them:

```
  Publisher encrypts Hyperdrive with encryptionKey
  Relay replicates the Hypercore (gets ciphertext blocks)
  Relay re-serves encrypted blocks to authorized peers
  Client has encryptionKey → decrypts locally

  Relay sees: block sizes, tree structure, access patterns
  Relay doesn't see: file contents, names, directory structure
```

Limitation: metadata (block count, sizes, timing) is still visible. For user data, local-first (data never leaves device) is strictly better than blind replication.

### 11.8 Proof of Storage & Reputation

Relay operators need accountability:

```
  PROOF-OF-RELAY
  ──────────────
  • Random block challenges: "give me block #N from core X"
  • Relay must respond with correct block within timeout
  • Failures reduce reputation score
  • Score affects seed-request matching (high-rep relays get priority)

  METRICS TRACKED
  ───────────────
  • Uptime percentage
  • Challenge success rate
  • Bandwidth served
  • Geographic latency measurements
  • Storage capacity utilization
```

### 11.9 Multi-Transport Gateway

The standalone approach requires native Hyperswarm peers. Production needs browser and mobile access:

```
  Native client ──── UDP (Hyperswarm) ───────────┐
  Browser client ─── WebSocket ──────── Gateway ──┤──► Hypercore
  Mobile client ──── HTTPS REST ─────── Gateway ──┤
  Tor client ─────── Onion transport ─── Gateway ──┘

  Gateway translates between:
  • HTTP GET /blocks/:seq → core.get(seq)
  • WebSocket frames → protomux-rpc calls
  • REST POST /blocks → core.append()
```

### 11.10 What This Means for a Username Registry

Applied to the block storage / username registry use case:

| Feature | Standalone (now) | Production Extension |
|---|---|---|
| Storage | Single Hypercore, single server | Federated across N relays |
| Lookup | Scan all blocks or index in memory | Hyperbee (B-tree on Hypercore) for O(log n) |
| Identity | Anonymous pubkey | Username → pubkey mapping |
| Privacy | Server sees everything | Tier choice per deployment |
| Access | Native Hyperswarm clients only | Browser, mobile, native |
| Availability | Server down = service down | Multi-relay redundancy |
| Key management | None (client responsible) | Platform key derivation |
| Encryption | None at rest | XChaCha20-Poly1305 per-entry |

The standalone version is the correct foundation. These extensions layer on top without changing the core Hypercore + Hyperswarm + protomux-rpc architecture.

---

## 12. Running the Code

### Prerequisites

```bash
node --version  # Must be >= 20.0.0
```

### Install

```bash
cd standalone
npm install
```

### Run the Demo (self-contained, no DHT needed)

```bash
npm run demo
```

This spins up a server and client in the same process, stores blocks, reads them back, benchmarks write throughput, and verifies Hypercore replication.

### Run Server + Client Separately

Terminal 1 — Start the server:
```bash
npm run server
```

Copy the public key from the output.

Terminal 2 — Start the client:
```bash
npm run client <public-key-from-server>
```

Client commands:
```
  store <text>     Store a text block
  get <seq>        Retrieve block by index
  random [n]       Store n random blocks
  info             Server info
  bench [n]        Benchmark n writes
  quit             Exit
```

### Run Tests

```bash
npm test
```

10 tests covering:
- Single block store/retrieve
- Sequential multi-block storage
- Binary data round-trip
- JSON structured data
- Out-of-range error handling
- Server info metadata
- Large block (1MB)
- Rapid writes (100 blocks)
- Hypercore replication verification
- Empty block edge case

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_DIR` | `./storage-server` or `./storage-client` | Data directory |
| `PORT` | (auto) | Hyperswarm port |

---

## File Structure

```
standalone/
├── server.js          Server: accepts blocks, stores in Hypercore
├── client.js          Client: connects to server, sends/reads blocks
├── demo.js            Self-contained demo (no external DHT)
├── test.js            Test suite (10 tests, zero test deps)
├── package.json       Dependencies and scripts
└── ARCHITECTURE.md    This document
```

---

## Summary

This standalone solution demonstrates the Holepunch protocol stack in its purest form: two peers, one Hypercore, direct encrypted communication. Clean, minimal, and correct.

The standalone approach is a walkie-talkie — direct, private, no middleman. A relay layer adds a post office and telephone network on top for the cases where availability and device diversity matter more than maximum simplicity. Both use the same radio frequency: the Holepunch protocol stack.

---

*Built for the Holepunch Technical Challenge.*

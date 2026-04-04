# HiveRelay

**Shared P2P relay backbone for the Holepunch/Pear ecosystem.**

HiveRelay solves the cold-start problem for Pear apps. When a developer deploys a P2P app and closes their laptop, the app disappears from the network. HiveRelay provides always-on relay nodes that seed apps, relay connections for NAT-challenged peers, and keep the Hyperswarm DHT alive.

## Status

**Phase 1: Community Relay Network** (current)

No token, no payments. Operators run relay nodes and earn reputation through cryptographically verifiable proof-of-relay challenges. The goal is to prove the system works and build a real operator community.

## Quick Start

```bash
# Install
git clone https://github.com/hiverelay/hiverelay
cd hiverelay
npm install

# Run a relay node
npx hiverelay start --region NA --max-storage 50GB

# Seed a Pear app
npx hiverelay seed <pear-app-key> --replicas 3

# Check status
npx hiverelay status
```

## Architecture

```
Application Layer (Pear apps, Keet, POS, etc.)
        │
  HiveRelay Protocol (seed registry, circuit relay, proof-of-relay)
        │
  Hyperswarm / HyperDHT (P2P transport + discovery)
        │
  Optional: Tor / I2P (censorship resistance)
```

### Core Components

- **Relay Node** (`core/relay-node/`) — The daemon that seeds Hypercores and relays connections
- **Seed Protocol** (`core/protocol/seed-request.js`) — Request and accept seeding over protomux
- **Circuit Relay** (`core/protocol/relay-circuit.js`) — NAT traversal fallback
- **Proof-of-Relay** (`core/protocol/proof-of-relay.js`) — Cryptographic verification of service
- **Bandwidth Receipts** (`core/protocol/bandwidth-receipt.js`) — Signed proof of data transfer
- **Seeding Registry** (`core/registry/`) — Autobase-powered distributed registry
- **Reputation System** (`incentive/reputation/`) — Score relays on reliability, latency, uptime
- **Payment Manager** (`incentive/payment/`) — Phase 2 Lightning micropayments + held-amount system

### Transport Plugins (Phase 2+)

- **Tor** (`transports/tor/`) — Hidden service transport for censorship resistance
- **I2P** (`transports/i2p/`) — Garlic routing for P2P-native anonymity
- **WebSocket** (`transports/websocket/`) — Browser peer support

## Documentation

- [Protocol Specification](docs/PROTOCOL-SPEC.md) — Wire protocol, message formats, security model
- [Economics Paper](docs/ECONOMICS.md) — Incentive design, tokenomics, game theory analysis

## Running Tests

```bash
npm test              # All tests
npm run test:unit     # Unit tests only
npm run test:integration  # Integration tests
npm run lint          # Linting (standard)
```

## Project Structure

```
hiverelay/
├── core/
│   ├── relay-node/       # Relay daemon (seeder + relay + metrics)
│   ├── protocol/         # Wire protocol (messages, seed, circuit, proofs)
│   └── registry/         # Autobase seeding registry
├── incentive/
│   ├── payment/          # Lightning micropayments (Phase 2)
│   └── reputation/       # Reputation scoring system
├── transports/           # Tor, I2P, WebSocket (Phase 2+)
├── cli/                  # CLI tool
├── config/               # Default configuration
├── test/                 # Unit and integration tests
└── docs/                 # Specs and economics paper
```

## Design Principles

1. **Hyperswarm-native.** Built on the same stack as Pear apps — not a separate network.
2. **Cross-app peer sharing.** One relay serves the whole ecosystem.
3. **Low barrier.** Runs on a $5/month VPS or Raspberry Pi.
4. **No blockchain for blockchain's sake.** Token phase only if real demand proves it necessary.
5. **Privacy by default.** Relays see encrypted bytes only. Optional Tor/I2P for anonymity.

## Contributing

Apache 2.0 licensed. PRs welcome. See the [open questions](docs/ECONOMICS.md#12-open-questions) for areas that need community input.

## License

[Apache 2.0](LICENSE)

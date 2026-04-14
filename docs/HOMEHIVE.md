# HomeHive: Private Mode Relay

## What is HomeHive?

HomeHive is HiveRelay's private mode -- a personal relay node that serves only your devices. Instead of joining the public DHT and accepting connections from anyone, a HomeHive node:

- Broadcasts on your LAN via mDNS (zero-config discovery)
- Only accepts connections from paired devices (allowlist)
- Never announces itself publicly
- Keeps all data on your local network

Use it for: home NAS, family photo sharing, personal app hosting, private Pear apps, small business POS systems.

## Quick Start

```bash
# Option 1: Interactive setup — select HomeHive mode in the wizard
hiverelay setup

# Option 2: Start normally, then switch mode via management console
hiverelay start
hiverelay manage    # Select "Operating Mode" → "HomeHive"

# Option 3: Switch mode via API
curl -X POST http://localhost:9100/api/manage/mode \
  -H "Content-Type: application/json" \
  -d '{"mode": "homehive"}'
```

HomeHive mode automatically configures low resource limits (32 connections, 25 Mbps, 10GB), LAN-priority discovery, and auto-accept for seed requests.

## Operating Modes

HiveRelay v0.3.0 has 6 operating modes, switchable live via `hiverelay manage` or the management API:

| Mode | Relay | Seeding | Connections | Bandwidth | Use Case |
|------|-------|---------|-------------|-----------|----------|
| **Standard** | Yes | Yes | 256 | 100 Mbps | Public VPS/server |
| **HomeHive** | Yes | Yes | 32 | 25 Mbps | Home/personal, LAN-priority |
| **Seed Only** | No | Yes | 256 | 100 Mbps | App hosting without relay |
| **Relay Only** | Yes | No | 256 | 100 Mbps | Pure circuit relay |
| **Stealth** | Yes | Yes | 32 | 25 Mbps | Tor-only, minimal footprint |
| **Gateway** | No | Yes | 512 | 500 Mbps | HTTP gateway focus |

**HomeHive mode** is designed for residential deployments -- low resource usage, LAN-priority mDNS discovery, auto-accept for local seed requests. Combine with the device allowlist and pairing protocol for family/small-business use.

## Device Pairing

### Adding Devices via Allowlist

The simplest approach -- specify device public keys in `config.json`:

```json
{
  "access": {
    "allowlist": ["abc123...", "def456..."]
  }
}
```

Or configure via the setup wizard (`hiverelay setup`) which writes the config for you.

### Interactive Pairing

For adding new devices after startup:

1. **Operator initiates pairing** (via API or CLI)
   - Generates a time-limited pairing token (16 bytes, 5-minute window)
   - Displays token + relay pubkey as a string or QR code

2. **New device connects** within the pairing window
   - Presents the token and its own pubkey
   - If token matches and hasn't expired, device is added to allowlist

3. **Pairing window closes** automatically after timeout or successful pair

Pairing tokens are single-use and cryptographically random (`crypto.randomBytes`).

### Connection Gating

In HomeHive mode with an allowlist, every incoming connection is checked at the transport level -- before any protocol negotiation, RPC, or replication happens. Unknown devices are silently dropped with zero information leakage.

## Relay Tunnel (Remote Access)

A private node can be reached from outside the LAN by tunneling through a trusted public relay.

### How It Works

```
[Your Phone]                [Public Relay]              [HomeHive Node]
     |                           |                           |
     |--- connect to relay ----->|                           |
     |                           |<-- outbound tunnel -------|
     |--- encrypted traffic ---->|--- forward through ------>|
     |<-- encrypted response ----|<-- tunnel response -------|
```

1. HomeHive node makes an **outbound-only** connection to a chosen public relay
2. The tunnel is persistent with automatic reconnection (exponential backoff)
3. Remote devices connect to the public relay, which forwards to the tunnel
4. All traffic is **end-to-end encrypted** via Noise protocol -- the relay sees metadata (who connects) but cannot read content
5. Device allowlist is enforced at the HomeHive node, not the relay

### Configuration

```json
{
  "relayTunnel": {
    "relayPubkey": "abc123..."
  }
}
```

The `relayPubkey` is the public key of the trusted relay node you want to tunnel through. You must trust this relay to forward your connections honestly.

## mDNS Discovery

HomeHive nodes broadcast on the local network using DNS-SD (RFC 6763) over multicast DNS:

- **Service type:** `_hiverelay._tcp.local`
- **PTR record:** Points to the service instance
- **SRV record:** Hostname + port
- **TXT record:** Public key (`pk=...`), mode (`mode=private`), version

Devices on the same LAN discover the HomeHive node automatically -- no configuration needed. This uses the `multicast-dns` library for proper DNS-SD compliance.

## Security Model

HomeHive's security is a three-layer stack:

1. **Privacy Tiers** (app manifest) -- Developer declares how much the relay can see
2. **PolicyGuard** (relay core) -- Enforces relay exposure rules; violations trigger immediate suspension
3. **AccessControl** (HomeHive) -- Only paired devices can connect at all

Additional security properties:

- **No inbound ports** in private mode (outbound tunnel only)
- **Device allowlist persisted** to disk with `0o600` permissions
- **Encrypted backups** of the allowlist via XSalsa20-Poly1305
- **Silent rejection** of unknown devices (no error messages, no information leakage)
- **Pairing tokens** are cryptographically random, single-use, time-limited

## Remote Access Without a Relay Tunnel

If you want remote access without tunneling through a public relay:
- Start your node normally with `hiverelay start`
- Enable Holesail transport via `hiverelay manage` (Transports menu) for NAT traversal
- Use the device allowlist to restrict who can connect
- Your node joins the DHT for connectivity but the allowlist enforces access control

This gives you the convenience of remote access while maintaining a restricted device list.

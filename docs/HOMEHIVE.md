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
# Start a private node
hiverelay start --mode private

# Start with pre-approved devices
hiverelay start --mode private --allowlist <pubkey1>,<pubkey2>

# Private node with WebSocket for browser access
hiverelay start --mode private --websocket --allowlist <pubkey>
```

The `--allowlist` flag implies `--mode private` if no mode is specified.

## Mode Comparison

| Feature | Public | Private | Hybrid |
|---------|--------|---------|--------|
| Join public DHT | Yes | No | Yes |
| Announce on DHT | Yes | No | No |
| mDNS LAN broadcast | No | Yes | Yes |
| Accept any connection | Yes | No | No |
| Device allowlist | No | Yes | Yes |
| Pairing protocol | No | Yes | Yes |
| Circuit relay | Yes | No | No |
| HTTP API | Yes | No | Yes |
| Metrics | Yes | No | Configurable |

**Private mode** is fully isolated -- LAN only, no external reachability.
**Hybrid mode** joins the DHT (for connectivity) but doesn't announce, and still requires allowlist. Use hybrid when you want remote access without a relay tunnel.

## Device Pairing

### Adding Devices via Allowlist

The simplest approach -- specify device public keys at startup:

```bash
hiverelay start --mode private --allowlist abc123...,def456...
```

Or in `config.json`:
```json
{
  "mode": "private",
  "access": {
    "allowlist": ["abc123...", "def456..."]
  }
}
```

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

In private/hybrid mode, every incoming connection is checked against the allowlist at the transport level -- before any protocol negotiation, RPC, or replication happens. Unknown devices are silently dropped with zero information leakage.

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
  "mode": "private",
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

## Hybrid Mode

Use hybrid when you want:
- LAN discovery (mDNS) for local devices
- Remote access via DHT (without a relay tunnel)
- Device allowlist enforcement
- HTTP API access (disabled in pure private mode)

Hybrid joins the public DHT for connectivity but does NOT announce -- your node won't appear in relay discovery. Only devices that already know your pubkey can connect, and they must be on the allowlist.

```bash
hiverelay start --mode hybrid --allowlist <pubkey1>,<pubkey2>
```

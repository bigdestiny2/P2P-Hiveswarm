# Blindspark for Umbrel

Earn sats for blind seeding P2P apps.

## What it does

Blindspark turns your Umbrel into a blind relay for the Pear/Holepunch
P2P app ecosystem. You host encrypted Hyperdrives — content the relay
can't read but can verify and serve — so apps stay reachable when their
users are offline. You get paid in Lightning sats, via LNbits, for the
storage and bandwidth you contribute.

The relay is genuinely blind: it stores ciphertext blocks and Merkle
proofs, never plaintext. Content is end-to-end encrypted between the
publisher and the consumer; the relay holds the unreadable middle.

## What it doesn't do

- It doesn't and can't tell you what content you're hosting.
- It doesn't promise specific earnings. The market is being bootstrapped.
  Early operators should expect modest sat flow that grows with the
  network.
- It doesn't custodial-hold your sats. All Lightning operations run
  through your own LNbits app. Sats land in your wallet.

## Requirements

- Umbrel OS 1.0 or later
- LNbits installed on the same Umbrel (offered as a dependency at install)
- ~50 GB free storage minimum

## Setup (5 steps, ~10 minutes)

After install, open the dashboard at `blindspark.<your-umbrel>.local`:

1. **Welcome** — one-page overview, click "Let's go"
2. **Name your relay** — defaults to a generated name; change if you like
3. **Connect LNbits** — your LNbits is auto-detected; paste your admin
   key from the LNbits app
4. **Choose accept-mode** — defaults to "Review" (every incoming
   seed request is queued for your approval before any storage or
   bandwidth is committed)
5. **Done** — the dashboard shows live earnings, connections, and status

That's the whole onboarding. The relay is now online and discoverable.

## What honest earnings look like

Earnings depend on network demand for paid seeding — a side of the
market still being built. Order-of-magnitude estimates:

| Effort level | Egress served / month | Approximate annual net |
|---|---|---|
| **Lazy** ("install and forget") | 500 GB | ~$90 / year |
| **Default** (works as advertised) | 1 TB | ~$165 / year |
| **Engaged** (good content + uptime) | 2 TB | ~$305 / year |

Earnings are denominated in sats and appreciate with BTC. These numbers
assume mid-tier pricing (10 sats/GB-month storage, 20 sats/GB egress)
and BTC at $60k. **Adjust both expectations down for the early phase
of the network.** A new relay may earn near $0 in its first month
while the demand-side ecosystem catches up.

## Default policy ("Review" mode)

Out of the box, every incoming seed request is queued for your
approval. You see the publisher's identity, the requested drive size,
and any payment offered. You accept or reject each request from the
dashboard.

This is the safe default. After you understand how the network works,
you can switch from the dashboard to:

- **Allowlist** — auto-accept requests from publishers you trust
- **Open** — auto-accept everything signed (with payment-required
  filtering enabled)
- **Closed** — relay-only mode; no inbound seed requests

## Federation (optional)

If you operate multiple Umbrels in different locations, you can have
them mirror each other — any drive accepted on one is then available on
all. Configured from the dashboard's **Federation** tab. Default is no
federation; you opt in explicitly.

## Privacy and security

- **End-to-end encryption**: content is encrypted by the publisher
  before the relay ever sees it. The relay holds ciphertext + Merkle
  proofs only.
- **Localhost-only management**: the dashboard binds to localhost; the
  Umbrel app proxy fronts it for browser access. No management API is
  exposed externally.
- **Identity persistence**: your relay's identity key is derived
  deterministically from `$APP_SEED` (Umbrel-provided). If you
  reinstall, you get the same relay identity back — no key backup
  needed.
- **LNbits credentials**: stored in the persistent app volume only.
  Never sent to the project's servers (we don't run any).

## Updates

Umbrel handles updates. New versions are published through the App
Store; your Umbrel offers the upgrade. All persistent state in `/data`
is preserved across updates.

## Uninstall

When you uninstall, Umbrel preserves the data volume by default —
reinstalling resumes from where you left off, including the same relay
identity. To wipe data, use the Umbrel app settings.

## Source and licensing

- **Source**: <https://github.com/bigdestiny2/p2p-hiverelay>
- **License**: Apache 2.0
- **Issues**: <https://github.com/bigdestiny2/p2p-hiverelay/issues>

## A note on the name

The project is mid-rebrand from "HiveRelay" to "Blindspark". v0.6.0 is
the first release that ships under the Blindspark name in the user-facing
Umbrel App Store listing. Underlying packages, classes, and the GHCR
image name still use `p2p-hiverelay` for v0.6.0; v0.7.0 will complete
the rename across the codebase.

If you see "HiveRelay" in logs, in environment variable names, or in
the Docker image path — that's why. It's the same project.

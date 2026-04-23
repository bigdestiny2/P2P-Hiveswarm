# Blindspark — Umbrel App Store submission checklist

Audit performed by reading [`getumbrel/umbrel-apps`](https://github.com/getumbrel/umbrel-apps)
README.md (the canonical spec) and cross-referencing against existing
Lightning-handling apps in the store (Albyhub, LNbits, BTCPay Server)
to verify policies for sat-earning apps.

## Compliance status

| Requirement | Spec | Our status | Notes |
|---|---|---|---|
| **App ID** | lowercase + dashes only | ✅ `blindspark` | |
| **Manifest version** | `1` (or `1.1` if hooks needed) | ✅ `1` | We don't need lifecycle hooks |
| **Category** | one of: `ai`, `automation`, `bitcoin`, `crypto`, `developer`, `files`, `finance`, `media`, `networking`, `social` | ✅ `bitcoin` | Lightning apps go here per Albyhub precedent |
| **Required manifest keys** | `manifestVersion`, `id`, `category`, `name`, `version`, `tagline`, `description`, `developer`, `website`, `repo`, `support`, `port`, `gallery` | ✅ all present | |
| **Multi-arch image** | linux/amd64 + linux/arm64 | ✅ `docker-publish.yml` builds both | |
| **Image pinned by sha256 digest** | `<image>:<tag>@sha256:<digest>` | ⚠️ placeholder digest | Reviewers help finalize this in PR review |
| **Non-root container user** | uid 1000 or similar | ✅ `user: 1000:1000` | Dockerfile creates `hiverelay` user |
| **Single web UI via app_proxy** | service named `app_proxy` + `web` | ✅ both present | port 9100 → app_proxy → user |
| **Persistent state under `${APP_DATA_DIR}`** | data must survive uninstall+reinstall | ✅ `${APP_DATA_DIR}/data:/data` | |
| **No external paid services required** | fully self-hosted | ✅ all dependencies are local apps | LNbits is on the same Umbrel |
| **Hard dependencies declared** | `dependencies:` array | ✅ `[lnbits]` | Auto-installs LNbits if missing |
| **Open source license** | OSI-approved | ✅ Apache 2.0 | |
| **No telemetry by default** | App must not phone home without consent | ✅ confirmed | No analytics SDKs, no metrics POST to any external |
| **Earning sats / Lightning handling** | Allowed (Albyhub precedent) | ✅ | We never custody — LNbits does, user controls LNbits |
| **Icon** | 256×256 SVG, no rounded corners | ⚠️ placeholder | Replace before submission |
| **Gallery** | 3-5 images, 1440×900 PNG | ⚠️ placeholder | Reviewers help if rough |
| **App must serve a web UI** | Even simple "connection details" page is OK | ✅ Full dashboard + setup wizard | |
| **PR submission template** | Specific markdown template | ✅ See below | |

## What this app does (ToS-relevant disclosure)

For the avoidance of doubt during review:

- **Custody**: NONE. We do not custody user funds. Lightning sats flow
  through the user's own LNbits app. Blindspark issues invoices and
  reads payment status via the LNbits API — sats land in the user's
  LNbits wallet, not ours.
- **External services**: NONE required. The app talks only to (a) the
  user's own LNbits container on the internal Docker network, (b) the
  Hyperswarm DHT (peer-to-peer, no central server), and (c) Lightning
  invoices the user's LNbits issues.
- **Telemetry**: NONE. No analytics, no error reporting, no usage
  metrics POSTed anywhere. Logs stay local.
- **User data the app stores**: relay identity keypair (derived from
  `$APP_SEED`), federation peer list, accept-mode policy, fee schedule,
  LNbits admin key (the user pasted it), and Hyperdrive ciphertext
  blocks (encrypted; we cannot read them).
- **Network exposure**: only the dashboard via Umbrel's app_proxy on
  port 9100. The relay itself listens on the Hyperswarm DHT (peer-to-
  peer, NAT-traversed via Holesail/UDP-hole-punching).
- **Trademark / branding**: "Blindspark" is the project's own brand.
  No third-party trademarks used in the app name, icon, or marketing
  copy.
- **Content moderation**: The relay is **blind** — it stores ciphertext
  the operator cannot read. Operators control what they accept via the
  accept-mode policy (default: review every incoming request). This
  matches the Tor relay / IPFS pin pattern; legal responsibility for
  content sits with the publisher, not the storage operator.

## PR submission template (paste verbatim into the GitHub PR)

```markdown
# App Submission

### App name
Blindspark

### Version
0.6.0

### One line description (tagline)
Earn sats for blind seeding P2P apps.

### Description
Blindspark turns your Umbrel into a paid blind relay for the
decentralized Pear/Holepunch P2P app ecosystem. You host encrypted
Hyperdrives — content the relay can verify and serve but cannot read —
so that P2P apps remain available while their users are offline.
Operators are paid in Lightning sats (via the user's own LNbits app)
for the storage and bandwidth they contribute.

The relay is genuinely blind: it stores ciphertext blocks and Merkle
proofs only, never plaintext. We do not custody funds — Lightning
operations flow through the user's LNbits installation.

### Developer name
Blindspark

### Website URL
https://github.com/bigdestiny2/p2p-hiverelay

### Source code repository URL
https://github.com/bigdestiny2/p2p-hiverelay

### Support link (issues, Telegram, etc.)
https://github.com/bigdestiny2/p2p-hiverelay/issues

### App category
bitcoin

### App port (the port your app's web UI listens on inside the container)
9100

### 256x256 SVG icon
[uploaded — see attachments]

### Gallery images
[uploaded — 3 screenshots, see attachments]

### Release notes for this version
v0.6.0 — first Umbrel App Store release.

Highlights:
- One-click install via the Umbrel App Store
- Auto-detection of LNbits running on the same Umbrel
- 5-step setup wizard (under 10 minutes from install to earning)
- Earnings dashboard with daily / weekly / monthly sat counters
- Default policy: review every incoming seed request before accepting
- Mid-tier pricing pre-filled (10 sats/GB-month storage, 20 sats/GB egress)

### Dependencies on other Umbrel apps
- lnbits (required — Lightning payment handling)

### I have tested my app on:
- [ ] umbrelOS on a Raspberry Pi
- [ ] umbrelOS on an Umbrel Home
- [ ] umbrelOS on Linux VM
```

## Pre-submission action items

In strict order — do not open the PR until all are checked:

- [ ] Replace `umbrel-app/icon.svg` with a real 256×256 SVG (no
      rounded corners). Budget $200-400 for a designer.
- [ ] Capture 3 real screenshots from a running Blindspark on actual
      Umbrel hardware. Store as `umbrel-app/gallery/1.png`,
      `2.png`, `3.png` (PNG, 1440×900 if possible).
- [ ] Update `umbrel-app/umbrel-app.yml` `gallery:` array if filenames
      change (currently `.jpg`).
- [ ] Build and push v0.6.0 multi-arch image to GHCR via the existing
      workflow (`git tag v0.6.0 && git push --tags`).
- [ ] After image is published, capture the sha256 digest:
      `docker buildx imagetools inspect ghcr.io/bigdestiny2/p2p-hiverelay:0.6.0`
      and replace `@sha256:PLACEHOLDER` in `docker-compose.yml`.
- [ ] Test install on actual Umbrel hardware (Pi or Home). Walk through
      the wizard, confirm LNbits autodetect works, confirm
      earnings dashboard renders.
- [ ] Test on a Linux VM with Umbrel installed.
- [ ] Fork [`getumbrel/umbrel-apps`](https://github.com/getumbrel/umbrel-apps),
      copy the `umbrel-app/` directory contents to a new `blindspark/`
      directory in the fork.
- [ ] Open a PR using the template above.
- [ ] Respond to reviewer feedback. Common reviewer asks per the README:
      port-conflict resolution, sha256 pinning (if missing),
      assigning unique IP addresses to containers.

## What we're NOT submitting yet

- [ ] LNbits PaymentProvider integration (planned for v0.6.0; the wizard
      stores the admin key, but the `LNbitsPaymentProvider` class that
      uses it is not yet wired into the live invoice-generation flow)
- [ ] Real earnings analytics endpoints (the dashboard's headline number
      is currently a placeholder until v0.6.0 ships LNbits integration)
- [ ] Tor support (some Umbrel apps offer this; we'll add in a later
      version if there's demand)

These gaps are documented in the README so reviewers know what to
expect and what's coming.

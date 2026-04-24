# @hive/verifier

Independent reference verifier for HiveRelay. Reads raw data from
multiple relay endpoints and reports divergence.

## Why this exists

[`docs/THREAT-MODEL.md`](../../docs/THREAT-MODEL.md) action item #3:
**ship a reference CLI alongside the official client to mitigate
monoculture risk.** Cross-client verification only works if there's
more than one client.

This package is intentionally separate from `p2p-hiverelay` and
`p2p-hiverelay-client`:

- It does not import the main SDK
- It uses only `b4a` + Node built-ins
- It can be installed and run independently
- A compromise of the main SDK does not silently affect the verifier

## Install

```sh
npm install -g p2p-hiverelay-verifier
```

## CLI usage

### Compare capability docs + catalogs across relays

```sh
hive-verify https://relay-a.example.com https://relay-b.example.com
```

Output (human-readable):

```
Relays checked:
  https://relay-a.example.com
  https://relay-b.example.com

Capabilities OK: ✓
Catalogs OK:     ✓

Divergences: 0

Verdict: AGREE
```

### Compare a specific drive's state across relays

```sh
hive-verify --drive abc123def456... https://relay-a https://relay-b https://relay-c
```

### JSON output (for scripting)

```sh
hive-verify --json https://relay-a https://relay-b > report.json
echo "Exit code: $?"
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | All compared relays agree |
| 1 | Divergence detected |
| 2 | All relays failed to respond |
| 3 | Argument or usage error |

## Library usage

```js
import { verifyRelays, compareDrive } from 'p2p-hiverelay-verifier'

const report = await verifyRelays([
  'https://relay-a.example.com',
  'https://relay-b.example.com'
])

if (report.verdict === 'diverge') {
  console.error('Relays disagree:', report.divergences)
}
```

## What it does NOT do

- It does not validate cryptographic signatures on individual blocks
  yet. (Future work; would require pulling in `hypercore-crypto` —
  acceptable.)
- It does not maintain its own catalog or content.
- It does not connect to the Hyperswarm DHT — it talks HTTP only.
- It is not a replacement for the main client SDK; it's a verification
  tool that runs alongside.

## License

Apache 2.0

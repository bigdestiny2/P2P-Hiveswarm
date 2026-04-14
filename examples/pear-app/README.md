# HiveRelay Pear Example

Minimal Pear terminal app that publishes content via HiveRelay.

## Run with Pear

```bash
cd examples/pear-app
npm install
pear run .
```

## Run with Node.js (for testing)

```bash
cd examples/pear-app
npm install
node index.js
```

## What it does

1. Connects to the HiveRelay network via DHT
2. Publishes an HTML file and manifest to a Hyperdrive
3. Sends a seed request so relay nodes replicate the content
4. Shows connected relays and available apps

After you quit, your content is still available from relay nodes.

## Key concept

The only difference between Pear and Node.js usage is storage:

```js
// Pear — use Pear's built-in storage
const store = new Corestore(Pear.config.storage)

// Node.js — use a filesystem path
const store = new Corestore('./my-storage')
```

Everything else (relay discovery, seeding, replication) works identically.

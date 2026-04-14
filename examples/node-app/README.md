# HiveRelay Node.js Example

Minimal Node.js app that publishes content via HiveRelay.

## Run

```bash
cd examples/node-app
npm install
node index.js
```

## What it does

1. Connects to the HiveRelay network via DHT
2. Publishes HTML + CSS + manifest to a Hyperdrive
3. Sends a seed request so relay nodes replicate the content
4. Calls the identity service on connected relays
5. Lists all available apps on the network

After you quit, your content is still available from relay nodes.

## Publish a directory

Instead of listing files individually, publish an entire directory:

```js
const drive = await relay.publish('./my-website')
```

This recursively reads all files (skipping `node_modules`, `.git`, hidden dirs) and publishes them to a Hyperdrive.

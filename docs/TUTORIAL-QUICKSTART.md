# Build Your First Always-On Pear App — in 10 Minutes

This is the fastest path to publishing a P2P app that stays online when your
laptop does not. By the end you will have:

1. A local testnet with 3 relays running on your machine.
2. A Pear (or Node) app that publishes a Hyperdrive.
3. The relays seeding your content 24/7 — survives `Ctrl+C` on your app.
4. An HTTP gateway URL anyone can open in a browser to see your files.

No accounts. No API keys. No fees. You need Node.js 20+ and 10 minutes.

---

## 1. Install HiveRelay (30 seconds)

```bash
npm install -g p2p-hiverelay
# or, without global install:
npx p2p-hiverelay --help
```

## 2. Start a local testnet (15 seconds)

```bash
npx p2p-hiverelay testnet
```

You will see three relays start up on ports 9100, 9101, 9102. Leave this
running in its own terminal. The testnet is already configured to discover
itself — no bootstrap nodes, no DNS.

Open `http://127.0.0.1:9100/dashboard` to see the live dashboard.

## 3. Write your app (3 minutes)

Create `my-app.js`:

```js
import { HiveRelayClient } from 'p2p-hiverelay/client'

const client = new HiveRelayClient({
  storage: './my-app-storage',
  bootstrap: [
    { host: '127.0.0.1', port: 49737 } // testnet DHT bootstrap (see testnet output)
  ]
})

await client.start()

// Publish a Hyperdrive with some files
const { key } = await client.publish({
  appId: 'my-first-app',
  files: {
    '/index.html': '<h1>Hello from a P2P app that never sleeps!</h1>',
    '/data.json': JSON.stringify({ version: '1.0', built: new Date() }),
    '/about.md': '# About\n\nThis content lives on the HiveRelay network.'
  }
})

console.log('Published! Drive key:', key)

// Seed via relays — they will keep replicating after this script exits
const acceptances = await client.seed(key, { replicas: 3 })
console.log(`Accepted by ${acceptances.length} relays`)

// Keep alive for a moment so replication completes
await new Promise(r => setTimeout(r, 5000))
await client.destroy()
console.log('Done. Your content is now pinned across', acceptances.length, 'relays.')
```

Run it:

```bash
node my-app.js
```

You should see:

```
Published! Drive key: 4f2c...a1b3
Accepted by 3 relays
Done. Your content is now pinned across 3 relays.
```

## 4. Open your content in the browser (15 seconds)

Copy the drive key from the output. In any browser, open:

```
http://127.0.0.1:9100/v1/hyper/<YOUR_DRIVE_KEY>/index.html
```

You are now serving a Hyperdrive over HTTP. The relay holds the full copy.

## 5. Kill your app. Watch it stay alive. (1 minute)

Your `my-app.js` has already exited. Your laptop can go to sleep. The
content is still reachable:

```bash
# In a new terminal — pretend to be a different user
curl http://127.0.0.1:9100/v1/hyper/<YOUR_DRIVE_KEY>/data.json
```

This is the whole point. **The relay is not a server you operate. It is a
peer on the DHT that happens to have your data.** You can take down the
entire testnet, restart it, and the content comes back — because it lives on
`./storage/` inside each relay.

## 6. Browse the catalog (30 seconds)

Open `http://127.0.0.1:9100/catalog` to see everything your relays are
serving, filter by type (apps, drives, datasets, media), and search. Click
"Browse Files" on any card to open the HTTP gateway for that drive.

## 7. Call a service (1 minute)

The relays also expose a service layer. Try calling the identity service:

```js
const result = await client.callService('identity', 'whoami', {})
console.log(result)
```

Or run some compute:

```js
const job = await client.callService('compute', 'submit', {
  type: 'js',
  input: {
    code: 'input.a + input.b',
    data: { a: 40, b: 2 }
  }
})
console.log('Job submitted:', job.jobId)

// Poll for result
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 100))
  const { ready, result } = await client.callService('compute', 'result', { jobId: job.jobId })
  if (ready) { console.log('Result:', result); break }
}
```

The JS handler runs in a sandboxed worker thread — no filesystem, no network
access from the caller's code.

---

## What just happened?

1. `client.publish()` created a Hyperdrive and wrote files into it.
2. `client.seed()` broadcast a signed request to the DHT asking any listening
   relay to replicate the drive.
3. The relays accepted (they have storage available and your content passed
   their privacy/policy checks), joined the drive's discovery topic, and
   started pulling blocks.
4. Each relay now has a full replica. Any peer who knows the drive key can
   fetch it from any relay — or via the HTTP gateway for non-P2P clients.

---

## Next steps

### Connect to live relays (not just your testnet)

Remove the `bootstrap` option and the client will auto-discover relays on
the public DHT. We run relays in Utah and Singapore:

```js
const client = new HiveRelayClient({ storage: './my-app-storage' })
```

Currently reachable: `relay-us.p2phiverelay.xyz`, `relay-sg.p2phiverelay.xyz`.

### Handle disconnection gracefully

`client.seed()` now has a persistent retry queue. If no relays accept
immediately, the request is stored to disk and retried with exponential
backoff across process restarts:

```js
client.on('seed-pending-enqueued', ({ appKey, attempts }) => {
  console.log(`Retrying seed for ${appKey} (attempt ${attempts})`)
})
client.on('seed-pending-success', ({ appKey }) => {
  console.log(`Finally seeded: ${appKey}`)
})
```

### Use an existing swarm (advanced)

If you already have a Hyperswarm and Corestore in your Pear app, pass them
in instead of having the client create its own:

```js
const client = new HiveRelayClient({
  swarm: myExistingSwarm,
  store: myExistingCorestore,
  keyPair: myExistingKeyPair
})
```

### Publish a directory instead of inline files

```js
await client.publish({
  appId: 'my-site',
  directory: './public',        // reads all files recursively
  maxFileSize: 50 * 1024 * 1024 // 50MB per file
})
```

Symlinks are automatically skipped; files larger than `maxFileSize` are
skipped with a `publish-skip` event so you can log them.

### Encrypt before seeding (relay-blind mode)

Relays see everything in a normal Hyperdrive. If you want them to hold your
data without being able to read it, encrypt your files at the app layer
before calling `publish()`. The drive key stays the same, the relays store
ciphertext, and only peers with your symmetric key can decrypt.

### Run your own relay

```bash
# Interactive setup (asks for storage path, max capacity, region)
npx p2p-hiverelay setup

# Start it
npx p2p-hiverelay start
```

Your relay joins the public DHT, announces itself, syncs the content
catalog from peers, and starts earning reputation for every verified
replication.

### Watch the dashboard

`http://<your-relay>:9100/dashboard` shows real-time connections, seeded
apps, bandwidth, reputation, and health. It updates live over WebSocket.

---

## Troubleshooting

**"No relays connected"**: The testnet bootstrap port changes each run.
Copy the exact port from the `testnet` output. For public DHT usage, give it
10–20 seconds after `client.start()` — DHT discovery is not instant.

**"Seed timed out with 0 acceptances"**: Check that your testnet is still
running and the relays have storage capacity (the dashboard shows this).

**Browser CORS errors**: The gateway sends permissive CORS headers by
default, but if you are behind a reverse proxy, make sure it forwards them.

**"Drive key changed on republish"**: If you pass a stable `appId`, the
client reuses the same drive across runs. The key is stable. If you omit
`appId`, a fresh drive is created every time.

---

## What makes this different?

Unlike a traditional backend:

- **No central server.** The relay network is federated; anyone can run one.
- **No account required.** Your keypair is your identity.
- **No vendor lock-in.** The data lives on Hyperdrive, a standard format.
- **No deployment.** Publishing is a single method call.
- **Always-on.** Your users' clients pull directly from relays even when
  you are asleep.

Unlike raw Hyperswarm:

- **Your laptop does not need to stay on** — relays keep content alive.
- **Browsers can reach your content** via the HTTP gateway.
- **NAT traversal works** even when both peers are behind symmetric NATs
  (relays provide circuit relay).
- **Discovery is solved** — the public DHT topic advertises which relays
  carry which content.

---

## Where to go from here

- `docs/ARCHITECTURE.md` — how the pieces fit together
- `docs/SECURITY.md` — threat model and hardening choices
- `docs/SERVICES.md` — the 8 built-in services and how to add your own
- `examples/pear-app/` — a real Pear runtime example
- `test/integration/` — runnable end-to-end scenarios

Questions? Issues? Open one on GitHub. Contributions welcome.

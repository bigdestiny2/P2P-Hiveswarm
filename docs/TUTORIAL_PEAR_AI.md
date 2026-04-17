# Build Your First Pear App with AI in 10 Minutes

Build a peer-to-peer AI chat app that runs on the HiveRelay network. No cloud accounts, no API keys, no data collection. Your app connects to relay nodes that serve AI inference directly over encrypted P2P connections.

By the end of this tutorial you'll have a working Pear app that:

- Connects to the HiveRelay P2P network
- Calls AI models running on relay nodes
- Publishes content that other peers can replicate
- Works offline-first with P2P sync

## Prerequisites

- Node.js 20+
- npm

## Step 1: Create Your Project

```bash
mkdir pear-ai-chat && cd pear-ai-chat
npm init -y
npm install p2p-hiverelay
```

Add `"type": "module"` to your `package.json`:

```json
{
  "name": "pear-ai-chat",
  "type": "module",
  "dependencies": {
    "p2p-hiverelay": "latest"
  }
}
```

## Step 2: Connect to the Network

Create `app.js`:

```javascript
import { HiveRelayClient } from 'p2p-hiverelay/client'

const app = new HiveRelayClient('./storage')

await app.start()
console.log('Connected to HiveRelay network')
console.log('Relays found:', app.getRelays().length)
```

Run it:

```bash
node app.js
```

That's it. Your app discovers relay nodes automatically via the DHT. No configuration needed.

## Step 3: Call the AI Service

Replace `app.js` with:

```javascript
import { HiveRelayClient } from 'p2p-hiverelay/client'

const app = new HiveRelayClient('./storage')
await app.start()

// Wait for a relay with AI service
console.log('Finding relay with AI service...')
await new Promise(resolve => {
  const check = () => {
    const relays = app.getRelays()
    if (relays.some(r => r.hasServiceProtocol)) return resolve()
    setTimeout(check, 1000)
  }
  check()
})

// Call the AI service
const result = await app.callService('ai', 'infer', {
  modelId: 'gemma4:latest',
  input: 'Explain P2P networking in one sentence.'
})

console.log('AI says:', result.text)
console.log('Tokens used:', result.tokens)

await app.destroy()
```

## Step 4: Build an Interactive Chat

Replace `app.js` with a chat loop:

```javascript
import { HiveRelayClient } from 'p2p-hiverelay/client'
import { createInterface } from 'readline'

const app = new HiveRelayClient('./storage')
await app.start()
console.log('Connected. Waiting for AI relay...')

// Wait for service channel
await new Promise(resolve => {
  app.on('service-channel-open', resolve)
  // Check if already connected
  if (app.getRelays().some(r => r.hasServiceProtocol)) resolve()
})

console.log('AI ready. Type a message (Ctrl+C to quit).\n')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const history = []

function ask () {
  rl.question('You: ', async (input) => {
    if (!input.trim()) return ask()

    history.push({ role: 'user', content: input })

    try {
      const result = await app.callService('ai', 'infer', {
        modelId: 'gemma4:latest',
        input: history
      })

      console.log(`AI: ${result.text}\n`)
      history.push({ role: 'assistant', content: result.text })
    } catch (err) {
      console.error('Error:', err.message)
    }

    ask()
  })
}

ask()
```

Run it and start chatting:

```
$ node app.js
Connected. Waiting for AI relay...
AI ready. Type a message (Ctrl+C to quit).

You: What is a Hyperdrive?
AI: A Hyperdrive is a distributed, append-only filesystem built on Hypercore...

You: How does it replicate?
AI: Hyperdrives replicate using a sparse Merkle tree...
```

The chat history is sent as messages, so the model has full context of the conversation.

## Step 5: Publish Your App to the Network

Make your app distributable over P2P:

```javascript
import { HiveRelayClient } from 'p2p-hiverelay/client'
import { readFileSync } from 'fs'

const app = new HiveRelayClient('./storage')
await app.start()

// Publish your app files
const drive = await app.publish([
  { path: '/app.js', content: readFileSync('./app.js') },
  { path: '/package.json', content: readFileSync('./package.json') }
], { appId: 'pear-ai-chat' })

console.log('App published!')
console.log('Share this key:', drive.key.toString('hex'))
console.log('Anyone can replicate with: app.open("' + drive.key.toString('hex') + '")')
```

Other users can replicate your app:

```javascript
const remote = new HiveRelayClient('./user-storage')
await remote.start()

const drive = await remote.open('the-key-you-shared')
const appCode = await remote.get(drive.key.toString('hex'), '/app.js')
console.log('Got app code:', appCode.toString().length, 'bytes')
```

## Step 6: Add Embeddings (Semantic Search)

Use the AI service for embeddings to build search over your data:

```javascript
// Generate embeddings for your documents
const docs = [
  'HiveRelay is a P2P relay infrastructure',
  'Pear apps run without cloud servers',
  'Lightning payments enable micropayments'
]

for (const doc of docs) {
  const embedding = await app.callService('ai', 'embed', {
    modelId: 'gemma4:latest',
    input: doc
  })
  console.log(`Embedded: "${doc.slice(0, 30)}..." → ${embedding.raw?.embeddings?.[0]?.length || '?'} dimensions`)
}
```

## Available Services

Every HiveRelay node exposes these services via `callService()`:

| Service | Methods | Use Case |
|---------|---------|----------|
| `ai` | `infer`, `embed`, `list-models`, `status` | LLM inference, embeddings |
| `storage` | `drive-create`, `drive-read`, `drive-write`, `drive-list` | Persistent P2P storage |
| `identity` | `whoami`, `sign`, `verify` | Cryptographic identity |
| `compute` | `submit`, `status`, `result` | Sandboxed code execution |
| `schema` | `register`, `validate`, `list` | Data validation |
| `sla` | `create`, `list`, `get` | Service guarantees |

## HTTP API (Alternative)

If your app can't use P2P connections (e.g., browser without WebSocket), use the HTTP API:

```bash
# List models
curl http://relay-host:9100/api/v1/ai/models

# Run inference
curl -X POST http://relay-host:9100/api/v1/ai/infer \
  -H 'Content-Type: application/json' \
  -d '{"modelId":"gemma4:latest","input":"Hello!"}'

# Service catalog
curl http://relay-host:9100/api/v1/services
```

## What Just Happened?

1. Your app joined the HiveRelay DHT and discovered relay nodes automatically
2. It opened an encrypted Protomux channel to a relay with AI service
3. AI inference ran on the relay's local GPU (no cloud, no data leaves the P2P network)
4. All communication is end-to-end encrypted via the Noise protocol
5. Your published content is replicated across relay nodes for availability

No API keys. No accounts. No cloud. Just P2P.

## Next Steps

- **Explore models**: Relay operators choose which models to serve. Check `callService('ai', 'list-models')` to see what's available.
- **Add payments**: Use the SLA service to create paid contracts with relay operators for guaranteed uptime and performance.
- **Go private**: Run your own relay with `p2p-hiverelay start --mode private --ai --ai-model gemma4:latest` for a personal AI server.
- **Read the docs**: See [SERVICES.md](./SERVICES.md) for the full services API and [DEVELOPER.md](./DEVELOPER.md) for the protocol spec.

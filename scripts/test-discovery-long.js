import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import sodium from 'sodium-universal'

const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

console.log('Topic:', b4a.toString(RELAY_DISCOVERY_TOPIC, 'hex'))

const swarm = new Hyperswarm()

swarm.on('connection', (conn, info) => {
  const pk = info.publicKey ? b4a.toString(info.publicKey, 'hex') : 'unknown'
  console.log(`[${new Date().toISOString()}] CONNECTED: ${pk.slice(0, 16)}...`)
})

// Join as client only — looking for relay servers
swarm.join(RELAY_DISCOVERY_TOPIC, { server: false, client: true })
console.log('Flushing DHT...')
await swarm.flush()
console.log('Flush done at', new Date().toISOString())
console.log('My PK:', b4a.toString(swarm.keyPair.publicKey, 'hex').slice(0, 16))
console.log('Waiting 60s for relay discovery...')

// Log every 10s
let elapsed = 0
const interval = setInterval(() => {
  elapsed += 10
  console.log(`[${elapsed}s] connections: ${swarm.connections.size}`)
}, 10000)

setTimeout(async () => {
  clearInterval(interval)
  console.log('\nFinal connections:', swarm.connections.size)
  for (const conn of swarm.connections) {
    console.log('  peer:', conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex').slice(0, 16) : '?')
  }
  await swarm.destroy()
  process.exit(0)
}, 60000)

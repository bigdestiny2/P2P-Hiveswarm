// Test if we can connect directly to the local relay's public key
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import sodium from 'sodium-universal'

const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

// Check what swarm.status() shows
const swarm = new Hyperswarm()

swarm.on('connection', (conn, info) => {
  const pk = info.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : 'unknown'
  console.log('CONNECTED to:', pk)
})

const disc = swarm.join(RELAY_DISCOVERY_TOPIC, { server: false, client: true })
console.log('Joined topic, flushing...')

// Check the discovery state
disc.flushed().then(() => {
  console.log('Discovery flushed')
  console.log('  server:', disc.isServer)
  console.log('  client:', disc.isClient)
}).catch(err => console.log('Discovery error:', err.message))

await swarm.flush()
console.log('Swarm flushed')
console.log('Peers connecting:', swarm.peers?.size || 'N/A')
console.log('Connections:', swarm.connections.size)

// Check DHT status
const dht = swarm.dht
console.log('DHT host:', dht.host)
console.log('DHT port:', dht.port)
console.log('DHT bootstrapped:', dht.bootstrapped)

// Wait and check repeatedly
for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 5000))
  console.log(`[${(i + 1) * 5}s] connections: ${swarm.connections.size}, peers: ${swarm.peers?.size || 0}`)
}

await swarm.destroy()
process.exit(0)

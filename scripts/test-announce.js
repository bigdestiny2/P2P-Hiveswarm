import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import sodium from 'sodium-universal'

const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

console.log('Topic:', b4a.toString(RELAY_DISCOVERY_TOPIC, 'hex'))

// Create a swarm that announces (like the relay does)
const server = new Hyperswarm()
server.on('connection', (conn, info) => {
  console.log('SERVER got connection from:', b4a.toString(info.publicKey, 'hex').slice(0, 16))
})

// Join as server (announcing)
const disc = server.join(RELAY_DISCOVERY_TOPIC, { server: true, client: false })
console.log('Flushing server announcement...')
await server.flush()
console.log('Server announced. PK:', b4a.toString(server.keyPair.publicKey, 'hex').slice(0, 16))

// Now create a separate swarm as client to look for the server
const client = new Hyperswarm()
client.on('connection', (conn, info) => {
  console.log('CLIENT connected to:', b4a.toString(info.publicKey, 'hex').slice(0, 16))
})

client.join(RELAY_DISCOVERY_TOPIC, { server: false, client: true })
console.log('Flushing client lookup...')
await client.flush()
console.log('Client flushed. PK:', b4a.toString(client.keyPair.publicKey, 'hex').slice(0, 16))

console.log('Waiting 15s...')
await new Promise(r => setTimeout(r, 15000))

console.log('Server connections:', server.connections.size)
console.log('Client connections:', client.connections.size)

await server.destroy()
await client.destroy()
process.exit(0)

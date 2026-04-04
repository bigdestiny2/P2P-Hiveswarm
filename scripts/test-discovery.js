import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import sodium from 'sodium-universal'

const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

console.log('Topic:', b4a.toString(RELAY_DISCOVERY_TOPIC, 'hex'))

const swarm = new Hyperswarm()
swarm.on('connection', (conn, info) => {
  const pk = info.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : 'unknown'
  console.log('CONNECTED:', pk)
})

swarm.join(RELAY_DISCOVERY_TOPIC, { server: true, client: true })
console.log('Flushing...')
await swarm.flush()
console.log('Flush done, PK:', b4a.toString(swarm.keyPair.publicKey, 'hex').slice(0, 16))
console.log('Waiting 20s...')
setTimeout(async () => {
  console.log('Final connections:', swarm.connections.size)
  await swarm.destroy()
  process.exit(0)
}, 20000)

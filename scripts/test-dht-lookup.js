import DHT from 'hyperdht'
import b4a from 'b4a'
import sodium from 'sodium-universal'

const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

console.log('Looking up topic:', b4a.toString(RELAY_DISCOVERY_TOPIC, 'hex'))

const dht = new DHT()
await dht.ready()
console.log('DHT ready, my node:', b4a.toString(dht.defaultKeyPair.publicKey, 'hex').slice(0, 16))

// Try to look up who's announcing on this topic
const query = dht.lookup(RELAY_DISCOVERY_TOPIC)
const peers = []

for await (const data of query) {
  if (data.peers && data.peers.length) {
    for (const peer of data.peers) {
      const host = peer.publicKey ? b4a.toString(peer.publicKey, 'hex').slice(0, 16) : 'unknown'
      console.log('Found peer:', host, '| relay:', peer.relayAddresses?.length || 0)
      peers.push(peer)
    }
  }
}

console.log('\nTotal peers found:', peers.length)
await dht.destroy()
process.exit(0)

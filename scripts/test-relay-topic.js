// Check if the running relay's topic announcement is visible in the DHT
import DHT from 'hyperdht'
import b4a from 'b4a'
import sodium from 'sodium-universal'

const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

console.log('Looking up topic:', b4a.toString(RELAY_DISCOVERY_TOPIC, 'hex'))

const dht = new DHT()
await dht.ready()
console.log('DHT ready, host:', dht.host, 'port:', dht.port, 'firewalled:', dht.firewalled)

// Perform a raw DHT lookup for the topic
const query = dht.lookup(RELAY_DISCOVERY_TOPIC)
const results = []

for await (const data of query) {
  console.log('DHT response from:', data.from?.host + ':' + data.from?.port)
  if (data.peers && data.peers.length) {
    for (const peer of data.peers) {
      const pk = peer.publicKey ? b4a.toString(peer.publicKey, 'hex').slice(0, 16) : '?'
      console.log('  PEER:', pk, '| relay addresses:', peer.relayAddresses?.length || 0)
      results.push(peer)
    }
  }
  console.log('  (peers in this response:', data.peers?.length || 0, ')')
}

console.log('\nTotal unique peers found:', results.length)
await dht.destroy()
process.exit(0)

import DHT from 'hyperdht'

const dht = new DHT()
await dht.ready()
console.log('DHT ready')
console.log('  host:', dht.host)
console.log('  port:', dht.port)
console.log('  firewalled:', dht.firewalled)
console.log('  bootstrapNodes:', dht.bootstrapNodes?.length || 'N/A')

// Try to find any node
const testKey = Buffer.alloc(32, 0xff)
const query = dht.findNode(testKey)
let nodes = 0
for await (const res of query) {
  nodes++
  if (nodes >= 3) break
}
console.log('Found', nodes, 'DHT nodes (findNode test)')

await dht.destroy()
process.exit(0)

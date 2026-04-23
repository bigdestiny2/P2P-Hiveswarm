import test from 'brittle'
import { AppRegistry } from 'p2p-hiverelay/core/app-registry.js'

test('AppRegistry: catalog keeps drive entries while deduplicating apps by appId', (t) => {
  const registry = new AppRegistry(null)

  registry.set('a'.repeat(64), {
    type: 'app',
    appId: 'peer-chat',
    version: '1.0.0',
    name: 'Peer Chat'
  })

  registry.set('b'.repeat(64), {
    type: 'app',
    appId: 'peer-chat',
    version: '1.1.0',
    name: 'Peer Chat'
  })

  registry.set('c'.repeat(64), {
    type: 'drive',
    appId: 'peer-chat',
    version: '2026.04',
    name: 'Peer Chat Attachments'
  })

  const catalog = registry.catalog()
  const apps = catalog.filter(entry => entry.type === 'app')
  const drives = catalog.filter(entry => entry.type === 'drive')

  t.is(apps.length, 1, 'only latest app version remains')
  t.is(apps[0].appKey, 'b'.repeat(64), 'latest app version kept')
  t.is(drives.length, 1, 'drive entry is retained')
  t.is(drives[0].appKey, 'c'.repeat(64), 'drive entry key is preserved')
})

test('AppRegistry: catalogByType and catalogForBroadcast include content metadata', (t) => {
  const registry = new AppRegistry(null)
  registry.set('d'.repeat(64), {
    type: 'drive',
    parentKey: 'e'.repeat(64),
    mountPath: '/data',
    appId: 'ghost-drive-demo'
  })

  const driveCatalog = registry.catalogByType('drive')
  t.is(driveCatalog.length, 1, 'catalogByType returns drive entry')
  t.is(driveCatalog[0].parentKey, 'e'.repeat(64), 'parentKey preserved in catalog')
  t.is(driveCatalog[0].mountPath, '/data', 'mountPath preserved in catalog')

  const broadcast = registry.catalogForBroadcast()
  t.is(broadcast.length, 1, 'broadcast includes entry')
  t.is(broadcast[0].type, 'drive', 'broadcast includes content type')
  t.is(broadcast[0].parentKey, 'e'.repeat(64), 'broadcast includes parentKey')
  t.is(broadcast[0].mountPath, '/data', 'broadcast includes mountPath')
})

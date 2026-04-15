/**
 * Default configuration for HiveRelay nodes
 */

export default {
  // Node identity
  storage: './hiverelay-storage',

  // Network
  // When null, uses HyperDHT defaults (node1-3.hyperdht.org:49737).
  // The bootstrap cache merges cached peers with these nodes so that
  // new nodes can still join the network if the hardcoded bootstrap
  // nodes are unreachable.
  bootstrapNodes: null,
  maxConnections: 256,

  // Bootstrap cache — persists DHT peers to disk so nodes can rejoin
  // the network even when the default bootstrap servers are down.
  bootstrapCacheEnabled: true,
  bootstrapCachePeers: 50,

  // Seeding
  enableSeeding: true,
  maxStorageBytes: 50 * 1024 * 1024 * 1024, // 50 GB
  announceInterval: 15 * 60 * 1000, // 15 minutes

  // Circuit relay
  enableRelay: true,
  maxRelayBandwidthMbps: 100,
  maxCircuitDuration: 10 * 60 * 1000, // 10 minutes
  maxCircuitBytes: 64 * 1024 * 1024, // 64 MB per circuit
  maxCircuitsPerPeer: 5,
  reservationTTL: 60 * 60 * 1000, // 1 hour

  // Proof of relay
  proofMaxLatencyMs: 5000,
  proofChallengeInterval: 5 * 60 * 1000, // 5 minutes

  // Reputation
  reputationDecayRate: 0.995, // Daily
  minChallengesForRanking: 10,

  // Metrics & API
  enableMetrics: true,
  enableAPI: true,
  apiPort: 9100,
  apiHost: '0.0.0.0',
  corsOrigins: [],

  // Seeding registry
  registryKey: null, // null = create new autobase
  registryScanInterval: 60_000, // 1 minute
  registryAutoAccept: true, // Auto-accept matching seed requests (false = approval mode)
  targetReplicaFloor: 2,
  replicationCheckInterval: 60_000,
  replicationRepairEnabled: true,

  // Catalog and gateway trust policy
  gatewayPublicOnlyPrivacyTier: true,
  requireSignedCatalog: false,
  catalogSignatureMaxAgeMs: 5 * 60 * 1000,
  catalogMaxAppAgeMs: 30 * 24 * 60 * 60 * 1000,

  // Discovery / access mode controls
  discovery: {
    dht: true,
    announce: true,
    mdns: false
  },
  access: {
    open: true,
    allowlist: []
  },
  pairing: {
    enabled: false
  },

  // Regions
  regions: [], // Empty = accept from all regions

  // Transports
  transports: {
    udp: true, // Always on (HyperDHT default)
    tor: false,
    i2p: false,
    websocket: false,
    holesail: false
  },
  wsPort: 8765,

  // Holesail API tunnel (for relays behind NAT)
  holesail: {
    host: '127.0.0.1'
  },

  // Tor hidden service
  tor: {
    socksHost: '127.0.0.1',
    socksPort: 9050,
    controlHost: '127.0.0.1',
    controlPort: 9051,
    controlPassword: null,
    cookieAuthFile: '/var/lib/tor/control_auth_cookie'
  },

  // Lightning payments
  lightning: {
    enabled: false,
    rpcUrl: 'localhost:10009',
    macaroonPath: null,
    certPath: null,
    network: 'mainnet'
  },

  // Payment settlement
  payment: {
    enabled: false,
    settlementInterval: 24 * 60 * 60 * 1000, // daily
    minSettlementSats: 1000
  },

  // Shutdown
  shutdownTimeoutMs: 10_000
}

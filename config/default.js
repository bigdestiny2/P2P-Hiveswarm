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

  // Seeding registry
  registryKey: null, // null = create new autobase
  registryScanInterval: 60_000, // 1 minute
  registryAutoAccept: true, // Auto-accept matching seed requests (false = approval mode)

  // Regions
  regions: [], // Empty = accept from all regions

  // Transports
  transports: {
    udp: true, // Always on (HyperDHT default)
    tor: false,
    websocket: false,
    holesail: false
  },
  wsPort: 8765,

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

  // Credits — everything starts free
  credits: {
    welcomeCredits: 1000, // 1k free credits for every new wallet
    minTopUp: 100,
    maxBalance: 100_000_000
  },

  // Payment settlement
  payment: {
    enabled: false,
    settlementInterval: 24 * 60 * 60 * 1000, // daily
    minSettlementSats: 1000
  },

  // Discovery
  discovery: {
    dht: true,
    announce: true,
    mdns: true
  },

  // Services
  enableServices: true,
  enableRouter: false,
  routerWorkers: 0, // 0 = auto (based on CPU cores)

  // AI inference
  ai: {
    enabled: false,
    maxConcurrent: 2,
    maxQueue: 10,
    ollamaUrl: 'http://127.0.0.1:11434',
    models: [],
    timeout: 30000
  },

  // Holesail transport
  holesail: {
    enabled: false,
    seed: null,
    connectorMode: false,
    secure: false
  },

  // Proxy trust (set true when behind a reverse proxy like Caddy/NGINX)
  trustProxy: false,

  // Shutdown
  shutdownTimeoutMs: 10_000,

  // Timeouts (all in milliseconds)
  timeouts: {
    driveReady: 15_000,
    driveUpdate: 30_000,
    driveDownload: 120_000,
    manifestRead: 5_000,
    eagerReplicationRetry: 5_000, // Initial retry delay
    eagerReplicationMaxRetry: 120_000 // Max retry delay
  }
}

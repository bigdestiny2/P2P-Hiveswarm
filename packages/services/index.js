/**
 * p2p-hiveservices — Application-layer services for HiveRelay.
 *
 * Built on top of p2p-hiverelay Core. A HiveServices node is always also
 * a HiveRelay Core node — it inherits seeding, circuit relay, gateway, and
 * proof-of-relay from Core and adds opinionated higher-level services
 * (AI inference, identity, schemas, SLAs, storage CRUD).
 *
 * Operators who only want to contribute availability install p2p-hiverelay
 * alone. Operators who want to offer compute / inference / identity install
 * p2p-hiveservices alongside.
 *
 * Trust surface differs: Core sees encrypted bytes only, Services sees
 * request payloads (LLM prompts, schema data) and processes them.
 */

export { AIService } from './builtin/ai-service.js'
export { IdentityService } from './builtin/identity-service.js'
export { SchemaService } from './builtin/schema-service.js'
export { SLAService } from './builtin/sla-service.js'
export { StorageService } from './builtin/storage-service.js'
export { ZKService } from './builtin/zk-service.js'
export { ArbitrationService } from './builtin/arbitration-service.js'

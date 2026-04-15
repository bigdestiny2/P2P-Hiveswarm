# Ghost Drive Integration (Relay-Side MVP)

This guide shows the fastest path to make Ghost Drive content discoverable and available when the original peer is offline.

## What this enables

- Pin a Ghost Drive key to one or more HiveRelay nodes.
- Publish a replication request to the distributed seeding registry.
- Surface Ghost Drive entries in relay catalogs (`/catalog.json`) for discovery.

## CLI workflow

All write operations require API auth when the relay is configured with `HIVERELAY_API_KEY`.

```bash
export HIVERELAY_API_KEY=your-relay-api-key
```

### 1) Pin a Ghost Drive key on a relay

```bash
hiverelay ghostdrive pin <64-hex-drive-key> \
  --relay http://127.0.0.1:9100 \
  --name "Tom's Shared Files" \
  --description "Public demo folder" \
  --author "tom" \
  --categories ghost-drive,files,public
```

This calls `POST /seed` and stores metadata used by `GET /catalog.json`.

### 2) Pin + publish replication intent to registry

```bash
hiverelay ghostdrive publish <64-hex-drive-key> \
  --relay http://127.0.0.1:9100 \
  --replicas 3 \
  --geo NA,EU \
  --ttl 30
```

This calls:

1. `POST /seed` (local relay pins immediately)
2. `POST /registry/publish` (network replication request)

### 3) Discover Ghost Drive entries

```bash
hiverelay ghostdrive discover \
  --relay http://127.0.0.1:9100 \
  --relay http://utah-relay.example.com:9100 \
  --relay http://singapore-relay.example.com:9100
```

The CLI filters catalog entries by Ghost Drive signals:

- category includes `ghost-drive`, or
- `id` starts with `ghost-drive`, or
- `name` contains `ghost drive`.

## Generic seeding workflow (non-Ghost Drive)

`hiverelay seed` now performs a real API call instead of printing placeholders.

```bash
hiverelay seed <64-hex-key> \
  --relay http://127.0.0.1:9100 \
  --app-id my-app \
  --name "My App" \
  --categories demo,p2p \
  --publish --replicas 2
```

## API contracts used by this workflow

- `POST /seed`
  - required: `appKey`
  - optional metadata: `appId`, `version`, `name`, `description`, `author`, `categories[]`, `privacyTier`
- `POST /registry/publish`
  - required: `appKey`
  - optional: `replicas`, `geo`, `ttlDays`, `maxStorageBytes`, `discoveryKeys[]`, `privacyTier`
- `GET /catalog.json`
  - read-only public catalog for discovery/search

## Integration notes for Ghost Drive app UI

- Add a **Pin to Relay** action that calls `POST /seed`.
- Add a **Publish to Network** action that also calls `POST /registry/publish`.
- Add a **Browse Network** tab that aggregates `/catalog.json` from known relays.


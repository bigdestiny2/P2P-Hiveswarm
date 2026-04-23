# Identity and storage — the anti-pattern that eats your keys

If you're building on HiveRelay and you're tempted to do this:

```js
// DON'T DO THIS
const store = new Corestore(storagePath, {
  primaryKey: identity.getSeed(),
  unsafe: true
})
```

Don't. This document exists because at least one downstream app (PearBrowser)
hit reproducible data loss from this pattern, and the HiveRelay docs used to
suggest it was fine. It is not fine. Here's why, and what to do instead.

## The failure chain

1. **First run.** `identity.json` exists. `identity.getSeed()` returns a
   deterministic seed derived from BIP-39 entropy. Corestore persists its
   `db/LOCK` and `db/primaryKey` using this seed as the primaryKey.

2. **Desync event.** Any of these happens:
   - SIGKILL or unclean shutdown mid-write to `identity.json`
   - Partial filesystem rollback after a crash
   - Pear's `Bare.on('suspend')` teardown hook doesn't fire reliably on
     external SIGTERM/SIGKILL
   - A bug in the app's identity-persistence layer regenerates the seed

3. **Next run.** `identity.getSeed()` returns a new seed (new entropy).

4. **Corestore refuses to open.** It sees stored `primaryKey != provided
   primaryKey` and throws:
   ```
   Another corestore is stored here
   ```

5. **Auto-recovery can't run.** Your app's fallback logic tries to
   `rm -rf` the storage dir and recreate — but rocksdb already holds
   `db/LOCK` in the same process, so `rm` throws `No locks available`.

6. **Manual `rm -rf` is the only way out** — and it destroys the publisher
   keypair. Every drive that was pinned via HiveRelay seed requests is now
   orphaned: you can no longer sign unseed requests for them, and you've
   lost the pubkey those drives were published under.

PearBrowser reproduced this in a single dev session on macOS 15.6.1 / Pear
0.2497 within minutes.

## The correct pattern

```js
// Let Corestore manage its own primaryKey independently.
const store = new Corestore(storagePath)
```

Corestore persists its own primaryKey (a random 32 bytes it generates on
first run, stored alongside the cores). This primaryKey has nothing to do
with your app-managed identity:

- Your identity regenerates? Corestore doesn't care. Every core it already
  has is still loadable, every pinned drive still has the original publisher
  keypair (which, separately, you should persist yourself).
- Corestore's storage corrupts? You lose the cores, but your identity and
  publisher keypair are intact in `identity.json`.
- Unclean shutdown? Corestore's primaryKey is a single small file; if it's
  missing on boot, Corestore regenerates and you lose cached cores (but
  drive content that was pinned on relays is still pullable by public key).

The failure modes are now **independent**. Corrupting one doesn't destroy
the other.

## "But I wanted rotating identity to give a clean store"

If you *really* want a user rotating their identity to drop all their
cached cores — a UX goal some apps have — do it explicitly at the
application layer:

```js
async function rotateIdentity (oldStorePath) {
  // 1. Close the old store cleanly (releases the rocksdb lock)
  await client.destroy()
  await oldStore.close()

  // 2. Wipe the directory (now safe because no handles are open)
  await rm(oldStorePath, { recursive: true, force: true })

  // 3. Generate new identity, create fresh store
  const newIdentity = await generateNewIdentity()
  const newStore = new Corestore(oldStorePath)
  // ... re-open client with new store + identity
}
```

This separates "rotate identity" (a deliberate user action) from "Corestore
boot validation" (a synchronisation check that has no business gating your
identity).

## What about the publisher keypair?

The publisher keypair is what signs `publish` and `unseed` requests. Losing
it means you can no longer control the drives you published. Persist it
separately from Corestore's primaryKey — ideally alongside your app's
identity file, with the same backup semantics as a password:

```js
// In your app's identity module, not HiveRelay's:
const publisherKeypair = {
  publicKey: readFileSync('publisher.pub'),
  secretKey: readFileSync('publisher.sec') // encrypted at rest if possible
}
const client = new HiveRelayClient({ swarm, store, keyPair: publisherKeypair })
```

Back this up. If `publisher.sec` is lost and you didn't export pinned drive
keys somewhere else, those drives are effectively stranded — any relay
that's seeding them will keep seeding, but you can't issue new publishes
under that identity, and your users can't authenticate you as the original
publisher.

The useful mental model:
- **Identity keypair**: who the user is. Backup is up to the app.
- **Publisher keypair**: who wrote this app's content. Backup is critical.
- **Corestore primaryKey**: local cache encryption seed. Not worth backing
  up on its own — regenerating costs a re-sync, not content.

Don't conflate any two of these. Especially don't tie Corestore's primaryKey
to either of the other two. That's the class of bug this doc exists to
prevent.

## Safe recovery pattern for operators hitting the old issue

If you already have apps with the anti-pattern in production:

```js
async function openStoreWithRecovery (storagePath) {
  try {
    return new Corestore(storagePath) // fresh, no primaryKey coupling
  } catch (err) {
    if (err.message.includes('Another corestore')) {
      // The old primaryKey-tied-to-identity story bit us. Rather than
      // force-wipe (which destroys publisher keys), surface clearly:
      throw new Error(
        'Corestore at ' + storagePath + ' is locked to a primaryKey we ' +
        "can't reproduce. See docs/IDENTITY-AND-STORAGE.md for the fix — " +
        'likely you need to migrate off the identity-tied primaryKey by ' +
        'exporting any pinned drive keys you care about, then re-creating ' +
        'storage without `primaryKey: identity.seed`.'
      )
    }
    throw err
  }
}
```

No silent wipe, ever. The user has to make the choice to drop content.

## TL;DR

- `new Corestore(storagePath)` — do this
- `new Corestore(storagePath, { primaryKey: someSeed, unsafe: true })` — don't do this
- Identity, publisher keypair, and Corestore primaryKey are three separate things with three separate backup stories; coupling them creates combinatorial failure modes

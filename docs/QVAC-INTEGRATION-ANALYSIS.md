# Qvac integration analysis + Tether payment strategy

Written from a read of `tetherto/qvac` at `~/Downloads/qvac` (SDK v0.9.0, April 2026).
This is an analysis document for decision-making, not an implementation plan.

## TL;DR

1. **Qvac and HiveRelay don't actually overlap much.** Qvac is a *local-first on-device AI SDK*; HiveRelay is an *always-on P2P availability tier*. The apparent overlap (both touch "AI" and both speak Hyperswarm) is superficial.

2. **Qvac has no payment model at all** in its current codebase — no wallet, no invoice, no billing. Its P2P inference delegation is currently "free / best-effort." This is an opportunity, not a problem: **HiveRelay's payment layer can cleanly plug underneath qvac's delegation mechanism.**

3. **Tether-over-Lightning is the lowest-friction payment pivot.** Keep the existing Lightning infrastructure; swap the unit from sats to USDt via Taproot Assets. Our `lightning-provider.js` scaffold is ~90% reusable.

4. **Qvac's delegation surface is the right integration point.** We don't replace our AIService; we reshape it to become a *qvac-aware* operator endpoint. HiveRelay operators with qvac installed become paid qvac providers.

## Qvac, concretely

### What it is

A cross-platform (Node + Bare + Expo + iOS/Android) SDK for **on-device AI** — LLM, embeddings, speech-to-text, text-to-speech, translation, OCR, diffusion. All powered by native C++ addons (llama.cpp, whisper.cpp, onnx-runtime, stable-diffusion.cpp).

Shipped as 28 monorepo packages; `@qvac/sdk` is the main entry point. Developer API:

```js
import { loadModel, LLAMA_3_2_1B_INST_Q4_0, completion, unloadModel } from '@qvac/sdk'
const modelId = await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelType: 'llm' })
await completion({ modelId, messages: [...] })
```

### P2P surfaces

Three distinct P2P features, each in a different spot in the tree:

1. **`@qvac/registry-server` / `@qvac/registry-client`** — a distributed model registry. Model weights are content-addressed and distributed via Hyperdrive. Think "BitTorrent for AI models." Anyone can host mirrors; clients find them via a shared registry key.

2. **`@qvac/dl-hyperdrive`** — a `BaseDL` subclass that loads model weights from a Hyperdrive instance. This is how `loadModel` can pull weights peer-to-peer rather than from the internet.

3. **Inference delegation** — the important one. `packages/sdk/server/bare/delegate-rpc-client.ts` + `schemas/delegate.ts` + `server/rpc/handlers/provideHandler/connection.ts`. The shape:

   ```ts
   // Schema
   delegateSchema = {
     topic: string,                  // Hyperswarm topic the provider announces on
     providerPublicKey: string,      // pinned provider identity
     timeout?: number,
     healthCheckTimeout?: number,
     fallbackToLocal?: boolean,      // if provider unreachable, run locally
     forceNewConnection?: boolean
   }
   ```

   A qvac client can say "run this inference on provider X" (identified by Hyperswarm pubkey). The wire is bare-rpc over a Hyperswarm connection. Provider verifies health via a heartbeat; client can fall back to local inference if provider is unreachable.

### What's NOT in qvac

No payment, no billing, no invoice, no wallet, no rate limit, no access control on providers. `grep -rln "pay\|lightning\|wallet\|invoice" packages/sdk/` returns zero meaningful hits. The current P2P delegation model is **wide open**: any peer that advertises on a topic can serve any request that finds it.

This isn't a design flaw — qvac is focused on the AI primitives. Payment is out of scope for their SDK. But it means if Tether wants HiveRelay-style monetization, it has to be layered on top, not built in.

## Compared to our `packages/services/builtin/ai-service.js`

| Dimension | HiveRelay AIService | Qvac |
|---|---|---|
| Inference location | Operator hardware (remote) | Device-local by default, P2P-delegatable |
| Backend | Ollama / OpenAI-compatible HTTP | Native C++ addons (llama.cpp, etc.) |
| Model distribution | Operator installs whatever they like | Content-addressed via Hyperdrive registry |
| Transport | Our service-protocol over protomux | bare-rpc over Hyperswarm |
| Access control | Accept-modes, allowlist, SLA contracts | None |
| Payment | Lightning sat-denominated (scaffold, not live) | None |
| Target audience | Server operators, GPU rigs | App developers embedding AI into apps |

**They don't compete — they solve different problems.** HiveRelay's AIService is server-side; qvac is client-side. The question isn't "which wins" but "how do they fit together."

## The integration shape

Three increasingly deep options, each with different operational consequences:

### Option A — Leave HiveRelay alone; apps use qvac directly for AI

Zero code change. HiveRelay operators run storage + circuit relay + HTTP gateway. AI gets handled inside the user's app via `@qvac/sdk`.

- **Pros:** No risk. Qvac gets its AI ecosystem; we get our availability ecosystem.
- **Cons:** HiveRelay operators can't monetize AI. The Services economy story (AI inference as the flagship paid service) goes away. Delete `packages/services/builtin/ai-service.js`, redo `OPERATOR_ECONOMICS.md`.

### Option B — HiveRelay's AIService wraps qvac's delegation surface (RECOMMENDED)

A HiveRelay operator who also installs qvac becomes a qvac *provider*. Our AIService plugin detects qvac and routes `ai.infer` / `ai.embed` calls through qvac's local inference. The client still sees our rate card and pays through HiveRelay's payment layer; qvac handles the model work underneath.

```
Client                      HiveRelay Operator                Model
─────                      ───────────────────                ─────
app.callService('ai',      AIService → qvac.completion({      llama.cpp
  'infer', {modelId,         modelSrc, messages })            ─────
  messages})                  ↓                              (local, fast)
                           HiveRelay meters, bills via
                           payment provider (Lightning/USDt)
```

- **Pros:** Operator still earns on inference. App developer gets a unified rate card (all service calls paid through one channel). Qvac's model distribution + addon performance become HiveRelay's too. Minimal new protocol work.
- **Cons:** Operators need qvac installed alongside HiveRelay (one extra dep). AIService gets restructured.
- **Effort:** ~1 day — AIService loses its Ollama-specific code, gains a qvac adapter.

### Option C — Deep — HiveRelay defers all AI to qvac's P2P delegation

We delete the AIService and our clients use qvac's `delegate(topic, providerPublicKey)` directly to reach HiveRelay operators who've announced as qvac providers. HiveRelay becomes purely a matchmaking / payment / reputation layer — it doesn't host an AI service at all; qvac does.

- **Pros:** Cleanest separation of concerns. Future qvac features (new modalities, better models) arrive free.
- **Cons:** Big API break for existing HiveRelay app developers. Our service protocol gets bypassed for AI — weakens the "one channel, one rate card" story.
- **Effort:** ~2-3 days — delete AIService, update SDK, migrate examples.

**Recommendation: Option B.** It preserves the operator economics story, leverages qvac's actual strengths (on-device + distributed models), and only asks operators to install one extra dep.

## The Tether payment question

You wrote: *"tether over lightning is now possible so we can use that, or tethers payment sdk, needs more thinking."* Here's the thinking.

### Option 1 — Tether-over-Lightning (Taproot Assets)

USDt is now issuable on Lightning via Taproot Assets. This is the same Lightning Network plumbing — invoices, channels, settlement — but the asset being moved is USDt rather than sats.

**What this costs us:** almost nothing architecturally. Our existing `packages/core/incentive/payment/lightning-provider.js` assumes sat amounts; we generalize it to `{ amount, asset: 'USDT' | 'BTC' }`. Invoice encoding stays LN. Operators run LND/CLN same as before but with Taproot Assets support.

**What this buys us:**
- Stable-dollar pricing (no "my AI call cost varied 8% with BTC price")
- Same micropayment granularity Lightning is known for (sub-cent settlement)
- Keeps the "no blockchain for blockchain's sake" posture — just Lightning, just now denominated in USDt
- Fits the existing `incentive/credits/pricing.js` rate card nearly verbatim

**Risks:**
- Taproot Assets is newer than vanilla Lightning; operator availability is thinner
- Not every Lightning wallet speaks Taproot Assets yet; client wallet UX is partial
- Requires LND-with-Taproot-Assets or CLN-with-Taproot-Assets — operational lift for operators

### Option 2 — Tether Wallet SDK (native, multi-chain, mostly TON)

Tether has their own wallet SDK (`@tetherto/wallet` or similar — not directly checked, but inferable from their ecosystem). Chain-agnostic, strong on TON. Uses HTTP + signed transactions, not Lightning-style channels.

**What this costs us:** a lot. Every micropayment is an on-chain transaction (or an L2 settlement batch). Fee floor is meaningfully higher than Lightning. Our per-call billing model (charge 1 sat = $0.0006 per `identity.sign`) doesn't survive — fees would eat margins. Requires batching (e.g. "top up $5 of credits, deduct from balance") which changes the pricing engine.

**What this buys us:**
- Broader wallet compatibility (Tether Wallet users can pay without setting up Lightning)
- Direct alignment with Tether's strategic stack
- Works for users who aren't crypto-native

**Risks:**
- Bigger rewrite. `lightning-provider.js` largely thrown away.
- UX shift from "pay-per-call" to "top up credits" — affects the whole app developer story.

### Option 3 — Both (RECOMMENDED)

The payment surface is already a pluggable provider (`packages/core/incentive/payment/` has a provider abstraction). Ship **two** providers:

- `LightningProvider` (existing, extended with `asset: 'USDT'` for Taproot Assets)
- `TetherWalletProvider` (new, wraps the Tether SDK; uses the credit-top-up model)

Relay operators configure whichever they support. App developers' clients probe which provider the operator offers and use whichever works. For operators who run both, clients prefer Lightning (cheaper micropayments) and fall back to Tether Wallet for users without Lightning.

**Effort:**
- Extending LightningProvider for USDt: ~½ day
- New TetherWalletProvider: ~2 days (mostly wrapping the SDK + credit-top-up flow)
- Client-side probe + fallback: ~½ day
- Total: ~3 days

**Why both:** Lightning gives us the micropayment granularity that makes per-call billing work. Tether Wallet gives us broader wallet compatibility and alignment with Tether's distribution channels. They're not in conflict — the `PaymentProvider` interface in our codebase was designed for this.

## What I'd start with

If you want the smallest durable step, it's this sequence:

1. **Abstract a `PaymentProvider` interface** in `packages/core/incentive/payment/provider.js` (if not already clean enough). Existing `LightningProvider` becomes one implementation; `MockProvider` stays for tests. ~2 hours.

2. **Extend `LightningProvider` to support USDt via Taproot Assets.** Asset-aware invoices + settlement. Most of the work is the invoice decoder — the rest of the pipeline is asset-agnostic. ~4 hours.

3. **Scaffold a `TetherWalletProvider` stub** with the interface wired but the SDK calls stubbed to "not yet implemented." Lets us commit the interface + two-provider architecture without blocking on the SDK details. ~2 hours.

4. **Adapt `AIService` to wrap qvac's `completion` / `loadModel` / `delegate` where present.** Fall back to the existing Ollama path if qvac isn't installed. ~1 day.

5. **Decide on Tether Wallet SDK integration** after (1)-(3) land and we've seen the provider interface work. At that point we have a concrete design to discuss with Tether about which SDK + which chain.

That's ~3 days of work, delivered in a sequence where each step is independently shippable. At the end of step 3, HiveRelay is ready for the Tether pivot architecturally without committing to a specific payment SDK; at the end of step 4, AI is qvac-backed without breaking the existing rate card; at the end of step 5, we have a full Tether strategy.

## Non-obvious things worth knowing

- **Qvac doesn't try to solve availability.** Their P2P delegation assumes providers are online when a client needs them. There's no queueing, no SLA, no retry-when-back-online. HiveRelay's always-on story is additive, not redundant.

- **Qvac's model registry is Hyperdrive-native.** If HiveRelay seeds qvac model registries alongside regular apps, *operators become qvac model CDNs* for free. This is a potentially big operator value-add that doesn't require any code change — operators seed the qvac registry drive key, and qvac clients pulling models see the HiveRelay operator as a fast source.

- **The delegation topic+pubkey addressing in qvac is clean** and slots into HiveRelay's federation model neatly: "follow qvac providers on topic X" is the same primitive as "follow a relay's /catalog.json."

- **Lightning's "no stablecoin" objection is obsolete.** Tether-over-Lightning via Taproot Assets was announced January 2025 and is live. Anyone still arguing "Lightning can only be BTC" hasn't caught up.

## Open questions I can't answer from the code alone

1. **Does Tether want HiveRelay to be a recognized qvac provider**, or is HiveRelay orthogonal? (This affects whether our AIService wraps qvac vs gets deleted.)
2. **What's Tether's preferred payment path for this?** Lightning + Taproot Assets, or their SDK, or something else? The "Tether over Lightning" path is our pick; whether it matches their strategy is a business question, not a code question.
3. **Is there a Tether Pay-for-Compute product or SDK** we should align to, or are we the first ones trying this? Worth asking Paul / Tether Dev relations before committing to an SDK choice.

If you want, I can draft talking-point notes for those three questions.

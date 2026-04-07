# WebView-to-Bare IPC Architecture for P2P Mobile Apps

A technical explainer on why WebViews in mobile P2P apps can't connect
directly to Bare Kit IPC, and what the alternatives are.

Audience: developers building on the Holepunch/Bare stack (Hyperswarm,
Hyperdrive, Autobase) who want to understand the architectural constraints
and available transport options for mobile.

---

## The Question

> "Is there no way to get the IPC client in the WebView to connect directly
> to the Bare IPC? Seems there always needs to be a relay in between. Is it
> just process isolation? Or maybe Bare needs to be the one that spawns the
> WebView?"

Short answer: on iOS, there is always a boundary between the WebView and
Bare. The question is how many hops that boundary costs you. This document
explains the three approaches, why iOS forces the relay pattern, and why
the localhost HTTP bridge is the right solution for mobile.

---

## Architecture Overview

In PearBrowser (and any Bare Kit mobile app), three runtimes coexist on the
device:

```
  ┌──────────────────────────────────────────────────────┐
  │  iOS / Android Device                                │
  │                                                      │
  │  ┌────────────────┐                                  │
  │  │  WKWebView     │  ← Separate OS process           │
  │  │  (WebContent)  │    Renders your P2P app HTML/JS  │
  │  └───────┬────────┘                                  │
  │          │  ???  How does this talk to Bare?          │
  │  ┌───────┴────────┐                                  │
  │  │  React Native  │  ← Main app process (UIKit)      │
  │  │  (JavaScript)  │    Owns the WebView, has IPC     │
  │  └───────┬────────┘                                  │
  │          │  bare-rpc over BareKit.IPC                 │
  │  ┌───────┴────────┐                                  │
  │  │  Bare Worklet  │  ← Background thread             │
  │  │  (Bare runtime)│    Runs Hyperswarm, Hyperdrive,  │
  │  │                │    HTTP proxy, P2P engine         │
  │  └────────────────┘                                  │
  └──────────────────────────────────────────────────────┘
```

The core tension: the WebView process and the Bare worklet thread live in
different security contexts. How you bridge that gap determines your
latency, complexity, and platform compatibility.

---

## The Three Approaches

### Approach 1: postMessage Relay (Current MVP)

```
  WebView               React Native              Bare Worklet
  ──────────            ────────────              ────────────
  window.pear.foo()
    │
    ▼
  ReactNativeWebView
    .postMessage(json) ──→ onMessage(event)
                              │
                              ▼
                           rpc.request(CMD)
                             .send(json) ──────→ RPC handler
                                                    │
                                                    ▼
                                                 process request
                                                    │
                                                    ▼
                                                 req.reply(json)
                           ◄──────────────────────  │
                           resolve Promise
                              │
                              ▼
                           webViewRef.current
                             .injectJavaScript()
    ◄──────────────────────   │
  callback fires
  UI updates
```

**How it works:**

1. The WebView loads with `injectedJavaScript` that creates a `window.pear`
   API object. Each method serializes its arguments to JSON and calls
   `ReactNativeWebView.postMessage()`.

2. React Native's `WebView` component receives the message in its
   `onMessage` handler. RN parses the JSON, determines which RPC command
   to send, and calls `rpc.request(CMD).send(payload)` via bare-rpc.

3. The Bare worklet receives the RPC request, processes it (queries
   Hyperbee, writes to Autobase, etc.), and calls `req.reply(result)`.

4. RN receives the reply, serializes it back to JSON, and injects it
   into the WebView via `injectJavaScript()` to resolve the pending
   Promise.

**Pros:**
- Simple to implement. Standard React Native WebView pattern.
- Works with any WebView configuration.
- No networking involved, just message passing.

**Cons:**
- Three hops: WebView -> RN -> IPC -> Bare (and back).
- Three JSON serialization/deserialization round trips.
- React Native's JS thread is a bottleneck — if RN is busy rendering,
  bridge calls queue up.
- Real-time events (peer count changes, sync updates) require either
  polling from the WebView or RN pushing via injectJavaScript.

### Approach 2: Localhost HTTP/WebSocket (Better, Building Now)

```
  WebView                                    Bare Worklet
  ──────────                                 ────────────
  fetch('http://127.0.0.1:PORT/api/sync/list')
    │                                           │
    └───── TCP loopback (kernel) ───────────────┘
                                                │
                                             bare-http1 server
                                             handles request
                                                │
                                             JSON response
    ┌───── TCP loopback (kernel) ───────────────┘
    │
  Response received
  UI updates


  Real-time (WebSocket):
  ──────────────────────

  new WebSocket('ws://127.0.0.1:PORT/events')
    │                                           │
    └───── TCP loopback (persistent) ───────────┘
                                                │
                                             ws.send({ event: 'peer-count',
                                                       data: { count: 5 } })
    ┌───────────────────────────────────────────┘
    │
  onmessage fires
  UI updates instantly
```

**How it works:**

The Bare worklet already runs a `bare-http1` server on localhost to proxy
hyper:// content for the WebView. The insight: extend that same server with
REST endpoints and a WebSocket upgrade handler, so the WebView talks
directly to Bare without RN in the data path.

1. **Boot sequence:** The Bare worklet calls `server.listen(0, '127.0.0.1')`
   to bind a random available port. It sends the port to RN via the
   existing RPC event: `sendEvent(EVT.READY, { port })`.

2. **Port injection:** RN receives the port in its `rpc.onReady()` handler,
   stores it as `proxyPort`, and passes it to the `<Browser>` component.
   The WebView receives the port through `injectedJavaScript` that sets
   `window.__PEAR_PORT = ${port}`.

3. **API calls:** The `window.pear` shim in the WebView uses `fetch()`:
   ```javascript
   // Inside injectedJavaScript
   window.pear = {
     sync: {
       list: async (app, prefix) => {
         const res = await fetch(
           `http://127.0.0.1:${window.__PEAR_PORT}/api/sync/list?app=${app}&prefix=${prefix}`
         )
         return res.json()
       },
       append: async (app, op) => {
         const res = await fetch(
           `http://127.0.0.1:${window.__PEAR_PORT}/api/sync/append`,
           { method: 'POST', headers: {'Content-Type': 'application/json'},
             body: JSON.stringify({ app, op }) }
         )
         return res.json()
       }
     }
   }
   ```

4. **Real-time events:** A WebSocket connection on the same port pushes
   events (peer count, sync updates, errors) directly to the WebView:
   ```javascript
   const ws = new WebSocket(`ws://127.0.0.1:${window.__PEAR_PORT}/events`)
   ws.onmessage = (e) => {
     const { event, data } = JSON.parse(e.data)
     if (event === 'peer-count') updatePeerUI(data.count)
     if (event === 'sync-update') refreshData()
   }
   ```

**Pros:**
- Only one hop: WebView -> localhost -> Bare. RN is not in the data path.
- Single JSON serialization round trip.
- WebSocket provides true real-time push events.
- Uses standard web APIs (fetch, WebSocket) — no framework-specific code.
- The same pattern works on iOS, Android, and desktop.

**Cons:**
- Localhost networking goes through the kernel TCP stack (still fast,
  ~1-3ms round trip, but not zero-copy).
- CORS: the WebView's origin is either `null` (for injected HTML) or
  `http://127.0.0.1:PORT`. The bare-http1 server must set
  `Access-Control-Allow-Origin: *` on responses. (PearBrowser already
  does this in hyper-proxy.js.)
- Port must be passed from RN to the WebView. This is a one-time
  injection at WebView creation time, not ongoing overhead.

### Approach 3: Native IPC Injection (Desktop Only)

```
  Electron / Electrobun                     Bare / Node
  ────────────────────                      ──────────
  BrowserWindow with preload.js
    │
    │  contextBridge.exposeInMainWorld(
    │    'pear', { sync: { list: (...) => ipcRenderer.invoke('sync:list', ...) } }
    │  )
    │
    ▼
  window.pear.sync.list()
    │
    ▼
  ipcRenderer.invoke()  ──→  ipcMain.handle()  ──→  Bare/Autobase
                         ◄──  result               ◄── result
  Promise resolves
```

**How Peersky Desktop does it:**

On desktop, the application process controls everything. Electron (or
Electrobun) creates the BrowserWindow AND runs the backend code in the
same Node.js/Bare process. The preload script uses `contextBridge` to
expose APIs directly into the WebView's JavaScript context.

Electron's `protocol.handle()` can also intercept custom URL schemes
(`pear://`) and route them to the backend without any HTTP server.

The result: zero network hops. The WebView's `window.pear` calls go
through V8 function calls and structured clone, not serialization.

**Why it does not work on mobile:**

iOS enforces a strict rule: **only the main UIKit thread can create and
configure WKWebView instances.** A Bare worklet runs as a background
thread. It cannot:

- Create a WKWebView (UIKit crashes if you touch it off the main thread)
- Inject scripts into a WKWebView it did not create
- Access WKWebView's JavaScript context directly
- Share memory with the WKWebView process

Even if Bare could create a WKWebView, Apple runs WebViews in a separate
**WebContent process** with its own address space. There is no shared
memory, no named pipes, no Unix domain sockets between the WebContent
process and the app process — only the message passing API that Apple
provides (which is what `postMessage` and `evaluateJavaScript` use under
the hood).

**Platform breakdown:**

| Platform | Can Bare spawn the WebView? | Direct IPC possible? |
|----------|----------------------------|---------------------|
| iOS      | No (UIKit main thread only) | No (process isolation) |
| Android  | Partially (custom WebView possible) | Possible via addJavascriptInterface |
| Electron | Yes (BrowserWindow) | Yes (contextBridge, protocol.handle) |
| Electrobun | Yes | Yes |

**Future possibility:** A `bare-webview` native module could wrap platform-
specific WebView creation. On Android, it could use `addJavascriptInterface`
to inject a Java bridge object that calls directly into Bare. On iOS, it
would still need to marshal calls through the main thread, so the benefit
over localhost HTTP would be marginal.

---

## Why iOS Forces the Relay Pattern

This section explains the OS-level constraints that make direct IPC
impossible on iOS. Understanding these constraints prevents wasted effort
trying to bypass them.

### WKWebView Process Architecture

```
  ┌─────────────────────────────┐
  │  App Process (your app)     │
  │                             │
  │  ┌───────────────────────┐  │
  │  │ Main Thread (UIKit)   │  │
  │  │  - Creates WKWebView  │  │
  │  │  - Handles UI events  │  │
  │  │  - Receives messages   │  │
  │  └───────────┬───────────┘  │
  │              │               │
  │  ┌───────────┴───────────┐  │
  │  │ Background Thread     │  │
  │  │  - Bare Worklet       │──│──── Cannot touch UIKit
  │  │  - Hyperswarm          │  │     Cannot access WKWebView
  │  │  - bare-http1 server  │  │     CAN listen on localhost
  │  └───────────────────────┘  │
  └──────────────┬──────────────┘
                 │ XPC (Apple private)
  ┌──────────────┴──────────────┐
  │  WebContent Process         │
  │  (separate OS process)      │
  │                             │
  │  - Runs JavaScript engine   │
  │  - Renders HTML/CSS         │
  │  - Sandboxed file system    │
  │  - CAN do localhost HTTP    │
  │  - CANNOT access app memory │
  │  - CANNOT open named pipes  │
  │  - CANNOT do shared memory  │
  └─────────────────────────────┘
```

### The Five Constraints

1. **WKWebView is a separate OS process.** Apple moved web rendering out of
   the app process starting in iOS 8. The WebContent process has its own
   virtual memory space. There is no `mmap`, no shared buffer, no direct
   pointer passing between your app and the WebView's JS engine.

2. **Only the main thread can create WKWebView.** UIKit is not thread-safe.
   Calling any UIKit API from a background thread (including the Bare
   worklet thread) is undefined behavior and will crash. The Bare worklet
   cannot create, configure, or inject scripts into a WKWebView.

3. **Message passing goes through Apple's XPC.** When you call
   `evaluateJavaScript()` or receive a `postMessage`, the data crosses an
   XPC boundary — Apple's inter-process communication mechanism. This is a
   kernel-mediated channel. You cannot replace it with something faster
   without jailbreaking.

4. **No Unix domain sockets between WebContent and app.** The WebContent
   process sandbox does not allow opening arbitrary Unix domain sockets or
   named pipes. The only networking it can do is standard TCP/UDP (which
   includes localhost).

5. **No `addJavascriptInterface` equivalent.** Android lets you inject a
   Java object directly into the WebView's JS context via
   `addJavascriptInterface()`. iOS has no equivalent. The only way to
   communicate is `postMessage` (async, serialized) or `evaluateJavaScript`
   (async, string-based).

### What IS Allowed

Despite all the restrictions, the WebContent process CAN make standard
HTTP and WebSocket connections to `127.0.0.1`. This is how the localhost
bridge works — it uses the one communication channel that both the
WebView sandbox and the Bare worklet have access to: the TCP loopback
interface.

---

## The Localhost Solution in Detail

This is the recommended architecture for mobile P2P apps. Here is exactly
how it works, step by step.

### Boot Sequence

```
  Time
   │
   │  1. App launches
   │     App.tsx creates Worklet(), calls worklet.start()
   │
   │  2. Bare worklet boots
   │     backend/index.js runs:
   │       - Corestore → ready
   │       - Hyperswarm → created
   │       - createHyperProxy(hyperFetch) → server created
   │       - server.listen(0, '127.0.0.1') → OS assigns random port
   │
   │  3. Worklet sends READY event
   │     sendEvent(EVT.READY, { port: 49152 })
   │     This is an RPC request from worklet → RN
   │
   │  4. React Native receives port
   │     rpc.onReady((port) => setProxyPort(port))
   │     RN now knows: Bare is listening on 127.0.0.1:49152
   │
   │  5. Browser component renders WebView
   │     <WebView source={{ uri: webViewUrl }} />
   │     webViewUrl = 'http://127.0.0.1:49152/hyper/KEY/index.html'
   │
   │  6. WebView loads app HTML from Bare's HTTP server
   │     Bare fetches content from Hyperdrive, serves via bare-http1
   │     WebView renders the P2P app
   │
   │  7. App calls window.pear API
   │     fetch('http://127.0.0.1:49152/api/sync/list?app=pos&prefix=products!')
   │     Goes directly to Bare — RN is not involved
   │
   ▼
```

### Request Flow (Reads)

```
  P2P App (in WebView)                  Bare Worklet (bare-http1)
  ─────────────────────                 ─────────────────────────

  const products = await
    window.pear.sync.list('pos', 'products!')

  // window.pear shim expands to:
  fetch('http://127.0.0.1:49152/api/sync/list?app=pos&prefix=products!')
         │
         │  TCP loopback
         │  (kernel routes to same device, ~0.1ms)
         │
         ▼
                                        HTTP request arrives at bare-http1
                                        Route: GET /api/sync/list
                                        Parse query: app=pos, prefix=products!
                                        │
                                        ▼
                                        Query local Hyperbee view:
                                          bee.createReadStream({
                                            gte: 'products!',
                                            lt:  'products"'
                                          })
                                        │
                                        ▼
                                        Collect results, serialize to JSON
                                        res.end(JSON.stringify({ items: [...] }))
         │
         │  TCP loopback
         │
         ▼
  Response: { items: [{ key: 'products!1', value: {...} }, ...] }
  UI renders product list
```

### Request Flow (Writes)

```
  P2P App (in WebView)                  Bare Worklet
  ─────────────────────                 ────────────

  await window.pear.sync.append('pos', {
    type: 'product:create',
    data: { id: 'prod_99', name: 'Espresso', price_cents: 350 }
  })

  // Expands to:
  fetch('http://127.0.0.1:49152/api/sync/append', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app: 'pos',
      op: { type: 'product:create', data: {...} }
    })
  })
         │
         ▼
                                        HTTP POST /api/sync/append
                                        Parse body
                                        │
                                        ▼
                                        Append to local Autobase writer:
                                          writer.append(op)
                                        │
                                        ▼
                                        Apply function runs:
                                          bee.put('products!prod_99', data)
                                        │
                                        ▼
                                        Hyperswarm replicates to peers
                                        res.end(JSON.stringify({ ok: true }))
         │
         ▼
  Write confirmed
  Optionally refresh data or wait for WebSocket event
```

### Real-Time Events via WebSocket

```
  P2P App (in WebView)                  Bare Worklet
  ─────────────────────                 ────────────

  const ws = new WebSocket(
    'ws://127.0.0.1:49152/events'
  )
         │
         │  TCP handshake + WebSocket upgrade
         │
         ▼
                                        ws connection established
                                        Add to event subscribers list

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)      // Later, a new peer connects:
    // handle event                     // swarm.on('connection', ...)
  }                                     //   peerCount++
                                        //   broadcast to all WS clients:
                                        //   ws.send(JSON.stringify({
                                        //     event: 'peer-count',
         │                              //     data: { count: 5 }
         │  WebSocket push              //   }))
         │
         ▼
  onmessage fires:
    { event: 'peer-count', data: { count: 5 } }
  Update peer count UI instantly

                                        // A sync update arrives from a peer:
                                        // autobase.on('update', ...)
                                        //   ws.send({ event: 'sync-update',
         │                              //     data: { app: 'pos' } })
         │  WebSocket push
         │
         ▼
  onmessage fires:
    { event: 'sync-update', data: { app: 'pos' } }
  Re-fetch product list to show new data
```

### CORS and Security Considerations

The Bare HTTP server must include CORS headers because the WebView's
origin (`http://127.0.0.1:PORT`) is making requests to itself. In
practice, since both the origin and the server are on localhost, CORS
is straightforward:

```javascript
// In bare-http1 request handler
res.setHeader('Access-Control-Allow-Origin', '*')
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
```

Security notes:
- The server binds to `127.0.0.1`, not `0.0.0.0`. It is not reachable
  from other devices on the network.
- The random port (assigned by the OS via `listen(0)`) makes it harder
  for other apps to guess and connect.
- For additional security, you could require a one-time token passed from
  RN to the WebView and included in API requests as a header.

---

## Performance Comparison

| Metric | postMessage Relay | Localhost HTTP | Direct IPC (Desktop) |
|---------------------|-------------------|----------------|----------------------|
| Hops | 3 (WV->RN->IPC->Bare) | 1 (WV->HTTP->Bare) | 0 (shared context) |
| Typical latency | ~5-10ms | ~1-3ms | <1ms |
| Serialization | JSON x3 | JSON x1 | Buffer/structured clone |
| Real-time events | Poll or injectJS | WebSocket push | Direct callback |
| RN thread required | Yes (bottleneck) | No (only at boot) | N/A |
| Works on iOS | Yes | Yes | No |
| Works on Android | Yes | Yes | Possible |
| Works on Desktop | Yes | Yes | Yes |
| Standard web APIs | No (RN-specific) | Yes (fetch, WS) | No (Electron-specific) |

The latency difference matters for interactive apps. A POS system scanning
barcodes and looking up products benefits from 1-3ms lookups (localhost)
versus 5-10ms (postMessage relay). For bulk operations (loading 100
products at startup), the difference compounds.

The serialization overhead is the more significant factor. With postMessage,
data is serialized to JSON three times: once in the WebView, once crossing
RN's bridge, and once crossing IPC to Bare. With localhost HTTP, data is
serialized once in the WebView and deserialized once in Bare. The Bare
HTTP server writes the response directly to the socket.

---

## Recommendations

### For Mobile Apps (iOS + Android)

Use **localhost HTTP/WebSocket** (Approach 2). It gives you:
- Direct WebView-to-Bare communication, no RN bottleneck
- Real-time push via WebSocket
- Standard web APIs that work in any WebView
- A single transport that works on both iOS and Android

### For Desktop Apps (Electron, Electrobun)

Use **direct IPC injection** (Approach 3). You control the process model,
so take advantage of it:
- `contextBridge` for zero-serialization API calls
- `protocol.handle()` for custom URL scheme interception
- Preload scripts for secure API surface

### For Cross-Platform Libraries

Build on **Approach 2**. Localhost HTTP works on every platform (iOS,
Android, Electron, Electrobun). If you build your `window.pear` shim
against localhost HTTP, it works everywhere without platform-specific
code.

On desktop, you can optionally swap the transport to direct IPC for
better performance, but localhost HTTP is a perfectly acceptable
baseline even on desktop.

### The Key Insight

**The `window.pear` API surface stays the same regardless of transport.**
App developers call `window.pear.sync.list()` and don't care whether it
goes through postMessage, localhost HTTP, or direct IPC. The transport
is an implementation detail of the platform layer.

```
  App code:
    const items = await window.pear.sync.list('pos', 'products!')

  Transport (invisible to the app):
    Mobile:   fetch('http://127.0.0.1:PORT/api/sync/list?...')
    Desktop:  ipcRenderer.invoke('sync:list', 'pos', 'products!')
    Future:   direct JS binding if bare-webview lands
```

This means apps are portable across platforms without changes. Write
once, run on PearBrowser (mobile), Peersky Desktop, or any future
Bare-based runtime.

---

## Summary

The question comes down to process boundaries. On desktop, the app
controls everything and can inject APIs directly. On mobile, Apple (and
to a lesser extent Google) enforce process isolation between the WebView
and the app for security reasons. You cannot bypass this.

But you can minimize its cost. The localhost HTTP bridge reduces the
communication path from three hops (WebView -> RN -> IPC -> Bare) to one
hop (WebView -> localhost -> Bare), removes React Native from the hot
path entirely, and gives you WebSocket for free. It uses standard web
APIs, works on every platform, and keeps the `window.pear` interface
identical for app developers.

```
  Before (postMessage relay):

    WebView ──postMessage──→ React Native ──bare-rpc──→ Bare Worklet
    WebView ◄──injectJS──── React Native ◄──bare-rpc─── Bare Worklet

  After (localhost HTTP):

    WebView ──fetch/ws──→ Bare Worklet (bare-http1 on 127.0.0.1)
    WebView ◄──ws push─── Bare Worklet
```

React Native still matters — it creates the WebView, passes the port,
and handles native UI (navigation bar, status bar). But it is no longer
in the data path between the app and the P2P engine. That is the win.

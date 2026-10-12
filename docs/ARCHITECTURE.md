# Architecture

```
                         ┌──────────────────────── Node backend (one process) ────────────────────────┐
 Browser A ──HTTPS──────▶│ Fastify                                                                     │
 (React SPA)  ──WSS /ws─▶│  ├─ Signaling: SessionManager (pairing, approval, relay, expiry)           │
     ▲                   │  ├─ Share API: ShareService (create/upload/finalize/read/delete/cleanup)  │──▶ BlobStore
     │ WebRTC data       │  ├─ /api/config, /api/health                                               │    ├─ local filesystem
     │ channel (DTLS)    │  └─ static frontend (production)                                           │    └─ S3-compatible
     ▼                   └─────────────────────────────────────────────────────────────────────────────┘
 Browser B
```

- **Quick Transfer:** signaling only introduces the browsers; files flow peer-to-peer (or via an optional TURN relay).
- **Share Files:** browsers encrypt before upload and decrypt after download; the server stores ciphertext.

**Serverless profile (Vercel).** The same Fastify app runs as one function behind `/api/*` (`src/server/vercel.ts`); the CDN serves the frontend. Because instances share no memory, signaling uses HTTP polling with its state in Redis (`PollingSignaling`), share metadata and capacity counters move to Redis (`KvMetaStore`, `KvUsageTracker`), and ciphertext goes to a private Vercel Blob store (`VercelBlobStore`). Expiry is enforced on every read; due packages are swept on traffic and by a daily cron job. See [DEPLOYMENT.md](DEPLOYMENT.md#vercel).

## Source layout

```
src/
  shared/          Code both sides agree on: constants, id/code formats, base64url,
                   signaling schemas, share API contract + layout math.
  server/
    config.ts      Environment parsing and validation (sizes, durations, TURN, storage).
    app.ts         buildApp(): wires everything; no listening (testable).
    index.ts       Process entry, graceful shutdown.
    vercel.ts      Vercel function entry (one app instance per function instance).
    security/      Rate limiter, origin policy, security headers/CSP.
    kv/            KvStore: in-memory and Upstash Redis (REST) implementations.
    signaling/     SessionManager + WebSocket route; PollingSignaling + HTTP routes (Redis); ICE/TURN.
    shares/        ShareService (lifecycle, quota, expiry, cleanup, reconcile), KvUsageTracker, HTTP routes.
    storage/       BlobStore interface; LocalBlobStore (atomic writes), S3BlobStore (lazy SDK),
                   VercelBlobStore (private store, write budget) and KvMetaStore (metadata in Redis).
    util/          KeyedRwLock (per-share readers/writer lock).
  client/
    app/           App root, providers (theme, runtime config), shell, hooks.
    brand/         Vector logo geometry, logo components, hero mark, intro, Notea attribution.
    icons/         Custom icon family.
    i18n/          English + Macedonian catalogs, ICU-style plural formatter.
    lib/           Formatting, files, device labels, clipboard, QR (SVG + PNG), HTTP, downloads.
    transfer/      Quick Transfer: protocol, TransferEngine, PeerLink, signaling clients (WebSocket,
                   HTTP polling), QuickSession.
    share/         Share Files: crypto, manifest/layout, API, ShareCreator, ShareRetriever.
    features/      Composite UI for the flows (pairing ticket, progress, offers, file panes).
    ui/            Design-system primitives (Button, Dialog, Toast, ProgressBar, QrCode, QrActions…).
    screens/       Routes: Home, Send, Receive, Join, JoinCode, Share, Recipient, NotFound.
tests/             Vitest unit + integration (Node and jsdom).
e2e/               Playwright end-to-end against the production build.
```

## Separation of concerns

UI components never touch WebRTC, crypto or storage directly. Each flow has one framework-agnostic "store" class with explicit phases and immutable snapshots, and React subscribes through `useSyncExternalStore`:

| Store            | Owns                                                           | Phases                                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QuickSession`   | signaling socket, `PeerLink`, `TransferEngine`, received files | `idle → creating-session → waiting-for-peer → [approval-required] → peer-connected → connecting → connected → awaiting-acceptance → transferring → completed` (+ `joining`, `awaiting-approval` for guests; `rejected`, `cancelled`, `expired`, `disconnected`, `failed`) |
| `ShareCreator`   | selection, key, upload pipeline, owner token, status polling   | `selecting-files → awaiting-confirmation → encrypting → uploading → finalizing → ready-to-share → accessed → expired` (+ `deleting`, `deleted`, `failed`)                                                                                                                 |
| `ShareRetriever` | key, manifest, chunk cache, per-file downloads, zip            | `opening-share → fetching-package → decrypting → ready-to-download` (+ `failed`; per file `idle → downloading → saved \| failed`)                                                                                                                                         |

`useOwnedStore` creates a store inside an effect and disposes it on unmount. React StrictMode's dev-only double mount therefore never leaves a disposed store in use. A generation counter in `QuickSession` drops late callbacks from torn-down connections.

The public Quick Transfer phase is derived (`derivePhase`): the connection phase, refined by the active transfer's status once connected. Connection-level and transfer-level states cannot contradict each other.

## Data flows

**Quick Transfer**

1. Host opens `/send` or `/receive` → `create-session` → QR + code.
2. Guest opens `/j/<id>` or types the code → `join-session` (→ host approval when joining a sending host by code).
3. Host offers, guest answers, ICE trickles through signaling; the negotiated data channel opens; both send `hello`.
4. Sender `offer` → receiver accepts → chunks with backpressure → `file-end`/`done` → receiver `complete`.
5. Either side can cancel, send more over the same connection, or leave (`bye`).

**Share Files**

1. Select files → limits checked locally → confirmation dialog.
2. Generate the secret, derive keys, build and encrypt the manifest, `POST /api/shares` (reserves quota).
3. Three workers: read the plaintext chunk → encrypt → `PUT` with retries (identical bytes on retry).
4. `finalize` → link `…/s/<id>#<secret>` → QR, actions, status polling.
5. Recipient: `GET` info + manifest → decrypt and validate → per file: fetch the covering chunks (window of 3, small LRU cache) → decrypt → assemble a Blob → save. "Download all" streams the files into a stored zip.

## Server internals

- `SessionManager` is pure logic behind a tiny `SignalingPeer` interface (unit-tested with fake peers and fake timers). The WebSocket route adds origin checks, rate limits, schema validation and heartbeats.
- `ShareService` keeps an in-memory index of package metadata (rebuilt from storage on start) for quota accounting. `meta.json` in storage is the source of truth. A per-share readers/writer lock lets chunk writes run in parallel while finalize, delete and cleanup are exclusive, so a late chunk write can never resurrect deleted data.
- Cleanup runs every `CLEANUP_INTERVAL`; every 12th run also reconciles storage (orphans without metadata older than 15 minutes are deleted). In the serverless profile, `consistentReads` re-reads metadata from Redis on every request, requests trigger a sweep of due packages, and `GET /api/cron/cleanup` reconciles daily. Background work (access counting, expiry) is handed to the platform's `waitUntil`.

## Testing strategy

| Layer           | Tooling                                         | Highlights                                                                                                                                       |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure logic      | Vitest (Node)                                   | protocol codecs, engine with simulated bandwidth, crypto, layout, i18n parity, formatters                                                        |
| Server          | Vitest (Node) + real HTTP/WebSocket             | config, limits, session state machine, share lifecycle with fake clock, API, signaling                                                           |
| Client ↔ server | Vitest (jsdom)                                  | real `ShareCreator`/`ShareRetriever` against the real server: no key/plaintext/name leaks, tampering, expiry, cleanup after failed upload        |
| UI              | Testing Library (jsdom)                         | home, routing, language switch, file selection, every QR action outcome                                                                          |
| End to end      | Playwright + Chrome, production build           | real WebRTC transfers with hash checks, clipboard QR decode, share after sender closes, expiry, deletion, errors, 7 viewports, axe accessibility |
| Storage         | Vitest against an S3-compatible server (opt-in) | adapter contract + share lifecycle                                                                                                               |

# Protocols

preprati. uses three protocols:

1. **Signaling** (WebSocket or HTTP polling, JSON) — helps two browsers find each other.
2. **Transfer** (WebRTC data channel) — carries file names and file bytes for Quick Transfer.
3. **Share package** (HTTPS + client-side encryption) — stores encrypted packages for Share Files.

All message schemas live in `src/shared/` and `src/client/transfer/protocol.ts` and are validated on receipt.

---

## 1. Signaling — `wss://<host>/ws`

JSON text frames only (binary frames are rejected). Max message size `WS_MAX_MESSAGE_SIZE` (64 KiB). Messages are validated with zod (`src/shared/signaling.ts`); invalid messages get `{type:"error",code:"invalid-message"}` and the 5th strike closes the socket with code `4400`.

### Client → server

| Message                                                                                   | Purpose                                                                                                                                |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `{type:"create-session", role:"sender"\|"receiver", device:{label}}`                      | Host creates a session.                                                                                                                |
| `{type:"join-session", target:{via:"link",sessionId}\|{via:"code",code}, device:{label}}` | Guest joins with the QR/link capability or the 6-character code.                                                                       |
| `{type:"approve-peer"}` / `{type:"decline-peer"}`                                         | Host decides about a device that joined **by code** while the host is **sending**.                                                     |
| `{type:"signal", payload}`                                                                | Relayed to the other member once paired. `payload` is `{kind:"description",description:{type,sdp}}` or `{kind:"candidate",candidate}`. |
| `{type:"leave-session"}`                                                                  | Leave explicitly (closing the socket does the same).                                                                                   |
| `{type:"ping"}`                                                                           | Liveness; answered with `pong`.                                                                                                        |

### Server → client

`session-created` (id, code, role, `expiresAt`, `iceServers`), `session-joined` (role, host device, `awaitingApproval`, `iceServers`), `peer-joined` (device, `via`, `needsApproval`), `peer-approved`, `peer-declined`, `signal`, `peer-left`, `session-expired`, `session-closed` (`lifetime-exceeded` \| `server-shutdown`), `error` (`invalid-message`, `rate-limited`, `session-not-found`, `session-expired`, `session-full`, `already-in-session`, `not-in-session`, `not-allowed`, `server-busy`, `internal`), `pong`.

### Session lifecycle (server)

```
waiting ──link join──────────────▶ paired
waiting ──code join (host receives)▶ paired
waiting ──code join (host sends)──▶ pending-approval ──approve──▶ paired
                                                     └─decline──▶ waiting
waiting ──SESSION_PAIRING_TTL──▶ expired (destroyed, both sides told)
any ──either side leaves──▶ destroyed (other side gets peer-left)
any ──SESSION_MAX_LIFETIME──▶ destroyed (session-closed)
```

- Session ids are 128-bit random (base64url, 22 chars) and act as the link capability in `/j/<id>`.
- Pairing codes are 6 characters from `ABCDEFGHJKMNPQRSTVWXYZ23456789` (no 0/O/1/I/L/U), drawn with rejection sampling. Wrong codes count towards `RATE_LIMIT_JOIN_FAILURES` per IP.
- The pairing TTL only applies while waiting. Once paired, nothing time-boxes an ongoing transfer (apart from the generous `SESSION_MAX_LIFETIME`, after which the existing peer-to-peer connection keeps working anyway).
- A session has exactly two members. Relaying starts only in `paired`.
- ICE servers are delivered per session. With `TURN_SECRET`, TURN credentials follow the TURN REST convention (`username = "<expiry>:<opaque>"`, `credential = base64(HMAC-SHA1(secret, username))`).

### Signaling over HTTP (serverless deployments)

On serverless hosts (`SIGNALING_TRANSPORT=http`; the default on Vercel) the same messages travel over plain HTTP. `/api/config` tells the browser which transport to use (`quickTransfer.signaling`).

| Request                                                               | Purpose                                                                                               |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /api/signal/connect` → `201 {connectionId, token}`              | Opens a connection. `token` is 256-bit random; the server keeps only its SHA-256.                     |
| `POST /api/signal/send` (body: a client message) → `{messages}`       | Handles one message and returns anything already queued for this connection.                          |
| `GET /api/signal/poll` → `{messages}`                                 | Returns and clears the connection's inbox, after applying expiry and departure rules.                 |
| `POST /api/signal/disconnect` (body: `{connectionId, token}`) → `204` | Leaves for good. Sent with `navigator.sendBeacon` on `pagehide`, so the body carries the credentials. |

`send` and `poll` authenticate with `Authorization: Bearer <token>` and `X-Signal-Connection: <connectionId>`. `send` carries `X-Signal-Seq`, a per-connection message number: a retried request whose response was lost is not handled twice.

Session state lives in Redis with a TTL on every key (connection, inbox, session, guest slot, approval flag, pairing code). There are no server timers: pairing expiry and a vanished peer are detected when the remaining device polls. A connection that hasn't polled for 150 s counts as gone, and the other device gets `peer-left`. The client polls every 0.4 s while messages flow, every 1.5 s while idle, and every 5 s once the data channel is open.

### Who offers

The **host** always creates the WebRTC offer; the guest answers. Remote ICE candidates arriving before the remote description are queued. Both sides create the same pre-negotiated data channel (`negotiated: true, id: 0, ordered`), so there is no `ondatachannel` race.

---

## 2. Transfer protocol (data channel), version 1

One reliable, ordered `RTCDataChannel`. Two frame kinds:

### Control messages (UTF-8 JSON text)

| `t`                 | Direction         | Fields                                                                                                               |
| ------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `hello`             | both              | `v` (protocol version), `maxFrame` (largest frame accepted)                                                          |
| `offer`             | sender → receiver | `id` (transfer id), `tag` (random uint32), `files[]` (`index`, `name`, `size`, `type`, `lastModified`), `totalBytes` |
| `accept` / `reject` | receiver → sender | `id`                                                                                                                 |
| `file-end`          | sender → receiver | `id`, `index`, `size` — after the last chunk of each file                                                            |
| `done`              | sender → receiver | `id` — after the last `file-end`                                                                                     |
| `progress`          | receiver → sender | `id`, `bytes` — cumulative bytes received (every ≥200 ms or 2 MiB)                                                   |
| `complete`          | receiver → sender | `id` — everything received and verified                                                                              |
| `cancel`            | both              | `id`, `reason` (`user` \| `error`)                                                                                   |
| `bye`               | both              | leaving on purpose (so the other side can say "ended" instead of "lost")                                             |

Offers are validated strictly: indices `0..n-1` in order, sizes summing to `totalBytes`, at most 1000 files, names ≤ 1024 chars. Received names are sanitized before display or download (`sanitizeFileName`).

### Chunk frames (binary)

```
offset  size  field
0       1     frame type (0x01 = file chunk)
1       1     reserved (0)
2       2     file index (uint16, big-endian)
4       4     transfer tag (uint32, big-endian)
8       4     sequence number within the file (uint32, big-endian)
12      n     payload, 1..(maxFrame − 12) bytes
```

The receiver accepts a chunk only if the tag matches the active transfer, the file index is the current file, the sequence number is the next expected one, and the file would not exceed its announced size. Chunks with a foreign tag (e.g. still in flight after a cancel) are ignored; anything else inconsistent aborts the transfer with `cancel(error)` → `protocol-error`. `file-end` must match the exact byte count.

### Flow and backpressure

```
sender                                receiver
  ── hello ───────────────────────────▶
  ◀────────────────────────────── hello ──
  ── offer ───────────────────────────▶  (user decides)
  ◀──────────────────── accept | reject ──
  ── chunk … chunk, file-end (per file) ▶
  ◀────────────── progress (periodic) ──
  ── done ────────────────────────────▶
  ◀──────────────────────────── complete ──
```

- Max frame: 64 KiB, or less if the peer or the SCTP association (`pc.sctp.maxMessageSize`) says so.
- Files are read in 1 MiB blocks with one block of read-ahead.
- The sender pauses whenever `bufferedAmount` exceeds 4 MiB and resumes at `bufferedamountlow` (threshold 1 MiB), with a polling fallback.
- Sender progress shows bytes **acknowledged by the receiver**, not bytes queued locally.
- The receiver folds chunks into `Blob`s every 8 MiB, so large files are handed to the browser's blob storage instead of piling up as JavaScript arrays. Blobs use `application/octet-stream`, never the peer-supplied MIME type.
- Not implemented: resuming an interrupted transfer. A dropped connection fails the transfer cleanly and discards partial data.

---

## 3. Share package format, version 1

### Keys

```
secret  = 32 random bytes (crypto.getRandomValues), base64url in the URL fragment
base    = HKDF-SHA-256(secret, salt = "preprati.share.v1")
content = HKDF info "content"  → AES-256-GCM key (file chunks)
manifest= HKDF info "manifest" → AES-256-GCM key (file list)
```

Share link: `https://<host>/s/<share id>#<secret>`. The fragment is never sent in HTTP requests; pages set `Referrer-Policy: no-referrer`.

### Layout

All files are concatenated into one plaintext stream (file 1, file 2, …) and cut into fixed-size chunks of `chunkBytes` (server setting `SHARE_CHUNK_SIZE`, default 4 MiB). The server therefore learns only the total size, not the number or sizes of files.

Each chunk `i` of `n` is sealed independently:

```
chunk_i = IV(12 random bytes) ‖ AES-256-GCM(content, IV, plaintext_i, AAD = "preprati/v1/chunk/<i>/<n>") ‖ tag(16)
```

Binding the index and the total count into the AAD makes reordering, substitution and truncation fail authentication. A fresh random IV per encryption avoids nonce reuse even if a chunk is re-encrypted.

### Manifest (encrypted)

```json
{
  "v": 1,
  "chunkBytes": 4194304,
  "chunkCount": 3,
  "totalBytes": 9000000,
  "createdAt": 1791744759225,
  "files": [{ "name": "report.pdf", "type": "application/pdf", "size": 8000000, "lastModified": 0, "offset": 0 }, …]
}
```

Sealed with the manifest key and AAD `"preprati/v1/manifest"`, after padding the JSON with spaces to a 512-byte boundary. On decryption the client checks contiguous offsets, the size sum, `chunkCount = ceil(totalBytes / chunkBytes)` and agreement with the server's `chunkCount`/`cipherBytes`. Every downloaded chunk must authenticate and have exactly the expected plaintext length. A file is handed to the browser only after all of its chunks passed.

---

## 4. HTTP API

All responses are JSON unless noted, with `Cache-Control: no-store`. Errors: `{ "error": { "code", "message", "retryAfterSeconds?" } }`.

| Method & path                       | Auth  | Description                                                                                                                                                             |
| ----------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/config`                   | —     | Public runtime config: limits, TTLs, whether sharing is available (and why not), attribution URL.                                                                       |
| `GET /api/health`                   | —     | `{status, signaling, share}`; 503 when storage is unhealthy.                                                                                                            |
| `POST /api/shares`                  | —     | Reserve a package: `{chunkBytes, chunkCount, cipherBytes, manifestBytes}` → `201 {id, ownerToken, uploadDeadline}`. Checks layout, size, quota and active-share limits. |
| `PUT /api/shares/:id/manifest`      | owner | Encrypted manifest (`application/octet-stream`, exact declared size).                                                                                                   |
| `PUT /api/shares/:id/chunks/:index` | owner | Encrypted chunk (exact expected size). Idempotent.                                                                                                                      |
| `POST /api/shares/:id/finalize`     | owner | Verifies every object is present and correctly sized, then starts the TTL → `{id, expiresAt}`.                                                                          |
| `GET /api/shares/:id`               | —     | `{id, formatVersion, expiresAt, chunkBytes, chunkCount, cipherBytes, manifestBytes}`; `404` unknown/incomplete, `410` with `expired`/`deleted`.                         |
| `GET /api/shares/:id/manifest`      | —     | Encrypted manifest bytes (counts as an access).                                                                                                                         |
| `GET /api/shares/:id/chunks/:index` | —     | Encrypted chunk bytes.                                                                                                                                                  |
| `GET /api/shares/:id/owner`         | owner | `{status, expiresAt, accessCount}`.                                                                                                                                     |
| `DELETE /api/shares/:id`            | owner | Deletes data immediately (idempotent).                                                                                                                                  |
| `GET /api/cron/cleanup`             | cron  | Runs reconcile + cleanup now (`Authorization: Bearer $CRON_SECRET`; 401 when unset or wrong). Used by Vercel Cron.                                                      |

`owner` = `Authorization: Bearer <ownerToken>`; the server stores only its SHA-256 hash and compares in constant time.

Error codes: `not-found`, `expired`, `deleted`, `invalid-request`, `unauthorized`, `too-large`, `quota-exceeded`, `too-many-shares`, `rate-limited`, `storage-unavailable`, `share-disabled`, `upload-incomplete`, `upload-expired`, `conflict`, `internal`.

### Storage layout

```
shares/<prefix>/meta.json              sizes, timestamps, owner-token hash, access count
shares/<prefix>/data/manifest.bin      encrypted manifest
shares/<prefix>/data/chunks/NNNNNNN.bin encrypted chunks
```

In the serverless profile, `meta.json` lives in Redis (`meta:shares/<prefix>/meta.json`) instead, with a set of known prefixes and a sorted set of each package's next deadline (upload deadline, expiry or purge), so due work is found without listing the blob store.

`<prefix>` = first 32 chars of base64url(SHA-256("preprati.share.v1:" + id)), so storage keys do not reveal share ids. On expiry or deletion `data/` is removed at once. `meta.json` remains as a tombstone for `SHARE_TOMBSTONE_TTL` so recipients see "expired"/"deleted" rather than "not found".

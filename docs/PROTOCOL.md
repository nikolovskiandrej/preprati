# Protocols

preprati. uses four protocols:

1. **Signaling** (WebSocket or HTTP polling, JSON) — helps two browsers find each other.
2. **Transfer** (WebRTC data channel) — carries file names and file bytes for Quick Transfer.
3. **Relay mode** (end-to-end encrypted messages over signaling + share packages) — Quick Transfer when the devices can't connect directly.
4. **Share package** (HTTPS + client-side encryption) — stores encrypted packages for Share Files and relay mode.

All message schemas live in `src/shared/` and `src/client/transfer/protocol.ts` and are validated on receipt.

---

## 1. Signaling — `wss://<host>/ws`

JSON text frames only (binary frames are rejected). Max message size `WS_MAX_MESSAGE_SIZE` (64 KiB). Messages are validated with zod (`src/shared/signaling.ts`); invalid messages get `{type:"error",code:"invalid-message"}` and the 5th strike closes the socket with code `4400`.

### Client → server

| Message                                                                                   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{type:"create-session", role:"sender"\|"receiver", device:{label}}`                      | Host creates a session.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `{type:"join-session", target:{via:"link",sessionId}\|{via:"code",code}, device:{label}}` | Guest joins with the QR/link capability or the 6-character code.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `{type:"approve-peer"}` / `{type:"decline-peer"}`                                         | Host decides about a device that joined **by code** while the host is **sending**.                                                                                                                                                                                                                                                                                                                                                                                       |
| `{type:"signal", payload}`                                                                | Relayed to the other member once paired. `payload` is `{kind:"description",description:{type,sdp},attempt?}`, `{kind:"candidate",candidate,attempt?}`, or one of the recovery steps `{kind:"retry",attempt}`, `{kind:"attempt-failed",attempt}` and `{kind:"gave-up",attempt}` (see [Connection attempts](#connection-attempts-and-repairs)), or relay mode's `{kind:"relay-hello",key,reply?}` and `{kind:"relay-message",seq,data}` (see [Relay mode](#3-relay-mode)). |
| `{type:"leave-session"}`                                                                  | Leave explicitly (closing the socket does the same).                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `{type:"lock-session"}`                                                                   | Host only, once files start moving (either engine). From then on the guest leaving ends the session instead of reopening it.                                                                                                                                                                                                                                                                                                                                             |
| `{type:"ping"}`                                                                           | Liveness; answered with `pong`.                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Server → client

`session-created` (id, code, role, `expiresAt`, `iceServers`), `session-joined` (role, host device, `awaitingApproval`, `iceServers`), `peer-joined` (device, `via`, `needsApproval`), `peer-approved`, `peer-declined`, `signal`, `peer-left` (`reason`: `left` when the other device left on purpose — leave message, page closed, WebSocket close code 1000/1001, disconnect beacon; `gone` when it went silent — presence lapsed, connection dropped; `expiresAt` when the session reopened — see below), `session-expired`, `session-closed` (`lifetime-exceeded` \| `server-shutdown`), `error` (`invalid-message`, `rate-limited`, `session-not-found`, `session-expired`, `session-full`, `already-in-session`, `not-in-session`, `not-allowed`, `server-busy`, `internal`), `pong`.

### Session lifecycle (server)

```
waiting ──link join──────────────▶ paired
waiting ──code join (host receives)▶ paired
waiting ──code join (host sends)──▶ pending-approval ──approve──▶ paired
                                                     └─decline──▶ waiting
waiting ──SESSION_PAIRING_TTL──▶ expired (destroyed, both sides told)
paired ──guest leaves, not locked──▶ waiting (host gets peer-left with expiresAt)
paired ──host sends lock-session──▶ paired, locked
any ──host leaves, or guest leaves a locked session──▶ destroyed (other side gets peer-left)
any ──SESSION_MAX_LIFETIME──▶ destroyed (session-closed)
```

- **Reopening.** A link pasted into a chat is often opened first in the chat app's built-in browser, or twice. A guest that leaves (on purpose or by going silent) before any files moved therefore doesn't use the session up: it goes back to `waiting` with the same id and code, the pairing window is extended to at least a full `SESSION_PAIRING_TTL` from now, and the host's `peer-left` carries the new deadline in `expiresAt`. The host keeps its page as it is ("the same link and code still work"). Once files start moving the host sends `lock-session`, and from then on a departing guest ends the session as before, so a link can't hand the same files to a second device.
- **Waiting for a busy link.** A guest whose join by link gets `session-full` (the link is open elsewhere) retries the join every 4 s for up to 3 minutes and connects as soon as the other page lets go; only then does it show the error.

- Session ids are 128-bit random (base64url, 22 chars) and act as the link capability in `/j/<id>`.
- Pairing codes are 6 characters from `ABCDEFGHJKMNPQRSTVWXYZ23456789` (no 0/O/1/I/L/U), drawn with rejection sampling. Wrong codes count towards `RATE_LIMIT_JOIN_FAILURES` per IP.
- The pairing TTL only applies while waiting. Once paired, nothing time-boxes an ongoing transfer (apart from the generous `SESSION_MAX_LIFETIME`, after which the existing peer-to-peer connection keeps working anyway).
- A session has exactly two members. Relaying starts only in `paired`.
- ICE servers are delivered per session. With `TURN_SECRET`, TURN credentials follow the TURN REST convention (`username = "<expiry>:<opaque>"`, `credential = base64(HMAC-SHA1(secret, username))`).

### Signaling over HTTP (serverless deployments)

On serverless hosts (`SIGNALING_TRANSPORT=http`; the default on Vercel) the same messages travel over plain HTTP. `/api/config` tells the browser which transport to use (`quickTransfer.signaling`).

| Request                                                                                            | Purpose                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/signal/connect` → `201 {connectionId, token}`                                           | Opens a connection. `token` is 256-bit random; the server keeps only its SHA-256.                                                                                                                                                                                    |
| `POST /api/signal/send` (body: a client message, or an array of up to 32) → `{messages, firstSeq}` | Handles the message(s) in order and returns anything queued for this connection.                                                                                                                                                                                     |
| `GET /api/signal/poll` → `{messages, firstSeq}`                                                    | Returns the connection's inbox, after applying expiry and departure rules.                                                                                                                                                                                           |
| `POST /api/signal/disconnect` (body: `{connectionId, token}`) → `204`                              | Leaves for good. Sent with `navigator.sendBeacon` on `pagehide`, so the body carries the credentials. It is exempt from the `Origin` check: a no-cors beacon from a `Referrer-Policy: no-referrer` page arrives with `Origin: null`. The token is the authorization. |

`send` and `poll` authenticate with `Authorization: Bearer <token>` and `X-Signal-Connection: <connectionId>`. Messages are numbered per connection, and `send` carries `X-Signal-Seq`, the number of its (first) message — message `i` of an array is number `seq + i`. The server handles each number once, so a retried request whose response was lost (even one that has grown by the messages queued meanwhile) doesn't handle anything twice. The client sends whatever queued up while its previous request was in flight together, so a burst of ICE candidates takes one or two requests instead of one each; an array over the limit is refused whole.

**Acknowledged delivery.** Inbox messages are numbered per connection (message `i` of a response has number `firstSeq + i`) and stay queued until a later `send` or `poll` acknowledges them with `X-Signal-Ack: <number of the last message handled>`. A response lost on the way (a phone changing cells, an aborted request) is therefore delivered again, and the client skips numbers it already handled, so every message is handled exactly once, in order. In Redis, numbering + append and acknowledge + read are single Lua scripts, so concurrent writers can't reorder an inbox. Requests without the header (older pages) get the previous behaviour: returned messages are removed.

Session state lives in Redis with a TTL on every key (connection, inbox, inbox counter, session, guest slot, approval flag, pairing code). There are no server timers: pairing expiry (also for a code join awaiting the host's approval) and a vanished peer are detected when a device polls. A connection that hasn't polled for 150 s counts as gone, and the other device gets `peer-left` with reason `gone`. The client polls every 0.4 s while messages flow, every 1.5 s while pairing, every 1.5 s while recovering from a failed attempt, every 5 s once a failure is shown (for up to 5 minutes, so "Try again" still works) and every 15 s once the data channel is open (0.4 s again while a dropped connection is repaired).

### Who offers

The **host** always creates the WebRTC offer; the guest answers. Remote ICE candidates arriving before the remote description are queued. Both sides create the same pre-negotiated data channel (`negotiated: true, id: 0, ordered`), so there is no `ondatachannel` race.

### Connection attempts and repairs

- **Attempts.** Every description and candidate carries `attempt` (absent = 0). Attempt n+1 runs over the same session, with a fresh `RTCPeerConnection` on both sides and no new code. The host starts it directly; a guest sends `{kind:"retry",attempt:n+1}` and the host answers with a new offer. Signals from an older attempt are dropped, and candidates that overtake their offer wait for it. At most `MAX_CONNECTION_ATTEMPTS` (6) attempts per session, automatic ones included.
- **Failure.** An attempt fails when ICE fails, nothing opens within 30 s, or the data channel opens but the other side's `hello` doesn't arrive within 15 s. The failure is classified from the candidates each side gathered (no STUN configured · nothing from the other device · both on one network, i.e. the same public address · no public address here · none there · both public but incompatible, e.g. a strict NAT).
- **Automatic recovery.** Nobody has to press anything after a failed attempt. The **sending** device decides the next step: relay mode (§3) when the server stores packages and the chosen files fit its limits — no direct path is likely to appear by itself — otherwise one automatic attempt n+1 (after 1 s). The **receiving** device closes its side, tells the sender `{kind:"attempt-failed",attempt:n}` (a browser can keep checking for up to 30 s; the sender then moves on at once), and waits up to 30 s for the sender's relay proposal or new attempt. When the sender has nothing left to try, it shows the failure and sends `{kind:"gave-up",attempt}`, so the receiver explains it at the same moment instead of waiting. Only then does **Try again** appear (on either device), which starts attempt n+1 and the automatic steps afresh.
- **Repairs.** Once the data channel has opened, ICE `disconnected` (for 2.5 s) or `failed` makes the host send an ICE-restart offer (`iceRestart: true`) on the same connection; the guest answers it. The DTLS/SCTP association and the data channel stay open, so a transfer continues after a network change. At most two restarts per drop, within 45 s; after that the connection counts as lost. A page that returns to the foreground repairs a dropped path at once (one more restart is allowed).
- **Signaling after connecting.** A working direct connection doesn't need signaling. `peer-left` with reason `gone` only closes signaling; the data channel reports a real departure (`bye`, channel close, ICE failing for good). `peer-left` with reason `left` ends the session right away.

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
- A dropped network path is repaired underneath the data channel (ICE restart, see [Connection attempts and repairs](#connection-attempts-and-repairs)), so the transfer simply continues. Not implemented: resuming after the connection is lost for good; that fails the transfer cleanly and discards partial data.

---

## 3. Relay mode

When a direct attempt fails, the sending device switches the session to relay mode on its own, if the server stores packages and the chosen files fit its limits (see [Automatic recovery](#connection-attempts-and-repairs)); while a direct attempt drags on, the sender may also choose it ("Send through preprati. instead"). Files then travel as a share package (§4) instead of over a data channel; the session, pairing and interface stay the same, and nothing is uploaded before the receiver accepts the offer. Code: `src/client/transfer/relay.ts`, `relayCrypto.ts`, `relayStorage.ts`.

### Key agreement (signaling payloads)

1. The sender creates an ephemeral ECDH P-256 key pair and sends `{kind:"relay-hello", key}` (`key`: the raw 65-byte public key, base64url, 87 characters).
2. The receiver creates its own pair and answers `{kind:"relay-hello", key, reply}`, `reply` being the sender key it answers. A sender only completes the proposal it made (also when the answer arrives after its 20 s wait); a receiver accepts a new proposal at any time unless a transfer is running.
3. Both derive the message key: `HKDF-SHA-256(ECDH secret, salt = "preprati.relay.v1", info = "<session id>|<sender key>|<receiver key>")` → AES-256-GCM.

### Control messages

Each control message is JSON, sealed with the message key and sent as `{kind:"relay-message", seq, data}`: `data` is base64url(IV (12) ‖ ciphertext ‖ tag (16)), at most 48,000 characters; `seq` numbers the sender's messages from 0. The additional authenticated data is `preprati/relay/v1/<sender|receiver>/<seq>`, so a message can't be replayed under another number, reflected to the device that sent it, or altered. Receivers handle messages strictly in order: a repeated number is ignored, a gap (a message that went missing) stops the active transfer.

| Message                                                                    | From     | Meaning                                                                                                                                                           |
| -------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{t:"offer", id, files:[{index,name,size,type,lastModified}], totalBytes}` | sender   | Same file list as the data-channel offer. Names are shortened (keeping extensions) only if the list wouldn't fit one message; the package carries the full names. |
| `{t:"accept", id}` / `{t:"reject", id}`                                    | receiver | Decision.                                                                                                                                                         |
| `{t:"progress", id, stage:"upload"\|"download", bytes}`                    | either   | The sender's upload (to the receiver), the receiver's download (to the sender); at most every 1.5 s.                                                              |
| `{t:"ready", id, share, secret}`                                           | sender   | The package is stored: its id and its 256-bit key (base64url), which never travel unencrypted.                                                                    |
| `{t:"complete", id}`                                                       | receiver | Every file was downloaded, authenticated and handed over; the sender deletes the package.                                                                         |
| `{t:"cancel", id, reason:"user"\|"error"}`                                 | either   | Stops the transfer; the sender deletes whatever was stored.                                                                                                       |

### Flow

`offer → accept → (sender uploads the package; progress…) → ready → (receiver downloads and verifies it; progress…) → complete → sender deletes the package`. The receiver checks that the package holds exactly the offered files (count and sizes); anything else fails the transfer as a protocol error. Leaving the session ends relay mode (the other device sees `peer-left`). A package whose deletion never happens expires with the share lifetime.

---

## 4. Share package format, version 1

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

## 5. HTTP API

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

# Security & privacy

This document states what preprati. protects, what it does not, and how. Claims here are backed by tests (`tests/`, `e2e/`) where noted.

## Quick Transfer

**What travels where**

| Data                                                                                                        | Path                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File names, types, sizes, file bytes                                                                        | Over the WebRTC data channel between the two browsers (DTLS-encrypted) — or, in relay mode, encrypted end to end through temporary storage (see below). |
| Device labels ("iPhone · Safari"), WebRTC session descriptions, ICE candidates (which include IP addresses) | Through the signaling server, relayed to the other member of the session. Not stored.                                                                   |
| Nothing                                                                                                     | Persisted on the server, except a relay-mode package (ciphertext) while it is being delivered.                                                          |

**Direct vs relayed.** With STUN, most devices connect directly. On restrictive networks a TURN relay may be needed. The relay forwards the still-encrypted DTLS traffic; it cannot read file contents, but it does see traffic volume and both endpoints' addresses. The interface shows whether the active connection is direct or relayed ("Direct connection" / "Relayed connection") and never claims files always travel directly. Without a configured TURN server (the default), connections that cannot go direct switch to relay mode on their own (below) when the server supports it and the files fit; otherwise they fail with an explanation of the likely cause. The "Connection details" shown with it contain counts and flags only, never addresses or ports. The STUN providers (Google, Cloudflare) see each device's public address, which they report back to it; see [CONNECTIVITY.md](CONNECTIVITY.md#10-privacy).

**Relay mode ("Through preprati.").** When the devices can't connect directly, the sending device sends the files through preprati.'s temporary storage instead, on its own ([PROTOCOL.md §3](PROTOCOL.md#3-relay-mode)); the sender can also choose it while a direct attempt drags on. Both devices say so while it is set up ("A direct connection wasn't possible, so the files will go through preprati. — encrypted so that only the two devices can open them"), and nothing is uploaded before the receiver has accepted the offer. The two browsers agree on a key with ephemeral ECDH (P-256) over signaling, bound to the session and both public keys with HKDF; every control message (file list, decisions, progress, the package id and key) is AES-256-GCM-encrypted with the sender role and a message number authenticated, so the server can't read, change, replay, reorder or reflect them. The files themselves are a share package (see Share Files below): encrypted in the sender's browser with a fresh 256-bit key that only travels inside an encrypted control message, verified chunk by chunk by the receiver, and deleted as soon as the receiver confirms it has everything (otherwise it expires with `SHARE_TTL`). The server sees the package size, timing and both devices' IP addresses, never names, contents or keys. Like WebRTC, whose DTLS fingerprints also travel over signaling, this protects against a passive or curious server, not one that substitutes keys while they are exchanged. The interface says "Through preprati." whenever relay mode is in use. _(tests: `relayCrypto.test.ts`, `relay.test.ts`, `quickRelay.test.ts`, `relayFlow.test.ts` asserts that no request carries file names or plaintext and that the package is deleted, e2e `connectivity.spec.ts`)_

**Session capabilities**

- QR codes and links carry a 128-bit random session id: unguessable, single-use (two members max), valid for `SESSION_PAIRING_TTL` (10 min) while waiting.
- A guest that leaves before any files moved frees the session for the next device that has the link or code (a link opened first in a chat app's built-in browser mustn't be used up). The rules for joining don't change: the next device needs the same link, or the code plus the host's approval when the host sends. Once files start moving the host locks the session, and a departing guest ends it, so one link never delivers the same files to a second device.
- Six-character pairing codes are guessable in principle (30⁶ ≈ 7×10⁸). Mitigations: short lifetime, per-IP limits on failed joins (`RATE_LIMIT_JOIN_FAILURES`), per-IP connection/session limits, single-use sessions, and **host approval**. A device that joins a _sending_ host by code receives nothing — not even file names — until the host taps **Allow** after seeing the device label. (A device joining a _receiving_ host can only offer files, which the receiver must accept.)
- The receiving user always accepts or declines an offer explicitly.

**HTTP signaling (serverless profile).** Each polling connection gets a 256-bit random token; Redis stores only its SHA-256, compared in constant time. Signaling messages (device labels, session descriptions, ICE candidates) wait in a per-connection Redis inbox until the client acknowledges them (normally the next poll), at most 10 minutes. Every key has a TTL, so abandoned sessions vanish on their own. Retried sends are de-duplicated by message number. _(tests: `pollingSignaling.test.ts`, `httpSignaling.test.ts`, `httpSignalingClient.test.ts`, e2e `quick-transfer-http.spec.ts`)_

**Untrusted peer input.** Every data-channel message is validated (schema, sizes, ordering, sequence numbers, exact byte counts). Received file names are sanitized (no path separators, control/bidi characters, reserved device names). Received files are stored as `application/octet-stream` blobs, so a peer-supplied type such as `text/html` cannot make a same-origin blob URL render. Only raster image types are previewed, never SVG. _(tests: `tests/client/engine.test.ts`, `tests/client/lib.test.ts`)_

## Share Files

**Explicit opt-in.** Choosing files uploads nothing. A confirmation dialog states that files will be encrypted, stored until the expiry time, and readable by anyone with the complete link. Only then does encryption and upload begin. _(e2e: `share.spec.ts`; integration: `tests/client/shareFlow.test.ts`)_

**Client-side encryption.** See [PROTOCOL.md §4](PROTOCOL.md#4-share-package-format-version-1). Web Crypto only: HKDF-SHA-256 → AES-256-GCM, a random 96-bit IV per chunk, index and count authenticated as additional data, encrypted and padded manifest. The server stores ciphertext plus minimal metadata: chunk count, total ciphertext size (from which the total plaintext size can be derived), timestamps, owner-token hash, and an access counter. It does **not** store or see file names, types, the number of files or their individual sizes. _(tests: `crypto.test.ts`, `shareFlow.test.ts` asserts that no request and no stored object contains file names, plaintext or the key)_

**The key never reaches the server.** It lives in the URL fragment (`#…`), which browsers do not send in HTTP requests. The page sets `Referrer-Policy: no-referrer` (header and meta tag), loads no third-party scripts, styles or fonts, and keeps a strict CSP. The app never logs URLs. _(e2e: every request during creation and download is checked for the key)_

**Bearer links.** A share link is a capability: anyone who obtains the complete link can download the files until they expire or are deleted. Encryption protects against the storage operator, not against people you send the link to. The interface says so in plain words and does not call such links "private".

**Integrity.** Tampered, truncated, reordered or swapped chunks fail authentication. A file is saved only after every chunk of it has been verified; a failure shows "Part of the data failed verification, so nothing was saved." A wrong key fails at the manifest, and no download controls are shown. _(tests: `crypto.test.ts`; `shareFlow.test.ts` tampers a stored chunk; e2e wrong-key case)_

**Lifetime.**

- Expiry is enforced on every read, independent of the cleanup job.
- Cleanup (`CLEANUP_INTERVAL`) deletes ciphertext of expired packages, removes abandoned uploads after `SHARE_UPLOAD_TIMEOUT`, and purges tombstones later.
- Owners can delete at any time. The owner token is shown only to the creator and kept in that browser's `localStorage` (never the key or file names) so the share can still be deleted after a reload.
- A failed or cancelled upload is deleted right away by the client; the server also removes it at the upload deadline.
- On startup the server rebuilds its index from storage and removes orphaned data without metadata. _(tests: `shareService.test.ts`, e2e expiry test)_
- Serverless profile (Vercel): there is no timer between requests. A read that finds an expired package deletes its data right away, API traffic triggers a sweep of due packages (at most every 5 minutes per instance), and a daily cron job reconciles and cleans up everything else. Metadata and capacity counters live in Redis, so quotas hold across instances. _(tests: `serverlessStorage.test.ts`)_

**Owner authorization.** Upload, finalize, status and delete require `Authorization: Bearer <ownerToken>` (256-bit random). The server stores its SHA-256 and compares in constant time.

## Server hardening

- **Input validation:** zod schemas for signaling, the share API and runtime config. Exact chunk sizes are enforced, so a declared package size cannot be exceeded. Path-traversal-safe storage keys. Request body limits.
- **Rate limits** (per IP): API requests, share creation, WebSocket connects, failed joins, messages per socket, concurrent sockets and sessions.
- **Origins:** API and WebSocket upgrades from foreign browser origins are refused (`PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`, same-host). CORS headers only for allowed origins. The one exception is `POST /api/signal/disconnect`: browsers send that `navigator.sendBeacon` without CORS, and with `Referrer-Policy: no-referrer` it arrives with `Origin: null`. It can only end the connection whose secret token is in its body, and it returns nothing, so a foreign page gains nothing from it.
- **Headers:** strict CSP for HTML (`default-src 'self'`; no inline scripts or styles; `frame-ancestors 'none'`; `connect-src` limited to self, `blob:` (received image previews; Chrome on Android checks blob image loads against it) and the signaling origin), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy`, and HSTS when served over HTTPS.
- **Logging:** route patterns only, never raw URLs (they contain share/session ids). Signaling logs lifecycle events (session created, device joined, approval, recovery steps such as relay mode or another attempt, departures, expiry) under a short tag derived from the session id with SHA-256 — enough to follow one session, useless for joining it — and never codes, device labels, addresses or signal contents. No analytics, no third-party requests.
- **Session membership:** signals are relayed only between the two members of a paired session; a connection record that merely names a session (a stale one, say from a declined join) can't send into it.
- **Secrets:** TURN secrets, S3 credentials, the Blob and Redis tokens and `CRON_SECRET` are read only by the server. The cleanup endpoint compares the cron secret in constant time. TURN credentials handed to browsers are short-lived HMAC credentials scoped by an opaque value. Nothing secret is in the frontend bundle.
- **Transport:** run behind HTTPS/WSS in production (see [DEPLOYMENT.md](DEPLOYMENT.md)). Web Crypto and the async Clipboard API only work in secure contexts.

## Known limitations

- With WebSocket signaling, in-memory rate limits and session state assume a single server process. Multiple instances need sticky WebSocket routing, and limits apply per instance. The serverless profile keeps signaling state, quotas and session-creation limits in Redis, but its general per-IP request limiter is still per instance (rely on the platform's firewall for volumetric abuse).
- No resumable transfers or uploads: an interruption restarts that transfer/package.
- Very large files are assembled as browser Blobs before saving; available memory/disk in the browser bounds the practical size (limits are configurable, default 1 GB for shares).
- Device labels come from the peer's user agent and are not authenticated; they help recognise a device but are not proof of identity.
- ICE candidates exchanged through signaling reveal network addresses to the other device and the signaling server, as with any WebRTC application.
- Relay mode's key agreement is not authenticated beyond the signaling session (no fingerprint comparison between the devices), the same trust model as WebRTC's own key exchange.

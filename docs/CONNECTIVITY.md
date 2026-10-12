# Connecting across networks

How Quick Transfer connects two devices — on different networks (home networks, mobile data, different cities), or on one network that doesn't let them reach each other. It covers what works without spending anything, what can't work directly, what the app does then, and how to test it.

**In short:** the app is publicly reachable (HTTPS on Vercel), signaling works from any network, and two free STUN servers let most network combinations connect **directly**. Some can't connect directly: a strict NAT on mobile data, a network that blocks UDP, or — as on the developer's own home Wi-Fi — one network that keeps its devices apart. For those, the sender can choose **Send through preprati.** (relay mode, §5): the files go end-to-end encrypted through the app's existing temporary storage, inside the same session, with nothing to share by hand. It works on any network that can open the website, costs nothing within the free plans, and the app explains in plain language why it was needed. **Try again** reconnects without a new code. An optional TURN relay can still be added; it is off by default because relays cost bandwidth.

---

## 1. Diagnosis

### Laptop and phone on the same Wi-Fi (12 October 2026, evening)

Report: "I tried to transfer a file between my laptop and my phone (they were on the same internet) but the connection is getting lost."

- **Production request logs** (Vercel, 14:10–14:14 UTC) showed the whole session: pairing and signaling worked, but **neither attempt ever opened a connection**. Each failed about 18 s after the offer (both devices switched to the post-failure polling pace at once, and never to the "connected" pace), then "Try again" failed the same way. The phone then went silent (screen locked), and its presence lapsed 150 s later.
- **The laptop** (Linux, Chrome, on the home Wi-Fi, no VPN, no active firewall) resolves and answers local mDNS names: two Chrome processes on it connect over local candidates alone. Its network is a **strict NAT** without IPv6 (`npm run nat-check`).
- **Conclusion:** two devices behind one strict NAT can only connect over their local (mDNS `.local`) candidates, because a strict NAT doesn't loop traffic for its own public address back into the network. When the phone and the laptop can't find each other locally — the router keeps Wi-Fi clients apart (guest networks do this; some routers filter multicast), or a VPN or Private Relay setting on one device — there is no direct path at all, and only a relay can help. The app then said "Try both devices on the same Wi-Fi", which they already were.
- **Fixed:** the failure is now recognised as "both devices are on the same network" (they report the same public address), explained as such, and **Send through preprati.** gets the files across anyway (§5). The NAT lab reproduces the situation (scenario 8): the direct attempt fails after ~18 s, as in production, and relay mode delivers the file.
- **Also fixed** while there, for phones in general: the screen is kept on while a session is live (a locked phone suspends the page and its connection), a page coming back from the background repairs a dropped connection at once, and a dropped connection gets 45 s (was 25 s) to come back.

### Across networks (12 October 2026)

What was checked, and what was found:

| Area                  | Finding                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public reachability   | Already public: `https://preprati.vercel.app` (Vercel, HTTPS). Signaling runs as HTTP polling through one Vercel function with state in Upstash Redis. Measured from outside: about 90 ms per relayed message, every message delivered. **Not the cause.**                                                                                   |
| STUN                  | One server (`stun:stun.l.google.com:19302`). In a two-NAT lab, two typical home routers connected directly in under half a second. STUN worked, but it was a single provider on a non-standard port.                                                                                                                                         |
| The actual limitation | Network combinations where STUN cannot produce a path: a **strict ("symmetric") NAT**, common on mobile data, opposite a typical router. Also networks that block UDP, and any network that blocks port 19302. These need a relay, and none is configured. The app only said "couldn't connect".                                             |
| Signaling defect 1    | HTTP polling removed messages from the inbox as soon as a response carried them. If that response was lost in transit (a phone changing cells), the offer or candidates were gone. A retried send was deduplicated, so even `session-created` could be lost and the page waited forever. **Fixed:** messages stay queued until acknowledged. |
| Signaling defect 2    | Over HTTP polling, a device that joined a sending host by code and was never allowed or declined waited forever. The WebSocket server expired it. **Fixed:** the pairing deadline is enforced in both.                                                                                                                                       |
| Connection defect 1   | When the server reported the other device gone, a **working** direct connection was torn down, even if only the other device's server connection had lapsed. **Fixed:** the server now says whether the device `left` on purpose or went `gone` silent, and a working direct connection outlives `gone`.                                     |
| Connection defect 2   | A short outage or a network change mid-transfer (Wi-Fi → mobile data) lost the transfer after 8 s. **Fixed:** ICE restart on the same connection, so the transfer continues.                                                                                                                                                                 |
| Error handling        | A generic message, and the only way forward was a new session with a new code. **Fixed:** a cause-specific explanation, connection details, "Try again" within the same session, and "Send as a link instead". There is also a timeout for a session the server never confirms.                                                              |

## 2. How a connection is made

```
          HTTPS (signaling: offers, answers, candidates — no file data)
 Phone ──────────────────────────────▶ preprati.vercel.app ◀────────────────────────── Laptop
   │                                    /api/signal/* ──▶ Upstash Redis (inboxes, TTLs)      │
   │                                    /api/shares/* ──▶ Vercel Blob (relay mode only)      │
   │                                                                                          │
   │  "what is my public address?"       stun.l.google.com:19302                              │
   ├───────────────────────────────────▶ stun.cloudflare.com:3478 ◀──────────────────────────┤
   │                                                                                          │
   └══════════════ direct, DTLS-encrypted WebRTC data channel (the files) ═══════════════════┘
          (when no direct path exists: through preprati.'s encrypted storage — relay mode;
           or through an optional TURN relay)
```

1. Both devices reach the signaling API over HTTPS, which works from any network.
2. Each browser asks the STUN servers for its public address (a "server-reflexive candidate") and sends its candidates to the other device through signaling.
3. ICE tries every pair of candidates. On typical routers, both sides sending to each other opens a path ("hole punching"), and the files then travel directly, encrypted.
4. When no pair works, the attempt fails after about 15–30 s with an explanation (§4), and the sender can switch to relay mode (§5) — also earlier, while the attempt is still dragging on.

The server sees device labels, WebRTC negotiation and, in relay mode, ciphertext only — never file names, contents or keys.

## 3. What works without paying anything

Verified in the NAT lab (§8) with the production build in real Chrome:

| Device A                               | Device B                                   | Result                                                                                              |
| -------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Same Wi-Fi, devices can see each other | Same Wi-Fi                                 | **Direct** (local candidates)                                                                       |
| Same Wi-Fi that keeps devices apart    | Same Wi-Fi                                 | Direct only if the router loops traffic back (not with a strict NAT); else **relay mode** · _lab 8_ |
| Home router                            | Home router (another city)                 | **Direct** through STUN · _lab 1, 7_                                                                |
| Home router                            | Mobile data, carrier with a "friendly" NAT | **Direct** through STUN (many carriers)                                                             |
| Home router                            | Strict / symmetric NAT (some carriers)     | Not directly: explained, "Try again", **relay mode** · _lab 2, 9_                                   |
| Network that blocks UDP                | Anything                                   | Not directly: explained, naming which device's network; **relay mode** · _lab 3_                    |
| Strict NAT                             | Strict NAT                                 | Not directly: **relay mode**, or the optional TURN relay · _lab 6_                                  |
| Network changes mid-transfer           |                                            | **Repaired** by ICE restart; the transfer continues · _lab 5_                                       |
| Moves to another network, retry        |                                            | **"Try again"** reconnects the same devices, no new code · _lab 4_                                  |

Relay mode works wherever both devices can open the website; it is limited by the size and budget of the temporary storage (§5).

Mobile networks differ by carrier and even by region. Whether a given phone on mobile data connects directly depends on that carrier's NAT. When both devices have IPv6 (common on mobile and some home connections), browsers can often connect directly over IPv6 without any NAT; both default STUN servers answer over IPv6 too.

## 4. When a direct connection isn't possible

The app tells the user what happened, in English or Macedonian, and what to do:

| Cause (from what both devices found)              | Message (abridged)                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both showed the same public address (one network) | "Both devices are on the same network, but it doesn't let them connect to each other directly. Some routers keep devices apart — guest networks usually do — and so does a VPN on either device." |
| Both found public addresses, still no path        | "Both devices are online, but their networks don't allow a direct connection between them…"                                                                                                       |
| This device found no public address               | "This device's network blocks direct connections… Try another network, such as mobile data…"                                                                                                      |
| The other device found no public address          | "The other device's network blocks direct connections…"                                                                                                                                           |
| Nothing arrived from the other device             | "The other device didn't answer in time. Check that its page is still open…"                                                                                                                      |
| No STUN configured on the server                  | "This server connects devices directly only when they're on the same network, such as the same Wi-Fi."                                                                                            |

Then:

- **Send through preprati.** (the sender's device) sends the chosen files through relay mode (§5), with a note on what that means: "The files are encrypted on this device first. preprati. keeps them only until _the other device_ has them, and never longer than 24 hours." The receiver sees "Or, on _the sender's device_, choose “Send through preprati.” — it works on any network." While a direct attempt is still trying (after 8 s), the sender can choose **Send through preprati. instead** right away.
- **Try again** reconnects the same two devices directly, without a new code, up to 5 retries per session. Use it after moving one device to another network (for example, turning Wi-Fi off on a phone).
- **Send as a link instead** (sender) appears when relay mode is no longer possible because the other device left. It moves the chosen files to Share Files without choosing them again.
- **Connection details** shows, without any addresses, what each device found: public address found or not, strict NAT detected, whether both are on the same network, whether a relay is set up, and how long the attempt ran.

If an established connection drops, both devices show "Connection interrupted. Reconnecting…" while ICE restarts (up to two restarts per drop, within 45 s); after that the connection counts as lost. A page that comes back to the foreground (phones pause background pages) repairs a dropped connection right away, and while a session is live the app keeps a phone's screen on (Screen Wake Lock; released five minutes after the last visible change, and whenever the page is hidden).

### When your own network is the strict one

If "Connection details" says **"Public address found (strict NAT)"** for _this device_, or `npm run nat-check` reports a strict NAT, your network picks a new public port for every destination. It can then connect directly only to fairly open networks, which is the classic "works only on the same Wi-Fi" symptom. Things to try that cost nothing:

1. **Router settings.** Look for a NAT option such as "NAT type", "full cone NAT", "endpoint-independent mapping", or a gaming/NAT-boost mode, and turn it on. Then run `npm run nat-check` again.
2. **Find out who does the NAT.** Compare the router's WAN/Internet address (on its admin page) with the public address the check reports. If the WAN address is in 100.64.0.0–100.127.255.255, or another private range, your provider uses carrier-grade NAT, and router settings won't help. Ask the provider whether it offers a public IPv4 address or IPv6.
3. **IPv6.** If your provider supports it, enable IPv6 on the router. Devices that both have IPv6 connect without any NAT.
4. Otherwise use **Send as a link instead**, or a relay (§6).

`npm run nat-check` asks two STUN servers from one socket which public port they see, then tries IPv6. It needs only Node.

### When both devices are on your Wi-Fi and still can't connect

"Connection details" then says **"Network: Same as the other device"**. The devices reach the internet through the same router but can't reach each other inside the network. Common reasons, and what to try:

1. **Guest Wi-Fi or "AP/client isolation".** Put both devices on the main network, or turn isolation off in the router.
2. **A VPN** (or iCloud Private Relay / "Limit IP address tracking" on an iPhone) on either device. Pause it for the transfer.
3. **Laptop on cable, phone on Wi-Fi**, on routers that don't pass local discovery (multicast) between the two. Try both on Wi-Fi.
4. Otherwise: **Send through preprati.** works regardless.

## 5. Relay mode: "Send through preprati."

When the devices can't connect directly, the files can still go through preprati. itself, without TURN and without anything new to pay for. Relay mode reuses the encrypted package format and the temporary storage of Share Files (Vercel Blob in production), but inside the Quick Transfer session: no link to copy, the receiver accepts or declines as usual, and the files land in the same "Received files" list.

```
 sender                              preprati.                              receiver
   │── relay-hello (ECDH public key) ──▶ signaling ──▶                          │
   │                            ◀── signaling ◀── relay-hello (its key, reply) ─│
   │      both derive one AES-256-GCM key; the server never sees it            │
   │── offer (names, sizes)      encrypted ─▶ signaling ─▶                      │
   │                                         ◀─ accept ── encrypted ──           │
   │── encrypted chunks ──▶ /api/shares (Blob) ── progress …                     │
   │── ready (package id + package key) encrypted ─▶                            │
   │                                         ◀── chunks ── /api/shares ─ receiver downloads, verifies
   │                                         ◀─ complete ── encrypted ──         │
   │── deletes the package (/api/shares DELETE)                                  │
```

- **Key agreement.** The sender proposes relay mode with its half of an ephemeral ECDH P-256 key agreement; the receiver answers with its own half, naming the proposal it answers. Both derive the message key with HKDF-SHA-256, bound to the session id and both public keys (`src/client/transfer/relayCrypto.ts`).
- **Control messages** (offer, accept/decline, progress, the package id and key, completion, cancellation) are sealed with AES-256-GCM. The sending side and a message number are authenticated, so the server can't read, alter, replay, reorder or reflect them; a missing message stops the transfer.
- **The files** are encrypted in the sender's browser chunk by chunk, exactly like Share Files, with a fresh random package key that only travels inside an encrypted control message. The receiver checks every chunk's authentication tag and that the package holds exactly the offered files.
- **Storage** keeps the package only until the receiver confirms it has everything; then the sender deletes it. If that confirmation never arrives (a page closed mid-way), it expires with the normal share lifetime (`SHARE_TTL`, 24 h in production).
- **Trust.** The server relays the public keys, so — as for WebRTC itself, whose DTLS fingerprints also travel over signaling — relay mode protects against a passive or curious server, not one that actively swaps keys during setup. File names and contents are never visible to the server either way.
- **Limits and cost.** Relay mode inherits the Share Files limits and safeguards: 100 MB per transfer and 100 files in the current setup, the storage quota, the active-share limit, and the Blob write budget that stops new uploads before the Hobby allowance runs out. A 100 MB transfer uses about 30 Blob writes (≈ 60 such transfers a month at most); small files use a handful. When storage is full or the monthly budget is used up, the sender sees "preprati. can't store files right now, so nothing was sent" at once instead of waiting. Nothing in relay mode can create charges.
- **Signaling pace.** During a relay transfer both devices poll once a second (progress reports travel over signaling), and every 5 s while relay mode is idle.

## 6. Free STUN servers

STUN only tells a device its public address. It never carries file data, and it can't connect networks that forbid direct paths.

| Server                          | Status                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stun:stun.l.google.com:19302`  | Google's public STUN endpoint, the de facto WebRTC default. No account; no published service level.                                                                              |
| `stun:stun.cloudflare.com:3478` | Cloudflare: "Cloudflare's STUN service at stun.cloudflare.com is free and unlimited" ([Realtime TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)). Standard port. |

Two independent providers on two ports keep working when one is down or a network blocks one port. The two answers also reveal a strict NAT (one socket, two different public ports), which the diagnostics use.

Configure with `STUN_URLS` (comma-separated, validated, at most 4; `""` turns STUN off, leaving only same-network connections). The list lives only on the server (`src/server/signaling/ice.ts`) and reaches browsers with each session. There are no credentials in the bundle and no list duplicated in the frontend.

## 7. TURN relay: optional, off by default

A TURN relay forwards the encrypted WebRTC traffic when no direct path exists, so the devices stay connected live (no upload-then-download, no size limit), unlike relay mode. It is **not enabled** because every option costs either money or the bandwidth of a machine someone keeps running:

| Option                                                         | Cost                                                                                                                                 | Notes                                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **coturn on hardware you already own** (home PC, Raspberry Pi) | €0, if your internet connection has a public IPv4 address (not carrier-grade NAT) and you can forward ports                          | Forward UDP/TCP 3478 and the relay port range; use a free dynamic-DNS name; the machine must stay on, and relayed transfers use your home upload bandwidth. Works with the existing settings. |
| Hosted TURN (e.g. Cloudflare Realtime TURN)                    | Billed per GB after a free allowance ("a free tier of 1,000 GB before any charges start", then "$0.05 per GB", per Cloudflare's FAQ) | Usage-based, so it can produce charges. Short-lived credentials come from the provider's API, which would need a small server-side integration. Not implemented on purpose.                   |
| A cloud VM running coturn                                      | Paid, or "free tier" plans that require a payment method                                                                             | Not used.                                                                                                                                                                                     |
| "Free public TURN servers" found online                        | n/a                                                                                                                                  | **Never.** Anonymous relays are unreliable, can disappear at any time, and you don't know who operates them.                                                                                  |

To enable a relay you control (coturn), set it on the server only:

```bash
TURN_URLS=turn:turn.example.org:3478?transport=udp,turn:turn.example.org:3478?transport=tcp
TURN_SECRET=<the coturn static-auth-secret>
```

Minimal hardened `turnserver.conf`:

```ini
listening-port=3478
realm=turn.example.org
use-auth-secret
static-auth-secret=<same value as TURN_SECRET>
fingerprint
no-cli
# Relay only to public addresses (protects your home network)
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
# Keep a relay on a home connection from eating all your bandwidth
user-quota=4
total-quota=20
max-bps=2000000
min-port=49160
max-port=49200
```

Browsers get short-lived HMAC credentials (`TURN_CREDENTIAL_TTL`, default 6 h), never the secret. The interface shows "Relayed connection" whenever traffic uses the relay. Lab scenario 6 verifies this setup end to end with coturn.

## 8. What signaling costs on the free plans

Every poll is one Vercel function call and about 4 Upstash Redis commands. The Upstash free plan includes 500K commands a month, and the database was added without a payment method, so it cannot bill. Upstash doesn't document what a free database does at the limit; expect requests to be refused until the month ends, not charges. The client therefore polls only as often as needed:

| State                                   | Poll interval                                    |
| --------------------------------------- | ------------------------------------------------ |
| Messages flowing (pairing, negotiation) | 0.4 s (for 6 s after the last message)           |
| Waiting for the other device            | 1.5 s (the code expires after 10 min)            |
| After a failed attempt                  | 5 s, for at most 5 minutes ("Try again")         |
| Devices connected directly              | 15 s (presence only; 0.4 s again during repairs) |
| Relay mode, idle / offer pending        | 5 s / 1.5 s                                      |
| Relay mode, transfer running            | 1 s (progress reports)                           |

Roughly: a 10-minute session costs about 600 commands (≈ 800 such sessions a month), and a session left open for 8 hours about 15,000. Before this change, connected sessions polled every 5 s, about three times as much. A relay transfer costs roughly 500–800 commands per minute of transfer for both devices together; the Blob write budget, not Redis, is what limits how much relay mode can be used.

## 9. Testing across networks

**With real devices.** This is the test that matters, because real carriers differ.

1. Open the deployed app (`https://preprati.vercel.app`) on a laptop on home Wi-Fi.
2. On a phone, **turn Wi-Fi off** (mobile data only), scan the QR code, and send a file.
3. Check the badge: "Direct connection" means STUN worked across the two networks.
4. If it fails, open **Connection details** and note what each device found. Try **Try again** after switching networks, a phone hotspot, a friend's network or another carrier, and **Send through preprati.** on the sending device.
5. For a network change mid-transfer, start a large transfer on Wi-Fi, then turn Wi-Fi off on the phone. Expect "Reconnecting…" and then the transfer continuing.

**Local development can't test this.** `npm run dev` and `npm run dev:lan` serve only your computer and your local network (with a self-signed certificate for phones). Devices on other networks can't reach that signaling server, even with STUN. Test cross-network behaviour against a public deployment (production or a Vercel preview deployment), not with temporary tunnel addresses written into configuration.

**NAT lab (no second network needed).** `scripts/nat-lab/lab.sh` builds two NATed networks and a "public" server in Docker and drives the real app in real Chrome on both sides. Linux with Docker, Node and Google Chrome; run `npm run build` first:

```bash
scripts/nat-lab/lab.sh up          # networks, NAT routers, STUN ×2, coturn (all named preprati-lab-*)
scripts/nat-lab/lab.sh scenarios   # 1–9 below, or e.g. `scenarios 2 5`
scripts/nat-lab/lab.sh down        # removes everything it created
```

Results from 12 October 2026 (current code; every transferred file byte-identical; the lab server stores relay packages in `test-results/nat-lab/shares`):

| #   | Scenario                                                    | Result                                                                                                                                                            |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Two home routers, HTTP signaling (as on Vercel)             | Direct connection in ~0.5 s of ICE; 2 MB transferred                                                                                                              |
| 2   | Home router ↔ strict NAT, no relay                          | Fails in ~16 s with "networks don't allow a direct connection"; strict NAT correctly attributed to the device behind it                                           |
| 3   | UDP blocked on A                                            | A: "This device's network blocks…"; B: "The other device's network blocks…"                                                                                       |
| 4   | Strict NAT fails → B moves to a home network → "Try again"  | Reconnected directly within ~5 s, same session and code, file transferred                                                                                         |
| 5   | A gets a new public address mid-transfer (30 MB, throttled) | Both showed "Reconnecting…"; ICE restart reconnected ~4 s after the drop was detected; transfer completed                                                         |
| 6   | Strict NAT on both sides, coturn configured                 | "Relayed connection", transfer completed                                                                                                                          |
| 7   | Two home routers, WebSocket signaling (self-hosted server)  | Direct connection, transfer completed                                                                                                                             |
| 8   | Both devices on one strict-NAT Wi-Fi that keeps them apart  | Fails in ~18 s with "Both devices are on the same network, but it doesn't let them connect…"; "Send through preprati." delivered 3 MB ~8 s later, package deleted |
| 9   | Home router ↔ strict NAT, no TURN, relay mode               | "Send through preprati." delivered 3 MB                                                                                                                           |

The lab mounts the host filesystem read-only into its containers and chroots into it, to run the host's own Node and Chrome inside the lab's network namespaces as your user. Results land in `test-results/nat-lab/`.

## 10. Privacy

- Candidates exchanged through signaling contain the devices' network addresses. The other device learns your public IP address, as with any direct (WebRTC) connection. The signaling server relays candidates and stores nothing after the session.
- The STUN providers see the public address they report back, like any server you contact.
- A TURN relay, if you add one, sees traffic volume and both devices' addresses. The content stays end-to-end encrypted (DTLS).
- Connection diagnostics in the interface contain counts and flags only, never addresses or ports. "Same network" is worked out on the device by comparing the public addresses both sides reported; only the yes/no is shown.
- In relay mode the server stores ciphertext for the duration of the transfer and relays encrypted control messages; it learns the package size, timing and both devices' IP addresses (as it does for any request), never names, contents or keys.

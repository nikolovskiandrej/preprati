# Connecting across networks

How Quick Transfer connects two devices that are **not** on the same Wi-Fi: different home networks, mobile data, different cities. It covers what works without spending anything, what can't work without a relay, what the app does in that case, and how to test it.

**In short:** the app is publicly reachable (HTTPS on Vercel), signaling works from any network, and two free STUN servers let most network combinations connect **directly**. Some combinations can't connect directly, most often a strict NAT on mobile data. No free, safe relay exists for those, so the app explains the problem in plain language. It offers **Try again** without a new code, and senders can **Send as a link instead** (encrypted Share Files), which works on any network. An optional TURN relay can be added later. It is off by default because relays cost bandwidth.

---

## 1. Diagnosis (12 October 2026)

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
   │                                                                                          │
   │  "what is my public address?"       stun.l.google.com:19302                              │
   ├───────────────────────────────────▶ stun.cloudflare.com:3478 ◀──────────────────────────┤
   │                                                                                          │
   └══════════════ direct, DTLS-encrypted WebRTC data channel (the files) ═══════════════════┘
                   (optional: through a TURN relay when no direct path exists)
```

1. Both devices reach the signaling API over HTTPS, which works from any network.
2. Each browser asks the STUN servers for its public address (a "server-reflexive candidate") and sends its candidates to the other device through signaling.
3. ICE tries every pair of candidates. On typical routers, both sides sending to each other opens a path ("hole punching"), and the files then travel directly, encrypted.
4. When no pair works, the attempt fails after about 15–30 s with an explanation (§4).

The server sees device labels and WebRTC negotiation only, never file names or contents.

## 3. What works without paying anything

Verified in the NAT lab (§8) with the production build in real Chrome:

| Device A                        | Device B                                   | Without a relay                                                                |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| Same Wi-Fi                      | Same Wi-Fi                                 | **Direct** (local candidates)                                                  |
| Home router                     | Home router (another city)                 | **Direct** through STUN · _lab 1, 7_                                           |
| Home router                     | Mobile data, carrier with a "friendly" NAT | **Direct** through STUN (many carriers)                                        |
| Home router                     | Strict / symmetric NAT (some carriers)     | **Not possible.** Explained, "Try again", link fallback · _lab 2_              |
| Network that blocks UDP         | Anything                                   | **Not possible.** Explained, naming which device's network · _lab 3_           |
| Strict NAT                      | Strict NAT                                 | **Not possible** without a relay; works with the optional TURN relay · _lab 6_ |
| Network changes mid-transfer    |                                            | **Repaired** by ICE restart; the transfer continues · _lab 5_                  |
| Moves to another network, retry |                                            | **"Try again"** reconnects the same devices, no new code · _lab 4_             |

Mobile networks differ by carrier and even by region. Whether a given phone on mobile data connects directly depends on that carrier's NAT. When both devices have IPv6 (common on mobile and some home connections), browsers can often connect directly over IPv6 without any NAT; both default STUN servers answer over IPv6 too.

## 4. When a direct connection isn't possible

The app tells the user what happened, in English or Macedonian, and what to do:

| Cause (from what both devices found)       | Message (abridged)                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Both found public addresses, still no path | "Both devices are online, but their networks don't allow a direct connection between them…"  |
| This device found no public address        | "This device's network blocks direct connections… Try another network, such as mobile data…" |
| The other device found no public address   | "The other device's network blocks direct connections…"                                      |
| Nothing arrived from the other device      | "The other device didn't answer in time. Check that its page is still open…"                 |
| No STUN configured on the server           | "This server only connects devices on the same network…"                                     |

Then:

- **Try again** reconnects the same two devices without a new code, up to 5 retries per session. Use it after moving one device to another network (for example, turning Wi-Fi off on a phone).
- **Send as a link instead** (sender) moves the chosen files to Share Files without choosing them again. They are encrypted in the browser and uploaded to the existing private Vercel Blob store, and the link works on any network. Limits and budget are those of Share Files (100 MB per package in the current setup; the Blob write budget stops new shares before the Hobby allowance runs out). Receivers see "Or ask the sender to share the files as a link".
- **Connection details** shows, without any addresses, what each device found: public address found or not, strict NAT detected, whether a relay is set up, and how long the attempt ran.

While connecting, the status changes after 8 s to "Still trying… Devices on different networks can take up to half a minute." If an established connection drops, both devices show "Connection interrupted. Reconnecting…" while ICE restarts (up to two restarts within 25 s). After that the connection counts as lost.

## 5. Free STUN servers

STUN only tells a device its public address. It never carries file data, and it can't connect networks that forbid direct paths.

| Server                          | Status                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stun:stun.l.google.com:19302`  | Google's public STUN endpoint, the de facto WebRTC default. No account; no published service level.                                                                              |
| `stun:stun.cloudflare.com:3478` | Cloudflare: "Cloudflare's STUN service at stun.cloudflare.com is free and unlimited" ([Realtime TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)). Standard port. |

Two independent providers on two ports keep working when one is down or a network blocks one port. The two answers also reveal a strict NAT (one socket, two different public ports), which the diagnostics use.

Configure with `STUN_URLS` (comma-separated, validated, at most 4; `""` turns STUN off, leaving only same-network connections). The list lives only on the server (`src/server/signaling/ice.ts`) and reaches browsers with each session. There are no credentials in the bundle and no list duplicated in the frontend.

## 6. TURN relay: optional, off by default

A TURN relay forwards the encrypted traffic when no direct path exists, which covers every case marked "not possible" above. It is **not enabled** because every option costs either money or the bandwidth of a machine someone keeps running:

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

## 7. What signaling costs on the free plans

Every poll is one Vercel function call and about 4 Upstash Redis commands. The Upstash free plan includes 500K commands a month, and the database was added without a payment method, so it cannot bill. Upstash doesn't document what a free database does at the limit; expect requests to be refused until the month ends, not charges. The client therefore polls only as often as needed:

| State                                   | Poll interval                                    |
| --------------------------------------- | ------------------------------------------------ |
| Messages flowing (pairing, negotiation) | 0.4 s (for 6 s after the last message)           |
| Waiting for the other device            | 1.5 s (the code expires after 10 min)            |
| After a failed attempt                  | 5 s, for at most 5 minutes ("Try again")         |
| Devices connected directly              | 15 s (presence only; 0.4 s again during repairs) |

Roughly: a 10-minute session costs about 600 commands (≈ 800 such sessions a month), and a session left open for 8 hours about 15,000. Before this change, connected sessions polled every 5 s, about three times as much.

## 8. Testing across networks

**With real devices.** This is the test that matters, because real carriers differ.

1. Open the deployed app (`https://preprati.vercel.app`) on a laptop on home Wi-Fi.
2. On a phone, **turn Wi-Fi off** (mobile data only), scan the QR code, and send a file.
3. Check the badge: "Direct connection" means STUN worked across the two networks.
4. If it fails, open **Connection details** and note what each device found. Try **Try again** after switching networks, a phone hotspot, a friend's network or another carrier, and **Send as a link instead**.
5. For a network change mid-transfer, start a large transfer on Wi-Fi, then turn Wi-Fi off on the phone. Expect "Reconnecting…" and then the transfer continuing.

**Local development can't test this.** `npm run dev` and `npm run dev:lan` serve only your computer and your local network (with a self-signed certificate for phones). Devices on other networks can't reach that signaling server, even with STUN. Test cross-network behaviour against a public deployment (production or a Vercel preview deployment), not with temporary tunnel addresses written into configuration.

**NAT lab (no second network needed).** `scripts/nat-lab/lab.sh` builds two NATed networks and a "public" server in Docker and drives the real app in real Chrome on both sides. Linux with Docker, Node and Google Chrome; run `npm run build` first:

```bash
scripts/nat-lab/lab.sh up          # networks, NAT routers, STUN ×2, coturn (all named preprati-lab-*)
scripts/nat-lab/lab.sh scenarios   # 1–7 below, or e.g. `scenarios 2 5`
scripts/nat-lab/lab.sh down        # removes everything it created
```

Results from 12 October 2026 (current code; every transferred file byte-identical):

| #   | Scenario                                                    | Result                                                                                                                  |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Two home routers, HTTP signaling (as on Vercel)             | Direct connection in ~0.5 s of ICE; 2 MB transferred                                                                    |
| 2   | Home router ↔ strict NAT, no relay                          | Fails in ~16 s with "networks don't allow a direct connection"; strict NAT correctly attributed to the device behind it |
| 3   | UDP blocked on A                                            | A: "This device's network blocks…"; B: "The other device's network blocks…"                                             |
| 4   | Strict NAT fails → B moves to a home network → "Try again"  | Reconnected directly within ~5 s, same session and code, file transferred                                               |
| 5   | A gets a new public address mid-transfer (30 MB, throttled) | Both showed "Reconnecting…"; ICE restart reconnected ~4 s after the drop was detected; transfer completed               |
| 6   | Strict NAT on both sides, coturn configured                 | "Relayed connection", transfer completed                                                                                |
| 7   | Two home routers, WebSocket signaling (self-hosted server)  | Direct connection, transfer completed                                                                                   |

The lab mounts the host filesystem read-only into its containers and chroots into it, to run the host's own Node and Chrome inside the lab's network namespaces as your user. Results land in `test-results/nat-lab/`.

## 9. Privacy

- Candidates exchanged through signaling contain the devices' network addresses. The other device learns your public IP address, as with any direct (WebRTC) connection. The signaling server relays candidates and stores nothing after the session.
- The STUN providers see the public address they report back, like any server you contact.
- A TURN relay, if you add one, sees traffic volume and both devices' addresses. The content stays end-to-end encrypted (DTLS).
- Connection diagnostics in the interface contain counts and flags only, never addresses or ports.

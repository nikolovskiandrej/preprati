# preprati.

**From here to there.** Send files between your devices. No accounts. No installations. Just transfer.

preprati. is a browser-based file transfer product with two clearly separated modes:

|                         | **Quick Transfer**                                                                                                                                                                 | **Share Files**                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| For                     | Moving files between devices that are online right now                                                                                                                             | Sending files to someone who opens them later                                  |
| How                     | Live session via QR code, link or 6-character pairing code; files go over a WebRTC data channel, or end-to-end encrypted through preprati. when the devices can't connect directly | Files are encrypted in the browser, uploaded, and shared as a link + QR code   |
| Server sees             | Device labels and WebRTC negotiation only (in relay mode, also ciphertext). No file names or contents                                                                              | Ciphertext and minimal metadata. No key, file names, types or individual sizes |
| Sender must stay online | Yes                                                                                                                                                                                | No — until expiry (default 24 h) or deletion                                   |

Both modes have **Copy QR Code** (a real PNG on the clipboard, with an honest fallback to downloading the PNG), **Download QR Code**, **Copy Link** and native **Share**.

---

## Quick start

Requirements: **Node.js ≥ 22.12** (developed on Node 24), npm.

```bash
npm install
npm run dev          # API on :8787, app on http://localhost:5173
```

Open http://localhost:5173 in two browser windows (or a normal and a private window), choose **Receive files** in one and join from the other with the code. Hosted sharing uses `./data/shares` in development.

### Testing with a phone on your network

```bash
npm run dev:lan      # https://<your-LAN-IP>:5173 (self-signed certificate)
```

Accept the certificate warning once on the phone. Share Files and Copy QR Code need a secure context (HTTPS), which is why LAN testing uses HTTPS.

### Production

```bash
npm run build
NODE_ENV=production PUBLIC_ORIGIN=https://preprati.example TRUST_PROXY=1 \
STORAGE_DRIVER=local STORAGE_DIR=/var/lib/preprati/shares \
npm start            # one process: frontend + API + signaling on :8787
```

Or `docker compose up -d --build`. Production needs **HTTPS/WSS** in front (reverse proxy) and **persistent storage** for Share Files. Without `STORAGE_DRIVER`, Share Files stays off and says so. See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for proxy, TURN, S3 and scaling notes.

### Vercel

The repository also deploys to **Vercel** as a serverless profile of the same app: the frontend on the CDN, the API as one function, signaling over HTTP polling, shared state in **Upstash Redis**, and encrypted packages in a **private Vercel Blob** store. Setup and plan limits: **[docs/DEPLOYMENT.md#vercel](docs/DEPLOYMENT.md#vercel)**.

---

## Scripts

| Command                | Does                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `npm run dev`          | Backend (tsx watch) + Vite dev server with proxy                                       |
| `npm run dev:lan`      | Same, served over HTTPS on all interfaces for phone testing                            |
| `npm run build`        | Frontend → `dist/client` (with precompressed .br/.gz), server → `dist/server/index.js` |
| `npm start`            | Runs the production server                                                             |
| `npm run build:vercel` | Frontend + Vercel Build Output (`.vercel/output`: static files, API function, cron)    |
| `npm run typecheck`    | TypeScript for client, server and tests                                                |
| `npm run lint`         | ESLint (TypeScript, React hooks, jsx-a11y)                                             |
| `npm test`             | Vitest unit + integration suites                                                       |
| `npm run test:e2e`     | Builds, then Playwright end-to-end tests in Chrome against the production build        |
| `npm run check`        | lint + typecheck + test + build                                                        |
| `npm run nat-check`    | Tells whether this computer's network allows direct connections across networks        |

Optional cross-network tests: NATed networks in Docker, the real app in real Chrome (Linux, Docker, Chrome; [details](docs/CONNECTIVITY.md#9-testing-across-networks)):

```bash
npm run build && scripts/nat-lab/lab.sh up && scripts/nat-lab/lab.sh scenarios && scripts/nat-lab/lab.sh down
```

Optional S3 adapter tests against any S3-compatible server:

```bash
docker run --rm -p 127.0.0.1:18333:8333 chrislusf/seaweedfs server -s3
PREPRATI_S3_TEST_ENDPOINT=http://127.0.0.1:18333 npm test -- s3Store
```

---

## Configuration

All settings are environment variables with defaults; **[.env.example](.env.example)** documents each one. The most important:

| Variable                                                                                  | Default                                 | Purpose                                                                                                             |
| ----------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`                                                                           | –                                       | Public https origin (origin checks, CSP, HSTS)                                                                      |
| `TRUST_PROXY`                                                                             | `false`                                 | Proxy hops to trust for client IPs                                                                                  |
| `STORAGE_DRIVER`                                                                          | `local` in dev, **unset in production** | `local`, `s3` or `vercel-blob`; unset = Share Files disabled                                                        |
| `STORAGE_DIR` / `S3_*`                                                                    | `data/shares`                           | Where encrypted packages live                                                                                       |
| `SHARE_TTL`                                                                               | `24h`                                   | Share link lifetime                                                                                                 |
| `SHARE_MAX_FILE_SIZE`, `SHARE_MAX_PACKAGE_SIZE`, `SHARE_MAX_FILES`, `SHARE_STORAGE_QUOTA` | `1GB`, `1GB`, `100`, `20GB`             | Limits shown to users before upload                                                                                 |
| `SESSION_PAIRING_TTL`                                                                     | `10m`                                   | How long a pairing code / QR waits for a device                                                                     |
| `STUN_URLS`                                                                               | Google + Cloudflare STUN (free)         | Direct connections across networks ([details](docs/CONNECTIVITY.md#6-free-stun-servers))                            |
| `TURN_URLS` + `TURN_SECRET`                                                               | – (off)                                 | Optional relay for strict networks ([options and costs](docs/CONNECTIVITY.md#7-turn-relay-optional-off-by-default)) |
| `NOTEA_URL`                                                                               | –                                       | Link for the "Made by Notea" attribution                                                                            |
| `SIGNALING_TRANSPORT`, `KV_REST_API_URL` + `KV_REST_API_TOKEN`, `CRON_SECRET`             | `websocket`; `http` on Vercel           | Serverless profile: HTTP signaling, Redis state, cleanup cron                                                       |

Frontend-public build variables (`VITE_API_BASE_URL`, `VITE_SIGNALING_URL`) are only needed when the frontend is hosted on a different origin. Secrets are never part of the bundle.

---

## How it works

- **Quick Transfer:** the signaling server (WebSocket, or HTTP polling on serverless hosts) pairs two browsers and relays offers, answers and ICE candidates. Two free STUN servers let devices on different networks connect directly. Files then move over a reliable WebRTC data channel using a small protocol: validated control messages, binary chunks with transfer tag, file index and sequence number, backpressure on `bufferedAmount`, receiver-acknowledged progress, and an explicit accept step. A device joining a _sending_ host by the short code must be allowed by the host first.
- **Across networks:** when a direct connection isn't possible (a strict NAT on mobile data, a network that blocks UDP, or a Wi-Fi that keeps its devices apart), the app explains why, offers **Try again** without a new code, and lets the sender **Send through preprati.**: relay mode moves the files end-to-end encrypted through the temporary share storage, inside the same session. A connection that drops mid-transfer (Wi-Fi → mobile data) is repaired with an ICE restart, and phones keep their screen on while a session is live. See **[docs/CONNECTIVITY.md](docs/CONNECTIVITY.md)**.
- **Share Files:** the browser generates a 256-bit key, derives AES-256-GCM keys with HKDF, encrypts an (padded) manifest of file names/types/sizes and every chunk of the concatenated files, uploads ciphertext, and builds `https://host/s/<id>#<key>`. The key stays in the URL fragment, which browsers never send to the server. Recipients decrypt and verify everything locally before a file is saved. Expiry is enforced on every read; a cleanup job deletes expired ciphertext.

Details: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** · **[docs/CONNECTIVITY.md](docs/CONNECTIVITY.md)** · **[docs/PROTOCOL.md](docs/PROTOCOL.md)** · **[docs/SECURITY.md](docs/SECURITY.md)** · **[docs/BRAND.md](docs/BRAND.md)** · **[docs/ICONS.md](docs/ICONS.md)**

### Privacy in one paragraph

Quick Transfer stores nothing on the server, except in relay mode, which the sender chooses: then the files are stored encrypted until the receiver has them (and never longer than the share lifetime). If a TURN relay is configured, it may carry the (still encrypted) traffic on some networks. The app tells you which way the files travel. Share Files stores only encrypted data, temporarily. **Anyone who has the complete share link can download the files until they expire or are deleted**, so share links only with people you trust.

---

## Project structure

```
src/shared/   constants, schemas and layout math used by client and server
src/server/   Fastify app: signaling, share API, storage adapters, security
src/client/   React app: brand, icons, i18n (EN/MK), transfer + share engines, UI, screens
tests/        Vitest (unit, integration, UI)
e2e/          Playwright (real WebRTC transfers, sharing, responsive, accessibility)
docs/         architecture, protocol, security, deployment, brand, icons
public/       favicons, app icons, manifest, robots.txt, theme bootstrap
```

The original brand references (`Современ концепт за бренд Препрати.png`, `Pasted image.png`) are kept in the project root. The app uses vector logo geometry derived from the concept image. The footer shows transparent copies of the Notea mark: dark green on light (`src/client/assets/notea-logo.png`) and Notea's mint mark on dark (`src/client/assets/notea-logo-on-dark.png`).

## Browser support

Current Chrome, Edge, Firefox and Safari (desktop and mobile). Quick Transfer needs WebRTC data channels. Share Files and Copy QR Code need a secure context (HTTPS or localhost). Where image copying isn't available, the app says so and offers the PNG download; where native sharing isn't available, it copies the link and says so.

## Known limitations

- Interrupted transfers and uploads restart from the beginning (no resume).
- Received/downloaded files are assembled as browser Blobs before saving, so the receiving browser's memory and disk bound very large files.
- On a long-lived server, signaling state and rate limits are in memory: one instance (or sticky sessions) per deployment. The serverless profile keeps this state in Redis instead.
- On Vercel's Hobby plan, share sizes are capped lower (100 MB in the setup above), Blob operations are budgeted, and the cleanup cron runs daily. Expiry is still enforced on every request.
- Without a TURN relay (off by default, because relays cost bandwidth), some network combinations cannot connect directly, most often a strict NAT on mobile data, or a Wi-Fi that keeps its devices apart. The app explains why, and the sender can send through preprati. instead (relay mode, within the Share Files size limits and storage budget). See [docs/CONNECTIVITY.md](docs/CONNECTIVITY.md).
- Cross-network behaviour can't be tested with `npm run dev`/`dev:lan` (they serve only your network); use the deployed app with real devices, or the Docker NAT lab (`scripts/nat-lab/lab.sh`).

# Deployment

preprati. is **one Node process** that serves the frontend, the HTTP API and the signaling WebSocket. It needs:

1. **HTTPS and WSS.** Browsers allow Web Crypto (Share Files) and the async Clipboard API (Copy QR Code) only in secure contexts, and phones expect HTTPS. Terminate TLS in a reverse proxy that supports WebSocket upgrades.
2. **Persistent storage** for Share Files: a persistent disk (`STORAGE_DRIVER=local`) or S3-compatible object storage (`STORAGE_DRIVER=s3`).
3. Optionally a **TURN server** for networks where devices cannot connect directly (off by default; see [CONNECTIVITY.md](CONNECTIVITY.md) for what works without one and what a relay costs).

Static-only hosting (GitHub Pages, a CDN alone) cannot run the signaling server or the storage API. For serverless hosting, the same app has a **Vercel profile** (see [Vercel](#vercel)).

## Build & run

```bash
npm ci
npm run build                     # dist/client (SPA) + dist/server/index.js
NODE_ENV=production \
PUBLIC_ORIGIN=https://preprati.example \
TRUST_PROXY=1 \
STORAGE_DRIVER=local STORAGE_DIR=/var/lib/preprati/shares \
node dist/server/index.js         # listens on 0.0.0.0:8787
```

Requires Node.js ≥ 22.12 (developed on Node 24). Production dependencies only: `npm ci --omit=dev` after copying `dist/`.

### Docker

```bash
docker build -t preprati .
docker run -d -p 127.0.0.1:8787:8787 \
  -e PUBLIC_ORIGIN=https://preprati.example -e TRUST_PROXY=1 \
  -e STORAGE_DRIVER=local -e STORAGE_DIR=/data/shares \
  -v preprati-data:/data preprati
```

…or `docker compose up -d --build` with the included `docker-compose.yml`. The image runs as the unprivileged `node` user and has a health check (`/api/health`). Without `STORAGE_DRIVER`, Quick Transfer works and Share Files reports that it isn't configured.

## Reverse proxy

**Caddy** (automatic HTTPS):

```caddyfile
preprati.example {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
}
```

**Nginx:**

```nginx
server {
    listen 443 ssl http2;
    server_name preprati.example;
    # ssl_certificate …; ssl_certificate_key …;

    client_max_body_size 20m;          # ≥ SHARE_CHUNK_SIZE + overhead
    proxy_read_timeout 3600s;          # long-lived signaling sockets

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
    }
}
```

Set `TRUST_PROXY` to the number of proxy hops (usually `1`) so rate limits see real client IPs, and `PUBLIC_ORIGIN` to the public origin (used for origin checks, CSP and HSTS). **Disable access logging of request paths** at the proxy if you can: they contain share and session ids. Share keys are never in paths, but ids are still capabilities for metadata such as expiry.

## Storage

|            | Local disk (`local`)                                                 | Object storage (`s3`)                                                        |
| ---------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Setup      | A directory on a persistent volume                                   | Bucket + access key (AWS S3, Cloudflare R2, Backblaze B2, MinIO, SeaweedFS…) |
| Durability | As good as the disk; lost if the container's filesystem is ephemeral | Managed, replicated                                                          |
| Scale      | One server                                                           | Bucket scales independently; the app itself stays one process                |
| Cost       | Disk space                                                           | Storage + requests + **egress** (each download is served through the app)    |

Recommendations:

- Size `SHARE_STORAGE_QUOTA` to the disk/bucket budget. Uploads beyond it are refused with a clear message.
- S3: keep the bucket private (no public access), give the key only `s3:PutObject`, `GetObject`, `DeleteObject`, `ListBucket` on the bucket/prefix, and add a lifecycle rule expiring objects under `S3_PREFIX` after a few days as a safety net.
- Bandwidth: every share download passes through the server, so budget egress accordingly (e.g. 1 GB shared with 5 people ≈ 5 GB out).
- Backups are unnecessary and undesirable: shares are temporary by design.

## TURN (optional)

Without TURN, devices on restrictive networks (symmetric NAT, some mobile carriers, corporate firewalls, Wi-Fi networks that keep devices apart) cannot connect directly. The app explains why, offers "Try again" and lets the sender **Send through preprati.**: relay mode moves the files end-to-end encrypted through the share storage, so it needs Share Files to be enabled (any storage driver) and inherits its size limits and budget ([CONNECTIVITY.md §5](CONNECTIVITY.md#5-relay-mode-send-through-preprati)). A TURN relay is off by default because it costs bandwidth; [CONNECTIVITY.md §7](CONNECTIVITY.md#7-turn-relay-optional-off-by-default) compares the options, including coturn on hardware you already own. With [coturn](https://github.com/coturn/coturn):

```ini
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
realm=preprati.example
use-auth-secret
static-auth-secret=<same value as TURN_SECRET>
cert=/etc/ssl/turn.pem
pkey=/etc/ssl/turn.key
no-cli
no-tcp-relay
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

```bash
TURN_URLS=turn:turn.preprati.example:3478?transport=udp,turns:turn.preprati.example:5349?transport=tcp
TURN_SECRET=<random secret>
```

Browsers receive short-lived HMAC credentials (`TURN_CREDENTIAL_TTL`), never the secret. Relayed traffic remains DTLS-encrypted end to end, but it consumes your bandwidth.

## Scaling notes

- Signaling state, rate limits and the share index live in memory. Run **one instance**, or put several behind sticky sessions for `/ws` with shared object storage. Limits then apply per instance, and a session's two devices must reach the same instance. To run many instances without sticky sessions, use the serverless profile's shared state: `SERVERLESS=true` and `SIGNALING_TRANSPORT=http` with Redis (`KV_REST_API_URL`/`KV_REST_API_TOKEN`).
- The process is light: signaling messages are tiny, and share traffic is streaming I/O.
- Graceful shutdown on `SIGTERM`: sessions are closed with a reason; the process exits within 10 s.

## Vercel

The repository also deploys to Vercel as a **serverless profile** of the same app. `vercel.json` runs `npm run build:vercel`, which writes a [Build Output API](https://vercel.com/docs/build-output-api/v3) bundle (`scripts/build-vercel.mjs`):

- the frontend is served by Vercel's CDN, with the same security headers and CSP as the Node server;
- every `/api/*` request runs in one Node.js function (`src/server/vercel.ts`), the same Fastify app;
- a Vercel Cron job calls `GET /api/cron/cleanup` once a day (authorized with `CRON_SECRET`).

Function instances are short-lived and don't share memory, and two devices are not guaranteed to reach the same instance. So on Vercel the app keeps shared state in Redis and signals over HTTP instead of a WebSocket:

|                          | Node server                      | Vercel                                                                  |
| ------------------------ | -------------------------------- | ----------------------------------------------------------------------- |
| Quick Transfer signaling | WebSocket `/ws`, state in memory | HTTP polling `/api/signal/*`, state in Redis                            |
| Share metadata and quota | memory + storage                 | Redis                                                                   |
| Encrypted packages       | disk or S3                       | a **private** Vercel Blob store (or S3)                                 |
| Expiry cleanup           | on every read + a timer (5 min)  | on every read + a sweep triggered by traffic (≤ 5 min) + the daily cron |

Files still move directly between the two devices over WebRTC; only the small signaling messages use HTTP. The polling client sends its messages in order as numbered, idempotent requests, and acknowledges what it received, so a response lost on a mobile network is delivered again. It checks its inbox every 0.4 s while messages flow, every 1.5 s while pairing, every 5 s after a failed attempt (for up to 5 minutes) and every 15 s once the devices are connected.

### Set up

1. Create a Vercel project from the repository (or `vercel link` locally). `vercel.json` sets the install and build commands; there is no framework preset.
2. **Redis:** add _Upstash for Redis_ from the Vercel Marketplace and connect it to the project. It provides `KV_REST_API_URL` and `KV_REST_API_TOKEN` (`UPSTASH_REDIS_REST_URL`/`_TOKEN` work too).
3. **Blob:** create a **private** Blob store and connect it to the project, e.g. `vercel blob create-store preprati-shares --access private`. Connecting sets `BLOB_READ_WRITE_TOKEN`.
4. **Environment variables** (Production):

   ```
   STORAGE_DRIVER=vercel-blob
   CRON_SECRET=<random, at least 32 characters>
   SHARE_CHUNK_SIZE=4MB          # each upload request stays under the 4.5 MB body limit
   SHARE_MAX_FILE_SIZE=100MB
   SHARE_MAX_PACKAGE_SIZE=100MB
   SHARE_STORAGE_QUOTA=800MB     # below the plan's Blob storage
   SHARE_MAX_ACTIVE=200
   SHARE_TTL=24h
   BLOB_MONTHLY_WRITE_BUDGET=1800
   ```

   `SERVERLESS=true` and `SIGNALING_TRANSPORT=http` follow from Vercel's `VERCEL=1`. Without Redis the function refuses to start with a clear error. Without a storage driver, Quick Transfer works and Share Files says it isn't configured.

5. Deploy (`vercel deploy --prod`, or push to the production branch of a connected repository) and open `/api/health`.

### Limits to plan for

- **Request bodies** are limited to 4.5 MB per function call ([limits](https://vercel.com/docs/functions/limitations)), so `SHARE_CHUNK_SIZE` must stay below that. 4 MB chunks keep a margin.
- **Blob operations are metered** ([usage and pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing)). On the Hobby plan, going over the included amount blocks the store for a while, so `BLOB_MONTHLY_WRITE_BUDGET` stops _new_ shares before the allowance runs out (the interface then reports storage as full). Each package costs one write per chunk plus two (manifest and the completeness check at finalize). Deleting is free. Each chunk download is one read.
- **Cron jobs** run at most once a day on Hobby ([cron usage](https://vercel.com/docs/cron-jobs/usage-and-pricing)). Expiry itself is exact: the API refuses expired packages and deletes their data as soon as anyone asks for them, and any API traffic triggers a sweep of due packages from a Redis index (no storage listing). A package nobody touches after expiry, while the site has no traffic at all, is deleted by the next daily run. Until then it stays encrypted in the private store and unreachable through the API.
- **Polling costs requests.** Every poll is a function invocation plus about 4 Redis commands: roughly 600 commands for a 10-minute session, against 500K a month on Upstash's free plan ([estimate](CONNECTIVITY.md#8-what-signaling-costs-on-the-free-plans)).
- **No TURN relay is included.** Set `TURN_URLS` with `TURN_SECRET` (or `TURN_USERNAME`/`TURN_CREDENTIAL`) for networks where devices can't connect directly; read [CONNECTIVITY.md §7](CONNECTIVITY.md#7-turn-relay-optional-off-by-default) first. Without one, relay mode covers those networks within the share limits.

## Local network testing (phones)

```bash
npm run dev:lan          # https://<your-LAN-IP>:5173 with a self-signed certificate
```

Open the address on the phone and accept the certificate warning once (Web Crypto and clipboard need a secure context). Both devices must reach your computer; WebRTC then connects directly on the LAN.

This tests one network only: devices elsewhere can't reach a signaling server on your computer. To test **across networks** (laptop on Wi-Fi, phone on mobile data), use a public deployment, or the Docker NAT lab. See [CONNECTIVITY.md §9](CONNECTIVITY.md#9-testing-across-networks).

## Checklist

- [ ] HTTPS/WSS in front, `PUBLIC_ORIGIN` and `TRUST_PROXY` set
- [ ] `STORAGE_DRIVER` chosen, volume/bucket persistent, quota sized
- [ ] STUN reachable (default: Google + Cloudflare); TURN only if you accept its bandwidth or cost (otherwise some networks cannot connect directly and users are offered a share link)
- [ ] `NOTEA_URL` set if the attribution should link somewhere
- [ ] Proxy access logs don't record full paths (or are rotated quickly)
- [ ] `/api/health` wired into your monitoring

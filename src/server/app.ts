/**
 * Builds the preprati. backend: signaling WebSocket, encrypted-share API,
 * runtime config, health check and (in production) the static frontend.
 *
 * `buildApp` does not listen on a port, so tests can drive it with
 * `app.inject()` or start it on an ephemeral port.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { SHARE_CHUNK_MAX_BYTES, SHARE_CHUNK_OVERHEAD } from '../shared/constants';
import type { PublicConfig } from '../shared/shareApi';
import type { ServerConfig } from './config';
import { ApiError, sendApiError } from './http/apiError';
import { applySecurityHeaders } from './security/headers';
import { isOriginAllowed } from './security/origin';
import { RateLimiter } from './security/rateLimiter';
import { createKv, type KvStore } from './kv';
import { KvUsageTracker } from './shares/kvUsage';
import { registerShareRoutes } from './shares/routes';
import { ShareService } from './shares/shareService';
import { registerHttpSignalingRoutes } from './signaling/httpRoutes';
import { iceServersFor } from './signaling/ice';
import { PollingSignaling } from './signaling/pollingSignaling';
import { registerSignalingRoute } from './signaling/route';
import { SessionManager } from './signaling/sessionManager';
import { createBlobStore, type BlobStore } from './storage';

/** How often (per instance) serverless requests trigger a sweep of due packages. */
const SERVERLESS_SWEEP_INTERVAL_MS = 5 * 60_000;

export interface BuildAppOptions {
  /** Override the storage adapter (tests). `null` disables hosted sharing. */
  store?: BlobStore | null;
  /** Override the shared KV store (tests). */
  kv?: KvStore | null;
  now?: () => number;
  logger?: boolean;
  /** Platform hook for work that continues after a response (Vercel's waitUntil). */
  waitUntil?: (task: Promise<unknown>) => void;
}

export interface PrepratiApp {
  app: FastifyInstance;
  sessions: SessionManager;
  /** Resolves once hosted sharing finished initializing (successfully or not). */
  shareReady: Promise<void>;
  getShareService(): ShareService | null;
  runCleanup(): Promise<void>;
}

export async function buildApp(
  config: ServerConfig,
  options: BuildAppOptions = {},
): Promise<PrepratiApp> {
  const now = options.now ?? Date.now;
  const app = Fastify({
    logger:
      options.logger === false || config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            // Never log raw URLs: they contain share and session identifiers.
            serializers: {
              req: (req) => ({ method: req.method, route: req.routeOptions?.url ?? 'unmatched' }),
            },
          },
    trustProxy: toTrustProxy(config.trustProxy),
    // Per-request logs would contain share/session ids in URLs; we log route patterns ourselves.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    requestTimeout: config.share.requestTimeoutMs,
    connectionTimeout: config.share.requestTimeoutMs,
    return503OnClosing: true,
  });

  for (const warning of config.warnings) app.log.warn(warning);

  /* ----------------------------- Body parsing ------------------------------ */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: SHARE_CHUNK_MAX_BYTES + SHARE_CHUNK_OVERHEAD },
    (_request, body, done) => done(null, body),
  );

  /* --------------------------- Security & limits --------------------------- */
  app.addHook('onSend', async (request, reply, payload) => {
    applySecurityHeaders(request, reply, config);
    return payload;
  });

  await app.register(cors, {
    delegator: (request, callback) => {
      const allowed = isOriginAllowed(request.headers.origin, request.headers.host, config);
      callback(null, {
        origin: allowed,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: [
          'Authorization',
          'Content-Type',
          'X-Signal-Connection',
          'X-Signal-Seq',
          'X-Signal-Ack',
        ],
        maxAge: 600,
        credentials: false,
      });
    },
  });

  const apiLimiter = new RateLimiter({ limit: config.rateLimits.apiPerMinute, windowMs: 60_000 });
  // Signaling polls have their own budget so they never starve share uploads.
  const pollLimiter = new RateLimiter({ limit: config.rateLimits.apiPerMinute, windowMs: 60_000 });
  const createLimiter = new RateLimiter({
    limit: config.rateLimits.shareCreatePerHour,
    windowMs: 3_600_000,
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (!isOriginAllowed(request.headers.origin, request.headers.host, config)) {
      return sendApiError(reply, 403, 'invalid-request', 'Origin not allowed');
    }
    const limiter = request.url.startsWith('/api/signal/poll') ? pollLimiter : apiLimiter;
    const limit = limiter.consume(request.ip);
    if (!limit.allowed) {
      return sendApiError(
        reply,
        429,
        'rate-limited',
        'Too many requests',
        limit.retryAfterMs / 1000,
      );
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url;
    if (!route || route.includes('/chunks/')) return;
    request.log.debug({
      method: request.method,
      route,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    });
  });

  /* ------------------------------- Signaling ------------------------------- */
  const kv = options.kv !== undefined ? options.kv : createKv(config.kv);
  const sessions = new SessionManager({
    pairingTtlMs: config.sessions.pairingTtlMs,
    maxLifetimeMs: config.sessions.maxLifetimeMs,
    maxSessions: config.sessions.maxSessions,
    maxSessionsPerIp: config.sessions.maxSessionsPerIp,
    iceServers: (sessionId) => iceServersFor(config.ice, sessionId, now()),
    now,
  });
  // WebSocket signaling for long-lived servers; HTTP polling (shared KV state) for serverless.
  let signaling: { close(): void } = { close: () => sessions.shutdown() };
  if (config.signalingTransport === 'websocket') {
    await app.register(websocket, { options: { maxPayload: config.sessions.maxMessageBytes } });
    signaling = registerSignalingRoute(app, { config, sessions, now });
  }
  if (kv) {
    registerHttpSignalingRoutes(
      app,
      new PollingSignaling(kv, {
        pairingTtlMs: config.sessions.pairingTtlMs,
        maxLifetimeMs: config.sessions.maxLifetimeMs,
        maxSessionsPerIpPer10Min: Math.max(config.sessions.maxSessionsPerIp * 3, 10),
        joinFailuresPer10Min: config.rateLimits.joinFailuresPer10Min,
        iceServers: (sessionId) => iceServersFor(config.ice, sessionId, now()),
        now,
      }),
    );
  }

  /* ---------------------------- Hosted sharing ----------------------------- */
  let shareService: ShareService | null = null;
  let shareError: ApiError | null = config.share.enabled
    ? new ApiError('storage-unavailable', 503, 'Temporary storage is starting up', 5)
    : new ApiError(
        'share-disabled',
        503,
        config.share.unavailableReason === 'not-configured'
          ? 'Hosted sharing is not configured on this server'
          : 'Hosted sharing is disabled on this server',
      );
  const store =
    options.store !== undefined
      ? options.store
      : config.share.enabled
        ? createBlobStore(config, kv)
        : null;

  const initShares = async (): Promise<void> => {
    if (!config.share.enabled || !store || shareService) return;
    const candidate = new ShareService({
      store,
      config: config.share,
      now,
      log: (level, message, details) => app.log[level](details ?? {}, message),
      // Several stateless instances share the storage: always read fresh metadata,
      // skip the startup scan (the scheduled job does it) and count capacity in KV.
      consistentReads: config.serverless,
      reconcileOnInit: !config.serverless,
      usage:
        config.serverless && kv
          ? new KvUsageTracker(kv, {
              quotaBytes: config.share.quotaBytes,
              maxActive: config.share.maxActive,
            })
          : undefined,
      waitUntil: options.waitUntil,
    });
    try {
      await candidate.init();
      shareService = candidate;
      shareError = null;
      app.log.info({ driver: store.kind }, 'hosted sharing ready');
    } catch (error) {
      shareError = new ApiError('storage-unavailable', 503, 'Temporary storage is unavailable', 30);
      app.log.error(
        { err: error, driver: store.kind },
        'hosted sharing unavailable: storage initialization failed',
      );
    }
  };
  const shareReady = initShares();

  registerShareRoutes(app, {
    config,
    createLimiter,
    getService: () =>
      shareService ?? shareError ?? new ApiError('storage-unavailable', 503, 'Unavailable'),
  });

  let cleanupRunning = false;
  const runCleanup = async () => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
      if (!shareService) {
        await initShares();
        return;
      }
      const report = await shareService.cleanup();
      if (report.expired + report.abandoned + report.purged > 0)
        app.log.info(report, 'share cleanup');
    } catch (error) {
      app.log.warn({ err: error }, 'share cleanup failed');
    } finally {
      cleanupRunning = false;
    }
  };
  let reconcileTick = 0;
  // Stateless functions are frozen between requests; there the scheduled job below does this.
  const cleanupTimer = config.serverless
    ? null
    : setInterval(() => {
        void runCleanup().then(async () => {
          // Every ~12 cleanups, re-scan storage for orphaned objects.
          if (shareService && ++reconcileTick % 12 === 0) {
            await shareService
              .reconcile()
              .catch((error) => app.log.warn({ err: error }, 'share reconcile failed'));
          }
        });
      }, config.cleanupIntervalMs);
  cleanupTimer?.unref();

  // Scheduled cleanup (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
  app.get('/api/cron/cleanup', async (request, reply) => {
    if (
      !config.cronSecret ||
      !secretMatches(request.headers.authorization, `Bearer ${config.cronSecret}`)
    ) {
      return sendApiError(reply, 401, 'unauthorized', 'Unauthorized');
    }
    if (!shareService) await initShares();
    if (!shareService) return reply.header('Cache-Control', 'no-store').send({ share: 'off' });
    const orphans = await shareService.reconcile();
    const report = await shareService.cleanup();
    app.log.info({ ...report, orphans }, 'scheduled share cleanup');
    return reply.header('Cache-Control', 'no-store').send({ ...report, orphans });
  });

  // Serverless: nothing runs between requests, so traffic nudges a cheap sweep of
  // due packages (expiry, abandoned uploads) instead of a timer.
  if (config.serverless) {
    app.addHook('onRequest', async () => {
      shareService?.sweepSoon(SERVERLESS_SWEEP_INTERVAL_MS);
    });
  }

  const limiterSweep = setInterval(() => {
    apiLimiter.sweep();
    pollLimiter.sweep();
    createLimiter.sweep();
  }, 60_000);
  limiterSweep.unref();

  /* --------------------------- Config & health ----------------------------- */
  app.get('/api/config', async (_request, reply) => {
    const share = config.share;
    const limits = {
      ttlSeconds: Math.round(share.ttlMs / 1000),
      maxFileBytes: share.maxFileBytes,
      maxPackageBytes: share.maxPackageBytes,
      maxFiles: share.maxFiles,
      chunkBytes: share.chunkBytes,
    };
    const body: PublicConfig = {
      version: config.version,
      quickTransfer: {
        pairingTtlSeconds: Math.round(config.sessions.pairingTtlMs / 1000),
        relayConfigured: config.ice.turn !== null,
        signaling: config.signalingTransport,
      },
      share: shareService
        ? { enabled: true, ...limits }
        : {
            enabled: false,
            reason: !config.share.enabled
              ? (config.share.unavailableReason ?? 'disabled')
              : 'storage-unavailable',
            ...limits,
          },
      attribution: { url: config.attributionUrl },
    };
    return reply.header('Cache-Control', 'no-store').send(body);
  });

  app.get('/api/health', async (_request, reply) => {
    const storageOk = shareService ? await store!.healthCheck() : null;
    const status = storageOk === false ? 'degraded' : 'ok';
    return reply
      .code(status === 'ok' ? 200 : 503)
      .header('Cache-Control', 'no-store')
      .send({
        status,
        signaling: 'ok',
        share: shareService ? (storageOk ? 'ok' : 'unavailable') : 'off',
      });
  });

  /* ------------------------- Static frontend (prod) ------------------------ */
  const indexHtml = path.join(config.staticDir, 'index.html');
  const serveStatic = config.serveStatic && existsSync(indexHtml);
  if (config.serveStatic && !serveStatic) {
    app.log.warn(
      { dir: config.staticDir },
      'SERVE_STATIC is on but no built frontend was found; run `npm run build`',
    );
  }
  if (serveStatic) {
    await app.register(fastifyStatic, {
      root: config.staticDir,
      wildcard: false,
      index: false,
      // Serve the .br/.gz files written at build time (scripts/compress-assets.mjs).
      preCompressed: true,
      setHeaders(reply, filePath) {
        const relative = path.relative(config.staticDir, filePath);
        void reply.header(
          'Cache-Control',
          relative.startsWith(`assets${path.sep}`)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api/') || request.url === '/api';
    if (serveStatic && !isApi && (request.method === 'GET' || request.method === 'HEAD')) {
      return reply
        .header('Cache-Control', 'no-cache')
        .type('text/html; charset=utf-8')
        .sendFile('index.html');
    }
    return sendApiError(reply, 404, 'not-found', 'Not found');
  });

  app.setErrorHandler(
    (error: { statusCode?: number; code?: string; message?: string }, request, reply) => {
      const status = error.statusCode ?? 500;
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return sendApiError(reply, 413, 'too-large', 'Request body too large');
      }
      if (status >= 400 && status < 500) {
        return sendApiError(reply, status, 'invalid-request', 'Invalid request');
      }
      request.log.error({ err: error }, 'unhandled error');
      return sendApiError(reply, 500, 'internal', 'Unexpected server error');
    },
  );

  app.addHook('onClose', async () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    await shareService?.settle();
    clearInterval(limiterSweep);
    signaling.close();
    await store?.close?.();
  });

  return {
    app,
    sessions,
    shareReady,
    getShareService: () => shareService,
    runCleanup,
  };
}

/** Fastify accepts hop counts at runtime but not in its types; express them as a trust function. */
function toTrustProxy(
  value: ServerConfig['trustProxy'],
): boolean | string | ((address: string, hop: number) => boolean) {
  if (typeof value === 'number') return (_address, hop) => hop < value;
  return value;
}

/** Constant-time comparison for shared secrets in headers. */
function secretMatches(received: string | undefined, expected: string): boolean {
  if (typeof received !== 'string') return false;
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

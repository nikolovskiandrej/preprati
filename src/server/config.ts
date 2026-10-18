/**
 * Server configuration, parsed from environment variables.
 *
 * Every setting has a documented default (see .env.example). Values that are
 * secrets (TURN secret, S3 credentials) are only ever read here and never
 * exposed through the public `/api/config` endpoint or the client bundle.
 */
import path from 'node:path';
import { SHARE_CHUNK_MAX_BYTES, SHARE_CHUNK_MIN_BYTES } from '../shared/constants';
import type { ShareUnavailableReason } from '../shared/shareApi';
import {
  DEFAULT_STUN_URLS,
  iceWarnings,
  validateIceUrls,
  type IceConfig,
  type TurnConfig,
} from './signaling/ice';

export type RuntimeEnv = 'development' | 'production' | 'test';
export type StorageDriver = 'local' | 's3' | 'vercel-blob';
export type SignalingTransport = 'websocket' | 'http';
export type KvDriver = 'memory' | 'upstash';

export type { TurnConfig };

export interface ServerConfig {
  env: RuntimeEnv;
  version: string;
  /** Running as stateless functions (e.g. Vercel): state lives in KV, no timers or local disk. */
  serverless: boolean;
  /** How browsers reach the signaling service. */
  signalingTransport: SignalingTransport;
  kv: {
    driver: KvDriver | null;
    url: string | null;
    token: string | null;
  };
  /** Shared secret for scheduled jobs (Vercel sends it as a Bearer token). */
  cronSecret: string | null;
  host: string;
  port: number;
  publicOrigin: string | null;
  /** Where links and QR codes point (see `readLinkOrigin`). */
  linkOrigin: string | null;
  allowedOrigins: string[];
  trustProxy: boolean | number | string;
  serveStatic: boolean;
  staticDir: string;
  logLevel: string;
  attributionUrl: string | null;
  ice: IceConfig;
  /** Valid but noteworthy settings, logged once at startup. */
  warnings: string[];
  sessions: {
    pairingTtlMs: number;
    maxLifetimeMs: number;
    maxSessions: number;
    maxSessionsPerIp: number;
    maxConnectionsPerIp: number;
    maxMessageBytes: number;
    heartbeatIntervalMs: number;
  };
  share: {
    enabled: boolean;
    unavailableReason: ShareUnavailableReason | null;
    driver: StorageDriver | null;
    ttlMs: number;
    uploadTimeoutMs: number;
    tombstoneTtlMs: number;
    maxFileBytes: number;
    maxPackageBytes: number;
    maxFiles: number;
    quotaBytes: number;
    maxActive: number;
    chunkBytes: number;
    requestTimeoutMs: number;
  };
  storage: {
    localDir: string;
    vercelBlob: {
      token: string | null;
      prefix: string;
      monthlyWriteBudget: number;
    };
    s3: {
      bucket: string | null;
      region: string;
      endpoint: string | null;
      accessKeyId: string | null;
      secretAccessKey: string | null;
      forcePathStyle: boolean;
      prefix: string;
    };
  };
  cleanupIntervalMs: number;
  rateLimits: {
    shareCreatePerHour: number;
    apiPerMinute: number;
    wsConnectPerMinute: number;
    joinFailuresPer10Min: number;
    wsMessagesPer10Sec: number;
  };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

function read(env: Env, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readBool(env: Env, key: string, fallback: boolean): boolean {
  const value = read(env, key);
  if (value === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new ConfigError(`${key} must be a boolean (true/false), got "${value}"`);
}

function readInt(env: Env, key: string, fallback: number, min: number, max: number): number {
  const value = read(env, key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}, got "${value}"`);
  }
  return parsed;
}

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** Parses "1073741824", "512MiB", "1.5 GB" … into bytes. */
export function parseBytes(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase() || 'b';
  const multiplier = BYTE_UNITS[unit];
  if (multiplier === undefined) return null;
  return Math.round(amount * multiplier);
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses "600" (seconds), "10m", "24h", "7d", "250ms" into milliseconds. */
export function parseDuration(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const multiplier = DURATION_UNITS[unit];
  if (multiplier === undefined) return null;
  return Math.round(amount * multiplier);
}

function readBytes(env: Env, key: string, fallback: number, min: number, max: number): number {
  const value = read(env, key);
  if (value === undefined) return fallback;
  const parsed = parseBytes(value);
  if (parsed === null || parsed < min || parsed > max) {
    throw new ConfigError(
      `${key} must be a size between ${min} and ${max} bytes (e.g. "512MiB"), got "${value}"`,
    );
  }
  return parsed;
}

function readDuration(
  env: Env,
  key: string,
  fallbackMs: number,
  minMs: number,
  maxMs: number,
): number {
  const value = read(env, key);
  if (value === undefined) return fallbackMs;
  const parsed = parseDuration(value);
  if (parsed === null || parsed < minMs || parsed > maxMs) {
    throw new ConfigError(
      `${key} must be a duration between ${minMs}ms and ${maxMs}ms (e.g. "10m", "24h"), got "${value}"`,
    );
  }
  return parsed;
}

function readList(env: Env, key: string, fallback: string[]): string[] {
  const value = env[key];
  if (value === undefined) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readOrigin(env: Env, key: string): string | null {
  const value = read(env, key);
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
    return url.origin;
  } catch {
    throw new ConfigError(
      `${key} must be an absolute http(s) origin such as https://preprati.example, got "${value}"`,
    );
  }
}

/**
 * The origin links and QR codes should use. Vercel serves every deployment on
 * its own URL besides the project's domain, and with deployment protection
 * (the default) those URLs ask for a Vercel login: a link copied on one would
 * send recipients to a login page. Production links therefore use the
 * project's production domain, which Vercel provides, unless PUBLIC_ORIGIN
 * names the public origin. Elsewhere links use the page's own origin.
 */
function readLinkOrigin(env: Env, publicOrigin: string | null): string | null {
  if (publicOrigin) return publicOrigin;
  const domain = read(env, 'VERCEL_PROJECT_PRODUCTION_URL');
  if (read(env, 'VERCEL_ENV') !== 'production' || !domain) return null;
  try {
    return new URL(`https://${domain}`).origin;
  } catch {
    return null;
  }
}

function readTrustProxy(env: Env): boolean | number | string {
  const value = read(env, 'TRUST_PROXY');
  if (value === undefined) return false;
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^\d+$/.test(value)) return Number(value);
  return value; // comma separated list of trusted addresses / CIDRs
}

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function loadConfig(env: Env = process.env, version = '1.0.0'): ServerConfig {
  const nodeEnv = read(env, 'NODE_ENV');
  const runtimeEnv: RuntimeEnv =
    nodeEnv === 'production' ? 'production' : nodeEnv === 'test' ? 'test' : 'development';
  const isProd = runtimeEnv === 'production';

  const allowedOrigins = readList(env, 'ALLOWED_ORIGINS', []).map((origin) => {
    try {
      return new URL(origin).origin;
    } catch {
      throw new ConfigError(`ALLOWED_ORIGINS contains an invalid origin: "${origin}"`);
    }
  });

  /* ------------------------------- ICE / TURN ------------------------------ */
  // An empty STUN_URLS ("") turns STUN off on purpose (same-network only, e.g. loopback tests).
  const stun = validateIceUrls(readList(env, 'STUN_URLS', [...DEFAULT_STUN_URLS]), 'stun');
  if (!stun.ok) throw new ConfigError(`STUN_URLS: ${stun.error}`);
  const turnList = validateIceUrls(readList(env, 'TURN_URLS', []), 'turn');
  if (!turnList.ok) throw new ConfigError(`TURN_URLS: ${turnList.error}`);
  const turnUrls = turnList.urls;
  const turnSecret = read(env, 'TURN_SECRET') ?? null;
  const turnUsername = read(env, 'TURN_USERNAME') ?? null;
  const turnCredential = read(env, 'TURN_CREDENTIAL') ?? null;
  if (turnUrls.length > 0 && !turnSecret && !(turnUsername && turnCredential)) {
    throw new ConfigError(
      'TURN_URLS requires either TURN_SECRET or both TURN_USERNAME and TURN_CREDENTIAL',
    );
  }
  const turn: TurnConfig | null =
    turnUrls.length > 0
      ? {
          urls: turnUrls,
          secret: turnSecret,
          username: turnUsername,
          credential: turnCredential,
          credentialTtlSeconds: Math.round(
            readDuration(env, 'TURN_CREDENTIAL_TTL', 6 * HOUR, MINUTE, 7 * DAY) / 1000,
          ),
        }
      : null;
  const ice: IceConfig = { stunUrls: stun.urls, turn };

  /* --------------------------------- Shares -------------------------------- */
  const shareEnabledFlag = readBool(env, 'SHARE_ENABLED', true);
  const driverRaw = read(env, 'STORAGE_DRIVER');
  let driver: StorageDriver | null;
  if (driverRaw === undefined) {
    // Development and tests fall back to the local filesystem; production must opt in
    // explicitly so we never claim hosted sharing works on an ephemeral disk by accident.
    driver = isProd ? null : 'local';
  } else if (driverRaw === 'local' || driverRaw === 's3' || driverRaw === 'vercel-blob') {
    driver = driverRaw;
  } else {
    throw new ConfigError(
      `STORAGE_DRIVER must be "local", "s3" or "vercel-blob", got "${driverRaw}"`,
    );
  }

  const s3Bucket = read(env, 'S3_BUCKET') ?? null;
  if (driver === 's3' && !s3Bucket) throw new ConfigError('STORAGE_DRIVER=s3 requires S3_BUCKET');

  let unavailableReason: ShareUnavailableReason | null = null;
  if (!shareEnabledFlag) unavailableReason = 'disabled';
  else if (driver === null) unavailableReason = 'not-configured';

  // Decimal defaults so the interface shows round numbers ("1 GB").
  const maxPackageBytes = readBytes(env, 'SHARE_MAX_PACKAGE_SIZE', 1e9, 1, 1024 * GIB);
  const maxFileBytes = Math.min(
    readBytes(env, 'SHARE_MAX_FILE_SIZE', 1e9, 1, 1024 * GIB),
    maxPackageBytes,
  );
  const quotaBytes = readBytes(env, 'SHARE_STORAGE_QUOTA', 20e9, 1, 1024 ** 5);
  if (quotaBytes < maxPackageBytes) {
    throw new ConfigError('SHARE_STORAGE_QUOTA must be at least SHARE_MAX_PACKAGE_SIZE');
  }

  const s3Prefix = (read(env, 'S3_PREFIX') ?? 'preprati/').replace(/^\/+/, '');

  /* ------------------------- Serverless / shared state ------------------------ */
  const serverless = readBool(env, 'SERVERLESS', read(env, 'VERCEL') === '1');
  const kvUrl = read(env, 'KV_REST_API_URL') ?? read(env, 'UPSTASH_REDIS_REST_URL') ?? null;
  const kvToken = read(env, 'KV_REST_API_TOKEN') ?? read(env, 'UPSTASH_REDIS_REST_TOKEN') ?? null;
  const kvRaw = read(env, 'KV_DRIVER');
  let kvDriver: KvDriver | null;
  if (kvRaw === 'memory' || kvRaw === 'upstash') kvDriver = kvRaw;
  else if (kvRaw === undefined)
    kvDriver = kvUrl && kvToken ? 'upstash' : serverless ? null : 'memory';
  else throw new ConfigError(`KV_DRIVER must be "memory" or "upstash", got "${kvRaw}"`);
  if (kvDriver === 'upstash' && !(kvUrl && kvToken)) {
    throw new ConfigError(
      'KV_DRIVER=upstash requires KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN)',
    );
  }
  const transportRaw = read(env, 'SIGNALING_TRANSPORT');
  let signalingTransport: SignalingTransport;
  if (transportRaw === 'websocket' || transportRaw === 'http') signalingTransport = transportRaw;
  else if (transportRaw === undefined) signalingTransport = serverless ? 'http' : 'websocket';
  else
    throw new ConfigError(
      `SIGNALING_TRANSPORT must be "websocket" or "http", got "${transportRaw}"`,
    );
  if (serverless && signalingTransport === 'http' && kvDriver !== 'upstash') {
    throw new ConfigError(
      'Serverless HTTP signaling needs shared state: connect a Redis store (KV_REST_API_URL / KV_REST_API_TOKEN)',
    );
  }
  if (serverless && driver !== null && driver !== 'vercel-blob' && driver !== 's3') {
    throw new ConfigError(
      'Serverless deployments need object storage: STORAGE_DRIVER=vercel-blob or s3',
    );
  }

  const publicOrigin = readOrigin(env, 'PUBLIC_ORIGIN');

  return {
    env: runtimeEnv,
    version,
    serverless,
    signalingTransport,
    kv: { driver: kvDriver, url: kvUrl, token: kvToken },
    cronSecret: read(env, 'CRON_SECRET') ?? null,
    host: read(env, 'HOST') ?? (isProd ? '0.0.0.0' : '127.0.0.1'),
    port: readInt(env, 'PORT', 8787, 0, 65535),
    publicOrigin,
    linkOrigin: readLinkOrigin(env, publicOrigin),
    allowedOrigins,
    trustProxy: readTrustProxy(env),
    serveStatic: readBool(env, 'SERVE_STATIC', isProd && !serverless),
    staticDir: path.resolve(read(env, 'STATIC_DIR') ?? 'dist/client'),
    logLevel: read(env, 'LOG_LEVEL') ?? (runtimeEnv === 'test' ? 'silent' : 'info'),
    attributionUrl: readAttributionUrl(env),
    ice,
    warnings: iceWarnings(ice),
    sessions: {
      pairingTtlMs: readDuration(env, 'SESSION_PAIRING_TTL', 10 * MINUTE, 1000, DAY),
      maxLifetimeMs: readDuration(env, 'SESSION_MAX_LIFETIME', 12 * HOUR, MINUTE, 7 * DAY),
      maxSessions: readInt(env, 'SESSION_MAX_TOTAL', 5000, 1, 1_000_000),
      maxSessionsPerIp: readInt(env, 'SESSION_MAX_PER_IP', 10, 1, 10_000),
      maxConnectionsPerIp: readInt(env, 'WS_MAX_CONNECTIONS_PER_IP', 20, 1, 10_000),
      maxMessageBytes: readBytes(env, 'WS_MAX_MESSAGE_SIZE', 64 * KIB, 4 * KIB, 4 * MIB),
      heartbeatIntervalMs: readDuration(env, 'WS_HEARTBEAT_INTERVAL', 30_000, 1000, 10 * MINUTE),
    },
    share: {
      enabled: unavailableReason === null,
      unavailableReason,
      driver,
      ttlMs: readDuration(env, 'SHARE_TTL', DAY, 1000, 365 * DAY),
      uploadTimeoutMs: readDuration(env, 'SHARE_UPLOAD_TIMEOUT', 2 * HOUR, 1000, 7 * DAY),
      tombstoneTtlMs: readDuration(env, 'SHARE_TOMBSTONE_TTL', 7 * DAY, 0, 365 * DAY),
      maxFileBytes,
      maxPackageBytes,
      maxFiles: readInt(env, 'SHARE_MAX_FILES', 100, 1, 10_000),
      quotaBytes,
      maxActive: readInt(env, 'SHARE_MAX_ACTIVE', 2000, 1, 10_000_000),
      chunkBytes: readBytes(
        env,
        'SHARE_CHUNK_SIZE',
        4 * MIB,
        SHARE_CHUNK_MIN_BYTES,
        SHARE_CHUNK_MAX_BYTES,
      ),
      requestTimeoutMs: readDuration(env, 'SHARE_REQUEST_TIMEOUT', 2 * MINUTE, 1000, HOUR),
    },
    storage: {
      localDir: path.resolve(read(env, 'STORAGE_DIR') ?? 'data/shares'),
      vercelBlob: {
        token: read(env, 'BLOB_READ_WRITE_TOKEN') ?? null,
        prefix: (read(env, 'BLOB_PREFIX') ?? 'preprati/').replace(/^\/+/, ''),
        monthlyWriteBudget: readInt(env, 'BLOB_MONTHLY_WRITE_BUDGET', 0, 0, 100_000_000),
      },
      s3: {
        bucket: s3Bucket,
        region: read(env, 'S3_REGION') ?? 'us-east-1',
        endpoint: read(env, 'S3_ENDPOINT') ?? null,
        accessKeyId: read(env, 'S3_ACCESS_KEY_ID') ?? null,
        secretAccessKey: read(env, 'S3_SECRET_ACCESS_KEY') ?? null,
        forcePathStyle: readBool(env, 'S3_FORCE_PATH_STYLE', false),
        prefix: s3Prefix === '' || s3Prefix.endsWith('/') ? s3Prefix : `${s3Prefix}/`,
      },
    },
    cleanupIntervalMs: readDuration(env, 'CLEANUP_INTERVAL', 5 * MINUTE, 250, DAY),
    rateLimits: {
      shareCreatePerHour: readInt(env, 'RATE_LIMIT_SHARE_CREATE', 30, 1, 1_000_000),
      apiPerMinute: readInt(env, 'RATE_LIMIT_API', 900, 1, 10_000_000),
      wsConnectPerMinute: readInt(env, 'RATE_LIMIT_WS_CONNECT', 30, 1, 1_000_000),
      joinFailuresPer10Min: readInt(env, 'RATE_LIMIT_JOIN_FAILURES', 20, 1, 1_000_000),
      wsMessagesPer10Sec: readInt(env, 'RATE_LIMIT_WS_MESSAGES', 300, 10, 1_000_000),
    },
  };
}

function readAttributionUrl(env: Env): string | null {
  const value = read(env, 'NOTEA_URL');
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
    return url.toString();
  } catch {
    throw new ConfigError(`NOTEA_URL must be an absolute http(s) URL, got "${value}"`);
  }
}

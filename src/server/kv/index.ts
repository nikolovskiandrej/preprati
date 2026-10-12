/**
 * Small key-value abstraction for state that must be shared between server
 * instances (serverless deployments): HTTP signaling sessions, share
 * metadata, usage counters and rate limits.
 *
 * Two implementations:
 * - MemoryKv: single process (development, tests, single-server installs).
 * - UpstashKv: Redis over Upstash's REST API (works from serverless functions).
 *
 * Values are JSON. All operations used for coordination are atomic in Redis
 * (SET NX, INCRBY, LPOP count) so concurrent instances cannot double-claim.
 */
import type { Redis } from '@upstash/redis';

export interface KvStore {
  readonly kind: 'memory' | 'upstash';
  /** Reads a JSON value; `refreshTtlMs` also resets its time to live (GETEX). */
  getJson<T>(key: string, options?: { refreshTtlMs?: number }): Promise<T | null>;
  /** Reads several JSON values in one round trip (missing keys are null). */
  getMany(keys: string[]): Promise<unknown[]>;
  /** Stores a JSON value. With `ifNotExists`, returns false when the key already exists. */
  setJson(
    key: string,
    value: unknown,
    options?: { ttlMs?: number; ifNotExists?: boolean },
  ): Promise<boolean>;
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<boolean>;
  /** Sets a key's time to live. */
  expire(key: string, ttlMs: number): Promise<void>;
  /** Appends JSON values to a list and refreshes its time to live. */
  push(key: string, values: unknown[], ttlMs: number): Promise<void>;
  /** Atomically removes and returns every element of a list. */
  drain<T>(key: string): Promise<T[]>;
  /** Atomically adds `by` (may be negative); sets the TTL when the key is created. */
  incrBy(key: string, by: number, ttlMs?: number): Promise<number>;
  addToSet(key: string, member: string): Promise<void>;
  removeFromSet(key: string, member: string): Promise<void>;
  members(key: string): Promise<string[]>;
  /** Sorted set: adds `member` or updates its score. */
  zadd(key: string, score: number, member: string): Promise<void>;
  zrem(key: string, member: string): Promise<void>;
  /** Members with a score ≤ `max`, lowest score first, at most `limit`. */
  zrangeByScore(key: string, max: number, limit: number): Promise<string[]>;
  healthCheck(): Promise<boolean>;
}

interface MemoryEntry {
  value: unknown;
  expiresAt: number | null;
}

/** In-process store with Redis-like semantics (TTL, atomic list drain, counters). */
export class MemoryKv implements KvStore {
  readonly kind = 'memory' as const;
  private readonly data = new Map<string, MemoryEntry>();
  private readonly sorted = new Map<string, Map<string, number>>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): MemoryEntry | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  private expiry(ttlMs?: number): number | null {
    return ttlMs === undefined ? null : this.now() + ttlMs;
  }

  async getJson<T>(key: string, options: { refreshTtlMs?: number } = {}): Promise<T | null> {
    const entry = this.live(key);
    if (!entry) return null;
    if (options.refreshTtlMs !== undefined) entry.expiresAt = this.now() + options.refreshTtlMs;
    return structuredClone(entry.value) as T;
  }

  async getMany(keys: string[]): Promise<unknown[]> {
    return Promise.all(keys.map((key) => this.getJson(key)));
  }

  async setJson(
    key: string,
    value: unknown,
    options: { ttlMs?: number; ifNotExists?: boolean } = {},
  ): Promise<boolean> {
    if (options.ifNotExists && this.live(key)) return false;
    this.data.set(key, { value: structuredClone(value), expiresAt: this.expiry(options.ttlMs) });
    return true;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.live(key) && this.data.delete(key)) removed++;
      else if (this.sorted.delete(key)) removed++;
    }
    return removed;
  }

  async exists(key: string): Promise<boolean> {
    return this.live(key) !== undefined;
  }

  async expire(key: string, ttlMs: number): Promise<void> {
    const entry = this.live(key);
    if (entry) entry.expiresAt = this.now() + ttlMs;
  }

  async push(key: string, values: unknown[], ttlMs: number): Promise<void> {
    const entry = this.live(key);
    const list = entry && Array.isArray(entry.value) ? (entry.value as unknown[]) : [];
    list.push(...values.map((value) => structuredClone(value)));
    this.data.set(key, { value: list, expiresAt: this.now() + ttlMs });
  }

  async drain<T>(key: string): Promise<T[]> {
    const entry = this.live(key);
    if (!entry || !Array.isArray(entry.value)) return [];
    this.data.delete(key);
    return entry.value as T[];
  }

  async incrBy(key: string, by: number, ttlMs?: number): Promise<number> {
    const entry = this.live(key);
    const next = (typeof entry?.value === 'number' ? entry.value : 0) + by;
    this.data.set(key, { value: next, expiresAt: entry ? entry.expiresAt : this.expiry(ttlMs) });
    return next;
  }

  async addToSet(key: string, member: string): Promise<void> {
    const entry = this.live(key);
    const set = new Set(entry && Array.isArray(entry.value) ? (entry.value as string[]) : []);
    set.add(member);
    this.data.set(key, { value: [...set], expiresAt: entry?.expiresAt ?? null });
  }

  async removeFromSet(key: string, member: string): Promise<void> {
    const entry = this.live(key);
    if (!entry || !Array.isArray(entry.value)) return;
    entry.value = (entry.value as string[]).filter((item) => item !== member);
  }

  async members(key: string): Promise<string[]> {
    const entry = this.live(key);
    return entry && Array.isArray(entry.value) ? [...(entry.value as string[])] : [];
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    const set = this.sorted.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.sorted.set(key, set);
  }

  async zrem(key: string, member: string): Promise<void> {
    this.sorted.get(key)?.delete(member);
  }

  async zrangeByScore(key: string, max: number, limit: number): Promise<string[]> {
    return [...(this.sorted.get(key) ?? new Map<string, number>())]
      .filter(([, score]) => score <= max)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([member]) => member);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/** Redis via Upstash's REST API (serverless-friendly, no TCP connection). */
export class UpstashKv implements KvStore {
  readonly kind = 'upstash' as const;
  private client: Redis | null = null;

  constructor(private readonly settings: { url: string; token: string }) {}

  private async redis() {
    if (!this.client) {
      const { Redis } = await import('@upstash/redis');
      this.client = new Redis({
        url: this.settings.url,
        token: this.settings.token,
        automaticDeserialization: false,
      });
    }
    return this.client;
  }

  async getJson<T>(key: string, options: { refreshTtlMs?: number } = {}): Promise<T | null> {
    const redis = await this.redis();
    const raw =
      options.refreshTtlMs === undefined
        ? await redis.get<string>(key)
        : await redis.getex<string>(key, { px: Math.max(1, Math.ceil(options.refreshTtlMs)) });
    return raw === null || raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async getMany(keys: string[]): Promise<unknown[]> {
    if (keys.length === 0) return [];
    const raws = await (await this.redis()).mget<(string | null)[]>(...keys);
    return raws.map((raw) =>
      raw === null || raw === undefined ? null : (JSON.parse(raw) as unknown),
    );
  }

  async setJson(
    key: string,
    value: unknown,
    options: { ttlMs?: number; ifNotExists?: boolean } = {},
  ): Promise<boolean> {
    const redis = await this.redis();
    const payload = JSON.stringify(value);
    const ttl = options.ttlMs !== undefined ? Math.max(1, Math.ceil(options.ttlMs)) : undefined;
    let result: unknown;
    if (options.ifNotExists)
      result = ttl
        ? await redis.set(key, payload, { px: ttl, nx: true })
        : await redis.set(key, payload, { nx: true });
    else result = ttl ? await redis.set(key, payload, { px: ttl }) : await redis.set(key, payload);
    return result === 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return (await this.redis()).del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    return (await (await this.redis()).exists(key)) > 0;
  }

  async expire(key: string, ttlMs: number): Promise<void> {
    await (await this.redis()).pexpire(key, Math.max(1, Math.ceil(ttlMs)));
  }

  async push(key: string, values: unknown[], ttlMs: number): Promise<void> {
    if (values.length === 0) return;
    const pipeline = (await this.redis()).pipeline();
    pipeline.rpush(key, ...values.map((value) => JSON.stringify(value)));
    pipeline.pexpire(key, Math.max(1, Math.ceil(ttlMs)));
    await pipeline.exec();
  }

  async drain<T>(key: string): Promise<T[]> {
    const redis = await this.redis();
    const out: T[] = [];
    for (;;) {
      const batch = (await redis.lpop<string[]>(key, 100)) as string[] | string | null;
      if (!batch) break;
      const items = Array.isArray(batch) ? batch : [batch];
      for (const item of items) out.push(JSON.parse(item) as T);
      if (items.length < 100) break;
    }
    return out;
  }

  async incrBy(key: string, by: number, ttlMs?: number): Promise<number> {
    const redis = await this.redis();
    const value = await redis.incrby(key, by);
    // First writer sets the window; later increments keep it.
    if (ttlMs !== undefined && value === by)
      await redis.pexpire(key, Math.max(1, Math.ceil(ttlMs)));
    return value;
  }

  async addToSet(key: string, member: string): Promise<void> {
    await (await this.redis()).sadd(key, member);
  }

  async removeFromSet(key: string, member: string): Promise<void> {
    await (await this.redis()).srem(key, member);
  }

  async members(key: string): Promise<string[]> {
    return (await (await this.redis()).smembers(key)) as string[];
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await (await this.redis()).zadd(key, { score, member });
  }

  async zrem(key: string, member: string): Promise<void> {
    await (await this.redis()).zrem(key, member);
  }

  async zrangeByScore(key: string, max: number, limit: number): Promise<string[]> {
    return (await this.redis()).zrange<string[]>(key, '-inf', max, {
      byScore: true,
      offset: 0,
      count: limit,
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      return (await (await this.redis()).ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}

/** Creates the configured KV store (or null when none is configured). */
export function createKv(settings: {
  driver: 'memory' | 'upstash' | null;
  url: string | null;
  token: string | null;
}): KvStore | null {
  if (settings.driver === 'memory') return new MemoryKv();
  if (settings.driver === 'upstash' && settings.url && settings.token)
    return new UpstashKv({ url: settings.url, token: settings.token });
  return null;
}

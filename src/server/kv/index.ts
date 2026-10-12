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
 * (SET NX, INCRBY, Lua scripts for the inbox) so concurrent instances cannot
 * double-claim or reorder.
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
  /**
   * Appends a value to a sequenced inbox. It is numbered with the next value
   * of `counterKey` atomically with the append, so numbers always follow list
   * order, even with concurrent writers. Both keys get `ttlMs` to live.
   */
  inboxPush(key: string, counterKey: string, value: unknown, ttlMs: number): Promise<number>;
  /**
   * Reads a sequenced inbox. With `ack`, the highest number the reader has
   * processed, entries up to it are removed and the remaining ones returned
   * but kept until a later read acknowledges them: a response lost on the way
   * to the reader is simply delivered again. `ack === null` removes everything
   * it returns (for readers that do not acknowledge). `first` is the number of
   * the first returned item (0 when there is none); numbers are consecutive.
   */
  inboxRead<T>(
    key: string,
    counterKey: string,
    ack: number | null,
    ttlMs: number,
  ): Promise<{ first: number; items: T[] }>;
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

interface InboxEntry {
  seq: number;
  value: unknown;
}

/**
 * Inbox entries in Redis are "<number>|<json>". Numbering and appending happen
 * in one script, so concurrent writers can never store numbers out of order.
 * KEYS: inbox, counter. ARGV: json, ttl (ms).
 */
const INBOX_PUSH = `
local n = redis.call('INCR', KEYS[2])
redis.call('RPUSH', KEYS[1], n .. '|' .. ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
return n`;

/**
 * Removes entries numbered up to the acknowledgement and returns the rest.
 * KEYS: inbox, counter. ARGV: ack (-1 = remove everything returned), ttl (ms).
 */
const INBOX_READ = `
local items = redis.call('LRANGE', KEYS[1], 0, -1)
local ack = tonumber(ARGV[1])
if ack < 0 then
  if #items > 0 then redis.call('DEL', KEYS[1]) end
  return items
end
local drop = 0
for i = 1, #items do
  local raw = items[i]
  local sep = string.find(raw, '|', 1, true)
  local seq = sep and tonumber(string.sub(raw, 1, sep - 1)) or 0 -- 0: written before numbering
  if seq <= ack then drop = i else break end
end
if drop == #items then
  if drop > 0 then redis.call('DEL', KEYS[1]) end
elseif drop > 0 then
  redis.call('LTRIM', KEYS[1], drop, -1)
end
redis.call('PEXPIRE', KEYS[2], ARGV[2])
local rest = {}
for i = drop + 1, #items do rest[#rest + 1] = items[i] end
return rest`;

function parseInboxEntry(raw: string): InboxEntry {
  const numbered = /^(\d+)\|/.exec(raw);
  return numbered
    ? { seq: Number(numbered[1]), value: JSON.parse(raw.slice(numbered[0].length)) }
    : { seq: 0, value: JSON.parse(raw) }; // written before inboxes were numbered
}

/** In-process store with Redis-like semantics (TTL, sequenced inbox, counters). */
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

  async inboxPush(key: string, counterKey: string, value: unknown, ttlMs: number): Promise<number> {
    const counter = this.live(counterKey);
    const seq = (typeof counter?.value === 'number' ? counter.value : 0) + 1;
    this.data.set(counterKey, { value: seq, expiresAt: this.now() + ttlMs });
    const entry = this.live(key);
    const list = entry && Array.isArray(entry.value) ? (entry.value as InboxEntry[]) : [];
    list.push({ seq, value: structuredClone(value) });
    this.data.set(key, { value: list, expiresAt: this.now() + ttlMs });
    return seq;
  }

  async inboxRead<T>(
    key: string,
    counterKey: string,
    ack: number | null,
    ttlMs: number,
  ): Promise<{ first: number; items: T[] }> {
    const entry = this.live(key);
    const list = entry && Array.isArray(entry.value) ? (entry.value as InboxEntry[]) : [];
    const rest = ack === null ? list : list.filter((item) => item.seq > ack);
    if (entry && (ack === null || rest.length === 0)) this.data.delete(key);
    else if (entry) entry.value = rest;
    const counter = this.live(counterKey);
    if (counter && ack !== null) counter.expiresAt = this.now() + ttlMs;
    return {
      first: rest[0]?.seq ?? 0,
      items: rest.map((item) => structuredClone(item.value) as T),
    };
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

  async inboxPush(key: string, counterKey: string, value: unknown, ttlMs: number): Promise<number> {
    const result = await (
      await this.redis()
    ).eval(
      INBOX_PUSH,
      [key, counterKey],
      [JSON.stringify(value), String(Math.max(1, Math.ceil(ttlMs)))],
    );
    return Number(result);
  }

  async inboxRead<T>(
    key: string,
    counterKey: string,
    ack: number | null,
    ttlMs: number,
  ): Promise<{ first: number; items: T[] }> {
    const raws = (await (
      await this.redis()
    ).eval(
      INBOX_READ,
      [key, counterKey],
      [String(ack ?? -1), String(Math.max(1, Math.ceil(ttlMs)))],
    )) as string[] | null;
    const entries = (raws ?? []).map(parseInboxEntry);
    return { first: entries[0]?.seq ?? 0, items: entries.map((entry) => entry.value as T) };
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

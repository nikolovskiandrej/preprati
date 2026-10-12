/**
 * Small fixed-window rate limiter keyed by an arbitrary string (usually an IP
 * address plus a bucket name). In-memory by design: preprati. targets a single
 * Node process per deployment; see docs/DEPLOYMENT.md for scaling notes.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  /** Hard cap on tracked keys to bound memory under a distributed flood. */
  maxKeys?: number;
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 100_000;
    this.now = options.now ?? Date.now;
  }

  /** Records `cost` units for `key` and reports whether the request is allowed. */
  consume(key: string, cost = 1): RateLimitResult {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket) this.ensureCapacity(now);
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count + cost > this.limit) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, bucket.resetAt - now) };
    }
    bucket.count += cost;
    return {
      allowed: true,
      remaining: this.limit - bucket.count,
      retryAfterMs: 0,
    };
  }

  /** Returns true if `key` is currently over its limit, without consuming. */
  isLimited(key: string): boolean {
    const bucket = this.buckets.get(key);
    return !!bucket && bucket.resetAt > this.now() && bucket.count >= this.limit;
  }

  /** Drops expired buckets. Called periodically and when the map fills up. */
  sweep(now = this.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  private ensureCapacity(now: number): void {
    if (this.buckets.size < this.maxKeys) return;
    this.sweep(now);
    // Still full: evict the oldest entries (Map preserves insertion order).
    const excess = this.buckets.size - this.maxKeys + 1;
    let removed = 0;
    for (const key of this.buckets.keys()) {
      if (removed >= excess) break;
      this.buckets.delete(key);
      removed++;
    }
  }
}

import type { KvStore } from '../kv';
import type { UsageTracker } from './shareService';

/**
 * Global capacity accounting in the shared KV store, so quota and the number
 * of active shares hold across every server instance. A per-package
 * reservation record makes `release` idempotent: concurrent cleanups cannot
 * release the same package twice.
 */
export class KvUsageTracker implements UsageTracker {
  constructor(
    private readonly kv: KvStore,
    private readonly limits: { quotaBytes: number; maxActive: number },
  ) {}

  async reserve(id: string, bytes: number): Promise<'ok' | 'quota' | 'active'> {
    const active = await this.kv.incrBy('usage:active', 1);
    const used = await this.kv.incrBy('usage:bytes', bytes);
    const verdict =
      active > this.limits.maxActive ? 'active' : used > this.limits.quotaBytes ? 'quota' : 'ok';
    if (verdict !== 'ok') {
      await this.kv.incrBy('usage:active', -1);
      await this.kv.incrBy('usage:bytes', -bytes);
      return verdict;
    }
    await this.kv.setJson(`usage:reserved:${id}`, bytes);
    return 'ok';
  }

  async release(id: string): Promise<void> {
    const key = `usage:reserved:${id}`;
    const bytes = await this.kv.getJson<number>(key);
    if (bytes === null) return;
    // Only the caller that actually deletes the reservation gives the capacity back.
    if ((await this.kv.del(key)) !== 1) return;
    await this.kv.incrBy('usage:active', -1);
    await this.kv.incrBy('usage:bytes', -bytes);
  }
}

import { Readable } from 'node:stream';
import type { KvStore } from '../kv';
import { assertSafeKey, StorageError, type BlobStore, type StoredObjectInfo } from './types';

/**
 * Wraps a BlobStore so that small, frequently changing package metadata
 * (`shares/<prefix>/meta.json`) lives in the shared KV store while bulk
 * ciphertext stays in the blob store. On serverless platforms this keeps
 * metadata consistent across instances and spares the blob store's
 * (often metered) operations.
 */
export class KvMetaStore implements BlobStore {
  readonly kind: BlobStore['kind'];

  constructor(
    private readonly data: BlobStore,
    private readonly kv: KvStore,
  ) {
    this.kind = data.kind;
  }

  private static readonly META = /^shares\/([A-Za-z0-9_-]+)\/meta\.json$/;
  private static readonly INDEX = 'meta:shares';
  private static readonly DUE = 'meta:due';

  private metaKey(key: string): string {
    return `meta:${key}`;
  }

  async init(): Promise<void> {
    await this.data.init();
    if (!(await this.kv.healthCheck())) throw new StorageError('Metadata store is not reachable');
  }

  async healthCheck(): Promise<boolean> {
    const [data, kv] = await Promise.all([this.data.healthCheck(), this.kv.healthCheck()]);
    return data && kv;
  }

  reserveWrites(operations: number): Promise<boolean> {
    return this.data.reserveWrites ? this.data.reserveWrites(operations) : Promise.resolve(true);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const meta = KvMetaStore.META.exec(key);
    if (!meta) return this.data.put(key, value);
    assertSafeKey(key);
    try {
      await this.kv.setJson(this.metaKey(key), Buffer.from(value).toString('utf8'));
      await this.kv.addToSet(KvMetaStore.INDEX, meta[1]!);
    } catch (error) {
      throw new StorageError('Failed to write metadata', { cause: error });
    }
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    if (!KvMetaStore.META.test(key)) return this.data.getBuffer(key);
    try {
      const value = await this.kv.getJson<string>(this.metaKey(key));
      return value === null ? null : Buffer.from(value, 'utf8');
    } catch (error) {
      throw new StorageError('Failed to read metadata', { cause: error });
    }
  }

  async getStream(key: string) {
    if (!KvMetaStore.META.test(key)) return this.data.getStream(key);
    const buffer = await this.getBuffer(key);
    return buffer ? { stream: Readable.from(buffer), size: buffer.length } : null;
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    if (!KvMetaStore.META.test(key)) return this.data.stat(key);
    const buffer = await this.getBuffer(key);
    return buffer ? { key, size: buffer.length, modifiedAt: Date.now() } : null;
  }

  async delete(key: string): Promise<void> {
    const meta = KvMetaStore.META.exec(key);
    if (!meta) return this.data.delete(key);
    await this.kv.del(this.metaKey(key));
    await this.kv.removeFromSet(KvMetaStore.INDEX, meta[1]!);
    await this.kv.zrem(KvMetaStore.DUE, meta[1]!);
  }

  async markDue(name: string, at: number | null): Promise<void> {
    if (at === null) await this.kv.zrem(KvMetaStore.DUE, name);
    else await this.kv.zadd(KvMetaStore.DUE, at, name);
  }

  listDue(now: number, limit: number): Promise<string[]> {
    return this.kv.zrangeByScore(KvMetaStore.DUE, now, limit);
  }

  async deleteMany(keys: string[]): Promise<void> {
    const metaKeys = keys.filter((key) => KvMetaStore.META.test(key));
    const dataKeys = keys.filter((key) => !KvMetaStore.META.test(key));
    for (const key of metaKeys) await this.delete(key);
    if (dataKeys.length === 0) return;
    if (this.data.deleteMany) await this.data.deleteMany(dataKeys);
    else for (const key of dataKeys) await this.data.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.data.deletePrefix(prefix);
    const root = /^shares\/([A-Za-z0-9_-]+)\/$/.exec(prefix);
    if (root) await this.delete(`${prefix}meta.json`);
  }

  list(prefix: string): AsyncIterable<StoredObjectInfo> {
    return this.data.list(prefix);
  }

  /** Share folders known from metadata plus any data folders (to find orphans). */
  async *listChildren(prefix: string): AsyncIterable<string> {
    const seen = new Set<string>();
    if (prefix === 'shares/') {
      for (const name of await this.kv.members(KvMetaStore.INDEX)) {
        seen.add(name);
        yield name;
      }
    }
    for await (const name of this.data.listChildren(prefix)) {
      if (!seen.has(name)) yield name;
    }
  }

  close(): Promise<void> {
    return this.data.close?.() ?? Promise.resolve();
  }
}

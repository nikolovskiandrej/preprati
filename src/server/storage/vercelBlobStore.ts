import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type * as BlobSdk from '@vercel/blob';
import type { KvStore } from '../kv';
import { assertSafeKey, StorageError, type BlobStore, type StoredObjectInfo } from './types';

type BlobModule = typeof BlobSdk;

export interface VercelBlobOptions {
  /** Read-write token; when omitted the SDK uses BLOB_READ_WRITE_TOKEN or Vercel OIDC. */
  token?: string | null;
  /** Key prefix inside the store. */
  prefix?: string;
  /**
   * Monthly cap on write operations (put/list count as "advanced operations"
   * on Vercel's Hobby plan, where exceeding the included amount locks Blob for
   * 30 days). Tracked in the shared KV store. 0 disables the guard.
   */
  monthlyWriteBudget?: number;
  kv?: KvStore | null;
  now?: () => number;
}

/**
 * Vercel Blob adapter for a **private** store. Only ciphertext is ever written
 * here; reads stream through the function, never via public URLs.
 */
export class VercelBlobStore implements BlobStore {
  readonly kind = 'vercel-blob' as const;
  private sdk: BlobModule | null = null;
  private readonly prefix: string;
  private readonly now: () => number;

  constructor(private readonly options: VercelBlobOptions = {}) {
    this.prefix = options.prefix ?? '';
    this.now = options.now ?? Date.now;
  }

  /** No network call: on serverless this runs on every cold start, and Blob operations are metered. */
  async init(): Promise<void> {
    await this.load();
  }

  private lastHealth: { at: number; ok: boolean } | null = null;

  /** A cheap `head()` probe (a "simple" operation), cached for 10 minutes per instance. */
  async healthCheck(): Promise<boolean> {
    if (this.lastHealth && this.now() - this.lastHealth.at < 10 * 60_000) return this.lastHealth.ok;
    let ok: boolean;
    try {
      const sdk = await this.load();
      await sdk.head(`${this.prefix}__health__.txt`, this.auth());
      ok = true;
    } catch (error) {
      ok = this.isNotFound(error); // reaching the store and getting "not found" means it works
    }
    this.lastHealth = { at: this.now(), ok };
    return ok;
  }

  /** Deletes exact keys; deletions are free on Vercel Blob, listings are not. */
  async deleteMany(keys: string[]): Promise<void> {
    const sdk = await this.load();
    for (const key of keys) assertSafeKey(key);
    for (let i = 0; i < keys.length; i += 100) {
      try {
        await sdk.del(
          keys.slice(i, i + 100).map((key) => this.prefix + key),
          this.auth(),
        );
      } catch (error) {
        if (!this.isNotFound(error))
          throw new StorageError('Failed to delete blobs', { cause: error });
      }
    }
  }

  /** Reserves `operations` write operations from this month's budget; false when it would be exceeded. */
  async reserveWrites(operations: number): Promise<boolean> {
    const { kv, monthlyWriteBudget } = this.options;
    if (!kv || !monthlyWriteBudget) return true;
    const used = await kv.incrBy(this.budgetKey(), operations, 40 * 86_400_000);
    if (used > monthlyWriteBudget) {
      await kv.incrBy(this.budgetKey(), -operations);
      return false;
    }
    return true;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    assertSafeKey(key);
    const sdk = await this.load();
    try {
      await sdk.put(this.prefix + key, Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
        ...this.auth(),
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: key.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        cacheControlMaxAge: 60,
      });
    } catch (error) {
      throw new StorageError('Failed to write blob', { cause: error });
    }
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    const object = await this.getStream(key, false);
    if (!object) return null;
    const parts: Buffer[] = [];
    for await (const part of object.stream) parts.push(Buffer.from(part as Uint8Array));
    return Buffer.concat(parts);
  }

  async getStream(
    key: string,
    useCache = true,
  ): Promise<{ stream: Readable; size: number } | null> {
    assertSafeKey(key);
    const sdk = await this.load();
    try {
      const result = await sdk.get(this.prefix + key, {
        ...this.auth(),
        access: 'private',
        useCache,
        // Ciphertext doesn't compress; without this the CDN serves larger blobs
        // Brotli-encoded and chunked, with no length.
        headers: { 'accept-encoding': 'identity' },
      });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      return {
        stream: Readable.fromWeb(result.stream as NodeReadableStream<Uint8Array>),
        size: result.blob.size,
      };
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw new StorageError('Failed to read blob', { cause: error });
    }
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    assertSafeKey(key);
    const sdk = await this.load();
    try {
      const info = await sdk.head(this.prefix + key, this.auth());
      return { key, size: info.size, modifiedAt: info.uploadedAt.getTime() };
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw new StorageError('Failed to stat blob', { cause: error });
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const sdk = await this.load();
    try {
      await sdk.del(this.prefix + key, this.auth());
    } catch (error) {
      if (this.isNotFound(error)) return;
      throw new StorageError('Failed to delete blob', { cause: error });
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertSafeKey(prefix, { prefix: true });
    const sdk = await this.load();
    const batch: string[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      try {
        await sdk.del(batch.splice(0, batch.length), this.auth());
      } catch (error) {
        throw new StorageError('Failed to delete blobs', { cause: error });
      }
    };
    for await (const object of this.list(prefix)) {
      batch.push(this.prefix + object.key);
      if (batch.length === 100) await flush();
    }
    await flush();
  }

  async *list(prefix: string): AsyncIterable<StoredObjectInfo> {
    assertSafeKey(prefix, { prefix: true });
    const sdk = await this.load();
    let cursor: string | undefined;
    do {
      let page;
      try {
        page = await sdk.list({
          ...this.auth(),
          prefix: this.prefix + prefix,
          cursor,
          limit: 1000,
        });
      } catch (error) {
        throw new StorageError('Failed to list blobs', { cause: error });
      }
      for (const blob of page.blobs) {
        yield {
          key: blob.pathname.slice(this.prefix.length),
          size: blob.size,
          modifiedAt: blob.uploadedAt.getTime(),
        };
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }

  async *listChildren(prefix: string): AsyncIterable<string> {
    assertSafeKey(prefix, { prefix: true });
    const sdk = await this.load();
    let cursor: string | undefined;
    const full = this.prefix + prefix;
    do {
      let page;
      try {
        page = await sdk.list({
          ...this.auth(),
          prefix: full,
          cursor,
          mode: 'folded',
          limit: 1000,
        });
      } catch (error) {
        throw new StorageError('Failed to list blob folders', { cause: error });
      }
      for (const folder of page.folders) {
        const name = folder.slice(full.length).replace(/\/$/, '');
        if (name) yield name;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }

  /** Uses the SDK's own error class: class names don't survive minified bundles. */
  private isNotFound(error: unknown): boolean {
    if (this.sdk && error instanceof this.sdk.BlobNotFoundError) return true;
    return (error as { name?: string } | null)?.name === 'BlobNotFoundError';
  }

  private auth(): { token?: string } {
    return this.options.token ? { token: this.options.token } : {};
  }

  private budgetKey(): string {
    const date = new Date(this.now());
    return `blob:writes:${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private async load(): Promise<BlobModule> {
    if (!this.sdk) {
      try {
        this.sdk = await import('@vercel/blob');
      } catch (error) {
        throw new StorageError(
          'The @vercel/blob package is required for STORAGE_DRIVER=vercel-blob',
          { cause: error },
        );
      }
    }
    return this.sdk;
  }
}

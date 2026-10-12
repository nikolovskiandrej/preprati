/**
 * The serverless storage stack: ciphertext in (a fake of) Vercel Blob,
 * metadata and capacity accounting in the shared KV store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/server/config';
import { MemoryKv } from '../../src/server/kv';
import { KvUsageTracker } from '../../src/server/shares/kvUsage';
import { ShareService, storagePrefixFor } from '../../src/server/shares/shareService';
import { KvMetaStore } from '../../src/server/storage/kvMetaStore';
import { VercelBlobStore } from '../../src/server/storage/vercelBlobStore';
import { SHARE_CHUNK_OVERHEAD } from '../../src/shared/constants';

const fake = vi.hoisted(() => {
  // Like the real SDK in a minified bundle: `name` stays "Error" and the class
  // name is mangled, so only `instanceof` against the SDK's export works.
  class Mangled extends Error {}
  const BlobNotFoundError = Mangled;
  const blobs = new Map<string, { data: Buffer; uploadedAt: Date }>();
  const calls: Array<{ op: string; options?: Record<string, unknown> }> = [];
  // Like the Blob CDN: unless asked for `identity`, larger blobs come back
  // compressed and chunked, so the SDK reports size 0.
  const state = { ignoreIdentity: false };
  return { BlobNotFoundError, blobs, calls, state };
});

vi.mock('@vercel/blob', () => ({
  BlobNotFoundError: fake.BlobNotFoundError,
  async put(pathname: string, body: Buffer, options: Record<string, unknown>) {
    fake.calls.push({ op: 'put', options });
    fake.blobs.set(pathname, { data: Buffer.from(body), uploadedAt: new Date() });
    return { pathname };
  },
  async get(pathname: string, options: Record<string, unknown>) {
    fake.calls.push({ op: 'get', options });
    const blob = fake.blobs.get(pathname);
    if (!blob) return null;
    return {
      statusCode: 200,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(blob.data));
          controller.close();
        },
      }),
      blob: {
        size:
          !fake.state.ignoreIdentity &&
          (options.headers as Record<string, string> | undefined)?.['accept-encoding'] ===
            'identity'
            ? blob.data.length
            : 0,
        pathname,
      },
    };
  },
  async head(pathname: string) {
    fake.calls.push({ op: 'head' });
    const blob = fake.blobs.get(pathname);
    if (!blob) throw new fake.BlobNotFoundError('not found');
    return { size: blob.data.length, uploadedAt: blob.uploadedAt };
  },
  async del(urls: string | string[]) {
    fake.calls.push({ op: 'del' });
    for (const url of [urls].flat()) fake.blobs.delete(url);
  },
  async list(options: { prefix: string; mode?: string }) {
    fake.calls.push({ op: 'list', options });
    const keys = [...fake.blobs.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    if (options.mode !== 'folded') {
      return {
        blobs: keys.map((pathname) => ({
          pathname,
          size: fake.blobs.get(pathname)!.data.length,
          uploadedAt: fake.blobs.get(pathname)!.uploadedAt,
        })),
        folders: [],
        hasMore: false,
      };
    }
    const folders = new Set<string>();
    for (const key of keys) {
      const rest = key.slice(options.prefix.length);
      if (rest.includes('/')) folders.add(`${options.prefix}${rest.split('/')[0]}/`);
    }
    return { blobs: [], folders: [...folders], hasMore: false };
  },
}));

const CHUNK = 64 * 1024;

describe('serverless storage (Vercel Blob + KV)', () => {
  let now: number;
  let kv: MemoryKv;

  const makeService = (env: Record<string, string> = {}) => {
    const config = loadConfig({
      SHARE_CHUNK_SIZE: '64KiB',
      SHARE_TTL: '1h',
      SHARE_TOMBSTONE_TTL: '1d',
      ...env,
    });
    const blob = new VercelBlobStore({
      token: 'test-token',
      prefix: 'preprati/',
      monthlyWriteBudget: 40,
      kv,
      now: () => now,
    });
    return new ShareService({
      store: new KvMetaStore(blob, kv),
      config: config.share,
      now: () => now,
      consistentReads: true,
      reconcileOnInit: false,
      usage: new KvUsageTracker(kv, {
        quotaBytes: config.share.quotaBytes,
        maxActive: config.share.maxActive,
      }),
    });
  };

  const upload = async (service: ShareService, lastPlain = 100) => {
    const cipherBytes = CHUNK + SHARE_CHUNK_OVERHEAD + lastPlain + SHARE_CHUNK_OVERHEAD;
    const created = await service.create({
      chunkBytes: CHUNK,
      chunkCount: 2,
      cipherBytes,
      manifestBytes: 540,
    });
    await service.putManifest(created.id, created.ownerToken, new Uint8Array(540).fill(7));
    await service.putChunk(
      created.id,
      created.ownerToken,
      0,
      new Uint8Array(CHUNK + SHARE_CHUNK_OVERHEAD).fill(1),
    );
    await service.putChunk(
      created.id,
      created.ownerToken,
      1,
      new Uint8Array(lastPlain + SHARE_CHUNK_OVERHEAD).fill(2),
    );
    return created;
  };

  beforeEach(() => {
    now = 1_800_000_000_000;
    kv = new MemoryKv(() => now);
    fake.blobs.clear();
    fake.calls.length = 0;
    fake.state.ignoreIdentity = false;
  });

  it('keeps ciphertext in private blobs and metadata in KV', async () => {
    const service = makeService();
    await service.init();
    const { id, ownerToken } = await upload(service);
    await service.finalize(id, ownerToken);

    const prefix = storagePrefixFor(id);
    expect([...fake.blobs.keys()].sort()).toEqual([
      `preprati/${prefix}data/chunks/0000000.bin`,
      `preprati/${prefix}data/chunks/0000001.bin`,
      `preprati/${prefix}data/manifest.bin`,
    ]);
    for (const call of fake.calls.filter((c) => c.op === 'put' || c.op === 'get')) {
      expect(call.options).toMatchObject({ access: 'private', token: 'test-token' });
    }
    expect(
      fake.calls.filter((c) => c.op === 'put').every((c) => c.options?.addRandomSuffix === false),
    ).toBe(true);
    // Metadata never reaches the blob store, and holds no share id in any key.
    expect(await kv.getJson(`meta:${prefix}meta.json`)).toEqual(expect.any(String));
    expect(await kv.members('meta:shares')).toHaveLength(1);
    expect([...fake.blobs.keys()].some((key) => key.includes(id))).toBe(false);
  });

  it('serves a package from any instance, then expires it everywhere', async () => {
    const writer = makeService();
    const { id, ownerToken } = await upload(writer);
    await writer.finalize(id, ownerToken);

    // A second instance with no local state sees the same package.
    const reader = makeService();
    expect((await reader.getInfo(id)).chunkCount).toBe(2);
    const chunk = await reader.openChunk(id, 1);
    const parts: Buffer[] = [];
    for await (const part of chunk.stream) parts.push(Buffer.from(part as Uint8Array));
    expect(Buffer.concat(parts)).toEqual(Buffer.alloc(100 + SHARE_CHUNK_OVERHEAD, 2));
    (await reader.openManifest(id)).stream.destroy(); // opening the manifest counts as an access
    await reader.settle();
    expect((await writer.ownerStatus(id, ownerToken)).accessCount).toBe(1);

    now += 3_600_000;
    await expect(reader.getInfo(id)).rejects.toMatchObject({ code: 'expired', status: 410 });
    await reader.settle(); // expiry noticed on read deletes the data right away
    expect(fake.blobs.size).toBe(0);
    await expect(writer.getInfo(id)).rejects.toMatchObject({ code: 'expired' });
  });

  it('serves exact sizes, asking for uncompressed data and never trusting a missing length', async () => {
    const service = makeService();
    const { id, ownerToken } = await upload(service);
    await service.finalize(id, ownerToken);

    const chunk = await service.openChunk(id, 0);
    chunk.stream.destroy();
    expect(chunk.size).toBe(CHUNK + SHARE_CHUNK_OVERHEAD);
    expect(fake.calls.filter((call) => call.op === 'get').at(-1)?.options).toMatchObject({
      headers: { 'accept-encoding': 'identity' },
    });

    // Even if the store streams without a length (size 0), the layout gives the exact size.
    fake.state.ignoreIdentity = true;
    const manifest = await service.openManifest(id);
    manifest.stream.destroy();
    expect(manifest.size).toBe(540);
    const last = await service.openChunk(id, 1);
    last.stream.destroy();
    expect(last.size).toBe(100 + SHARE_CHUNK_OVERHEAD);
    await service.settle();

    // A stored object whose known size is wrong is refused rather than served.
    fake.state.ignoreIdentity = false;
    const key = [...fake.blobs.keys()].find((name) => name.endsWith('chunks/0000001.bin'))!;
    fake.blobs.set(key, { data: Buffer.alloc(10), uploadedAt: new Date() });
    await expect(service.openChunk(id, 1)).rejects.toMatchObject({ code: 'storage-unavailable' });
  });

  it('owner deletion removes data immediately and frees capacity', async () => {
    const service = makeService();
    const { id, ownerToken } = await upload(service);
    await service.finalize(id, ownerToken);
    expect(await kv.getJson('usage:active')).toBe(1);
    await service.delete(id, ownerToken);
    expect(fake.blobs.size).toBe(0);
    expect(await kv.getJson('usage:active')).toBe(0);
    expect(await kv.getJson('usage:bytes')).toBe(0);
    await expect(service.getInfo(id)).rejects.toMatchObject({ code: 'deleted' });
  });

  it('enforces the quota across instances', async () => {
    const env = {
      SHARE_STORAGE_QUOTA: '300KiB',
      SHARE_MAX_ACTIVE: '10',
      SHARE_MAX_PACKAGE_SIZE: '150KiB',
    };
    const a = makeService(env);
    const b = makeService(env);
    const layout = {
      chunkBytes: CHUNK,
      chunkCount: 2,
      cipherBytes: 2 * (CHUNK + SHARE_CHUNK_OVERHEAD),
      manifestBytes: 540,
    };
    await a.create(layout);
    await b.create(layout);
    await expect(a.create(layout)).rejects.toMatchObject({ code: 'quota-exceeded', status: 507 });
    expect(await kv.getJson('usage:active')).toBe(2); // the rejected reservation was rolled back
  });

  it('stops accepting packages when the monthly write budget is spent', async () => {
    const service = makeService();
    // Budget 40 operations; each 2-chunk package reserves 4.
    for (let i = 0; i < 10; i++) await upload(service);
    await expect(
      service.create({
        chunkBytes: CHUNK,
        chunkCount: 1,
        cipherBytes: 50 + SHARE_CHUNK_OVERHEAD,
        manifestBytes: 540,
      }),
    ).rejects.toMatchObject({
      code: 'quota-exceeded',
      message: expect.stringMatching(/monthly/),
    });
    // The rejected package released its capacity reservation.
    expect(await kv.getJson('usage:active')).toBe(10);
    // A new month starts with a fresh budget.
    now += 32 * 86_400_000;
    await expect(upload(service)).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('cleans up from a cold instance: expired data, then tombstones', async () => {
    const service = makeService();
    const { id, ownerToken } = await upload(service);
    await service.finalize(id, ownerToken);
    now += 3_600_001;

    const cron = makeService();
    await cron.init();
    expect(await cron.reconcile()).toBe(0);
    expect(await cron.cleanup()).toMatchObject({ expired: 1 });
    expect(fake.blobs.size).toBe(0);
    expect(await kv.members('meta:shares')).toHaveLength(1);

    now += 86_400_001;
    const later = makeService();
    await later.reconcile();
    expect(await later.cleanup()).toMatchObject({ purged: 1 });
    expect(await kv.members('meta:shares')).toEqual([]);
    await expect(later.getInfo(id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('sweeps due packages from the KV index, without listing the blob store', async () => {
    const service = makeService({ SHARE_UPLOAD_TIMEOUT: '30m' });
    const { id, ownerToken } = await upload(service);
    await service.finalize(id, ownerToken);
    const abandoned = await service.create({
      chunkBytes: CHUNK,
      chunkCount: 1,
      cipherBytes: 10 + SHARE_CHUNK_OVERHEAD,
      manifestBytes: 540,
    });
    await service.putManifest(abandoned.id, abandoned.ownerToken, new Uint8Array(540));
    expect(await service.sweepDue()).toMatchObject({ expired: 0, abandoned: 0 }); // nothing due yet

    now += 3_600_001; // past the 1 h expiry and the 30 min upload window
    fake.calls.length = 0;
    expect(await makeService().sweepDue()).toMatchObject({ expired: 1, abandoned: 1 }); // a cold instance
    expect(fake.calls.some((call) => call.op === 'list')).toBe(false);
    expect(fake.blobs.size).toBe(0);

    now += 86_400_001; // the tombstone is purged a day after expiry
    expect(await makeService().sweepDue()).toMatchObject({ purged: 1 });
    expect(await kv.zrangeByScore('meta:due', Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
    expect(await kv.members('meta:shares')).toEqual([]);
  });

  it('removes orphaned blobs that have no metadata', async () => {
    fake.blobs.set('preprati/shares/orphan000000000000000000000000000/data/chunks/0000000.bin', {
      data: Buffer.from('x'),
      uploadedAt: new Date(now - 60 * 60_000),
    });
    const service = makeService();
    expect(await service.reconcile()).toBe(1);
    expect(fake.blobs.size).toBe(0);
  });

  it('reports a reachable store as healthy without writing to it', async () => {
    const blob = new VercelBlobStore({ token: 't', kv, now: () => now });
    expect(await blob.healthCheck()).toBe(true);
    expect(fake.calls.map((call) => call.op)).toEqual(['head']);
    expect(await blob.healthCheck()).toBe(true); // cached
    expect(fake.calls).toHaveLength(1);
  });
});

describe('KvUsageTracker', () => {
  it('releases each reservation exactly once', async () => {
    const kv = new MemoryKv();
    const usage = new KvUsageTracker(kv, { quotaBytes: 1000, maxActive: 2 });
    expect(await usage.reserve('a', 400)).toBe('ok');
    expect(await usage.reserve('b', 700)).toBe('quota');
    expect(await usage.reserve('c', 500)).toBe('ok');
    expect(await usage.reserve('d', 1)).toBe('active');
    await Promise.all([usage.release('a'), usage.release('a'), usage.release('a')]);
    expect(await kv.getJson('usage:bytes')).toBe(500);
    expect(await kv.getJson('usage:active')).toBe(1);
    await usage.release('unknown');
    expect(await kv.getJson('usage:active')).toBe(1);
  });
});

describe('MemoryKv', () => {
  it('honours TTLs, refreshes on read, drains lists atomically', async () => {
    let now = 0;
    const kv = new MemoryKv(() => now);
    await kv.setJson('a', { x: 1 }, { ttlMs: 1000 });
    expect(await kv.setJson('a', 2, { ifNotExists: true })).toBe(false);
    now = 900;
    expect(await kv.getJson('a', { refreshTtlMs: 1000 })).toEqual({ x: 1 });
    now = 1800;
    expect(await kv.getMany(['a', 'missing'])).toEqual([{ x: 1 }, null]);
    now = 1901;
    expect(await kv.getJson('a')).toBeNull();

    await kv.push('list', [1, 2], 1000);
    await kv.push('list', [3], 1000);
    expect(await kv.drain('list')).toEqual([1, 2, 3]);
    expect(await kv.drain('list')).toEqual([]);

    expect(await kv.incrBy('n', 5, 100)).toBe(5);
    expect(await kv.incrBy('n', 5, 100)).toBe(10);
    now += 101;
    expect(await kv.incrBy('n', 1)).toBe(1);
  });
});

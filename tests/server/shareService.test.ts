import { mkdtemp, readdir, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config';
import {
  ShareService,
  ShareServiceError,
  storagePrefixFor,
} from '../../src/server/shares/shareService';
import { LocalBlobStore } from '../../src/server/storage/localStore';
import { SHARE_CHUNK_OVERHEAD } from '../../src/shared/constants';

const CHUNK = 64 * 1024;

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  await walk(dir);
  return out.sort();
}

describe('ShareService', () => {
  let dir: string;
  let now: number;
  let service: ShareService;
  let store: LocalBlobStore;

  const make = (env: Record<string, string> = {}) => {
    const config = loadConfig({
      SHARE_CHUNK_SIZE: '64KiB',
      SHARE_TTL: '1h',
      SHARE_UPLOAD_TIMEOUT: '10m',
      SHARE_TOMBSTONE_TTL: '1d',
      ...env,
    });
    store = new LocalBlobStore(dir);
    service = new ShareService({ store, config: config.share, now: () => now });
    return service.init();
  };

  /** Uploads a complete package of `chunks` full chunks plus a partial last chunk. */
  const createPackage = async (chunks = 2, lastPlain = 100) => {
    const chunkCount = chunks + 1;
    const cipherBytes = chunks * (CHUNK + SHARE_CHUNK_OVERHEAD) + lastPlain + SHARE_CHUNK_OVERHEAD;
    const created = await service.create({
      chunkBytes: CHUNK,
      chunkCount,
      cipherBytes,
      manifestBytes: 540,
    });
    await service.putManifest(created.id, created.ownerToken, new Uint8Array(540));
    for (let i = 0; i < chunks; i++)
      await service.putChunk(
        created.id,
        created.ownerToken,
        i,
        new Uint8Array(CHUNK + SHARE_CHUNK_OVERHEAD),
      );
    await service.putChunk(
      created.id,
      created.ownerToken,
      chunks,
      new Uint8Array(lastPlain + SHARE_CHUNK_OVERHEAD),
    );
    return created;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'preprati-share-'));
    now = 1_800_000_000_000;
    await make();
  });

  afterEach(async () => {
    await service.settle();
    await rm(dir, { recursive: true, force: true });
  });

  it('stores a package and serves it until it expires', async () => {
    const { id, ownerToken } = await createPackage();
    const { expiresAt } = await service.finalize(id, ownerToken);
    expect(expiresAt).toBe(now + 3_600_000);
    const info = await service.getInfo(id);
    expect(info).toMatchObject({ id, chunkCount: 3, manifestBytes: 540, formatVersion: 1 });
    const chunk = await service.openChunk(id, 0);
    expect(chunk.size).toBe(CHUNK + SHARE_CHUNK_OVERHEAD);
    chunk.stream.destroy();
    (await service.openManifest(id)).stream.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await service.ownerStatus(id, ownerToken)).accessCount).toBe(1);
  });

  it('enforces expiry on every read, even before cleanup runs', async () => {
    const { id, ownerToken } = await createPackage();
    await service.finalize(id, ownerToken);
    now += 3_600_000;
    await expect(service.getInfo(id)).rejects.toMatchObject({ code: 'expired', status: 410 });
    await expect(service.openChunk(id, 0)).rejects.toMatchObject({ code: 'expired' });
    expect((await service.ownerStatus(id, ownerToken)).status).toBe('expired');
  });

  it('deletes expired data during cleanup and keeps only a small tombstone', async () => {
    const { id, ownerToken } = await createPackage();
    await service.finalize(id, ownerToken);
    now += 3_600_001;
    const report = await service.cleanup();
    expect(report.expired).toBe(1);
    const files = await listFiles(dir);
    expect(files).toEqual([`${storagePrefixFor(id)}meta.json`]);
    await expect(service.getInfo(id)).rejects.toMatchObject({ code: 'expired' });
    // After the tombstone period the metadata disappears too.
    now += 86_400_001;
    expect((await service.cleanup()).purged).toBe(1);
    expect(await listFiles(dir)).toEqual([]);
    await expect(service.getInfo(id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('deletes immediately on owner request and reports "deleted" afterwards', async () => {
    const { id, ownerToken } = await createPackage();
    await service.finalize(id, ownerToken);
    await expect(service.delete(id, 'A'.repeat(43))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await service.delete(id, ownerToken);
    await expect(service.getInfo(id)).rejects.toMatchObject({ code: 'deleted', status: 410 });
    await expect(service.openChunk(id, 0)).rejects.toMatchObject({ code: 'deleted' });
    expect(await listFiles(dir)).toEqual([`${storagePrefixFor(id)}meta.json`]);
    await service.delete(id, ownerToken); // idempotent
  });

  it('never stores share ids or anything readable in storage paths', async () => {
    const { id, ownerToken } = await createPackage();
    await service.finalize(id, ownerToken);
    const files = await listFiles(dir);
    expect(files.some((file) => file.includes(id))).toBe(false);
  });

  it('only finalizes complete uploads', async () => {
    const created = await service.create({
      chunkBytes: CHUNK,
      chunkCount: 2,
      cipherBytes: 2 * (CHUNK + SHARE_CHUNK_OVERHEAD),
      manifestBytes: 540,
    });
    await expect(service.finalize(created.id, created.ownerToken)).rejects.toMatchObject({
      code: 'upload-incomplete',
    });
    await service.putManifest(created.id, created.ownerToken, new Uint8Array(540));
    await service.putChunk(
      created.id,
      created.ownerToken,
      0,
      new Uint8Array(CHUNK + SHARE_CHUNK_OVERHEAD),
    );
    await expect(service.finalize(created.id, created.ownerToken)).rejects.toMatchObject({
      code: 'upload-incomplete',
    });
    await expect(service.getInfo(created.id)).rejects.toMatchObject({ code: 'not-found' }); // not public before finalize
  });

  it('accepts only exactly-sized chunks, in range, from the owner', async () => {
    const created = await service.create({
      chunkBytes: CHUNK,
      chunkCount: 1,
      cipherBytes: 500 + SHARE_CHUNK_OVERHEAD,
      manifestBytes: 540,
    });
    const ok = new Uint8Array(500 + SHARE_CHUNK_OVERHEAD);
    await expect(
      service.putChunk(created.id, created.ownerToken, 0, new Uint8Array(10)),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(service.putChunk(created.id, created.ownerToken, 1, ok)).rejects.toMatchObject({
      code: 'invalid-request',
    });
    await expect(service.putChunk(created.id, undefined, 0, ok)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(service.putChunk(created.id, 'B'.repeat(43), 0, ok)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(
      service.putManifest(created.id, created.ownerToken, new Uint8Array(539)),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await service.putChunk(created.id, created.ownerToken, 0, ok);
  });

  it('enforces package size, quota and active share limits', async () => {
    await make({
      SHARE_MAX_PACKAGE_SIZE: '100KiB',
      SHARE_STORAGE_QUOTA: '300KiB',
      SHARE_MAX_ACTIVE: '3',
    });
    const tooBig = {
      chunkBytes: CHUNK,
      chunkCount: 2,
      cipherBytes: CHUNK + 50_000 + 2 * SHARE_CHUNK_OVERHEAD,
      manifestBytes: 540,
    };
    await expect(service.create(tooBig)).rejects.toMatchObject({ code: 'too-large', status: 413 });
    const fits = {
      chunkBytes: CHUNK,
      chunkCount: 2,
      cipherBytes: CHUNK + 30_000 + 2 * SHARE_CHUNK_OVERHEAD,
      manifestBytes: 540,
    };
    await service.create(fits);
    await service.create(fits);
    await service.create(fits);
    await expect(service.create(fits)).rejects.toMatchObject({
      code: expect.stringMatching(/quota-exceeded|too-many-shares/),
    });
  });

  it('rejects malformed and inconsistent package descriptions', async () => {
    await expect(service.create({})).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      service.create({
        chunkBytes: 1024 * 1024,
        chunkCount: 1,
        cipherBytes: 100,
        manifestBytes: 540,
      }),
    ).rejects.toMatchObject({
      code: 'invalid-request',
    });
    await expect(
      service.create({ chunkBytes: CHUNK, chunkCount: 1, cipherBytes: 10, manifestBytes: 540 }),
    ).rejects.toMatchObject({
      code: 'invalid-request',
    });
    await expect(
      service.create({
        chunkBytes: CHUNK,
        chunkCount: 1,
        cipherBytes: 100,
        manifestBytes: 540,
        extra: true,
      }),
    ).rejects.toBeInstanceOf(ShareServiceError);
  });

  it('removes abandoned partial uploads once the upload window closes', async () => {
    const created = await service.create({
      chunkBytes: CHUNK,
      chunkCount: 2,
      cipherBytes: 2 * (CHUNK + SHARE_CHUNK_OVERHEAD),
      manifestBytes: 540,
    });
    await service.putChunk(
      created.id,
      created.ownerToken,
      0,
      new Uint8Array(CHUNK + SHARE_CHUNK_OVERHEAD),
    );
    expect((await listFiles(dir)).length).toBe(2);
    now += 10 * 60_000 + 1;
    await expect(
      service.putChunk(
        created.id,
        created.ownerToken,
        1,
        new Uint8Array(CHUNK + SHARE_CHUNK_OVERHEAD),
      ),
    ).rejects.toMatchObject({
      code: 'upload-expired',
    });
    expect((await service.cleanup()).abandoned).toBe(1);
    expect(await listFiles(dir)).toEqual([]);
  });

  it('lets the owner cancel an upload, removing everything at once', async () => {
    const created = await service.create({
      chunkBytes: CHUNK,
      chunkCount: 1,
      cipherBytes: 100 + SHARE_CHUNK_OVERHEAD,
      manifestBytes: 540,
    });
    await service.putManifest(created.id, created.ownerToken, new Uint8Array(540));
    await service.delete(created.id, created.ownerToken);
    expect(await listFiles(dir)).toEqual([]);
    expect(service.usedBytes).toBe(0);
  });

  it('rebuilds its index from storage after a restart and removes orphaned data', async () => {
    const { id, ownerToken } = await createPackage();
    await service.finalize(id, ownerToken);
    // Orphan: data without metadata, older than the grace period.
    const orphanDir = path.join(
      dir,
      'shares',
      'orphaned-prefix-0000000000000000',
      'data',
      'chunks',
    );
    await mkdir(orphanDir, { recursive: true });
    const orphanFile = path.join(orphanDir, '0000000.bin');
    await writeFile(orphanFile, 'x');
    const old = new Date(now - 60 * 60_000);
    await utimes(orphanFile, old, old);

    const restarted = new ShareService({
      store: new LocalBlobStore(dir),
      config: loadConfig({ SHARE_CHUNK_SIZE: '64KiB', SHARE_TTL: '1h' }).share,
      now: () => now,
    });
    await restarted.init();
    expect((await restarted.getInfo(id)).id).toBe(id);
    expect((await listFiles(dir)).some((file) => file.includes('orphaned'))).toBe(false);
  });

  it('keeps storage keys inside the storage directory', async () => {
    await expect(store.put('../escape.txt', new Uint8Array(1))).rejects.toThrow();
    await expect(store.put('shares/../../x', new Uint8Array(1))).rejects.toThrow();
    await expect(store.getBuffer('/etc/passwd')).rejects.toThrow();
  });
});

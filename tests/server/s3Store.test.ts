/**
 * S3 adapter contract tests. They run only when an S3-compatible endpoint is
 * provided, e.g. a disposable local SeaweedFS or MinIO:
 *
 *   docker run --rm -p 127.0.0.1:18333:8333 chrislusf/seaweedfs server -s3
 *   PREPRATI_S3_TEST_ENDPOINT=http://127.0.0.1:18333 npm test -- s3Store
 */
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config';
import { ShareService } from '../../src/server/shares/shareService';
import { S3BlobStore } from '../../src/server/storage/s3Store';
import { SHARE_CHUNK_OVERHEAD } from '../../src/shared/constants';
import { randomId } from '../../src/shared/encoding';

const endpoint = process.env.PREPRATI_S3_TEST_ENDPOINT;

describe.skipIf(!endpoint)('S3 storage adapter', () => {
  const bucket = `preprati-test-${randomId()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12)}`;
  const env = {
    STORAGE_DRIVER: 's3',
    S3_BUCKET: bucket,
    S3_ENDPOINT: endpoint ?? '',
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test',
    S3_PREFIX: 'preprati-e2e/',
    SHARE_CHUNK_SIZE: '64KiB',
    SHARE_TTL: '1h',
  };
  let store: S3BlobStore;

  beforeAll(async () => {
    const client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    client.destroy();
    store = new S3BlobStore(loadConfig(env).storage.s3);
    await store.init();
  });
  afterAll(async () => {
    await store?.deletePrefix('shares/').catch(() => undefined);
    await store?.close();
  });

  it('stores, reads, lists and deletes objects', async () => {
    const data = new Uint8Array(70_000);
    crypto.getRandomValues(data.subarray(0, 65_536));
    crypto.getRandomValues(data.subarray(65_536));
    await store.put('shares/abc/data/chunks/0000000.bin', data);
    await store.put('shares/abc/meta.json', new TextEncoder().encode('{"ok":true}'));
    expect(await store.healthCheck()).toBe(true);
    expect(new Uint8Array((await store.getBuffer('shares/abc/data/chunks/0000000.bin'))!)).toEqual(
      data,
    );
    expect((await store.stat('shares/abc/meta.json'))?.size).toBe(11);
    expect(await store.stat('shares/abc/missing.bin')).toBeNull();
    expect(await store.getStream('shares/abc/missing.bin')).toBeNull();

    const children: string[] = [];
    for await (const child of store.listChildren('shares/')) children.push(child);
    expect(children).toContain('abc');
    const keys: string[] = [];
    for await (const object of store.list('shares/abc/')) keys.push(object.key);
    expect(keys.sort()).toEqual(['shares/abc/data/chunks/0000000.bin', 'shares/abc/meta.json']);

    await store.deletePrefix('shares/abc/data/');
    expect(await store.stat('shares/abc/data/chunks/0000000.bin')).toBeNull();
    expect(await store.stat('shares/abc/meta.json')).not.toBeNull();
    await store.delete('shares/abc/meta.json');
    expect(await store.stat('shares/abc/meta.json')).toBeNull();
  });

  it('runs the full share lifecycle on object storage', async () => {
    let now = Date.now();
    const service = new ShareService({ store, config: loadConfig(env).share, now: () => now });
    await service.init();
    const created = await service.create({
      chunkBytes: 65_536,
      chunkCount: 1,
      cipherBytes: 500 + SHARE_CHUNK_OVERHEAD,
      manifestBytes: 540,
    });
    await service.putManifest(created.id, created.ownerToken, new Uint8Array(540));
    const chunk = crypto.getRandomValues(new Uint8Array(500 + SHARE_CHUNK_OVERHEAD));
    await service.putChunk(created.id, created.ownerToken, 0, chunk);
    await service.finalize(created.id, created.ownerToken);

    const opened = await service.openChunk(created.id, 0);
    const parts: Buffer[] = [];
    for await (const part of opened.stream) parts.push(Buffer.from(part as Uint8Array));
    expect(new Uint8Array(Buffer.concat(parts))).toEqual(chunk);

    now += 3_600_001;
    expect((await service.cleanup()).expired).toBe(1);
    await expect(service.getInfo(created.id)).rejects.toMatchObject({ code: 'expired' });
    const remaining: string[] = [];
    for await (const object of store.list('shares/')) remaining.push(object.key);
    expect(remaining.every((key) => key.endsWith('meta.json'))).toBe(true);
  });
});

// @vitest-environment jsdom
/**
 * Share Files end to end in a browser-like environment: the real ShareCreator
 * and ShareRetriever talk to the real backend over HTTP.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { storagePrefixFor } from '../../src/server/shares/shareService';
import { startTestServer, type TestServer } from '../helpers/server';

const saved: Array<{ blob: Blob; name: string }> = [];
vi.mock('../../src/client/lib/download', () => ({
  saveBlob: (blob: Blob, name: string) => saved.push({ blob, name }),
  canShareFiles: () => false,
}));

const { ShareCreator } = await import('../../src/client/share/creator');
const { ShareRetriever } = await import('../../src/client/share/retriever');

const ORIGIN = 'http://localhost:3000';
let now = Date.now();

async function allStoredFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(dir);
  return out;
}

function randomFile(name: string, size: number, type = 'application/octet-stream') {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65_536)
    crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65_536)));
  return { file: new File([bytes], name, { type, lastModified: 1_700_000_000_000 }), bytes };
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() - start > ms) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const limits = (server: TestServer) => ({
  enabled: true as const,
  ttlSeconds: 3600,
  maxFileBytes: server.config.share.maxFileBytes,
  maxPackageBytes: server.config.share.maxPackageBytes,
  maxFiles: server.config.share.maxFiles,
  chunkBytes: server.config.share.chunkBytes,
});

async function createShare(server: TestServer, files: File[]) {
  const creator = new ShareCreator(limits(server));
  creator.addFiles(files);
  creator.requestConfirmation();
  expect(creator.getSnapshot().phase).toBe('awaiting-confirmation');
  await creator.confirm();
  const state = creator.getSnapshot();
  expect(state.error).toBeNull();
  expect(state.phase).toBe('ready-to-share');
  const url = new URL(state.result!.url);
  return { creator, url, id: url.pathname.split('/').pop()!, key: url.hash.slice(1) };
}

describe('Share Files (creator → server → recipient)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(
      { ALLOWED_ORIGINS: ORIGIN, SHARE_TTL: '1h' },
      { record: true, now: () => now },
    );
  });
  afterAll(() => server.close());

  beforeEach(() => {
    vi.stubEnv('VITE_API_BASE_URL', server.url);
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    saved.length = 0;
    server.requests.length = 0;
    now = Date.now();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('encrypts in the browser, never sends the key, and lets a recipient decrypt later', async () => {
    const a = randomFile('квартален-извештај.pdf', 200_000, 'application/pdf');
    const b = randomFile('holiday-photo.jpg', 70_000, 'image/jpeg');

    const creator = new ShareCreator(limits(server));
    creator.addFiles([a.file, b.file]);
    creator.requestConfirmation();
    // Selecting files and opening the confirmation uploads nothing.
    expect(server.requests.filter((r) => r.url.startsWith('/api/shares'))).toHaveLength(0);
    await creator.confirm();
    const result = creator.getSnapshot().result!;
    const url = new URL(result.url);
    const id = url.pathname.split('/').pop()!;
    const key = url.hash.slice(1);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.fileCount).toBe(2);

    // The server never saw the key, the plaintext or the file names.
    for (const request of server.requests) {
      const blob = [
        request.url,
        JSON.stringify(request.headers),
        request.body?.toString('latin1') ?? '',
      ].join('\n');
      expect(blob).not.toContain(key);
      expect(blob).not.toContain('holiday-photo');
      if (request.body && request.body.length > 1000) {
        expect(request.body.includes(Buffer.from(a.bytes.subarray(0, 64)))).toBe(false);
        expect(request.body.includes(Buffer.from(b.bytes.subarray(0, 64)))).toBe(false);
      }
    }
    for (const file of await allStoredFiles(server.storageDir)) {
      const content = await readFile(file);
      expect(content.includes(Buffer.from('holiday-photo'))).toBe(false);
      expect(content.includes(Buffer.from(a.bytes.subarray(1000, 1064)))).toBe(false);
      expect(file).not.toContain(id);
    }

    // The sender is gone; a recipient opens the link later.
    creator.dispose();
    const retriever = new ShareRetriever(id, url.hash);
    await retriever.open();
    const state = retriever.getSnapshot();
    expect(state.phase).toBe('ready-to-download');
    expect(state.files.map((f) => f.name)).toEqual(['квартален-извештај.pdf', 'holiday-photo.jpg']);

    await retriever.downloadFile(0);
    await retriever.downloadFile(1);
    expect(saved.map((s) => s.name)).toEqual(['квартален-извештај.pdf', 'holiday-photo.jpg']);
    expect(new Uint8Array(await saved[0]!.blob.arrayBuffer())).toEqual(a.bytes);
    expect(new Uint8Array(await saved[1]!.blob.arrayBuffer())).toEqual(b.bytes);
    retriever.dispose();
  });

  it('reports an invalid key without offering corrupted files', async () => {
    const { id, key } = await createShare(server, [randomFile('a.bin', 1000).file]);
    const otherKey = key.startsWith('A') ? `B${key.slice(1)}` : `A${key.slice(1)}`;
    const retriever = new ShareRetriever(id, `#${otherKey}`);
    await retriever.open();
    expect(retriever.getSnapshot()).toMatchObject({
      phase: 'failed',
      error: 'invalid-key',
      files: [],
    });
  });

  it('rejects malformed links before contacting the server', async () => {
    const retriever = new ShareRetriever('not-an-id', '#short');
    await retriever.open();
    expect(retriever.getSnapshot()).toMatchObject({ phase: 'failed', error: 'invalid-link' });
  });

  it('refuses to save a file whose stored ciphertext was tampered with', async () => {
    const { id, url } = await createShare(server, [randomFile('tampered.bin', 150_000).file]);
    const ownDir = path.join(server.storageDir, storagePrefixFor(id));
    const chunkFiles = (await allStoredFiles(ownDir)).filter((f) =>
      f.includes(`${path.sep}chunks${path.sep}`),
    );
    const target = chunkFiles.sort()[0]!;
    const bytes = await readFile(target);
    bytes[100]! ^= 0xff;
    await writeFile(target, bytes);

    const retriever = new ShareRetriever(id, url.hash);
    await retriever.open();
    await retriever.downloadFile(0);
    expect(retriever.getSnapshot().files[0]).toMatchObject({
      status: 'failed',
      error: 'corrupted',
    });
    expect(saved).toHaveLength(0);
  });

  it('shows deleted and expired shares as such', async () => {
    const first = await createShare(server, [randomFile('x.bin', 10).file]);
    expect(await first.creator.deleteShare()).toBe(true);
    const deleted = new ShareRetriever(first.id, first.url.hash);
    await deleted.open();
    expect(deleted.getSnapshot()).toMatchObject({ phase: 'failed', error: 'deleted' });

    const second = await createShare(server, [randomFile('y.bin', 10).file]);
    now += 3_600_000 + 1;
    const expired = new ShareRetriever(second.id, second.url.hash);
    await expired.open();
    expect(expired.getSnapshot()).toMatchObject({ phase: 'failed', error: 'expired' });
  });

  it('enforces file limits before encrypting or uploading anything', async () => {
    const creator = new ShareCreator({ ...limits(server), maxFileBytes: 1000, maxFiles: 2 });
    creator.addFiles([randomFile('big.bin', 1001).file]);
    creator.requestConfirmation();
    expect(creator.getSnapshot()).toMatchObject({
      phase: 'selecting-files',
      error: 'file-too-large',
    });
    creator.addFiles([randomFile('b.bin', 1).file, randomFile('c.bin', 1).file]);
    creator.requestConfirmation();
    expect(creator.getSnapshot().error).toBe('too-many-files');
    expect(server.requests).toHaveLength(0);
  });
});

describe('Share Files upload failures', () => {
  it('removes the partial package when an upload fails', async () => {
    let chunkPuts = 0;
    const server = await startTestServer(
      { ALLOWED_ORIGINS: ORIGIN },
      {
        fail: ({ method, url }) =>
          method === 'PUT' && url.includes('/chunks/') && ++chunkPuts === 2 ? 413 : null,
      },
    );
    vi.stubEnv('VITE_API_BASE_URL', server.url);
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    try {
      const creator = new ShareCreator(limits(server));
      creator.addFiles([randomFile('three-chunks.bin', 3 * 65_536 - 5).file]);
      creator.requestConfirmation();
      await creator.confirm();
      expect(creator.getSnapshot().phase).toBe('failed');
      // The best-effort cleanup request runs right after the failure.
      await waitFor(
        () => server.instance.getShareService()!.activeCount,
        (count) => count === 0,
      );
      expect(await allStoredFiles(server.storageDir)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await server.close();
    }
  });
});

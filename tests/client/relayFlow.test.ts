// @vitest-environment jsdom
/**
 * Relay mode against the real backend: two RelayEngines move files through
 * the actual share API (encrypted upload, download, deletion), and a full
 * server is reported in terms the interface can explain.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, TransferSnapshot } from '../../src/client/transfer/engine';
import { RelayEngine } from '../../src/client/transfer/relay';
import {
  createRelayKeyPair,
  deriveRelayKey,
  type RelaySide,
} from '../../src/client/transfer/relayCrypto';
import { shareRelayStorage } from '../../src/client/transfer/relayStorage';
import { uploadPackage } from '../../src/client/share/upload';
import { startTestServer, type TestServer } from '../helpers/server';

const ORIGIN = 'http://localhost:3000';

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function storedFiles(dir: string): Promise<string[]> {
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

async function engines(server: TestServer) {
  const sender = await createRelayKeyPair();
  const receiver = await createRelayKeyPair();
  const context = { sessionId: 's', senderKey: sender.publicKey, receiverKey: receiver.publicKey };
  const keys = {
    sender: await deriveRelayKey(sender, receiver.publicKey, context),
    receiver: await deriveRelayKey(receiver, sender.publicKey, context),
  };
  const share = server.config.share;
  const storage = shareRelayStorage(share.chunkBytes);
  const limits = {
    maxFiles: share.maxFiles,
    maxFileBytes: share.maxFileBytes,
    maxPackageBytes: share.maxPackageBytes,
  };
  const events: Record<RelaySide, EngineEvent[]> = { sender: [], receiver: [] };
  const relays = {} as Record<RelaySide, RelayEngine>;
  for (const side of ['sender', 'receiver'] as const) {
    const other: RelaySide = side === 'sender' ? 'receiver' : 'sender';
    relays[side] = new RelayEngine({
      side,
      key: keys[side],
      storage,
      limits,
      send: ({ seq, data }) => setTimeout(() => relays[other].handleMessage(seq, data), 0),
      onEvent: (event) => events[side].push(event),
    });
    relays[side].start();
  }
  const last = (side: RelaySide): TransferSnapshot | undefined =>
    events[side].flatMap((event) => (event.type === 'transfer' ? [event.transfer] : [])).at(-1);
  return { relays, events, last };
}

function randomBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65_536)
    crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65_536)));
  return bytes;
}

describe('relay mode through the share API', () => {
  let server: TestServer | null = null;

  beforeEach(() => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await server?.close();
    server = null;
  });

  it('uploads encrypted, downloads intact, and deletes the package afterwards', async () => {
    server = await startTestServer({ ALLOWED_ORIGINS: ORIGIN }, { record: true });
    vi.stubEnv('VITE_API_BASE_URL', server.url);
    const { relays, events, last } = await engines(server);
    const bytes = randomBytes(300_000); // several 64 KiB chunks
    relays.sender.offer([new File([bytes], 'пасош-скен.png', { type: 'image/png' })]);
    await until(() => last('receiver')?.status === 'offered');
    relays.receiver.accept(last('receiver')!.id);
    await until(() => last('sender')?.status === 'completed');

    const received = events.receiver.flatMap((event) =>
      event.type === 'file-received' ? [event.file] : [],
    );
    expect(received.map((file) => file.name)).toEqual(['пасош-скен.png']);
    expect(new Uint8Array(await received[0]!.blob.arrayBuffer())).toEqual(bytes);

    // Deleted right after delivery; nothing but ciphertext ever reached the server.
    await until(() => server!.instance.getShareService()!.activeCount === 0);
    for (const file of await storedFiles(server.storageDir)) {
      if (file.endsWith('meta.json')) continue; // the deletion tombstone
      expect((await readFile(file)).includes(Buffer.from(bytes.subarray(0, 64)))).toBe(false);
    }
    for (const request of server.requests)
      expect(`${request.url} ${request.body?.toString('utf8') ?? ''}`).not.toContain('пасош');
  });

  it('reports a server that can’t store the files as such, on both devices', async () => {
    server = await startTestServer({ ALLOWED_ORIGINS: ORIGIN, SHARE_MAX_ACTIVE: '1' });
    vi.stubEnv('VITE_API_BASE_URL', server.url);
    // Someone else's share takes the only slot.
    await uploadPackage([new File(['taken'], 'other.txt')], server.config.share.chunkBytes, {
      signal: new AbortController().signal,
    });
    const { relays, last } = await engines(server);
    relays.sender.offer([new File([randomBytes(1_000)], 'mine.bin')]);
    await until(() => last('receiver')?.status === 'offered');
    relays.receiver.accept(last('receiver')!.id);
    await until(() => last('receiver')?.status === 'failed');
    expect(last('sender')).toMatchObject({ status: 'failed', error: 'relay-storage' });
    expect(last('receiver')).toMatchObject({ status: 'failed', error: 'peer-error' });
  });
});

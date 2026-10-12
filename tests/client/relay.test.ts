/**
 * RelayEngine: files travel as a temporary package (in-memory storage here)
 * while encrypted control messages travel between the two engines — offer,
 * accept, upload and download progress, completion, cancellation, failures,
 * limits, and messages the server forged, dropped or repeated.
 */
import { describe, expect, it } from 'vitest';
import type { EngineEvent, TransferSnapshot } from '../../src/client/transfer/engine';
import { RelayEngine, RelayStorageError, type RelayLimits } from '../../src/client/transfer/relay';
import {
  createRelayKeyPair,
  deriveRelayKey,
  type RelaySide,
} from '../../src/client/transfer/relayCrypto';
import { MemoryStorage } from '../helpers/memoryRelayStorage';

const LIMITS: RelayLimits = { maxFiles: 100, maxFileBytes: 1_000_000, maxPackageBytes: 2_000_000 };

type Wire = Array<{ from: RelaySide; seq: number; data: string }>;

async function pair(storage = new MemoryStorage(), limits = LIMITS) {
  const sender = await createRelayKeyPair();
  const receiver = await createRelayKeyPair();
  const context = {
    sessionId: 'session',
    senderKey: sender.publicKey,
    receiverKey: receiver.publicKey,
  };
  const keys = {
    sender: await deriveRelayKey(sender, receiver.publicKey, context),
    receiver: await deriveRelayKey(receiver, sender.publicKey, context),
  };
  const events: Record<RelaySide, EngineEvent[]> = { sender: [], receiver: [] };
  const wire: Wire = [];
  const engines = {} as Record<RelaySide, RelayEngine>;
  const deliver = { enabled: true };
  for (const side of ['sender', 'receiver'] as const) {
    const other: RelaySide = side === 'sender' ? 'receiver' : 'sender';
    engines[side] = new RelayEngine({
      side,
      key: keys[side],
      storage,
      limits,
      send: ({ seq, data }) => {
        wire.push({ from: side, seq, data });
        if (deliver.enabled) setTimeout(() => engines[other].handleMessage(seq, data), 0);
      },
      onEvent: (event) => events[side].push(event),
    });
    engines[side].start();
  }
  return { engines, events, wire, storage, deliver };
}

const transfers = (events: EngineEvent[]) =>
  events.flatMap((event) => (event.type === 'transfer' ? [event.transfer] : []));
const last = (events: EngineEvent[]): TransferSnapshot | undefined => transfers(events).at(-1);

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const file = (name: string, content: string, type = 'text/plain') =>
  new File([content], name, { type, lastModified: 1_700_000_000_000 });

describe('RelayEngine', () => {
  it('moves files through storage: offer, accept, upload, download, then deletes the package', async () => {
    const { engines, events, wire, storage } = await pair();
    expect(events.sender[0]).toMatchObject({ type: 'ready' });

    const files = [
      file('план.txt', 'the secret plan'),
      file('photo.jpg', 'jpeg bytes', 'image/jpeg'),
    ];
    engines.sender.offer(files);
    await until(() => last(events.receiver)?.status === 'offered');
    expect(last(events.receiver)!.files.map((f) => [f.name, f.size])).toEqual([
      ['план.txt', 15],
      ['photo.jpg', 10],
    ]);

    engines.receiver.accept(last(events.receiver)!.id);
    await until(() => last(events.sender)?.status === 'completed');
    await until(() => last(events.receiver)?.status === 'completed');

    const received = events.receiver.flatMap((event) =>
      event.type === 'file-received' ? [event.file] : [],
    );
    expect(await Promise.all(received.map((f) => f.blob.text()))).toEqual([
      'the secret plan',
      'jpeg bytes',
    ]);
    expect(received.map((f) => f.name)).toEqual(['план.txt', 'photo.jpg']);
    // Both legs were visible on both devices: the upload, then the download.
    for (const side of ['sender', 'receiver'] as const) {
      const stages = transfers(events[side]).map((t) => t.stage);
      expect(stages.indexOf('upload')).toBeLessThan(stages.lastIndexOf('download'));
    }
    expect(last(events.sender)).toMatchObject({ transferredBytes: 25, totalBytes: 25 });
    // The package is gone as soon as the receiver has it.
    expect(storage.packages.size).toBe(0);
    expect(storage.removed).toHaveLength(1);
    // Signaling only ever carried ciphertext: no names, contents or package key.
    const carried = JSON.stringify(wire);
    for (const secret of ['план', 'photo.jpg', 'the secret plan', storage.secrets[0]!])
      expect(carried).not.toContain(secret);
    expect(engines.sender.busy || engines.receiver.busy).toBe(false);
  });

  it('uploads nothing when the receiver declines', async () => {
    const { engines, events, storage } = await pair();
    engines.sender.offer([file('a.txt', 'a')]);
    await until(() => last(events.receiver)?.status === 'offered');
    engines.receiver.reject(last(events.receiver)!.id);
    await until(() => last(events.sender)?.status === 'rejected');
    expect(last(events.sender)!.endedBy).toBe('remote');
    expect(storage.secrets).toEqual([]);
  });

  it('stops an upload when the sender cancels, and leaves nothing stored', async () => {
    const storage = new MemoryStorage();
    let release!: () => void;
    storage.hold = new Promise((resolve) => (release = resolve));
    const { engines, events } = await pair(storage);
    engines.sender.offer([file('big.bin', 'x'.repeat(1000))]);
    await until(() => last(events.receiver)?.status === 'offered');
    engines.receiver.accept(last(events.receiver)!.id);
    await until(() => (last(events.sender)?.transferredBytes ?? 0) > 0);
    engines.sender.cancel();
    release();
    await until(() => last(events.receiver)?.status === 'cancelled');
    expect(last(events.receiver)!.endedBy).toBe('remote');
    expect(last(events.sender)).toMatchObject({ status: 'cancelled', endedBy: 'local' });
    expect(storage.packages.size).toBe(0);
  });

  it('deletes the package when the receiver cancels before downloading it', async () => {
    const storage = new MemoryStorage();
    let release!: () => void;
    storage.hold = new Promise((resolve) => (release = resolve));
    const { engines, events, deliver, wire } = await pair(storage);
    engines.sender.offer([file('a.txt', 'abc')]);
    await until(() => last(events.receiver)?.status === 'offered');
    engines.receiver.accept(last(events.receiver)!.id);
    await until(() => last(events.sender)?.stage === 'upload');
    // The upload finishes, but its `ready` message is held back from the receiver…
    deliver.enabled = false;
    release();
    await until(() => last(events.sender)?.stage === 'download');
    expect(storage.packages.size).toBe(1);
    // …which cancels meanwhile; its cancellation reaches the sender.
    const sent = wire.length;
    engines.receiver.cancel();
    await until(() => wire.length > sent);
    const cancel = wire.at(-1)!;
    expect(cancel.from).toBe('receiver');
    engines.sender.handleMessage(cancel.seq, cancel.data);
    await until(() => last(events.sender)?.status === 'cancelled');
    expect(last(events.sender)!.endedBy).toBe('remote');
    expect(storage.packages.size).toBe(0);
  });

  it('reports a failed upload on both devices', async () => {
    const storage = new MemoryStorage();
    storage.failUpload = new RelayStorageError('unavailable');
    const { engines, events } = await pair(storage);
    engines.sender.offer([file('a.txt', 'abc')]);
    await until(() => last(events.receiver)?.status === 'offered');
    engines.receiver.accept(last(events.receiver)!.id);
    await until(() => last(events.receiver)?.status === 'failed');
    expect(last(events.sender)).toMatchObject({ status: 'failed', error: 'relay-storage' });
    expect(last(events.receiver)).toMatchObject({ status: 'failed', error: 'peer-error' });
  });

  it('refuses a selection over the storage limits without uploading anything', async () => {
    const { engines, events, wire, storage } = await pair(new MemoryStorage(), {
      ...LIMITS,
      maxPackageBytes: 3,
    });
    engines.sender.offer([file('a.txt', 'abcd')]);
    expect(last(events.sender)).toMatchObject({
      status: 'failed',
      error: 'relay-too-large',
      endedBy: 'local',
    });
    expect(wire).toEqual([]);
    expect(storage.secrets).toEqual([]);
    expect(engines.sender.busy).toBe(false);
  });

  it('ignores repeated messages and fails a transfer on a forged one', async () => {
    const { engines, events, wire } = await pair();
    engines.sender.offer([file('a.txt', 'abc')]);
    await until(() => last(events.receiver)?.status === 'offered');
    const offer = wire[0]!;
    // The server delivers the offer again: still one offer, and no "busy" refusal.
    engines.receiver.handleMessage(offer.seq, offer.data);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(transfers(events.receiver).filter((t) => t.status === 'offered')).toHaveLength(1);
    expect(wire.filter((message) => message.from === 'receiver')).toHaveLength(0);

    // A message the server made up can't be decrypted: the transfer stops on both sides.
    engines.receiver.handleMessage(offer.seq + 1, `${offer.data.slice(0, -4)}AAAA`);
    await until(() => last(events.receiver)?.status === 'failed');
    expect(last(events.receiver)!.error).toBe('protocol-error');
    await until(() => last(events.sender)?.status === 'failed');
    expect(last(events.sender)!.error).toBe('peer-error');
  });

  it('stops a transfer when a message went missing on the way', async () => {
    const { engines, events, deliver, wire } = await pair();
    engines.sender.offer([file('a.txt', 'abc')]);
    await until(() => last(events.receiver)?.status === 'offered');
    // From here on, messages are passed on by hand.
    deliver.enabled = false;
    engines.receiver.accept(last(events.receiver)!.id);
    await until(() => wire.some((message) => message.from === 'receiver'));
    const accept = wire.find((message) => message.from === 'receiver')!;
    engines.sender.handleMessage(accept.seq, accept.data);
    // The sender reports progress, then announces the package: offer, progress, ready.
    await until(() => wire.filter((message) => message.from === 'sender').length === 3);
    const [, progress, ready] = wire.filter((message) => message.from === 'sender');
    expect(ready!.seq).toBe(progress!.seq + 1);
    // The server drops the progress report and passes on what follows.
    engines.receiver.handleMessage(ready!.seq, ready!.data);
    await until(() => last(events.receiver)?.status === 'failed');
    expect(last(events.receiver)!.error).toBe('protocol-error');
  });

  it('shortens long names to fit one signaling message, and delivers them in full', async () => {
    const { engines, events } = await pair();
    const long = (i: number) => `${String(i).padStart(3, '0')}-${'отчет-'.repeat(60)}.pdf`;
    const files = Array.from({ length: 100 }, (_, i) => file(long(i), `file ${i}`));
    engines.sender.offer(files);
    await until(() => last(events.receiver)?.status === 'offered');
    const offered = last(events.receiver)!.files;
    expect(offered).toHaveLength(100);
    expect(offered[7]!.name.length).toBeLessThan(long(7).length);
    expect(offered[7]!.name).toMatch(/^007-.*….pdf$/);

    engines.receiver.accept(last(events.receiver)!.id);
    await until(() => last(events.receiver)?.status === 'completed');
    const received = events.receiver.flatMap((event) =>
      event.type === 'file-received' ? [event.file] : [],
    );
    expect(received[7]!.name).toBe(long(7));
  });
});

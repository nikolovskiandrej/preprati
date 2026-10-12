import { describe, expect, it } from 'vitest';
import {
  TransferEngine,
  type EngineEvent,
  type ReceivedFile,
  type TransferSnapshot,
} from '../../src/client/transfer/engine';
import {
  encodeChunk,
  encodeControl,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
} from '../../src/client/transfer/protocol';
import { channelPair, type FakeChannel } from '../helpers/fakeChannel';

function randomFile(name: string, size: number, type = 'application/octet-stream'): File {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65_536)));
  }
  return new File([bytes], name, { type, lastModified: 1_700_000_000_000 });
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

interface Side {
  engine: TransferEngine;
  channel: FakeChannel;
  events: EngineEvent[];
  snapshots: TransferSnapshot[];
  received: ReceivedFile[];
  waitFor: (
    predicate: (snapshot: TransferSnapshot) => boolean,
    ms?: number,
  ) => Promise<TransferSnapshot>;
}

function makeSide(
  channel: FakeChannel,
  options: Partial<ConstructorParameters<typeof TransferEngine>[1]> = {},
): Side {
  const events: EngineEvent[] = [];
  const snapshots: TransferSnapshot[] = [];
  const received: ReceivedFile[] = [];
  const waiters: Array<{
    predicate: (s: TransferSnapshot) => boolean;
    resolve: (s: TransferSnapshot) => void;
  }> = [];
  const engine = new TransferEngine(channel, {
    ...options,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'file-received') received.push(event.file);
      if (event.type === 'transfer') {
        snapshots.push(event.transfer);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(event.transfer)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(event.transfer);
          }
        }
      }
    },
  });
  return {
    engine,
    channel,
    events,
    snapshots,
    received,
    waitFor: (predicate, ms = 8000) =>
      new Promise((resolve, reject) => {
        const existing = snapshots.find(predicate);
        if (existing) return resolve(existing);
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for transfer state')),
          ms,
        );
        waiters.push({
          predicate,
          resolve: (snapshot) => {
            clearTimeout(timer);
            resolve(snapshot);
          },
        });
      }),
  };
}

async function connected(bytesPerTick?: number, senderOptions = {}, receiverOptions = {}) {
  const [a, b] = channelPair(bytesPerTick);
  const sender = makeSide(a, senderOptions);
  const receiver = makeSide(b, receiverOptions);
  sender.engine.start();
  receiver.engine.start();
  await until(() => sender.engine.ready && receiver.engine.ready);
  return { sender, receiver };
}

async function until(condition: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('TransferEngine', () => {
  it('transfers several files, including an empty one, byte for byte and in order', async () => {
    const { sender, receiver } = await connected();
    const files = [
      randomFile('a.bin', 300_000),
      randomFile('empty.txt', 0, 'text/plain'),
      randomFile('photo.jpg', 1_234_567, 'image/jpeg'),
    ];
    sender.engine.offer(files);
    const offer = await receiver.waitFor((s) => s.status === 'offered');
    expect(offer.files.map((f) => f.name)).toEqual(['a.bin', 'empty.txt', 'photo.jpg']);
    expect(offer.totalBytes).toBe(300_000 + 1_234_567);

    receiver.engine.accept(offer.id);
    await receiver.waitFor((s) => s.status === 'completed');
    const done = await sender.waitFor((s) => s.status === 'completed');
    expect(done.transferredBytes).toBe(done.totalBytes);
    expect(done.files.every((f) => f.done)).toBe(true);

    expect(receiver.received.map((f) => f.name)).toEqual(['a.bin', 'empty.txt', 'photo.jpg']);
    for (const [index, file] of files.entries()) {
      expect(await bytesOf(receiver.received[index]!.blob)).toEqual(await bytesOf(file));
    }
    // Downloads never carry a peer-chosen MIME type.
    expect(receiver.received.every((f) => f.blob.type === 'application/octet-stream')).toBe(true);
  });

  it('reports real, monotonic byte progress from receiver acknowledgements', async () => {
    const { sender, receiver } = await connected(256 * 1024);
    sender.engine.offer([randomFile('big.bin', 5_000_000)]);
    receiver.engine.accept((await receiver.waitFor((s) => s.status === 'offered')).id);
    await sender.waitFor((s) => s.status === 'completed');
    const progress = sender.snapshots
      .filter((s) => s.status === 'transferring')
      .map((s) => s.transferredBytes);
    expect(progress.length).toBeGreaterThan(2);
    for (let i = 1; i < progress.length; i++)
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(Math.max(...progress)).toBeLessThanOrEqual(5_000_000);
  });

  it('respects backpressure: bufferedAmount stays bounded on a slow channel', async () => {
    const { sender, receiver } = await connected(128 * 1024);
    sender.engine.offer([randomFile('slow.bin', 12_000_000)]);
    receiver.engine.accept((await receiver.waitFor((s) => s.status === 'offered')).id);
    await receiver.waitFor((s) => s.status === 'completed', 20_000);
    // HIGH_WATER is 4 MiB; at most one frame can be queued past it.
    expect(sender.channel.peakBuffered).toBeLessThanOrEqual(4 * 1024 * 1024 + MAX_FRAME_BYTES);
    // Frames never exceed the agreed maximum message size.
    const frames = sender.channel.sent.filter((m): m is ArrayBuffer => typeof m !== 'string');
    expect(Math.max(...frames.map((f) => f.byteLength))).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it('lets the receiver decline an offer', async () => {
    const { sender, receiver } = await connected();
    sender.engine.offer([randomFile('nope.bin', 1000)]);
    receiver.engine.reject((await receiver.waitFor((s) => s.status === 'offered')).id);
    const result = await sender.waitFor((s) => s.status === 'rejected');
    expect(result.endedBy).toBe('remote');
    expect(sender.channel.sent.some((m) => typeof m !== 'string')).toBe(false); // no bytes were sent
  });

  it('stops sending when the sender cancels, and the receiver discards partial data', async () => {
    const { sender, receiver } = await connected(64 * 1024);
    sender.engine.offer([randomFile('cancel.bin', 8_000_000)]);
    receiver.engine.accept((await receiver.waitFor((s) => s.status === 'offered')).id);
    await receiver.waitFor((s) => s.status === 'transferring' && s.transferredBytes > 200_000);
    sender.engine.cancel();
    const sentAtCancel = sender.channel.sent.length;
    const result = await receiver.waitFor((s) => s.status === 'cancelled');
    expect(result.endedBy).toBe('remote');
    expect(receiver.received).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sender.channel.sent.length - sentAtCancel).toBeLessThanOrEqual(1);
    expect(sender.engine.busy).toBe(false);
  });

  it('stops the sender when the receiver cancels mid-transfer', async () => {
    const { sender, receiver } = await connected(64 * 1024);
    sender.engine.offer([randomFile('cancel2.bin', 8_000_000)]);
    receiver.engine.accept((await receiver.waitFor((s) => s.status === 'offered')).id);
    await receiver.waitFor((s) => s.status === 'transferring' && s.transferredBytes > 100_000);
    receiver.engine.cancel();
    const result = await sender.waitFor((s) => s.status === 'cancelled');
    expect(result.endedBy).toBe('remote');
    const sentAfter = sender.channel.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sender.channel.sent.length).toBe(sentAfter);
  });

  it('turns a dropped connection into a clear connection-lost failure on both sides', async () => {
    const { sender, receiver } = await connected(64 * 1024);
    sender.engine.offer([randomFile('drop.bin', 8_000_000)]);
    receiver.engine.accept((await receiver.waitFor((s) => s.status === 'offered')).id);
    await receiver.waitFor((s) => s.transferredBytes > 100_000);
    sender.channel.close();
    expect((await sender.waitFor((s) => s.status === 'failed')).error).toBe('connection-lost');
    expect((await receiver.waitFor((s) => s.status === 'failed')).error).toBe('connection-lost');
    expect(receiver.events.some((e) => e.type === 'channel-closed')).toBe(true);
  });

  it('rejects out-of-sequence chunks as a protocol error and tells the sender', async () => {
    const { sender, receiver } = await connected();
    let tampered = false;
    sender.channel.intercept = (data) => {
      if (!tampered && typeof data !== 'string') {
        tampered = true;
        const view = new DataView(data);
        view.setUint32(8, 7); // wrong sequence number
      }
      return data;
    };
    sender.engine.offer([randomFile('seq.bin', 500_000)]);
    receiver.engine.accept((await receiver.waitFor((s) => s.status === 'offered')).id);
    expect((await receiver.waitFor((s) => s.status === 'failed')).error).toBe('protocol-error');
    expect((await sender.waitFor((s) => s.status === 'failed')).error).toBe('peer-error');
    expect(receiver.received).toHaveLength(0);
  });

  it('treats malformed control messages as a protocol error during a transfer', async () => {
    const { sender, receiver } = await connected(64 * 1024);
    sender.engine.offer([randomFile('x.bin', 2_000_000)]);
    receiver.engine.accept((await receiver.waitFor((s) => s.status === 'offered')).id);
    await receiver.waitFor((s) => s.status === 'transferring');
    // An offer whose sizes do not add up is invalid input from the peer.
    sender.channel.send(
      encodeControl({
        t: 'offer',
        id: 'abcdefgh',
        tag: 1,
        files: [{ index: 0, name: 'a', size: 5, type: '', lastModified: 0 }],
        totalBytes: 99,
      }),
    );
    expect((await receiver.waitFor((s) => s.status === 'failed')).error).toBe('protocol-error');
  });

  it('reports unreadable files as a file-read failure', async () => {
    const { sender, receiver } = await connected(undefined, {
      readBlock: async () => {
        throw new DOMException('The file could not be read', 'NotReadableError');
      },
    });
    sender.engine.offer([randomFile('gone.bin', 10_000)]);
    receiver.engine.accept((await receiver.waitFor((s) => s.status === 'offered')).id);
    expect((await sender.waitFor((s) => s.status === 'failed')).error).toBe('file-read-failed');
    expect((await receiver.waitFor((s) => s.status === 'failed')).error).toBe('peer-error');
  });

  it('declines a second offer while busy', async () => {
    const { sender, receiver } = await connected();
    sender.engine.offer([randomFile('one.bin', 1000)]);
    await receiver.waitFor((s) => s.status === 'offered');
    // A misbehaving peer sends another offer while the first awaits a decision.
    sender.channel.send(
      encodeControl({
        t: 'offer',
        id: 'second00',
        tag: 2,
        files: [{ index: 0, name: 'two', size: 1, type: '', lastModified: 0 }],
        totalBytes: 1,
      }),
    );
    await until(() =>
      receiver.channel.sent.some(
        (m) => typeof m === 'string' && m.includes('"reject"') && m.includes('second00'),
      ),
    );
  });

  it('sanitizes peer-supplied file names', async () => {
    const { sender, receiver } = await connected();
    sender.engine.offer([
      randomFile('../../etc/passwd', 10),
      randomFile('<img src=x onerror=alert(1)>.html', 10),
    ]);
    const offer = await receiver.waitFor((s) => s.status === 'offered');
    for (const file of offer.files) {
      expect(file.name).not.toMatch(/[\\/<>]/);
      expect(file.name.startsWith('.')).toBe(false);
    }
  });

  it('ignores stray chunks that do not belong to the active transfer', async () => {
    const { sender, receiver } = await connected();
    sender.engine.offer([randomFile('ok.bin', 100_000)]);
    const offer = await receiver.waitFor((s) => s.status === 'offered');
    // A chunk with a foreign tag arrives before acceptance: it is dropped silently.
    sender.channel.send(encodeChunk(12345, 0, 0, new Uint8Array(10)));
    receiver.engine.accept(offer.id);
    await receiver.waitFor((s) => s.status === 'completed');
    expect(receiver.received[0]!.size).toBe(100_000);
    expect(FRAME_HEADER_BYTES).toBe(12);
  });
});

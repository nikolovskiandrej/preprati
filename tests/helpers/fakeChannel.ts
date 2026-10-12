/**
 * In-memory stand-in for a pair of connected RTCDataChannels. Messages are
 * delivered asynchronously with a per-tick byte budget, so `bufferedAmount`
 * grows and drains like a real channel and backpressure is exercised.
 */
import type { ChannelLike } from '../../src/client/transfer/engine';

type Listener = (event: never) => void;

export class FakeChannel implements ChannelLike {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  peer: FakeChannel | null = null;
  /** Highest bufferedAmount observed (to assert backpressure). */
  peakBuffered = 0;
  /** Everything this side sent, for inspection. */
  readonly sent: Array<string | ArrayBuffer> = [];
  /** Optional hook to tamper with outgoing messages. */
  intercept: ((data: string | ArrayBuffer) => string | ArrayBuffer | null) | null = null;

  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly queue: Array<{ data: string | ArrayBuffer; size: number }> = [];
  private flushing = false;

  constructor(private readonly bytesPerTick = Number.POSITIVE_INFINITY) {}

  send(data: string | ArrayBufferView<ArrayBuffer>): void {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: channel not open');
    let payload: string | ArrayBuffer =
      typeof data === 'string'
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.sent.push(payload);
    if (this.intercept) {
      const replaced = this.intercept(payload);
      if (replaced === null) return;
      payload = replaced;
    }
    const size = typeof payload === 'string' ? payload.length : payload.byteLength;
    this.bufferedAmount += size;
    this.peakBuffered = Math.max(this.peakBuffered, this.bufferedAmount);
    this.queue.push({ data: payload, size });
    this.schedule();
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Closes both ends, like a dropped connection. */
  close(): void {
    for (const side of [this, this.peer]) {
      if (!side || side.readyState === 'closed') continue;
      side.readyState = 'closed';
      side.queue.length = 0;
      side.bufferedAmount = 0;
      side.emit('close', new Event('close'));
    }
  }

  protected emit(type: string, event: Event): void {
    for (const listener of [...(this.listeners.get(type) ?? [])])
      (listener as (event: Event) => void)(event);
  }

  private schedule(): void {
    if (this.flushing) return;
    this.flushing = true;
    setTimeout(() => this.flush(), 0);
  }

  protected flush(): void {
    this.flushing = false;
    if (this.readyState !== 'open' || !this.peer) return;
    let budget = this.bytesPerTick;
    const before = this.bufferedAmount;
    while (this.queue.length > 0 && budget > 0) {
      const message = this.queue.shift()!;
      budget -= message.size;
      this.bufferedAmount -= message.size;
      this.peer.emit('message', new MessageEvent('message', { data: message.data }));
      if (this.readyState !== 'open') return;
    }
    if (
      before > this.bufferedAmountLowThreshold &&
      this.bufferedAmount <= this.bufferedAmountLowThreshold
    ) {
      this.emit('bufferedamountlow', new Event('bufferedamountlow'));
    }
    if (this.queue.length > 0) this.schedule();
  }
}

export function channelPair(bytesPerTick?: number): [FakeChannel, FakeChannel] {
  const a = new FakeChannel(bytesPerTick);
  const b = new FakeChannel(bytesPerTick);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

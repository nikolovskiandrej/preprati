/**
 * TransferEngine — moves files over one reliable, ordered data channel using
 * the protocol in ./protocol.ts. It knows nothing about WebRTC or React: it
 * only needs an object shaped like RTCDataChannel, which keeps it testable.
 *
 * Guarantees
 * - Real progress: the sender reports bytes the *receiver* acknowledged.
 * - Bounded memory: the sender never lets `bufferedAmount` exceed HIGH_WATER
 *   and reads files in 1 MiB blocks; the receiver folds chunks into Blobs.
 * - Integrity: chunks must match the active transfer tag, the current file
 *   and the next sequence number, and per-file byte counts must match the
 *   offer exactly; anything else aborts the transfer as a protocol error.
 * - One transfer at a time; offers received while busy are rejected.
 */
import { sanitizeFileName } from '../lib/files';
import {
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
  FRAME_HEADER_BYTES,
  helloMessage,
  MAX_FILES_PER_TRANSFER,
  MAX_FRAME_BYTES,
  randomTag,
  randomTransferId,
  type ControlMessage,
  type OfferedFile,
} from './protocol';
import { PROTOCOL_VERSION } from '../../shared/constants';

/** The subset of RTCDataChannel the engine relies on. */
export interface ChannelLike {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  send(data: string | ArrayBufferView<ArrayBuffer>): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'close' | 'bufferedamountlow' | 'error', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'close' | 'bufferedamountlow' | 'error', listener: () => void): void;
}

export type TransferDirection = 'outgoing' | 'incoming';
export type TransferStatus =
  | 'offered'
  | 'awaiting-acceptance'
  | 'transferring'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'failed';
export type TransferErrorCode =
  | 'connection-lost'
  | 'protocol-error'
  | 'file-read-failed'
  | 'peer-error'
  /** Relay mode: the selection is over the storage limits. */
  | 'relay-too-large'
  /** Relay mode: the server can't store files right now (full, busy, monthly budget used). */
  | 'relay-storage'
  /** Relay mode: the upload or download was interrupted. */
  | 'relay-network';

export interface TransferFileSnapshot {
  index: number;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  transferredBytes: number;
  done: boolean;
}

export interface TransferSnapshot {
  id: string;
  direction: TransferDirection;
  status: TransferStatus;
  files: TransferFileSnapshot[];
  totalBytes: number;
  transferredBytes: number;
  startedAt: number | null;
  finishedAt: number | null;
  endedBy: 'local' | 'remote' | null;
  error: TransferErrorCode | null;
  /**
   * Relay mode only: what `transferredBytes` currently counts — the sender
   * uploading the encrypted package, or the receiver downloading it.
   */
  stage?: 'upload' | 'download';
}

export interface ReceivedFile {
  transferId: string;
  index: number;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  blob: Blob;
}

export type EngineEvent =
  | { type: 'ready'; remoteVersion: number }
  | { type: 'version-mismatch'; remoteVersion: number }
  | { type: 'transfer'; transfer: TransferSnapshot }
  | { type: 'file-received'; file: ReceivedFile }
  | { type: 'peer-bye' }
  | { type: 'channel-closed' };

/**
 * What a Quick Transfer session needs from the thing that moves its files:
 * TransferEngine over a direct connection, RelayEngine through temporary
 * encrypted storage when there is none.
 */
export interface FileTransport {
  readonly ready: boolean;
  readonly busy: boolean;
  /** Call once the path is up; `ready` is emitted when both sides can transfer. */
  start(): void;
  offer(files: File[]): TransferSnapshot;
  accept(id: string): void;
  reject(id: string): void;
  cancel(): void;
  sayGoodbye(): void;
  dispose(): void;
}

export interface EngineOptions {
  onEvent: (event: EngineEvent) => void;
  now?: () => number;
  /** Negotiated SCTP max message size, if known (read when a transfer starts). */
  getMaxMessageSize?: () => number | undefined;
  /** Override file reading (tests). */
  readBlock?: (file: Blob, start: number, end: number) => Promise<ArrayBuffer>;
}

const READ_BLOCK_BYTES = 1024 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const FOLD_BYTES = 8 * 1024 * 1024;
const ACK_INTERVAL_MS = 200;
const ACK_BYTES = 2 * 1024 * 1024;
const UI_INTERVAL_MS = 100;

interface Outgoing {
  snapshot: TransferSnapshot;
  tag: number;
  files: File[];
  aborted: boolean;
}

interface Incoming {
  snapshot: TransferSnapshot;
  tag: number;
  fileIndex: number;
  sequence: number;
  fileBytes: number;
  parts: BlobPart[];
  partBytes: number;
  blobs: Blob[];
  lastAckAt: number;
  lastAckBytes: number;
}

export class TransferEngine implements FileTransport {
  private readonly channel: ChannelLike;
  private readonly options: EngineOptions;
  private readonly now: () => number;
  private outgoing: Outgoing | null = null;
  private incoming: Incoming | null = null;
  private remoteMaxFrame = MAX_FRAME_BYTES;
  private remoteReady = false;
  private disposed = false;
  private lastUiEmit = 0;
  private drainWaiters: Array<() => void> = [];

  constructor(channel: ChannelLike, options: EngineOptions) {
    this.channel = channel;
    this.options = options;
    this.now = options.now ?? Date.now;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;
    // Listen right away so a fast peer's first messages are never missed.
    channel.addEventListener('message', this.handleMessage);
    channel.addEventListener('close', this.handleClose);
    channel.addEventListener('bufferedamountlow', this.handleDrain);
  }

  /** Announces our protocol version; call once the channel is open. */
  start(): void {
    this.sendControl(helloMessage(MAX_FRAME_BYTES));
  }

  get ready(): boolean {
    return this.remoteReady;
  }

  /** True while a transfer is offered, awaiting a decision or moving bytes. */
  get busy(): boolean {
    const active = (s: TransferSnapshot | undefined) =>
      !!s &&
      (s.status === 'offered' || s.status === 'awaiting-acceptance' || s.status === 'transferring');
    return active(this.outgoing?.snapshot) || active(this.incoming?.snapshot);
  }

  /** Offers files to the peer. Throws if not ready, busy, or given nothing to send. */
  offer(files: File[]): TransferSnapshot {
    if (!this.remoteReady) throw new Error('Peer is not ready');
    if (this.busy) throw new Error('A transfer is already in progress');
    if (files.length === 0 || files.length > MAX_FILES_PER_TRANSFER)
      throw new Error('Invalid file selection');

    const id = randomTransferId();
    const tag = randomTag();
    const offered: OfferedFile[] = files.map((file, index) => ({
      index,
      name: file.name || `file-${index + 1}`,
      size: file.size,
      type: file.type.slice(0, 255),
      lastModified: Number.isFinite(file.lastModified)
        ? Math.max(0, Math.floor(file.lastModified))
        : 0,
    }));
    const snapshot: TransferSnapshot = {
      id,
      direction: 'outgoing',
      status: 'awaiting-acceptance',
      files: offered.map((file) => ({ ...file, transferredBytes: 0, done: false })),
      totalBytes: offered.reduce((sum, file) => sum + file.size, 0),
      transferredBytes: 0,
      startedAt: null,
      finishedAt: null,
      endedBy: null,
      error: null,
    };
    this.outgoing = { snapshot, tag, files, aborted: false };
    this.sendControl({ t: 'offer', id, tag, files: offered, totalBytes: snapshot.totalBytes });
    this.emitTransfer(snapshot);
    return snapshot;
  }

  accept(id: string): void {
    const incoming = this.incoming;
    if (!incoming || incoming.snapshot.id !== id || incoming.snapshot.status !== 'offered') return;
    incoming.snapshot = { ...incoming.snapshot, status: 'transferring', startedAt: this.now() };
    incoming.lastAckAt = this.now();
    this.sendControl({ t: 'accept', id });
    this.emitTransfer(incoming.snapshot);
    // Zero-byte files never produce chunks; they complete on `file-end`.
  }

  reject(id: string): void {
    const incoming = this.incoming;
    if (!incoming || incoming.snapshot.id !== id || incoming.snapshot.status !== 'offered') return;
    this.sendControl({ t: 'reject', id });
    this.finishIncoming('rejected', 'local');
  }

  /** Cancels whatever transfer is active (either direction). */
  cancel(): void {
    if (this.outgoing && this.isActive(this.outgoing.snapshot)) {
      this.outgoing.aborted = true;
      this.sendControl({ t: 'cancel', id: this.outgoing.snapshot.id, reason: 'user' });
      this.finishOutgoing('cancelled', 'local');
      this.wakeDrainWaiters();
    }
    if (this.incoming && this.isActive(this.incoming.snapshot)) {
      this.sendControl({ t: 'cancel', id: this.incoming.snapshot.id, reason: 'user' });
      this.finishIncoming('cancelled', 'local');
    }
  }

  /** Tells the peer we are leaving on purpose (so it can say so instead of "connection lost"). */
  sayGoodbye(): void {
    this.sendControl({ t: 'bye' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.outgoing) this.outgoing.aborted = true;
    this.channel.removeEventListener('message', this.handleMessage);
    this.channel.removeEventListener('close', this.handleClose);
    this.channel.removeEventListener('bufferedamountlow', this.handleDrain);
    this.wakeDrainWaiters();
    if (this.incoming) {
      this.incoming.parts = [];
      this.incoming.blobs = [];
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Inbound                                                                  */
  /* ------------------------------------------------------------------------ */

  private readonly handleMessage = (event: MessageEvent) => {
    if (this.disposed) return;
    if (typeof event.data === 'string') {
      const message = decodeControl(event.data);
      if (!message) {
        this.protocolError();
        return;
      }
      this.handleControl(message);
    } else if (event.data instanceof ArrayBuffer) {
      this.handleChunk(event.data);
    } else {
      this.protocolError();
    }
  };

  private handleControl(message: ControlMessage): void {
    switch (message.t) {
      case 'hello':
        this.remoteMaxFrame = message.maxFrame;
        if (message.v !== PROTOCOL_VERSION) {
          this.options.onEvent({ type: 'version-mismatch', remoteVersion: message.v });
          return;
        }
        this.remoteReady = true;
        this.options.onEvent({ type: 'ready', remoteVersion: message.v });
        return;
      case 'offer':
        this.handleOffer(message);
        return;
      case 'accept': {
        const outgoing = this.outgoing;
        if (
          !outgoing ||
          outgoing.snapshot.id !== message.id ||
          outgoing.snapshot.status !== 'awaiting-acceptance'
        )
          return;
        outgoing.snapshot = { ...outgoing.snapshot, status: 'transferring', startedAt: this.now() };
        this.emitTransfer(outgoing.snapshot);
        void this.pump(outgoing);
        return;
      }
      case 'reject':
        if (
          this.outgoing?.snapshot.id === message.id &&
          this.outgoing.snapshot.status === 'awaiting-acceptance'
        ) {
          this.finishOutgoing('rejected', 'remote');
        }
        return;
      case 'progress': {
        const outgoing = this.outgoing;
        if (
          !outgoing ||
          outgoing.snapshot.id !== message.id ||
          outgoing.snapshot.status !== 'transferring'
        )
          return;
        const bytes = Math.min(message.bytes, outgoing.snapshot.totalBytes);
        if (bytes < outgoing.snapshot.transferredBytes) return; // acknowledgements are monotonic
        outgoing.snapshot = withProgress(outgoing.snapshot, bytes);
        this.emitTransfer(outgoing.snapshot, true);
        return;
      }
      case 'complete': {
        const outgoing = this.outgoing;
        if (
          !outgoing ||
          outgoing.snapshot.id !== message.id ||
          outgoing.snapshot.status !== 'transferring'
        )
          return;
        outgoing.snapshot = {
          ...outgoing.snapshot,
          transferredBytes: outgoing.snapshot.totalBytes,
          files: outgoing.snapshot.files.map((file) => ({
            ...file,
            transferredBytes: file.size,
            done: true,
          })),
        };
        this.finishOutgoing('completed', null);
        return;
      }
      case 'cancel':
        if (this.outgoing?.snapshot.id === message.id && this.isActive(this.outgoing.snapshot)) {
          this.outgoing.aborted = true;
          this.wakeDrainWaiters();
          this.finishOutgoing(
            message.reason === 'error' ? 'failed' : 'cancelled',
            'remote',
            message.reason === 'error' ? 'peer-error' : null,
          );
        }
        if (this.incoming?.snapshot.id === message.id && this.isActive(this.incoming.snapshot)) {
          this.finishIncoming(
            message.reason === 'error' ? 'failed' : 'cancelled',
            'remote',
            message.reason === 'error' ? 'peer-error' : null,
          );
        }
        return;
      case 'file-end':
        this.handleFileEnd(message.id, message.index, message.size);
        return;
      case 'done':
        this.handleDone(message.id);
        return;
      case 'bye':
        this.options.onEvent({ type: 'peer-bye' });
        return;
    }
  }

  private handleOffer(message: Extract<ControlMessage, { t: 'offer' }>): void {
    if (this.busy) {
      this.sendControl({ t: 'reject', id: message.id });
      return;
    }
    const files: TransferFileSnapshot[] = message.files.map((file) => ({
      index: file.index,
      name: sanitizeFileName(file.name, `file-${file.index + 1}`),
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      transferredBytes: 0,
      done: false,
    }));
    const snapshot: TransferSnapshot = {
      id: message.id,
      direction: 'incoming',
      status: 'offered',
      files,
      totalBytes: message.totalBytes,
      transferredBytes: 0,
      startedAt: null,
      finishedAt: null,
      endedBy: null,
      error: null,
    };
    this.incoming = {
      snapshot,
      tag: message.tag,
      fileIndex: 0,
      sequence: 0,
      fileBytes: 0,
      parts: [],
      partBytes: 0,
      blobs: [],
      lastAckAt: 0,
      lastAckBytes: 0,
    };
    this.emitTransfer(snapshot);
  }

  private handleChunk(data: ArrayBuffer): void {
    const incoming = this.incoming;
    const frame = decodeChunk(data);
    if (!incoming || !frame) {
      // Stale chunks of a cancelled transfer may still be in flight; ignore those quietly.
      if (!frame) this.protocolError();
      return;
    }
    if (frame.tag !== incoming.tag || incoming.snapshot.status !== 'transferring') return;
    const file = incoming.snapshot.files[incoming.fileIndex];
    const maxPayload = MAX_FRAME_BYTES - FRAME_HEADER_BYTES;
    if (
      !file ||
      frame.fileIndex !== incoming.fileIndex ||
      frame.sequence !== incoming.sequence ||
      frame.payload.byteLength > maxPayload ||
      incoming.fileBytes + frame.payload.byteLength > file.size
    ) {
      this.protocolError();
      return;
    }

    incoming.parts.push(frame.payload as Uint8Array<ArrayBuffer>);
    incoming.partBytes += frame.payload.byteLength;
    incoming.fileBytes += frame.payload.byteLength;
    incoming.sequence += 1;
    if (incoming.partBytes >= FOLD_BYTES) this.foldParts(incoming);

    incoming.snapshot = withProgress(
      incoming.snapshot,
      incoming.snapshot.transferredBytes + frame.payload.byteLength,
    );
    this.maybeAck(incoming, false);
    this.emitTransfer(incoming.snapshot, true);
  }

  private handleFileEnd(id: string, index: number, size: number): void {
    const incoming = this.incoming;
    if (!incoming || incoming.snapshot.id !== id || incoming.snapshot.status !== 'transferring')
      return;
    const file = incoming.snapshot.files[incoming.fileIndex];
    if (
      !file ||
      index !== incoming.fileIndex ||
      size !== file.size ||
      incoming.fileBytes !== file.size
    ) {
      this.protocolError();
      return;
    }
    this.foldParts(incoming);
    const blob = new Blob(incoming.blobs, { type: 'application/octet-stream' });
    incoming.blobs = [];
    incoming.snapshot = {
      ...incoming.snapshot,
      files: incoming.snapshot.files.map((f) =>
        f.index === index ? { ...f, transferredBytes: f.size, done: true } : f,
      ),
    };
    this.options.onEvent({
      type: 'file-received',
      file: {
        transferId: id,
        index,
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        blob,
      },
    });
    incoming.fileIndex += 1;
    incoming.sequence = 0;
    incoming.fileBytes = 0;
    this.emitTransfer(incoming.snapshot);
  }

  private handleDone(id: string): void {
    const incoming = this.incoming;
    if (!incoming || incoming.snapshot.id !== id || incoming.snapshot.status !== 'transferring')
      return;
    if (
      incoming.fileIndex !== incoming.snapshot.files.length ||
      incoming.snapshot.transferredBytes !== incoming.snapshot.totalBytes
    ) {
      this.protocolError();
      return;
    }
    this.maybeAck(incoming, true);
    this.sendControl({ t: 'complete', id });
    this.finishIncoming('completed', null);
  }

  private maybeAck(incoming: Incoming, force: boolean): void {
    const bytes = incoming.snapshot.transferredBytes;
    const now = this.now();
    if (
      force ||
      now - incoming.lastAckAt >= ACK_INTERVAL_MS ||
      bytes - incoming.lastAckBytes >= ACK_BYTES
    ) {
      incoming.lastAckAt = now;
      incoming.lastAckBytes = bytes;
      this.sendControl({ t: 'progress', id: incoming.snapshot.id, bytes });
    }
  }

  private foldParts(incoming: Incoming): void {
    if (incoming.parts.length === 0) return;
    incoming.blobs.push(new Blob(incoming.parts));
    incoming.parts = [];
    incoming.partBytes = 0;
  }

  /* ------------------------------------------------------------------------ */
  /* Outbound                                                                 */
  /* ------------------------------------------------------------------------ */

  private async pump(outgoing: Outgoing): Promise<void> {
    const limit = Math.min(
      MAX_FRAME_BYTES,
      this.remoteMaxFrame,
      this.options.getMaxMessageSize?.() ?? MAX_FRAME_BYTES,
    );
    const payloadSize = Math.max(1024, limit - FRAME_HEADER_BYTES);
    const readRaw =
      this.options.readBlock ??
      ((file: Blob, start: number, end: number) => file.slice(start, end).arrayBuffer());
    // Read-ahead promises may be abandoned on cancel; mark them handled (awaiting still sees errors).
    const read = (file: Blob, start: number, end: number) => {
      const promise = readRaw(file, start, end);
      promise.catch(() => undefined);
      return promise;
    };
    const id = outgoing.snapshot.id;

    try {
      for (let index = 0; index < outgoing.files.length; index++) {
        const file = outgoing.files[index]!;
        let sequence = 0;
        let offset = 0;
        let pending: Promise<ArrayBuffer> | null =
          file.size > 0 ? read(file, 0, Math.min(READ_BLOCK_BYTES, file.size)) : null;
        while (pending) {
          const block = new Uint8Array(await pending);
          if (block.byteLength === 0 && offset < file.size) throw new FileReadError();
          const nextOffset = offset + block.byteLength;
          pending =
            nextOffset < file.size
              ? read(file, nextOffset, Math.min(nextOffset + READ_BLOCK_BYTES, file.size))
              : null;
          for (let position = 0; position < block.byteLength; position += payloadSize) {
            await this.waitForDrain();
            if (outgoing.aborted || this.disposed) return;
            if (this.channel.readyState !== 'open') throw new ConnectionLostError();
            const payload = block.subarray(
              position,
              Math.min(position + payloadSize, block.byteLength),
            );
            this.channel.send(encodeChunk(outgoing.tag, index, sequence, payload));
            sequence += 1;
          }
          offset = nextOffset;
        }
        if (offset !== file.size) throw new FileReadError();
        if (outgoing.aborted || this.disposed) return;
        this.sendControl({ t: 'file-end', id, index, size: file.size });
      }
      if (outgoing.aborted || this.disposed) return;
      this.sendControl({ t: 'done', id });
      // Completion is declared when the receiver's `complete` arrives.
    } catch (error) {
      if (outgoing.aborted || this.disposed) return;
      outgoing.aborted = true;
      if (error instanceof ConnectionLostError || this.channel.readyState !== 'open') {
        this.finishOutgoing('failed', null, 'connection-lost');
      } else {
        this.sendControl({ t: 'cancel', id, reason: 'error' });
        this.finishOutgoing('failed', 'local', 'file-read-failed');
      }
    }
  }

  private waitForDrain(): Promise<void> {
    if (this.channel.bufferedAmount <= HIGH_WATER || this.channel.readyState !== 'open')
      return Promise.resolve();
    return new Promise((resolve) => {
      // Poll as a safety net: some browsers have dropped `bufferedamountlow` events.
      const poll = setInterval(() => {
        if (
          this.channel.bufferedAmount <= LOW_WATER ||
          this.channel.readyState !== 'open' ||
          this.disposed
        )
          wake();
      }, 250);
      const wake = () => {
        clearInterval(poll);
        this.drainWaiters = this.drainWaiters.filter((waiter) => waiter !== wake);
        resolve();
      };
      this.drainWaiters.push(wake);
    });
  }

  private readonly handleDrain = () => this.wakeDrainWaiters();

  private wakeDrainWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const wake of waiters) wake();
  }

  /* ------------------------------------------------------------------------ */
  /* Shared                                                                   */
  /* ------------------------------------------------------------------------ */

  private readonly handleClose = () => {
    if (this.disposed) return;
    this.wakeDrainWaiters();
    if (this.outgoing && this.isActive(this.outgoing.snapshot)) {
      this.outgoing.aborted = true;
      this.finishOutgoing('failed', null, 'connection-lost');
    }
    if (this.incoming && this.isActive(this.incoming.snapshot)) {
      this.finishIncoming('failed', null, 'connection-lost');
    }
    this.options.onEvent({ type: 'channel-closed' });
  };

  private protocolError(): void {
    if (this.incoming && this.isActive(this.incoming.snapshot)) {
      this.sendControl({ t: 'cancel', id: this.incoming.snapshot.id, reason: 'error' });
      this.finishIncoming('failed', 'local', 'protocol-error');
    }
    if (this.outgoing && this.isActive(this.outgoing.snapshot)) {
      this.outgoing.aborted = true;
      this.sendControl({ t: 'cancel', id: this.outgoing.snapshot.id, reason: 'error' });
      this.finishOutgoing('failed', 'local', 'protocol-error');
    }
  }

  private finishOutgoing(
    status: TransferStatus,
    endedBy: 'local' | 'remote' | null,
    error: TransferErrorCode | null = null,
  ) {
    if (!this.outgoing) return;
    this.outgoing.snapshot = {
      ...this.outgoing.snapshot,
      status,
      endedBy,
      error,
      finishedAt: this.now(),
    };
    this.emitTransfer(this.outgoing.snapshot);
  }

  private finishIncoming(
    status: TransferStatus,
    endedBy: 'local' | 'remote' | null,
    error: TransferErrorCode | null = null,
  ) {
    const incoming = this.incoming;
    if (!incoming) return;
    if (status !== 'completed') {
      // Drop partial data right away.
      incoming.parts = [];
      incoming.blobs = [];
    }
    incoming.snapshot = { ...incoming.snapshot, status, endedBy, error, finishedAt: this.now() };
    this.emitTransfer(incoming.snapshot);
  }

  private isActive(snapshot: TransferSnapshot): boolean {
    return (
      snapshot.status === 'offered' ||
      snapshot.status === 'awaiting-acceptance' ||
      snapshot.status === 'transferring'
    );
  }

  private emitTransfer(snapshot: TransferSnapshot, progressOnly = false): void {
    if (progressOnly) {
      const now = this.now();
      if (now - this.lastUiEmit < UI_INTERVAL_MS && snapshot.transferredBytes < snapshot.totalBytes)
        return;
      this.lastUiEmit = now;
    }
    this.options.onEvent({ type: 'transfer', transfer: snapshot });
  }

  private sendControl(message: ControlMessage): void {
    if (this.channel.readyState !== 'open') return;
    try {
      this.channel.send(encodeControl(message));
    } catch {
      // A failing send means the channel is going away; `close` will follow.
    }
  }
}

class FileReadError extends Error {}
class ConnectionLostError extends Error {}

/** Recomputes per-file progress from a cumulative byte count. */
function withProgress(snapshot: TransferSnapshot, transferredBytes: number): TransferSnapshot {
  let remaining = transferredBytes;
  const files = snapshot.files.map((file) => {
    const bytes = Math.min(file.size, Math.max(0, remaining));
    remaining -= file.size;
    return {
      ...file,
      transferredBytes: bytes,
      done: file.done || (bytes === file.size && remaining >= 0 && file.size > 0),
    };
  });
  return { ...snapshot, files, transferredBytes };
}

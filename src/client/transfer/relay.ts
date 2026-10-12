/**
 * RelayEngine — Quick Transfer when the two devices can't connect directly
 * (networks that keep devices apart, strict NATs on both sides, no TURN
 * relay). The sender encrypts the files into a temporary share package — the
 * same format and storage as Share Files — and the receiver downloads and
 * decrypts it, all inside the same session:
 *
 *   sender ─offer─▶ receiver ─accept | reject─▶ sender
 *   sender uploads the package (progress…) ─ready {share, secret}─▶ receiver
 *   receiver downloads it (progress…) ─complete─▶ sender, which deletes it
 *   either side may send `cancel` at any time
 *
 * The control messages travel over signaling, end-to-end encrypted with the
 * key from ./relayCrypto.ts: the server sees neither file names nor the
 * package key, only ciphertext. The package itself is deleted as soon as the
 * receiver has it (and expires on its own otherwise).
 *
 * RelayEngine has the surface and events of TransferEngine, so the session
 * and the screens treat both paths alike.
 */
import { z } from 'zod';
import { PROTOCOL_VERSION, RANDOM_ID_PATTERN, SECRET_PATTERN } from '../../shared/constants';
import { RELAY_MESSAGE_MAX_CHARS } from '../../shared/signaling';
import { sanitizeFileName } from '../lib/files';
import type {
  EngineEvent,
  FileTransport,
  TransferErrorCode,
  TransferSnapshot,
  TransferStatus,
} from './engine';
import {
  isConsistentOffer,
  MAX_FILES_PER_TRANSFER,
  OfferedFileSchema,
  randomTransferId,
  TransferIdSchema,
  type OfferedFile,
} from './protocol';
import { openRelayMessage, sealRelayMessage, type RelaySide } from './relayCrypto';

/** An uploaded package: what the receiver needs (id, secret) and what deletes it (token). */
export interface RelayPackage {
  id: string;
  ownerToken: string;
  /** The package key, base64url (as in a share link's fragment). */
  secret: string;
}

export interface RelayDownloadedFile {
  name: string;
  type: string;
  size: number;
  lastModified: number;
  blob: Blob;
}

/** Where packages go: the share API in the app, an in-memory fake in tests. */
export interface RelayStorage {
  upload(
    files: File[],
    options: { signal: AbortSignal; onProgress: (bytes: number) => void },
  ): Promise<RelayPackage>;
  download(
    pkg: { id: string; secret: string },
    options: { signal: AbortSignal; onProgress: (bytes: number) => void },
  ): Promise<RelayDownloadedFile[]>;
  remove(pkg: RelayPackage): Promise<void>;
}

/** Storage failures in terms the interface can explain (thrown by RelayStorage). */
export class RelayStorageError extends Error {
  override name = 'RelayStorageError';
  constructor(
    readonly code:
      'aborted' | 'too-large' | 'unavailable' | 'network' | 'file-read-failed' | 'corrupted',
  ) {
    super(code);
  }
}

export interface RelayLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxPackageBytes: number;
}

/** Why a selection can't go through the relay, or null when it can. */
export function relayLimitProblem(
  files: readonly File[],
  limits: RelayLimits,
): 'too-many-files' | 'file-too-large' | 'package-too-large' | null {
  if (files.length > Math.min(limits.maxFiles, MAX_FILES_PER_TRANSFER)) return 'too-many-files';
  if (files.some((file) => file.size > limits.maxFileBytes)) return 'file-too-large';
  if (files.reduce((sum, file) => sum + file.size, 0) > limits.maxPackageBytes)
    return 'package-too-large';
  return null;
}

export interface RelayEngineOptions {
  side: RelaySide;
  /** The key both devices derived (see ./relayCrypto.ts). */
  key: CryptoKey;
  /** Hands an encrypted control message to signaling. */
  send: (payload: { kind: 'relay-message'; seq: number; data: string }) => void;
  storage: RelayStorage;
  limits: RelayLimits;
  onEvent: (event: EngineEvent) => void;
  now?: () => number;
}

const Bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const RelayMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('offer'),
    id: TransferIdSchema,
    files: z.array(OfferedFileSchema).min(1).max(MAX_FILES_PER_TRANSFER),
    totalBytes: Bytes,
  }),
  z.object({ t: z.literal('accept'), id: TransferIdSchema }),
  z.object({ t: z.literal('reject'), id: TransferIdSchema }),
  z.object({
    t: z.literal('progress'),
    id: TransferIdSchema,
    stage: z.enum(['upload', 'download']),
    bytes: Bytes,
  }),
  z.object({
    t: z.literal('ready'),
    id: TransferIdSchema,
    share: z.string().regex(RANDOM_ID_PATTERN),
    secret: z.string().regex(SECRET_PATTERN),
  }),
  z.object({ t: z.literal('complete'), id: TransferIdSchema }),
  z.object({ t: z.literal('cancel'), id: TransferIdSchema, reason: z.enum(['user', 'error']) }),
]);
type RelayMessage = z.infer<typeof RelayMessageSchema>;

/** How often each side reports its upload/download progress to the other. */
const PROGRESS_INTERVAL_MS = 1500;
const UI_INTERVAL_MS = 100;
/** Largest control message (JSON) that still fits a signaling payload once encrypted. */
const MAX_MESSAGE_JSON_BYTES = Math.floor((RELAY_MESSAGE_MAX_CHARS * 3) / 4) - 64;

interface Outgoing {
  snapshot: TransferSnapshot;
  files: File[];
  controller: AbortController | null;
  /** The uploaded package, until it is deleted. */
  pkg: RelayPackage | null;
}

interface Incoming {
  snapshot: TransferSnapshot;
  controller: AbortController | null;
}

export class RelayEngine implements FileTransport {
  private readonly options: RelayEngineOptions;
  private readonly now: () => number;
  private readonly remoteSide: RelaySide;
  private outgoing: Outgoing | null = null;
  private incoming: Incoming | null = null;
  private started = false;
  private disposed = false;
  private sendSeq = 0;
  private expectSeq = 0;
  private outbound: Promise<void> = Promise.resolve();
  private inbound: Promise<void> = Promise.resolve();
  private lastUiEmit = 0;

  constructor(options: RelayEngineOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.remoteSide = options.side === 'sender' ? 'receiver' : 'sender';
  }

  /** Both devices hold the key, so transfers can start right away. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.options.onEvent({ type: 'ready', remoteVersion: PROTOCOL_VERSION });
  }

  get ready(): boolean {
    return this.started && !this.disposed;
  }

  get busy(): boolean {
    return isActive(this.outgoing?.snapshot) || isActive(this.incoming?.snapshot);
  }

  /** Offers files to the other device (throws if not ready, busy or given nothing). */
  offer(files: File[]): TransferSnapshot {
    if (!this.ready) throw new Error('Relay is not ready');
    if (this.busy) throw new Error('A transfer is already in progress');
    if (files.length === 0) throw new Error('Invalid file selection');
    const id = randomTransferId();
    const offered: OfferedFile[] = files.map((file, index) => ({
      index,
      name: file.name || `file-${index + 1}`,
      size: file.size,
      type: file.type.slice(0, 255),
      lastModified: Number.isFinite(file.lastModified)
        ? Math.max(0, Math.floor(file.lastModified))
        : 0,
    }));
    const totalBytes = offered.reduce((sum, file) => sum + file.size, 0);
    this.outgoing = {
      snapshot: {
        id,
        direction: 'outgoing',
        status: 'awaiting-acceptance',
        files: offered.map((file) => ({ ...file, transferredBytes: 0, done: false })),
        totalBytes,
        transferredBytes: 0,
        startedAt: null,
        finishedAt: null,
        endedBy: null,
        error: null,
      },
      files,
      controller: null,
      pkg: null,
    };
    const message = relayLimitProblem(files, this.options.limits)
      ? null
      : fitOffer(id, offered, totalBytes);
    if (!message) {
      this.finishOutgoing('failed', 'local', 'relay-too-large');
    } else {
      this.send(message);
      this.emitTransfer(this.outgoing.snapshot);
    }
    return this.outgoing.snapshot;
  }

  accept(id: string): void {
    const incoming = this.incoming;
    if (!incoming || incoming.snapshot.id !== id || incoming.snapshot.status !== 'offered') return;
    incoming.snapshot = {
      ...incoming.snapshot,
      status: 'transferring',
      stage: 'upload',
      startedAt: this.now(),
    };
    this.send({ t: 'accept', id });
    this.emitTransfer(incoming.snapshot);
  }

  reject(id: string): void {
    const incoming = this.incoming;
    if (!incoming || incoming.snapshot.id !== id || incoming.snapshot.status !== 'offered') return;
    this.send({ t: 'reject', id });
    this.finishIncoming('rejected', 'local');
  }

  /** Cancels whatever transfer is active (either direction). */
  cancel(): void {
    const outgoing = this.outgoing;
    if (outgoing && isActive(outgoing.snapshot)) {
      this.send({ t: 'cancel', id: outgoing.snapshot.id, reason: 'user' });
      this.stopOutgoing(outgoing);
      this.finishOutgoing('cancelled', 'local');
    }
    const incoming = this.incoming;
    if (incoming && isActive(incoming.snapshot)) {
      this.send({ t: 'cancel', id: incoming.snapshot.id, reason: 'user' });
      incoming.controller?.abort();
      this.finishIncoming('cancelled', 'local');
    }
  }

  /**
   * Nothing to send: leaving ends the signaling session itself, which the
   * other device hears as the session's `peer-left`.
   */
  sayGoodbye(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.outgoing) this.stopOutgoing(this.outgoing);
    this.incoming?.controller?.abort();
  }

  /** Feeds one `relay-message` from signaling; messages are handled strictly in order. */
  handleMessage(seq: number, data: string): void {
    this.inbound = this.inbound
      .then(() => this.receive(seq, data))
      .catch(() => {
        if (!this.disposed) this.protocolError();
      });
  }

  /* ------------------------------------------------------------------------ */

  private async receive(seq: number, data: string): Promise<void> {
    if (this.disposed || seq < this.expectSeq) return; // a duplicate
    // The server may drop or inject messages but can't forge them; a gap means one is missing.
    const message = await openRelayMessage(this.options.key, this.remoteSide, seq, data);
    const missed = seq > this.expectSeq;
    this.expectSeq = seq + 1;
    if (missed) this.protocolError();
    const parsed = RelayMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.protocolError();
      return;
    }
    this.handleControl(parsed.data);
  }

  private handleControl(message: RelayMessage): void {
    switch (message.t) {
      case 'offer':
        this.handleOffer(message);
        return;
      case 'accept': {
        const outgoing = this.outgoing;
        if (
          this.options.side !== 'sender' ||
          !outgoing ||
          outgoing.snapshot.id !== message.id ||
          outgoing.snapshot.status !== 'awaiting-acceptance'
        )
          return;
        outgoing.snapshot = {
          ...outgoing.snapshot,
          status: 'transferring',
          stage: 'upload',
          startedAt: this.now(),
        };
        this.emitTransfer(outgoing.snapshot);
        void this.upload(outgoing);
        return;
      }
      case 'reject':
        if (
          this.outgoing?.snapshot.id === message.id &&
          this.outgoing.snapshot.status === 'awaiting-acceptance'
        )
          this.finishOutgoing('rejected', 'remote');
        return;
      case 'progress':
        this.handleProgress(message);
        return;
      case 'ready': {
        const incoming = this.incoming;
        if (
          this.options.side !== 'receiver' ||
          !incoming ||
          incoming.snapshot.id !== message.id ||
          incoming.snapshot.status !== 'transferring' ||
          incoming.snapshot.stage !== 'upload'
        )
          return;
        incoming.snapshot = { ...atBytes(incoming.snapshot, 0), stage: 'download' };
        this.emitTransfer(incoming.snapshot);
        void this.download(incoming, { id: message.share, secret: message.secret });
        return;
      }
      case 'complete': {
        const outgoing = this.outgoing;
        if (
          !outgoing ||
          outgoing.snapshot.id !== message.id ||
          outgoing.snapshot.status !== 'transferring' ||
          outgoing.snapshot.stage !== 'download'
        )
          return;
        outgoing.snapshot = atBytes(outgoing.snapshot, outgoing.snapshot.totalBytes);
        this.stopOutgoing(outgoing); // the receiver has everything: delete the package
        this.finishOutgoing('completed', null);
        return;
      }
      case 'cancel': {
        const failed = message.reason === 'error';
        const outgoing = this.outgoing;
        if (outgoing?.snapshot.id === message.id && isActive(outgoing.snapshot)) {
          this.stopOutgoing(outgoing);
          this.finishOutgoing(
            failed ? 'failed' : 'cancelled',
            'remote',
            failed ? 'peer-error' : null,
          );
        }
        const incoming = this.incoming;
        if (incoming?.snapshot.id === message.id && isActive(incoming.snapshot)) {
          incoming.controller?.abort();
          this.finishIncoming(
            failed ? 'failed' : 'cancelled',
            'remote',
            failed ? 'peer-error' : null,
          );
        }
        return;
      }
    }
  }

  private handleOffer(message: Extract<RelayMessage, { t: 'offer' }>): void {
    if (this.options.side !== 'receiver') return;
    if (!isConsistentOffer(message.files, message.totalBytes)) {
      this.protocolError();
      return;
    }
    if (this.busy) {
      this.send({ t: 'reject', id: message.id });
      return;
    }
    this.incoming = {
      snapshot: {
        id: message.id,
        direction: 'incoming',
        status: 'offered',
        files: message.files.map((file) => ({
          index: file.index,
          name: sanitizeFileName(file.name, `file-${file.index + 1}`),
          size: file.size,
          type: file.type,
          lastModified: file.lastModified,
          transferredBytes: 0,
          done: false,
        })),
        totalBytes: message.totalBytes,
        transferredBytes: 0,
        startedAt: null,
        finishedAt: null,
        endedBy: null,
        error: null,
      },
      controller: null,
    };
    this.emitTransfer(this.incoming.snapshot);
  }

  /** The other side's progress: the sender's upload (seen by the receiver) or the receiver's download. */
  private handleProgress(message: Extract<RelayMessage, { t: 'progress' }>): void {
    const transfer =
      this.options.side === 'receiver' && message.stage === 'upload'
        ? this.incoming
        : this.options.side === 'sender' && message.stage === 'download'
          ? this.outgoing
          : null;
    const snapshot = transfer?.snapshot;
    if (
      !transfer ||
      !snapshot ||
      snapshot.id !== message.id ||
      snapshot.status !== 'transferring' ||
      snapshot.stage !== message.stage
    )
      return;
    const bytes = Math.min(message.bytes, snapshot.totalBytes);
    if (bytes < snapshot.transferredBytes) return; // progress only moves forward
    transfer.snapshot = atBytes(snapshot, bytes);
    this.emitTransfer(transfer.snapshot, true);
  }

  private async upload(outgoing: Outgoing): Promise<void> {
    const { id, totalBytes } = outgoing.snapshot;
    const controller = new AbortController();
    outgoing.controller = controller;
    let lastReport = 0;
    try {
      const pkg = await this.options.storage.upload(outgoing.files, {
        signal: controller.signal,
        onProgress: (bytes) => {
          if (controller.signal.aborted || outgoing.snapshot.stage !== 'upload') return;
          // Storage reports estimates while a chunk is in flight; progress is whole bytes.
          outgoing.snapshot = atBytes(outgoing.snapshot, Math.min(Math.floor(bytes), totalBytes));
          this.emitTransfer(outgoing.snapshot, true);
          const now = this.now();
          if (now - lastReport >= PROGRESS_INTERVAL_MS) {
            lastReport = now;
            this.send({
              t: 'progress',
              id,
              stage: 'upload',
              bytes: outgoing.snapshot.transferredBytes,
            });
          }
        },
      });
      if (controller.signal.aborted || outgoing.snapshot.status !== 'transferring') {
        void this.options.storage.remove(pkg).catch(() => undefined);
        return;
      }
      outgoing.controller = null;
      outgoing.pkg = pkg;
      this.send({ t: 'ready', id, share: pkg.id, secret: pkg.secret });
      outgoing.snapshot = { ...atBytes(outgoing.snapshot, 0), stage: 'download' };
      this.emitTransfer(outgoing.snapshot);
    } catch (error) {
      if (controller.signal.aborted || outgoing.snapshot.status !== 'transferring') return;
      outgoing.controller = null;
      this.send({ t: 'cancel', id, reason: 'error' });
      this.finishOutgoing('failed', 'local', errorCodeOf(error));
    }
  }

  private async download(incoming: Incoming, pkg: { id: string; secret: string }): Promise<void> {
    const { id, totalBytes } = incoming.snapshot;
    const controller = new AbortController();
    incoming.controller = controller;
    let lastReport = 0;
    try {
      const files = await this.options.storage.download(pkg, {
        signal: controller.signal,
        onProgress: (bytes) => {
          if (controller.signal.aborted) return;
          incoming.snapshot = atBytes(incoming.snapshot, Math.min(Math.floor(bytes), totalBytes));
          this.emitTransfer(incoming.snapshot, true);
          const now = this.now();
          if (now - lastReport >= PROGRESS_INTERVAL_MS) {
            lastReport = now;
            this.send({
              t: 'progress',
              id,
              stage: 'download',
              bytes: incoming.snapshot.transferredBytes,
            });
          }
        },
      });
      if (controller.signal.aborted || incoming.snapshot.status !== 'transferring') return;
      // The package must hold exactly what was offered (names may have been shortened).
      const expected = incoming.snapshot.files;
      if (
        files.length !== expected.length ||
        files.some((file, index) => file.size !== expected[index]!.size)
      )
        throw new RelayStorageError('corrupted');
      incoming.controller = null;
      files.forEach((file, index) =>
        this.options.onEvent({
          type: 'file-received',
          file: {
            transferId: id,
            index,
            name: file.name,
            size: file.size,
            type: file.type,
            lastModified: file.lastModified,
            blob: file.blob,
          },
        }),
      );
      this.send({ t: 'complete', id });
      incoming.snapshot = atBytes(incoming.snapshot, totalBytes);
      this.finishIncoming('completed', null);
    } catch (error) {
      if (controller.signal.aborted || incoming.snapshot.status !== 'transferring') return;
      incoming.controller = null;
      this.send({ t: 'cancel', id, reason: 'error' });
      this.finishIncoming('failed', 'local', errorCodeOf(error));
    }
  }

  /** Aborts an upload in progress and deletes an uploaded package (best effort). */
  private stopOutgoing(outgoing: Outgoing): void {
    outgoing.controller?.abort();
    outgoing.controller = null;
    const pkg = outgoing.pkg;
    outgoing.pkg = null;
    if (pkg) void this.options.storage.remove(pkg).catch(() => undefined);
  }

  private protocolError(): void {
    const outgoing = this.outgoing;
    if (outgoing && isActive(outgoing.snapshot)) {
      this.send({ t: 'cancel', id: outgoing.snapshot.id, reason: 'error' });
      this.stopOutgoing(outgoing);
      this.finishOutgoing('failed', 'local', 'protocol-error');
    }
    const incoming = this.incoming;
    if (incoming && isActive(incoming.snapshot)) {
      this.send({ t: 'cancel', id: incoming.snapshot.id, reason: 'error' });
      incoming.controller?.abort();
      this.finishIncoming('failed', 'local', 'protocol-error');
    }
  }

  private send(message: RelayMessage): void {
    if (this.disposed) return;
    const seq = this.sendSeq++;
    // Encryption is asynchronous; the chain keeps messages in their numbered order.
    this.outbound = this.outbound
      .then(async () => {
        const data = await sealRelayMessage(this.options.key, this.options.side, seq, message);
        if (!this.disposed) this.options.send({ kind: 'relay-message', seq, data });
      })
      .catch(() => undefined);
  }

  private finishOutgoing(
    status: TransferStatus,
    endedBy: 'local' | 'remote' | null,
    error: TransferErrorCode | null = null,
  ): void {
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
  ): void {
    if (!this.incoming) return;
    this.incoming.snapshot = {
      ...this.incoming.snapshot,
      status,
      endedBy,
      error,
      finishedAt: this.now(),
    };
    this.emitTransfer(this.incoming.snapshot);
  }

  private emitTransfer(snapshot: TransferSnapshot, progressOnly = false): void {
    if (this.disposed) return;
    if (progressOnly) {
      const now = this.now();
      if (now - this.lastUiEmit < UI_INTERVAL_MS && snapshot.transferredBytes < snapshot.totalBytes)
        return;
      this.lastUiEmit = now;
    }
    this.options.onEvent({ type: 'transfer', transfer: snapshot });
  }
}

function isActive(snapshot: TransferSnapshot | undefined): boolean {
  return (
    !!snapshot &&
    (snapshot.status === 'offered' ||
      snapshot.status === 'awaiting-acceptance' ||
      snapshot.status === 'transferring')
  );
}

function errorCodeOf(error: unknown): TransferErrorCode {
  if (error instanceof RelayStorageError) {
    switch (error.code) {
      case 'too-large':
        return 'relay-too-large';
      case 'unavailable':
        return 'relay-storage';
      case 'file-read-failed':
        return 'file-read-failed';
      case 'corrupted':
        return 'protocol-error';
      default:
        return 'relay-network';
    }
  }
  return 'relay-network';
}

/** Per-file progress of the current stage, recomputed from a byte count. */
function atBytes(snapshot: TransferSnapshot, transferredBytes: number): TransferSnapshot {
  let before = 0;
  const files = snapshot.files.map((file) => {
    const bytes = Math.min(file.size, Math.max(0, transferredBytes - before));
    before += file.size;
    return {
      ...file,
      transferredBytes: bytes,
      done:
        file.size > 0 ? bytes === file.size : transferredBytes >= before && transferredBytes > 0,
    };
  });
  return { ...snapshot, files, transferredBytes };
}

/**
 * The offer message, with names shortened (keeping extensions) as far as
 * needed to fit one signaling payload; the full names arrive inside the
 * encrypted package. Null if even the shortest form doesn't fit.
 */
function fitOffer(id: string, files: OfferedFile[], totalBytes: number): RelayMessage | null {
  const encoder = new TextEncoder();
  for (const limit of [1024, 160, 48, 16]) {
    const message: RelayMessage = {
      t: 'offer',
      id,
      totalBytes,
      files: files.map((file) => ({
        ...file,
        name: shortenName(file.name, limit),
        type: limit >= 160 ? file.type : '',
      })),
    };
    if (encoder.encode(JSON.stringify(message)).byteLength <= MAX_MESSAGE_JSON_BYTES)
      return message;
  }
  return null;
}

function shortenName(name: string, limit: number): string {
  const chars = Array.from(name);
  if (chars.length <= limit) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 10 ? Array.from(name.slice(dot)) : [];
  return `${chars.slice(0, Math.max(1, limit - extension.length - 1)).join('')}…${extension.join('')}`;
}

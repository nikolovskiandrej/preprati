/**
 * ShareCreator — the "Share Files" flow for the sender.
 *
 *   selecting-files → awaiting-confirmation → encrypting → uploading
 *     → finalizing → ready-to-share → accessed → expired
 *   (plus deleting/deleted, and failed with a retry path)
 *
 * Nothing is uploaded until the user explicitly confirms temporary storage.
 * Each chunk is encrypted in the browser immediately before its upload; the
 * key never leaves this page except inside the share link's URL fragment.
 * The ready state is only reached after the server confirmed every chunk.
 */
import type { PublicConfig } from '../../shared/shareApi';
import { appUrl, isSecureContextAvailable } from '../lib/env';
import { localFileId, totalSize, type SelectedFile } from '../lib/files';
import { HttpError, withRetry } from '../lib/http';
import { RateMeter } from '../lib/rateMeter';
import {
  createShare,
  deleteShare,
  finalizeShare,
  ownerStatus,
  uploadChunk,
  uploadManifest,
} from './api';
import {
  deriveShareKeys,
  encodeShareSecret,
  encryptChunk,
  encryptManifest,
  generateShareSecret,
} from './crypto';
import { buildManifest, cipherBytesFor, plainChunkLength, readPlainChunk } from './manifest';
import { forgetOwnedShare, rememberOwnedShare } from './ownedShares';

export type CreatorPhase =
  | 'selecting-files'
  | 'awaiting-confirmation'
  | 'encrypting'
  | 'uploading'
  | 'finalizing'
  | 'ready-to-share'
  | 'accessed'
  | 'expired'
  | 'deleting'
  | 'deleted'
  | 'failed';

export type { SelectedFile };

export type CreatorErrorCode =
  | 'unsupported'
  | 'share-disabled'
  | 'empty'
  | 'too-many-files'
  | 'file-too-large'
  | 'package-too-large'
  | 'quota-exceeded'
  | 'too-many-shares'
  | 'rate-limited'
  | 'storage-unavailable'
  | 'network'
  | 'file-read-failed'
  | 'upload-expired'
  | 'delete-failed'
  | 'internal';

export interface ShareResult {
  id: string;
  url: string;
  expiresAt: number;
  fileCount: number;
  totalBytes: number;
}

export interface CreatorState {
  phase: CreatorPhase;
  files: SelectedFile[];
  totalBytes: number;
  progress: {
    uploadedBytes: number;
    totalBytes: number;
    startedAt: number;
    bytesPerSecond: number | null;
    etaSeconds: number | null;
  } | null;
  result: ShareResult | null;
  accessCount: number;
  error: CreatorErrorCode | null;
}

export type ShareLimits = Extract<PublicConfig['share'], { enabled: true }>;

const UPLOAD_CONCURRENCY = 3;
const STATUS_POLL_MS = 15_000;

const INITIAL: CreatorState = {
  phase: 'selecting-files',
  files: [],
  totalBytes: 0,
  progress: null,
  result: null,
  accessCount: 0,
  error: null,
};

export class ShareCreator {
  private state: CreatorState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private ownerToken: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private limits: ShareLimits) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CreatorState => this.state;

  setLimits(limits: ShareLimits): void {
    this.limits = limits;
  }

  /* ----------------------------- Selection ------------------------------ */

  addFiles(files: File[]): void {
    if (!this.isEditable()) return;
    const known = new Set(
      this.state.files.map(({ file }) => `${file.name}|${file.size}|${file.lastModified}`),
    );
    const added = files
      .filter((file) => !known.has(`${file.name}|${file.size}|${file.lastModified}`))
      .map((file) => ({ id: localFileId(), file }));
    const next = [...this.state.files, ...added];
    this.update({
      files: next,
      totalBytes: totalSize(next.map(({ file }) => file)),
      error: null,
      phase: 'selecting-files',
    });
  }

  removeFile(id: string): void {
    if (!this.isEditable()) return;
    const next = this.state.files.filter((entry) => entry.id !== id);
    this.update({
      files: next,
      totalBytes: totalSize(next.map(({ file }) => file)),
      error: null,
      phase: 'selecting-files',
    });
  }

  /** Validates the selection against the server limits. */
  validate(): CreatorErrorCode | null {
    const { files, totalBytes } = this.state;
    if (files.length === 0) return 'empty';
    if (files.length > this.limits.maxFiles) return 'too-many-files';
    if (files.some(({ file }) => file.size > this.limits.maxFileBytes)) return 'file-too-large';
    if (totalBytes > this.limits.maxPackageBytes) return 'package-too-large';
    return null;
  }

  requestConfirmation(): void {
    if (this.state.phase !== 'selecting-files' && this.state.phase !== 'failed') return;
    const problem = this.validate();
    if (problem) {
      this.update({ error: problem, phase: 'selecting-files' });
      return;
    }
    this.update({ phase: 'awaiting-confirmation', error: null });
  }

  cancelConfirmation(): void {
    if (this.state.phase === 'awaiting-confirmation') this.update({ phase: 'selecting-files' });
  }

  /* ------------------------------ Upload -------------------------------- */

  /** The user confirmed temporary encrypted storage: encrypt and upload. */
  async confirm(): Promise<void> {
    if (this.state.phase !== 'awaiting-confirmation' && this.state.phase !== 'failed') return;
    if (!isSecureContextAvailable()) {
      this.update({ phase: 'failed', error: 'unsupported' });
      return;
    }
    const problem = this.validate();
    if (problem) {
      this.update({ phase: 'selecting-files', error: problem });
      return;
    }

    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const files = this.state.files.map(({ file }) => file);
    const chunkBytes = this.limits.chunkBytes;
    let shareId: string | null = null;
    let token: string | null = null;

    try {
      this.update({
        phase: 'encrypting',
        error: null,
        progress: null,
        result: null,
        accessCount: 0,
      });
      const secret = generateShareSecret();
      const keys = await deriveShareKeys(secret);
      const manifest = buildManifest(files, chunkBytes);
      const sealedManifest = await encryptManifest(keys.manifest, manifest);
      const cipherBytes = cipherBytesFor(manifest.totalBytes, chunkBytes);

      const created = await withRetry(
        () =>
          createShare(
            {
              chunkBytes,
              chunkCount: manifest.chunkCount,
              cipherBytes,
              manifestBytes: sealedManifest.byteLength,
            },
            signal,
          ),
        { signal, attempts: 2 },
      );
      shareId = created.id;
      token = created.ownerToken;
      this.ownerToken = token;
      const id = created.id;
      const ownerToken = created.ownerToken;

      await withRetry(() => uploadManifest(id, ownerToken, sealedManifest, signal), { signal });

      const startedAt = Date.now();
      const meter = new RateMeter();
      this.update({
        phase: 'uploading',
        progress: {
          uploadedBytes: 0,
          totalBytes: manifest.totalBytes,
          startedAt,
          bytesPerSecond: null,
          etaSeconds: null,
        },
      });

      let next = 0;
      let completedBytes = 0;
      const inFlight = new Map<number, number>();
      let lastEmit = 0;
      const report = (force = false) => {
        const now = Date.now();
        if (!force && now - lastEmit < 100) return;
        lastEmit = now;
        let partial = 0;
        for (const value of inFlight.values()) partial += value;
        const uploadedBytes = Math.min(manifest.totalBytes, completedBytes + partial);
        const rate = meter.push(uploadedBytes, manifest.totalBytes);
        this.update({
          progress: { uploadedBytes, totalBytes: manifest.totalBytes, startedAt, ...rate },
        });
      };

      const worker = async () => {
        for (;;) {
          const index = next++;
          if (index >= manifest.chunkCount || signal.aborted) return;
          let plain: Uint8Array<ArrayBuffer>;
          try {
            plain = await readPlainChunk(files, manifest, index);
          } catch {
            throw new FileReadFailure();
          }
          // Encrypt before anything leaves the browser; retries resend these exact bytes.
          const sealed = await encryptChunk(keys.content, plain, index, manifest.chunkCount);
          const plainLength = plainChunkLength(manifest, index);
          await withRetry(
            () =>
              uploadChunk(id, ownerToken, index, sealed, {
                signal,
                onProgress: (sent) => {
                  inFlight.set(
                    index,
                    Math.min(plainLength, (sent / sealed.byteLength) * plainLength),
                  );
                  report();
                },
              }),
            { signal, attempts: 5 },
          );
          inFlight.delete(index);
          completedBytes += plainLength;
          report(true);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(UPLOAD_CONCURRENCY, Math.max(1, manifest.chunkCount)) },
          worker,
        ),
      );
      if (signal.aborted) throw new HttpError('aborted', 0, 'Upload cancelled');

      this.update({ phase: 'finalizing' });
      const finalized = await withRetry(() => finalizeShare(id, ownerToken, signal), { signal });

      const result: ShareResult = {
        id,
        url: appUrl(`/s/${id}#${encodeShareSecret(secret)}`),
        expiresAt: finalized.expiresAt,
        fileCount: files.length,
        totalBytes: manifest.totalBytes,
      };
      rememberOwnedShare({
        id,
        ownerToken,
        createdAt: Date.now(),
        expiresAt: finalized.expiresAt,
        fileCount: files.length,
        totalBytes: manifest.totalBytes,
      });
      this.controller = null;
      this.update({
        phase: 'ready-to-share',
        result,
        progress: {
          uploadedBytes: manifest.totalBytes,
          totalBytes: manifest.totalBytes,
          startedAt,
          bytesPerSecond: null,
          etaSeconds: null,
        },
      });
      this.startWatching(result);
    } catch (error) {
      controller.abort();
      this.controller = null;
      // Remove whatever was uploaded so far; the server also expires abandoned uploads.
      if (shareId && token) void deleteShare(shareId, token).catch(() => undefined);
      this.ownerToken = null;
      if (this.disposed) return;
      if (error instanceof HttpError && error.code === 'aborted') {
        this.update({ phase: 'selecting-files', progress: null, error: null });
        return;
      }
      this.update({ phase: 'failed', progress: null, error: toCreatorError(error) });
    }
  }

  /** Stops an upload in progress and discards the partial package. */
  cancelUpload(): void {
    this.controller?.abort();
  }

  /* ---------------------------- After upload ---------------------------- */

  async deleteShare(): Promise<boolean> {
    const result = this.state.result;
    const token = this.ownerToken;
    if (!result || !token) return false;
    const previous = this.state.phase;
    this.update({ phase: 'deleting', error: null });
    try {
      await withRetry(() => deleteShare(result.id, token), { attempts: 3 });
      forgetOwnedShare(result.id);
      this.stopWatching();
      this.update({ phase: 'deleted' });
      return true;
    } catch {
      this.update({ phase: previous, error: 'delete-failed' });
      return false;
    }
  }

  /** Starts over with an empty selection (the previous share stays online until it expires). */
  reset(): void {
    this.controller?.abort();
    this.stopWatching();
    this.ownerToken = null;
    this.update({ ...INITIAL });
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    this.stopWatching();
    this.listeners.clear();
  }

  private startWatching(result: ShareResult): void {
    this.stopWatching();
    const token = this.ownerToken;
    const poll = async () => {
      if (!token) return;
      try {
        const status = await ownerStatus(result.id, token);
        if (this.state.result?.id !== result.id) return;
        if (status.status === 'expired') this.update({ phase: 'expired' });
        else if (status.status === 'deleted') this.update({ phase: 'deleted' });
        else if (status.accessCount > 0 && this.state.phase === 'ready-to-share') {
          this.update({ phase: 'accessed', accessCount: status.accessCount });
        } else if (status.accessCount !== this.state.accessCount) {
          this.update({ accessCount: status.accessCount });
        }
      } catch {
        // Polling is best effort; the share itself is unaffected.
      }
    };
    this.pollTimer = setInterval(() => void poll(), STATUS_POLL_MS);
    this.expiryTimer = setTimeout(
      () => {
        if (this.state.result?.id === result.id) {
          this.stopWatching();
          this.update({ phase: 'expired' });
        }
      },
      Math.max(0, Math.min(result.expiresAt - Date.now(), 2 ** 31 - 1)),
    );
  }

  private stopWatching(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.pollTimer = null;
    this.expiryTimer = null;
  }

  private isEditable(): boolean {
    return (
      this.state.phase === 'selecting-files' ||
      this.state.phase === 'awaiting-confirmation' ||
      this.state.phase === 'failed'
    );
  }

  private update(patch: Partial<CreatorState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

class FileReadFailure extends Error {}

function toCreatorError(error: unknown): CreatorErrorCode {
  if (error instanceof FileReadFailure) return 'file-read-failed';
  if (error instanceof HttpError) {
    switch (error.code) {
      case 'too-large':
        return 'package-too-large';
      case 'quota-exceeded':
      case 'too-many-shares':
      case 'rate-limited':
      case 'storage-unavailable':
      case 'share-disabled':
      case 'upload-expired':
        return error.code;
      case 'network':
      case 'timeout':
        return 'network';
      default:
        return 'internal';
    }
  }
  if (error instanceof DOMException && error.name === 'NotReadableError') return 'file-read-failed';
  return 'internal';
}

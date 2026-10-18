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
import { deleteShare, ownerStatus } from './api';
import { encodeShareSecret } from './crypto';
import { forgetOwnedShare, rememberOwnedShare } from './ownedShares';
import { FileReadFailure, uploadPackage } from './upload';

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

  constructor(
    private limits: ShareLimits,
    /** The server's public origin for links (`linkOrigin`), if it names one. */
    private readonly linkOrigin: string | null = null,
  ) {}

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
    const files = this.state.files.map(({ file }) => file);

    try {
      this.update({
        phase: 'encrypting',
        error: null,
        progress: null,
        result: null,
        accessCount: 0,
      });
      let startedAt = Date.now();
      const meter = new RateMeter();
      const uploaded = await uploadPackage(files, this.limits.chunkBytes, {
        signal: controller.signal,
        onUploading: (totalBytes) => {
          startedAt = Date.now();
          this.update({
            phase: 'uploading',
            progress: {
              uploadedBytes: 0,
              totalBytes,
              startedAt,
              bytesPerSecond: null,
              etaSeconds: null,
            },
          });
        },
        onProgress: (uploadedBytes, totalBytes) => {
          const rate = meter.push(uploadedBytes, totalBytes);
          this.update({ progress: { uploadedBytes, totalBytes, startedAt, ...rate } });
        },
        onFinalizing: () => this.update({ phase: 'finalizing' }),
      });
      const { id, ownerToken } = uploaded;
      this.ownerToken = ownerToken;

      const result: ShareResult = {
        id,
        url: appUrl(`/s/${id}#${encodeShareSecret(uploaded.secret)}`, this.linkOrigin),
        expiresAt: uploaded.expiresAt,
        fileCount: files.length,
        totalBytes: uploaded.totalBytes,
      };
      rememberOwnedShare({
        id,
        ownerToken,
        createdAt: Date.now(),
        expiresAt: uploaded.expiresAt,
        fileCount: files.length,
        totalBytes: uploaded.totalBytes,
      });
      this.controller = null;
      this.update({
        phase: 'ready-to-share',
        result,
        progress: {
          uploadedBytes: uploaded.totalBytes,
          totalBytes: uploaded.totalBytes,
          startedAt,
          bytesPerSecond: null,
          etaSeconds: null,
        },
      });
      this.startWatching(result);
    } catch (error) {
      // uploadPackage already removed whatever was uploaded.
      this.controller = null;
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

export function toCreatorError(error: unknown): CreatorErrorCode {
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

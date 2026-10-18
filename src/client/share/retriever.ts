/**
 * ShareRetriever — the recipient side of a shared package.
 *
 *   opening-share → fetching-package → decrypting → ready-to-download
 *   (per file: idle → downloading → saved | failed)
 *
 * The key is read from the URL fragment and never sent anywhere. A file is
 * handed to the browser's download manager only after every chunk it spans
 * decrypted and authenticated successfully; corrupted or tampered data is
 * reported and discarded, never saved.
 */
import { downloadZip } from 'client-zip';
import { RANDOM_ID_PATTERN } from '../../shared/constants';
import { isSecureContextAvailable } from '../lib/env';
import { fileKind, sanitizeFileName, uniqueNames, type FileKind } from '../lib/files';
import { HttpError, withRetry } from '../lib/http';
import { hasUserActivation, saveFile, type SaveOutcome } from '../lib/download';
import { getChunk, getManifest, getShareInfo } from './api';
import {
  decodeShareSecret,
  decryptChunk,
  decryptManifest,
  deriveShareKeys,
  DecryptionError,
  type ShareKeys,
} from './crypto';
import {
  chunkRangeForFile,
  manifestMatchesInfo,
  plainChunkLength,
  type ShareManifest,
} from './manifest';

export type RetrieverPhase =
  'opening-share' | 'fetching-package' | 'decrypting' | 'ready-to-download' | 'failed';

export type RetrieverErrorCode =
  | 'invalid-link'
  | 'unsupported'
  | 'not-found'
  | 'expired'
  | 'deleted'
  | 'invalid-key'
  | 'corrupted'
  | 'storage-unavailable'
  | 'network'
  | 'internal';

export interface RecipientFile {
  index: number;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  kind: FileKind;
  /**
   * `ready`: decrypted and verified, waiting for a tap to save (browsers only
   * save files right after a tap). `requested`: the browser was asked to
   * download it — it doesn't confirm more. `shared`: saved via the share sheet.
   */
  status: 'idle' | 'downloading' | SaveStatus | 'failed';
  /** 0..1 while downloading. */
  progress: number;
  error: RetrieverErrorCode | null;
}

/** A decrypted, verified file (see `fetchFiles`). */
export interface RetrievedFile {
  index: number;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  blob: Blob;
}

type SaveStatus = 'ready' | Exclude<SaveOutcome, 'cancelled'>;

export interface RetrieverState {
  phase: RetrieverPhase;
  expiresAt: number | null;
  totalBytes: number;
  files: RecipientFile[];
  zip: {
    status: 'idle' | 'preparing' | SaveStatus | 'failed';
    progress: number;
    error: RetrieverErrorCode | null;
  };
  error: RetrieverErrorCode | null;
}

const CHUNK_CONCURRENCY = 3;
const FOLD_BYTES = 32 * 1024 * 1024;
const CACHE_CHUNKS = 2;

const INITIAL: RetrieverState = {
  phase: 'opening-share',
  expiresAt: null,
  totalBytes: 0,
  files: [],
  zip: { status: 'idle', progress: 0, error: null },
  error: null,
};

export class ShareRetriever {
  private state: RetrieverState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private keys: ShareKeys | null = null;
  private manifest: ShareManifest | null = null;
  private readonly cache = new Map<number, Uint8Array<ArrayBuffer>>();
  private readonly controller = new AbortController();
  private disposed = false;
  /** Decrypted files (and the .zip of all) kept for "Save" and "Save again". */
  private readonly prepared = new Map<number | 'zip', Blob>();

  constructor(
    private readonly shareId: string,
    private readonly fragment: string,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RetrieverState => this.state;

  /** Validates the link, fetches the package description and decrypts the file list. */
  async open(): Promise<void> {
    this.update({ ...INITIAL, phase: 'opening-share' });
    const secret = decodeShareSecret(this.fragment);
    if (!RANDOM_ID_PATTERN.test(this.shareId) || !secret) {
      this.update({ phase: 'failed', error: 'invalid-link' });
      return;
    }
    if (!isSecureContextAvailable()) {
      this.update({ phase: 'failed', error: 'unsupported' });
      return;
    }
    const signal = this.controller.signal;
    try {
      this.update({ phase: 'fetching-package' });
      const info = await withRetry(() => getShareInfo(this.shareId, signal), {
        signal,
        attempts: 3,
      });
      this.update({ expiresAt: info.expiresAt });
      const sealedManifest = await withRetry(() => getManifest(this.shareId, signal), {
        signal,
        attempts: 3,
      });

      this.update({ phase: 'decrypting' });
      this.keys = await deriveShareKeys(secret);
      let manifest: ShareManifest;
      try {
        manifest = await decryptManifest(this.keys.manifest, sealedManifest);
      } catch (error) {
        throw error instanceof DecryptionError ? new KeyMismatch() : error;
      }
      if (!manifestMatchesInfo(manifest, info)) throw new CorruptPackage();
      this.manifest = manifest;
      const names = uniqueNames(
        manifest.files.map((file, i) => sanitizeFileName(file.name, `file-${i + 1}`)),
      );
      this.update({
        phase: 'ready-to-download',
        totalBytes: manifest.totalBytes,
        files: manifest.files.map((file, index) => ({
          index,
          name: names[index]!,
          type: file.type,
          size: file.size,
          lastModified: file.lastModified,
          kind: fileKind(file.name, file.type),
          status: 'idle',
          progress: 0,
          error: null,
        })),
      });
    } catch (error) {
      if (this.disposed) return;
      this.update({ phase: 'failed', error: retrieverErrorOf(error) });
    }
  }

  /** Decrypts one file completely, then hands it to the browser's download manager. */
  /**
   * Downloads, decrypts and verifies one file, then saves it — at once while
   * the tap that started it still counts, otherwise on the next tap (the
   * file is then `ready`). Call it from a click. `preferShare`: save through
   * the share sheet (an app's built-in browser can't download).
   */
  async downloadFile(index: number, { preferShare = false } = {}): Promise<void> {
    const file = this.state.files[index];
    if (!file || file.status === 'downloading' || this.state.phase !== 'ready-to-download') return;
    const prepared = this.prepared.get(index);
    if (prepared) {
      await this.saveFileAt(index, prepared, preferShare);
      return;
    }
    this.patchFile(index, { status: 'downloading', progress: 0, error: null });
    try {
      const blob = await this.decryptFile(index, (progress) => this.patchFile(index, { progress }));
      if (this.disposed) return;
      this.prepared.set(index, blob);
      if (hasUserActivation()) await this.saveFileAt(index, blob, preferShare);
      else this.patchFile(index, { status: 'ready', progress: 1 });
    } catch (error) {
      if (this.disposed) return;
      this.patchFile(index, { status: 'failed', progress: 0, error: retrieverErrorOf(error) });
    }
  }

  private async saveFileAt(index: number, blob: Blob, preferShare: boolean): Promise<void> {
    const file = this.state.files[index]!;
    const outcome = await saveFile(blob, file.name, { type: file.type, preferShare });
    this.patchFile(index, { status: outcome === 'cancelled' ? 'ready' : outcome, progress: 1 });
  }

  /** Builds a .zip of every file (each one verified) and saves it, like `downloadFile`. */
  async downloadAll({ preferShare = false } = {}): Promise<void> {
    if (this.state.phase !== 'ready-to-download' || this.state.zip.status === 'preparing') return;
    if (this.state.files.length === 1) {
      await this.downloadFile(0, { preferShare });
      return;
    }
    const prepared = this.prepared.get('zip');
    if (prepared) {
      await this.saveZip(prepared, preferShare);
      return;
    }
    const total = Math.max(1, this.state.totalBytes);
    this.update({ zip: { status: 'preparing', progress: 0, error: null } });
    try {
      const zip = await downloadZip(
        this.zipEntries((done) =>
          this.update({
            zip: { status: 'preparing', progress: Math.min(1, done / total), error: null },
          }),
        ),
      ).blob();
      if (this.disposed) return;
      this.prepared.set('zip', zip);
      if (hasUserActivation()) await this.saveZip(zip, preferShare);
      else this.update({ zip: { status: 'ready', progress: 1, error: null } });
    } catch (error) {
      if (this.disposed) return;
      this.update({ zip: { status: 'failed', progress: 0, error: retrieverErrorOf(error) } });
    }
  }

  private async saveZip(zip: Blob, preferShare: boolean): Promise<void> {
    const outcome = await saveFile(zip, 'preprati-files.zip', {
      type: 'application/zip',
      preferShare,
    });
    this.update({
      zip: { status: outcome === 'cancelled' ? 'ready' : outcome, progress: 1, error: null },
    });
  }

  /**
   * Decrypts and verifies every file, in order, without saving anything — for
   * callers with their own received-files list (Quick Transfer's relay mode).
   * `onProgress` gets the plaintext bytes done so far. Throws on any failure;
   * `retrieverErrorOf` turns the error into a RetrieverErrorCode.
   */
  async fetchFiles(
    onProgress: (doneBytes: number) => void = () => undefined,
  ): Promise<RetrievedFile[]> {
    if (this.state.phase !== 'ready-to-download') throw new Error('Package not loaded');
    const files: RetrievedFile[] = [];
    let done = 0;
    for (const file of this.state.files) {
      const blob = await this.decryptFile(file.index, (fraction) =>
        onProgress(done + fraction * file.size),
      );
      done += file.size;
      onProgress(done);
      files.push({
        index: file.index,
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        blob,
      });
    }
    return files;
  }

  /** Decrypts files one after another for the zip stream, reporting cumulative bytes. */
  private async *zipEntries(onProgress: (doneBytes: number) => void) {
    let done = 0;
    for (const file of this.state.files) {
      const blob = await this.decryptFile(file.index, (fraction) =>
        onProgress(done + fraction * file.size),
      );
      done += file.size;
      onProgress(done);
      yield {
        name: file.name,
        input: blob,
        lastModified: new Date(file.lastModified || Date.now()),
      };
    }
  }

  dispose(): void {
    this.disposed = true;
    this.controller.abort();
    this.cache.clear();
    this.prepared.clear();
    this.listeners.clear();
  }

  private async decryptFile(index: number, onProgress: (fraction: number) => void): Promise<Blob> {
    const manifest = this.manifest;
    const keys = this.keys;
    const entry = manifest?.files[index];
    if (!manifest || !keys || !entry) throw new Error('Package not loaded');
    const range = chunkRangeForFile(entry, manifest.chunkBytes);
    if (!range) return new Blob([], { type: 'application/octet-stream' });

    const blobs: Blob[] = [];
    let parts: Uint8Array<ArrayBuffer>[] = [];
    let partBytes = 0;
    let written = 0;
    const indices: number[] = [];
    for (let k = range.first; k <= range.last; k++) indices.push(k);

    // Fetch ahead with a small window while assembling strictly in order.
    const inFlightBytes = new Map<number, number>();
    const reportProgress = () => {
      let partial = 0;
      for (const value of inFlightBytes.values()) partial += value;
      onProgress(Math.min(1, (written + partial * 0.95) / entry.size));
    };
    const pending = new Map<number, Promise<Uint8Array<ArrayBuffer>>>();
    const launch = (k: number) => {
      const promise = this.loadChunk(k, (received) => {
        inFlightBytes.set(k, Math.min(received, plainChunkLength(manifest, k)));
        reportProgress();
      });
      promise.catch(() => undefined);
      pending.set(k, promise);
    };
    let cursor = 0;
    while (cursor < Math.min(CHUNK_CONCURRENCY, indices.length)) launch(indices[cursor++]!);

    for (const k of indices) {
      const plain = await pending.get(k)!;
      pending.delete(k);
      inFlightBytes.delete(k);
      if (cursor < indices.length) launch(indices[cursor++]!);

      const chunkStart = k * manifest.chunkBytes;
      const from = Math.max(entry.offset, chunkStart) - chunkStart;
      const to = Math.min(entry.offset + entry.size, chunkStart + plain.byteLength) - chunkStart;
      const slice = plain.subarray(from, to);
      parts.push(slice);
      partBytes += slice.byteLength;
      written += slice.byteLength;
      if (partBytes >= FOLD_BYTES) {
        blobs.push(new Blob(parts));
        parts = [];
        partBytes = 0;
      }
      reportProgress();
    }
    if (parts.length) blobs.push(new Blob(parts));
    if (written !== entry.size) throw new CorruptPackage();
    return new Blob(blobs, { type: 'application/octet-stream' });
  }

  private async loadChunk(
    k: number,
    onProgress: (received: number) => void,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const cached = this.cache.get(k);
    if (cached) return cached;
    const manifest = this.manifest!;
    const sealed = await withRetry(
      () => getChunk(this.shareId, k, { signal: this.controller.signal, onProgress }),
      {
        signal: this.controller.signal,
        attempts: 4,
      },
    );
    const plain = await decryptChunk(this.keys!.content, sealed, k, manifest.chunkCount);
    if (plain.byteLength !== plainChunkLength(manifest, k)) throw new CorruptPackage();
    this.cache.set(k, plain);
    while (this.cache.size > CACHE_CHUNKS) this.cache.delete(this.cache.keys().next().value!);
    return plain;
  }

  private patchFile(index: number, patch: Partial<RecipientFile>): void {
    this.update({
      files: this.state.files.map((file) => (file.index === index ? { ...file, ...patch } : file)),
    });
  }

  private update(patch: Partial<RetrieverState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

class KeyMismatch extends Error {}
class CorruptPackage extends Error {}

export function retrieverErrorOf(error: unknown): RetrieverErrorCode {
  if (error instanceof KeyMismatch) return 'invalid-key';
  if (error instanceof CorruptPackage || error instanceof DecryptionError) return 'corrupted';
  if (error instanceof HttpError) {
    switch (error.code) {
      case 'not-found':
      case 'expired':
      case 'deleted':
      case 'storage-unavailable':
        return error.code;
      case 'network':
      case 'timeout':
      case 'rate-limited':
        return 'network';
      default:
        return 'internal';
    }
  }
  return 'internal';
}

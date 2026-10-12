/**
 * Encrypts files into a share package and uploads it — for Share Files and
 * for Quick Transfer's relay mode. Each chunk is encrypted in the browser
 * immediately before its upload; the package key only leaves this module in
 * the returned result. The upload counts as done only after the server
 * confirmed every chunk and finalized the package.
 */
import { HttpError, withRetry } from '../lib/http';
import { createShare, deleteShare, finalizeShare, uploadChunk, uploadManifest } from './api';
import { deriveShareKeys, encryptChunk, encryptManifest, generateShareSecret } from './crypto';
import { buildManifest, cipherBytesFor, plainChunkLength, readPlainChunk } from './manifest';

export interface UploadedPackage {
  id: string;
  /** Authorizes status checks and deletion. */
  ownerToken: string;
  /** The package key (what a share link carries in its fragment). */
  secret: Uint8Array<ArrayBuffer>;
  expiresAt: number;
  totalBytes: number;
}

export interface UploadOptions {
  signal: AbortSignal;
  /** The package exists on the server; chunks start uploading. */
  onUploading?: (totalBytes: number) => void;
  /** Plaintext bytes uploaded so far (about ten times per second, and after every chunk). */
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  /** Every chunk is stored; the package is being finalized. */
  onFinalizing?: () => void;
}

/** A selected file could not be read (moved, deleted, or access was revoked). */
export class FileReadFailure extends Error {}

const UPLOAD_CONCURRENCY = 3;

/**
 * Uploads `files` as one encrypted package. On failure or abort, whatever was
 * uploaded so far is deleted (the server also expires abandoned uploads) and
 * the error is rethrown: an HttpError (code `aborted` after `signal` fired)
 * or a FileReadFailure.
 */
export async function uploadPackage(
  files: File[],
  chunkBytes: number,
  options: UploadOptions,
): Promise<UploadedPackage> {
  // A failing chunk stops the others too (they would only upload into a deleted package).
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (options.signal.aborted) stop();
  options.signal.addEventListener('abort', stop, { once: true });
  const { signal } = controller;
  let created: { id: string; ownerToken: string } | null = null;
  try {
    const secret = generateShareSecret();
    const keys = await deriveShareKeys(secret);
    const manifest = buildManifest(files, chunkBytes);
    const sealedManifest = await encryptManifest(keys.manifest, manifest);
    const cipherBytes = cipherBytesFor(manifest.totalBytes, chunkBytes);

    const share = await withRetry(
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
    created = share;
    const { id, ownerToken } = share;

    await withRetry(() => uploadManifest(id, ownerToken, sealedManifest, signal), { signal });
    options.onUploading?.(manifest.totalBytes);

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
      options.onProgress?.(
        Math.min(manifest.totalBytes, completedBytes + partial),
        manifest.totalBytes,
      );
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

    options.onFinalizing?.();
    const finalized = await withRetry(() => finalizeShare(id, ownerToken, signal), { signal });
    return {
      id,
      ownerToken,
      secret,
      expiresAt: finalized.expiresAt,
      totalBytes: manifest.totalBytes,
    };
  } catch (error) {
    controller.abort();
    if (created) {
      const { id, ownerToken } = created;
      void deleteShare(id, ownerToken).catch(() => undefined);
    }
    if (options.signal.aborted) throw new HttpError('aborted', 0, 'Upload cancelled');
    throw error;
  } finally {
    options.signal.removeEventListener('abort', stop);
  }
}

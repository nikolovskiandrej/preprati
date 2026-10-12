/**
 * Share package layout.
 *
 * All selected files are treated as one continuous byte stream (file 1, then
 * file 2, …) that is cut into fixed-size plaintext chunks. The server
 * therefore only learns the total size — not how many files there are or how
 * big each one is. The encrypted manifest maps files to byte offsets.
 */
import { z } from 'zod';
import { SHARE_CHUNK_OVERHEAD, SHARE_FORMAT_VERSION } from '../../shared/constants';

export const ShareManifestSchema = z
  .object({
    v: z.literal(SHARE_FORMAT_VERSION),
    chunkBytes: z.number().int().positive(),
    chunkCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    files: z
      .array(
        z.object({
          name: z.string().min(1).max(1024),
          type: z.string().max(255),
          size: z.number().int().nonnegative(),
          lastModified: z.number().int().nonnegative(),
          offset: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(10_000),
  })
  .superRefine((manifest, ctx) => {
    let expectedOffset = 0;
    for (const file of manifest.files) {
      if (file.offset !== expectedOffset) {
        ctx.addIssue({ code: 'custom', message: 'File offsets are not contiguous' });
        return;
      }
      expectedOffset += file.size;
    }
    if (expectedOffset !== manifest.totalBytes) {
      ctx.addIssue({ code: 'custom', message: 'File sizes do not add up' });
    }
    if (manifest.chunkCount !== chunkCountFor(manifest.totalBytes, manifest.chunkBytes)) {
      ctx.addIssue({ code: 'custom', message: 'Chunk count does not match the total size' });
    }
  });
export type ShareManifest = z.infer<typeof ShareManifestSchema>;
export type ManifestFile = ShareManifest['files'][number];

export function chunkCountFor(totalBytes: number, chunkBytes: number): number {
  return Math.ceil(totalBytes / chunkBytes);
}

export function cipherBytesFor(totalBytes: number, chunkBytes: number): number {
  return totalBytes + chunkCountFor(totalBytes, chunkBytes) * SHARE_CHUNK_OVERHEAD;
}

export function buildManifest(files: File[], chunkBytes: number, now = Date.now()): ShareManifest {
  let offset = 0;
  const entries = files.map((file) => {
    const entry = {
      name: (file.name || 'file').slice(0, 1024),
      type: file.type.slice(0, 255),
      size: file.size,
      lastModified: Number.isFinite(file.lastModified)
        ? Math.max(0, Math.floor(file.lastModified))
        : 0,
      offset,
    };
    offset += file.size;
    return entry;
  });
  return {
    v: SHARE_FORMAT_VERSION,
    chunkBytes,
    chunkCount: chunkCountFor(offset, chunkBytes),
    totalBytes: offset,
    createdAt: now,
    files: entries,
  };
}

/** Checks that the manifest agrees with what the server reports about the stored package. */
export function manifestMatchesInfo(
  manifest: ShareManifest,
  info: { chunkBytes: number; chunkCount: number; cipherBytes: number },
): boolean {
  return (
    manifest.chunkBytes === info.chunkBytes &&
    manifest.chunkCount === info.chunkCount &&
    cipherBytesFor(manifest.totalBytes, manifest.chunkBytes) === info.cipherBytes
  );
}

/** Byte length of plaintext chunk `index`. */
export function plainChunkLength(
  manifest: Pick<ShareManifest, 'chunkBytes' | 'totalBytes'>,
  index: number,
): number {
  const start = index * manifest.chunkBytes;
  return Math.max(0, Math.min(manifest.chunkBytes, manifest.totalBytes - start));
}

/** Inclusive chunk range holding a file's bytes, or null for empty files. */
export function chunkRangeForFile(file: Pick<ManifestFile, 'offset' | 'size'>, chunkBytes: number) {
  if (file.size === 0) return null;
  return {
    first: Math.floor(file.offset / chunkBytes),
    last: Math.floor((file.offset + file.size - 1) / chunkBytes),
  };
}

/** Reads plaintext chunk `index` of the concatenated stream of `files`. */
export async function readPlainChunk(
  files: File[],
  manifest: Pick<ShareManifest, 'chunkBytes' | 'totalBytes' | 'files'>,
  index: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const start = index * manifest.chunkBytes;
  const end = Math.min(start + manifest.chunkBytes, manifest.totalBytes);
  const parts: Blob[] = [];
  manifest.files.forEach((entry, i) => {
    const fileStart = entry.offset;
    const fileEnd = entry.offset + entry.size;
    if (fileEnd <= start || fileStart >= end) return;
    const from = Math.max(start, fileStart) - fileStart;
    const to = Math.min(end, fileEnd) - fileStart;
    parts.push(files[i]!.slice(from, to));
  });
  const buffer = await new Blob(parts).arrayBuffer();
  if (buffer.byteLength !== end - start)
    throw new Error('A selected file could not be read completely');
  return new Uint8Array(buffer);
}

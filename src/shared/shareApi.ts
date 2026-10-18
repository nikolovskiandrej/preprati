/**
 * HTTP contract for the runtime configuration and the encrypted share API.
 *
 * The server only ever sees ciphertext: an encrypted manifest (file names,
 * types, sizes, layout) and a sequence of encrypted chunks. The decryption
 * key lives in the URL fragment of the share link and is never sent to the
 * server. See docs/PROTOCOL.md for the full package format.
 */
import { z } from 'zod';
import {
  SHARE_CHUNK_MAX_BYTES,
  SHARE_CHUNK_MIN_BYTES,
  SHARE_CHUNK_OVERHEAD,
  SHARE_MANIFEST_MAX_BYTES,
} from './constants';

/* -------------------------------------------------------------------------- */
/* Runtime configuration (GET /api/config)                                    */
/* -------------------------------------------------------------------------- */

export type ShareUnavailableReason = 'disabled' | 'not-configured' | 'storage-unavailable';

export interface PublicConfig {
  version: string;
  quickTransfer: {
    pairingTtlSeconds: number;
    relayConfigured: boolean;
    /** How the browser should reach the signaling service. */
    signaling: 'websocket' | 'http';
  };
  share:
    | {
        enabled: true;
        ttlSeconds: number;
        maxFileBytes: number;
        maxPackageBytes: number;
        maxFiles: number;
        chunkBytes: number;
      }
    | {
        enabled: false;
        reason: ShareUnavailableReason;
        ttlSeconds: number;
        maxFileBytes: number;
        maxPackageBytes: number;
        maxFiles: number;
        chunkBytes: number;
      };
  attribution: {
    url: string | null;
  };
  /**
   * The origin that links and QR codes point to, when the server names one
   * (PUBLIC_ORIGIN, or the production domain on Vercel); null means the page's
   * own origin. A page can be open on another address of the same app, such as
   * a login-protected deployment URL, and links copied from it must still open
   * for recipients.
   */
  linkOrigin: string | null;
}

/* -------------------------------------------------------------------------- */
/* Share API                                                                  */
/* -------------------------------------------------------------------------- */

export const ShareErrorCodeSchema = z.enum([
  'not-found',
  'expired',
  'deleted',
  'invalid-request',
  'unauthorized',
  'too-large',
  'quota-exceeded',
  'too-many-shares',
  'rate-limited',
  'storage-unavailable',
  'share-disabled',
  'upload-incomplete',
  'upload-expired',
  'conflict',
  'internal',
]);
export type ShareErrorCode = z.infer<typeof ShareErrorCodeSchema>;

export interface ApiErrorBody {
  error: { code: ShareErrorCode; message: string; retryAfterSeconds?: number };
}

/** POST /api/shares — reserve space for an encrypted package. */
export const CreateShareRequestSchema = z
  .object({
    /** Plaintext bytes per chunk; must equal the server's configured chunk size. */
    chunkBytes: z.number().int().min(SHARE_CHUNK_MIN_BYTES).max(SHARE_CHUNK_MAX_BYTES),
    /** Number of encrypted chunks that will be uploaded. */
    chunkCount: z.number().int().min(0).max(1_000_000),
    /** Sum of the sizes of all encrypted chunks (IV + ciphertext + tag). */
    cipherBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    /** Size of the encrypted manifest. */
    manifestBytes: z
      .number()
      .int()
      .min(SHARE_CHUNK_OVERHEAD + 2)
      .max(SHARE_MANIFEST_MAX_BYTES),
  })
  .strict();
export type CreateShareRequest = z.infer<typeof CreateShareRequestSchema>;

export interface CreateShareResponse {
  id: string;
  /** Secret that authorizes uploads, status checks and deletion. Shown only once. */
  ownerToken: string;
  uploadDeadline: number;
}

export interface FinalizeShareResponse {
  id: string;
  expiresAt: number;
}

/** GET /api/shares/:id — public, non-sensitive package information. */
export interface ShareInfo {
  id: string;
  formatVersion: number;
  expiresAt: number;
  chunkBytes: number;
  chunkCount: number;
  cipherBytes: number;
  manifestBytes: number;
}

export type ShareStatus = 'uploading' | 'ready' | 'expired' | 'deleted';

/** GET /api/shares/:id/owner — status for the creator (requires the owner token). */
export interface ShareOwnerStatus {
  id: string;
  status: ShareStatus;
  expiresAt: number | null;
  accessCount: number;
}

/* -------------------------------------------------------------------------- */
/* Package layout helpers (shared so the server can validate exact sizes)     */
/* -------------------------------------------------------------------------- */

/** Encrypted size of chunk `index` given the package layout. Returns null if out of range. */
export function expectedChunkCipherSize(
  index: number,
  layout: { chunkCount: number; chunkBytes: number; cipherBytes: number },
): number | null {
  const { chunkCount, chunkBytes, cipherBytes } = layout;
  if (!Number.isInteger(index) || index < 0 || index >= chunkCount) return null;
  const full = chunkBytes + SHARE_CHUNK_OVERHEAD;
  if (index < chunkCount - 1) return full;
  return cipherBytes - (chunkCount - 1) * full;
}

/**
 * Checks that a declared layout is internally consistent: every chunk but the
 * last is full, and the last one carries between 1 byte and a full chunk of
 * plaintext. A zero-chunk package (only empty files) has zero cipher bytes.
 */
export function isConsistentLayout(layout: {
  chunkCount: number;
  chunkBytes: number;
  cipherBytes: number;
}): boolean {
  const { chunkCount, chunkBytes, cipherBytes } = layout;
  if (chunkCount === 0) return cipherBytes === 0;
  const last = expectedChunkCipherSize(chunkCount - 1, layout);
  return (
    last !== null && last >= SHARE_CHUNK_OVERHEAD + 1 && last <= chunkBytes + SHARE_CHUNK_OVERHEAD
  );
}

/** Plaintext bytes carried by a package with the given layout. */
export function plaintextBytes(layout: { chunkCount: number; cipherBytes: number }): number {
  return layout.cipherBytes - layout.chunkCount * SHARE_CHUNK_OVERHEAD;
}

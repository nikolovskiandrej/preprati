import type { Readable } from 'node:stream';

/**
 * Minimal object-storage abstraction used by the share service.
 *
 * Keys are slash-separated relative paths made of URL-safe characters
 * (e.g. `shares/Xy…/chunks/000001.bin`). Adapters never receive plaintext:
 * the share service only stores client-side encrypted bytes and a small JSON
 * metadata record per package.
 */
export interface StoredObjectInfo {
  key: string;
  size: number;
  modifiedAt: number;
}

export interface BlobStore {
  readonly kind: 'local' | 's3' | 'vercel-blob';
  /** Prepares the backend (creates directories, verifies the bucket). */
  init(): Promise<void>;
  /** Cheap liveness probe used by /api/health and the public config. */
  healthCheck(): Promise<boolean>;
  put(key: string, data: Uint8Array): Promise<void>;
  /** Returns null when the object does not exist. */
  getBuffer(key: string): Promise<Buffer | null>;
  /** Returns null when the object does not exist. */
  getStream(key: string): Promise<{ stream: Readable; size: number } | null>;
  stat(key: string): Promise<StoredObjectInfo | null>;
  delete(key: string): Promise<void>;
  /** Deletes every object whose key starts with `prefix` (which must end in "/"). */
  deletePrefix(prefix: string): Promise<void>;
  /** Lists all objects below `prefix` (recursive). */
  list(prefix: string): AsyncIterable<StoredObjectInfo>;
  /** Lists the immediate child "directories" of `prefix` (names only, without slashes). */
  listChildren(prefix: string): AsyncIterable<string>;
  /** Deletes exact keys without listing (cheaper on metered object stores). Missing keys are ignored. */
  deleteMany?(keys: string[]): Promise<void>;
  /**
   * Reserves `operations` writes from a limited allowance (e.g. a monthly
   * operation quota). Absent or true = allowed.
   */
  reserveWrites?(operations: number): Promise<boolean>;
  /**
   * Optional index of when each share folder next needs attention (upload
   * deadline, expiry, purge), so due work is found without listing storage.
   * `at: null` removes the entry.
   */
  markDue?(name: string, at: number | null): Promise<void>;
  /** Share folder names whose next step is due at `now`, earliest first. */
  listDue?(now: number, limit: number): Promise<string[]>;
  close?(): Promise<void>;
}

export class StorageError extends Error {
  override name = 'StorageError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

const KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9/_.-]*$/;

/** Rejects keys that could escape the storage root or address unexpected objects. */
export function assertSafeKey(key: string, { prefix = false } = {}): void {
  if (
    !KEY_PATTERN.test(key) ||
    key.includes('//') ||
    key.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new StorageError('Invalid storage key');
  }
  if (prefix && !key.endsWith('/')) throw new StorageError('Storage prefixes must end with "/"');
  if (!prefix && key.endsWith('/')) throw new StorageError('Storage keys must not end with "/"');
}

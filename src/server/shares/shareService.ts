/**
 * Encrypted share packages: creation, upload, retrieval, expiry and deletion.
 *
 * The service never sees plaintext or keys. It stores, per package:
 *   shares/<prefix>/meta.json            minimal metadata (sizes, timestamps, owner-token hash)
 *   shares/<prefix>/data/manifest.bin    encrypted manifest (file names, types, layout)
 *   shares/<prefix>/data/chunks/NNNNNN   encrypted chunks
 *
 * `<prefix>` is derived from the public share id with SHA-256, so storage keys
 * do not reveal share ids and are unguessable. After deletion or expiry the
 * data objects are removed immediately and a small tombstone (meta.json) is
 * kept for a while so recipients see "expired"/"deleted" instead of "not found".
 *
 * Expiry is enforced on every read, independent of the cleanup job.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { RANDOM_ID_PATTERN, SECRET_PATTERN, SHARE_FORMAT_VERSION } from '../../shared/constants';
import { randomId, randomSecret, toBase64Url } from '../../shared/encoding';
import {
  CreateShareRequestSchema,
  expectedChunkCipherSize,
  isConsistentLayout,
  plaintextBytes,
  type CreateShareResponse,
  type FinalizeShareResponse,
  type ShareErrorCode,
  type ShareInfo,
  type ShareOwnerStatus,
  type ShareStatus,
} from '../../shared/shareApi';
import type { ServerConfig } from '../config';
import type { BlobStore } from '../storage';
import { KeyedRwLock } from '../util/keyedLock';

export class ShareServiceError extends Error {
  override name = 'ShareServiceError';
  constructor(
    readonly code: ShareErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const ShareMetaSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(RANDOM_ID_PATTERN),
  status: z.enum(['uploading', 'ready', 'expired', 'deleted']),
  createdAt: z.number(),
  uploadDeadline: z.number(),
  finalizedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  chunkBytes: z.number().int().positive(),
  chunkCount: z.number().int().nonnegative(),
  cipherBytes: z.number().int().nonnegative(),
  manifestBytes: z.number().int().positive(),
  ownerTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  accessCount: z.number().int().nonnegative(),
  lastAccessAt: z.number().nullable(),
  purgeAt: z.number().nullable(),
});
export type ShareMeta = z.infer<typeof ShareMetaSchema>;

/** Capacity accounting shared by several server instances (e.g. serverless). */
export interface UsageTracker {
  /** Atomically reserves room for a new package. */
  reserve(id: string, bytes: number): Promise<'ok' | 'quota' | 'active'>;
  /** Releases a package's reservation. Idempotent. */
  release(id: string): Promise<void>;
}

export interface ShareServiceOptions {
  store: BlobStore;
  config: ServerConfig['share'];
  now?: () => number;
  log?: (
    level: 'info' | 'warn' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) => void;
  /** Re-read metadata on every request (several instances share the storage). Default false. */
  consistentReads?: boolean;
  /** Scan storage when starting (long-lived single process). Default true. */
  reconcileOnInit?: boolean;
  /** Shared capacity accounting; defaults to this process's own index. */
  usage?: UsageTracker;
  /** Keeps the platform alive for work finishing after a response (e.g. Vercel's waitUntil). */
  waitUntil?: (task: Promise<unknown>) => void;
}

export interface CleanupReport {
  expired: number;
  abandoned: number;
  purged: number;
  orphans: number;
}

const SHARES_ROOT = 'shares/';
/** Orphaned objects (no metadata) younger than this are left alone: a creation may be in flight. */
const ORPHAN_GRACE_MS = 15 * 60_000;

export function storagePrefixFor(id: string): string {
  const digest = createHash('sha256').update(`preprati.share.v1:${id}`).digest();
  return `${SHARES_ROOT}${toBase64Url(digest).slice(0, 32)}/`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function chunkKey(prefix: string, index: number): string {
  return `${prefix}data/chunks/${String(index).padStart(7, '0')}.bin`;
}

export class ShareService {
  private readonly store: BlobStore;
  private readonly config: ServerConfig['share'];
  private readonly now: () => number;
  private readonly log: NonNullable<ShareServiceOptions['log']>;
  private readonly index = new Map<string, ShareMeta>();
  private readonly locks = new KeyedRwLock();
  private readonly consistentReads: boolean;
  private readonly reconcileOnInit: boolean;
  private readonly usage: UsageTracker | null;
  private readonly waitUntil: ((task: Promise<unknown>) => void) | null;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(options: ShareServiceOptions) {
    this.store = options.store;
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.consistentReads = options.consistentReads ?? false;
    this.reconcileOnInit = options.reconcileOnInit ?? true;
    this.usage = options.usage ?? null;
    this.waitUntil = options.waitUntil ?? null;
  }

  /** Waits for background work (access counting, expiry cleanup) to finish. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private background(task: Promise<unknown>): void {
    const tracked = task.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    this.waitUntil?.(tracked);
  }

  /** Prepares storage and (for long-lived processes) loads existing package metadata. */
  async init(): Promise<void> {
    await this.store.init();
    if (this.reconcileOnInit) await this.reconcile();
  }

  /* ------------------------------------------------------------------------ */
  /* Accounting                                                               */
  /* ------------------------------------------------------------------------ */

  /** Bytes reserved by packages that are uploading or ready. */
  get usedBytes(): number {
    let total = 0;
    for (const meta of this.index.values()) {
      if (this.isLive(meta)) total += meta.cipherBytes + meta.manifestBytes;
    }
    return total;
  }

  get activeCount(): number {
    let count = 0;
    for (const meta of this.index.values()) if (this.isLive(meta)) count++;
    return count;
  }

  private isLive(meta: ShareMeta): boolean {
    return meta.status === 'uploading' || meta.status === 'ready';
  }

  /* ------------------------------------------------------------------------ */
  /* Creation & upload (owner)                                                */
  /* ------------------------------------------------------------------------ */

  async create(body: unknown): Promise<CreateShareResponse> {
    const parsed = CreateShareRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new ShareServiceError('invalid-request', 400, 'Invalid package description');
    const request = parsed.data;

    if (request.chunkBytes !== this.config.chunkBytes) {
      throw new ShareServiceError('invalid-request', 400, 'Unsupported chunk size');
    }
    if (!isConsistentLayout(request)) {
      throw new ShareServiceError('invalid-request', 400, 'Inconsistent package layout');
    }
    if (plaintextBytes(request) > this.config.maxPackageBytes) {
      throw new ShareServiceError('too-large', 413, 'Package exceeds the maximum size');
    }
    const required = request.cipherBytes + request.manifestBytes;
    const id = randomId();
    if (this.usage) {
      const reservation = await this.usage.reserve(id, required);
      if (reservation === 'active') {
        throw new ShareServiceError(
          'too-many-shares',
          503,
          'Too many active shares on this server',
          600,
        );
      }
      if (reservation === 'quota')
        throw new ShareServiceError('quota-exceeded', 507, 'Temporary storage is full', 900);
    } else {
      if (this.activeCount >= this.config.maxActive) {
        throw new ShareServiceError(
          'too-many-shares',
          503,
          'Too many active shares on this server',
          600,
        );
      }
      if (this.usedBytes + required > this.config.quotaBytes) {
        throw new ShareServiceError('quota-exceeded', 507, 'Temporary storage is full', 900);
      }
    }
    // Storage with a monthly operation allowance (e.g. Vercel Blob on Hobby) must not be overrun.
    // chunks + manifest + one verification listing at finalize
    if (this.store.reserveWrites && !(await this.store.reserveWrites(request.chunkCount + 2))) {
      await this.usage?.release(id);
      throw new ShareServiceError(
        'quota-exceeded',
        507,
        'The monthly storage allowance has been used up',
        86_400,
      );
    }

    const now = this.now();
    const ownerToken = randomSecret();
    const meta: ShareMeta = {
      v: 1,
      id,
      status: 'uploading',
      createdAt: now,
      uploadDeadline: now + this.config.uploadTimeoutMs,
      finalizedAt: null,
      expiresAt: null,
      chunkBytes: request.chunkBytes,
      chunkCount: request.chunkCount,
      cipherBytes: request.cipherBytes,
      manifestBytes: request.manifestBytes,
      ownerTokenHash: hashToken(ownerToken),
      accessCount: 0,
      lastAccessAt: null,
      purgeAt: null,
    };

    // Reserve quota synchronously before the first await so concurrent creates can't overshoot.
    this.index.set(id, meta);
    try {
      await this.writeMeta(meta);
    } catch (error) {
      this.index.delete(id);
      await this.usage?.release(id);
      throw this.storageFailure(error);
    }
    return { id, ownerToken, uploadDeadline: meta.uploadDeadline };
  }

  async putManifest(id: string, token: string | undefined, data: Uint8Array): Promise<void> {
    const meta = await this.requireOwner(id, token);
    await this.locks.read(id, async () => {
      this.assertUploading(meta);
      if (data.byteLength !== meta.manifestBytes) {
        throw new ShareServiceError(
          'invalid-request',
          400,
          'Manifest size does not match the declared size',
        );
      }
      await this.storeWrite(`${storagePrefixFor(id)}data/manifest.bin`, data);
    });
  }

  async putChunk(
    id: string,
    token: string | undefined,
    index: number,
    data: Uint8Array,
  ): Promise<void> {
    const meta = await this.requireOwner(id, token);
    await this.locks.read(id, async () => {
      this.assertUploading(meta);
      const expected = expectedChunkCipherSize(index, meta);
      if (expected === null)
        throw new ShareServiceError('invalid-request', 400, 'Chunk index out of range');
      if (data.byteLength !== expected) {
        throw new ShareServiceError(
          'invalid-request',
          400,
          'Chunk size does not match the package layout',
        );
      }
      await this.storeWrite(chunkKey(storagePrefixFor(id), index), data);
    });
  }

  async finalize(id: string, token: string | undefined): Promise<FinalizeShareResponse> {
    await this.requireOwner(id, token);
    return this.locks.write(id, async () => {
      const meta = await this.current(id);
      if (!meta) throw new ShareServiceError('not-found', 404, 'Share not found');
      if (meta.status === 'ready' && meta.expiresAt !== null) {
        return { id, expiresAt: meta.expiresAt }; // idempotent retry
      }
      this.assertUploading(meta);

      const prefix = storagePrefixFor(id);
      const manifest = await this.storeStat(`${prefix}data/manifest.bin`);
      if (!manifest || manifest.size !== meta.manifestBytes) {
        throw new ShareServiceError(
          'upload-incomplete',
          409,
          'The encrypted manifest has not been uploaded',
        );
      }
      const sizes = new Map<string, number>();
      try {
        for await (const object of this.store.list(`${prefix}data/chunks/`))
          sizes.set(object.key, object.size);
      } catch (error) {
        throw this.storageFailure(error);
      }
      let missing = 0;
      for (let i = 0; i < meta.chunkCount; i++) {
        const key = chunkKey(prefix, i);
        let size = sizes.get(key);
        // Listings can lag behind recent writes on some object stores; confirm directly.
        if (size === undefined && missing === 0) size = (await this.storeStat(key))?.size;
        if (size !== expectedChunkCipherSize(i, meta)) missing++;
      }
      if (missing > 0) {
        throw new ShareServiceError(
          'upload-incomplete',
          409,
          `${missing} chunk(s) are missing or incomplete`,
        );
      }

      const now = this.now();
      const ready: ShareMeta = {
        ...meta,
        status: 'ready',
        finalizedAt: now,
        expiresAt: now + this.config.ttlMs,
      };
      await this.persist(ready);
      return { id, expiresAt: ready.expiresAt! };
    });
  }

  async ownerStatus(id: string, token: string | undefined): Promise<ShareOwnerStatus> {
    const meta = await this.requireOwner(id, token);
    return {
      id,
      status: this.effectiveStatus(meta),
      expiresAt: meta.expiresAt,
      accessCount: meta.accessCount,
    };
  }

  /** Deletes a package immediately. Idempotent. */
  async delete(id: string, token: string | undefined): Promise<void> {
    await this.requireOwner(id, token);
    await this.locks.write(id, async () => {
      const meta = await this.current(id);
      if (!meta) return;
      if (meta.status === 'uploading') {
        await this.purge(meta);
        return;
      }
      if (meta.status === 'deleted') return;
      await this.deleteData(meta);
      const now = this.now();
      await this.persist({
        ...meta,
        status: 'deleted',
        purgeAt: Math.max(meta.expiresAt ?? now, now) + this.config.tombstoneTtlMs,
      });
      await this.usage?.release(id);
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Retrieval (public, by bearer link)                                       */
  /* ------------------------------------------------------------------------ */

  async getInfo(id: string): Promise<ShareInfo> {
    const meta = await this.requireReadable(id);
    return {
      id,
      formatVersion: SHARE_FORMAT_VERSION,
      expiresAt: meta.expiresAt!,
      chunkBytes: meta.chunkBytes,
      chunkCount: meta.chunkCount,
      cipherBytes: meta.cipherBytes,
      manifestBytes: meta.manifestBytes,
    };
  }

  async openManifest(id: string): Promise<{ stream: Readable; size: number }> {
    const meta = await this.requireReadable(id);
    const object = await this.storeOpen(`${storagePrefixFor(id)}data/manifest.bin`);
    if (!object) throw new ShareServiceError('not-found', 404, 'Share data is unavailable');
    this.background(this.recordAccess(meta.id));
    return object;
  }

  async openChunk(id: string, index: number): Promise<{ stream: Readable; size: number }> {
    const meta = await this.requireReadable(id);
    if (expectedChunkCipherSize(index, meta) === null) {
      throw new ShareServiceError('not-found', 404, 'Chunk not found');
    }
    const object = await this.storeOpen(chunkKey(storagePrefixFor(id), index));
    if (!object) throw new ShareServiceError('not-found', 404, 'Share data is unavailable');
    return object;
  }

  /* ------------------------------------------------------------------------ */
  /* Expiry & cleanup                                                         */
  /* ------------------------------------------------------------------------ */

  /** Expires due packages, removes abandoned uploads and old tombstones. */
  async cleanup(): Promise<CleanupReport> {
    return this.cleanupIds([...this.index.keys()]);
  }

  /**
   * Like cleanup(), but only for packages the store's due index lists, so it
   * needs no storage listing. Used on serverless platforms, where no timer
   * runs between requests.
   */
  async sweepDue(): Promise<CleanupReport | null> {
    if (!this.store.listDue) return null;
    const ids: string[] = [];
    for (const name of await this.store.listDue(this.now(), 100)) {
      const prefix = `${SHARES_ROOT}${name}/`;
      const meta = await this.readMeta(prefix).catch(() => null);
      if (meta && storagePrefixFor(meta.id) === prefix) {
        this.index.set(meta.id, meta);
        ids.push(meta.id);
      } else {
        await this.store.markDue?.(name, null); // stale entry
      }
    }
    return this.cleanupIds(ids);
  }

  private lastSweep = 0;

  /** Starts sweepDue() in the background at most once per `intervalMs` (per instance). */
  sweepSoon(intervalMs: number): void {
    const now = this.now();
    if (now - this.lastSweep < intervalMs) return;
    this.lastSweep = now;
    this.background(
      this.sweepDue().catch((error: unknown) =>
        this.log('warn', 'share sweep failed', { error: String(error) }),
      ),
    );
  }

  private async cleanupIds(ids: string[]): Promise<CleanupReport> {
    const report: CleanupReport = { expired: 0, abandoned: 0, purged: 0, orphans: 0 };
    const now = this.now();
    for (const id of ids) {
      try {
        await this.locks.write(id, async () => {
          const meta = await this.current(id);
          if (!meta) return;
          if (meta.status === 'uploading' && now > meta.uploadDeadline) {
            await this.purge(meta);
            report.abandoned++;
          } else if (meta.status === 'ready' && meta.expiresAt !== null && now >= meta.expiresAt) {
            await this.expireData(meta);
            report.expired++;
          } else if (
            (meta.status === 'expired' || meta.status === 'deleted') &&
            meta.purgeAt !== null &&
            now >= meta.purgeAt
          ) {
            await this.purge(meta);
            report.purged++;
          }
        });
      } catch (error) {
        this.log('warn', 'share cleanup step failed', { error: String(error) });
      }
    }
    return report;
  }

  /**
   * Rebuilds the in-memory index from storage and deletes orphaned data that
   * has no metadata record (e.g. left behind by a crash during deletion).
   */
  async reconcile(): Promise<number> {
    let orphans = 0;
    const seen = new Set<string>();
    for await (const name of this.store.listChildren(SHARES_ROOT)) {
      const prefix = `${SHARES_ROOT}${name}/`;
      const meta = await this.readMeta(prefix).catch(() => null);
      if (meta && storagePrefixFor(meta.id) === prefix) {
        seen.add(meta.id);
        if (!this.index.has(meta.id)) this.index.set(meta.id, meta);
        continue;
      }
      // No valid metadata: delete once the newest object is older than the grace period.
      let newest = 0;
      for await (const object of this.store.list(prefix))
        newest = Math.max(newest, object.modifiedAt);
      if (this.now() - newest > ORPHAN_GRACE_MS) {
        await this.store.deletePrefix(prefix);
        orphans++;
      }
    }
    // Drop index entries whose metadata vanished from storage.
    for (const [id, meta] of this.index) {
      if (!seen.has(id) && this.now() - meta.createdAt > ORPHAN_GRACE_MS) this.index.delete(id);
    }
    return orphans;
  }

  /* ------------------------------------------------------------------------ */
  /* Internals                                                                */
  /* ------------------------------------------------------------------------ */

  private effectiveStatus(meta: ShareMeta): ShareStatus {
    if (meta.status === 'ready' && meta.expiresAt !== null && this.now() >= meta.expiresAt)
      return 'expired';
    if (meta.status === 'uploading' && this.now() > meta.uploadDeadline) return 'expired';
    return meta.status;
  }

  private async lookup(id: string): Promise<ShareMeta | null> {
    if (!RANDOM_ID_PATTERN.test(id)) return null;
    const cached = this.index.get(id);
    if (cached && !this.consistentReads) return cached;
    if (this.consistentReads) {
      const fresh = await this.readMeta(storagePrefixFor(id)).catch(() => null);
      if (fresh && fresh.id === id) this.index.set(id, fresh);
      else this.index.delete(id);
      return fresh && fresh.id === id ? fresh : null;
    }
    // Not in the index (e.g. written by another instance): consult storage once.
    const meta = await this.readMeta(storagePrefixFor(id)).catch(() => null);
    if (meta && meta.id === id) {
      this.index.set(id, meta);
      return meta;
    }
    return null;
  }

  private async requireOwner(id: string, token: string | undefined): Promise<ShareMeta> {
    const meta = await this.lookup(id);
    if (!meta) throw new ShareServiceError('not-found', 404, 'Share not found');
    if (!token || !SECRET_PATTERN.test(token)) {
      throw new ShareServiceError('unauthorized', 401, 'Missing or invalid owner token');
    }
    const expected = Buffer.from(meta.ownerTokenHash, 'hex');
    const actual = Buffer.from(hashToken(token), 'hex');
    if (!timingSafeEqual(expected, actual)) {
      throw new ShareServiceError('unauthorized', 401, 'Missing or invalid owner token');
    }
    return meta;
  }

  private async requireReadable(id: string): Promise<ShareMeta> {
    const meta = await this.lookup(id);
    if (!meta || meta.status === 'uploading')
      throw new ShareServiceError('not-found', 404, 'Share not found');
    if (meta.status === 'deleted')
      throw new ShareServiceError('deleted', 410, 'This share was deleted');
    if (this.effectiveStatus(meta) === 'expired') {
      if (meta.status === 'ready') this.background(this.expireNow(id));
      throw new ShareServiceError('expired', 410, 'This share has expired');
    }
    return meta;
  }

  /** Removes an expired package's data as soon as someone notices it expired. */
  private async expireNow(id: string): Promise<void> {
    try {
      await this.locks.write(id, async () => {
        const meta = await this.current(id);
        if (meta?.status === 'ready' && meta.expiresAt !== null && this.now() >= meta.expiresAt)
          await this.expireData(meta);
      });
    } catch (error) {
      this.log('warn', 'failed to expire share data', { error: String(error) });
    }
  }

  private async expireData(meta: ShareMeta): Promise<void> {
    await this.deleteData(meta);
    await this.persist({
      ...meta,
      status: 'expired',
      purgeAt: (meta.expiresAt ?? this.now()) + this.config.tombstoneTtlMs,
    });
    await this.usage?.release(meta.id);
  }

  /** The live record: re-read when several instances share the storage. */
  private async current(id: string): Promise<ShareMeta | null> {
    return this.consistentReads ? this.lookup(id) : (this.index.get(id) ?? null);
  }

  private assertUploading(meta: ShareMeta): void {
    // Always re-check the live record: the package may have been purged or
    // finalized while this request waited for the lock.
    const current = this.index.get(meta.id);
    if (!current) throw new ShareServiceError('not-found', 404, 'Share not found');
    if (current.status !== 'uploading') {
      throw new ShareServiceError('conflict', 409, 'This share is no longer accepting uploads');
    }
    if (this.now() > current.uploadDeadline) {
      throw new ShareServiceError(
        'upload-expired',
        410,
        'The upload window for this share has closed',
      );
    }
  }

  private async recordAccess(id: string): Promise<void> {
    try {
      await this.locks.write(id, async () => {
        const meta = await this.current(id);
        if (!meta || meta.status !== 'ready') return;
        await this.persist({
          ...meta,
          accessCount: meta.accessCount + 1,
          lastAccessAt: this.now(),
        });
      });
    } catch (error) {
      this.log('warn', 'failed to record share access', { error: String(error) });
    }
  }

  private async persist(meta: ShareMeta): Promise<void> {
    await this.writeMeta(meta);
    this.index.set(meta.id, meta);
  }

  private async writeMeta(meta: ShareMeta): Promise<void> {
    const prefix = storagePrefixFor(meta.id);
    await this.store.put(`${prefix}meta.json`, Buffer.from(JSON.stringify(meta)));
    await this.store.markDue?.(prefix.slice(SHARES_ROOT.length, -1), nextActionAt(meta));
  }

  private async readMeta(prefix: string): Promise<ShareMeta | null> {
    const raw = await this.store.getBuffer(`${prefix}meta.json`);
    if (!raw) return null;
    const parsed = ShareMetaSchema.safeParse(JSON.parse(raw.toString('utf8')));
    return parsed.success ? parsed.data : null;
  }

  private async deleteData(meta: ShareMeta): Promise<void> {
    const prefix = storagePrefixFor(meta.id);
    try {
      if (this.store.deleteMany) {
        // Every key is known from the metadata: no listing needed.
        const keys = [`${prefix}data/manifest.bin`];
        for (let i = 0; i < meta.chunkCount; i++) keys.push(chunkKey(prefix, i));
        await this.store.deleteMany(keys);
      } else {
        await this.store.deletePrefix(`${prefix}data/`);
      }
    } catch (error) {
      throw this.storageFailure(error);
    }
  }

  /** Removes every object of a package, data first and metadata last. */
  private async purge(meta: ShareMeta): Promise<void> {
    const prefix = storagePrefixFor(meta.id);
    await this.deleteData(meta);
    try {
      if (this.store.deleteMany) await this.store.deleteMany([`${prefix}meta.json`]);
      else await this.store.deletePrefix(prefix);
    } catch (error) {
      throw this.storageFailure(error);
    }
    this.index.delete(meta.id);
    await this.usage?.release(meta.id);
  }

  private async storeWrite(key: string, data: Uint8Array): Promise<void> {
    try {
      await this.store.put(key, data);
    } catch (error) {
      throw this.storageFailure(error);
    }
  }

  private async storeStat(key: string) {
    try {
      return await this.store.stat(key);
    } catch (error) {
      throw this.storageFailure(error);
    }
  }

  private async storeOpen(key: string) {
    try {
      return await this.store.getStream(key);
    } catch (error) {
      throw this.storageFailure(error);
    }
  }

  private storageFailure(error: unknown): ShareServiceError {
    if (error instanceof ShareServiceError) return error;
    this.log('error', 'storage operation failed', { error: String(error) });
    return new ShareServiceError(
      'storage-unavailable',
      503,
      'Temporary storage is unavailable',
      30,
    );
  }
}

/** When a package next needs attention: upload deadline, expiry, or tombstone purge. */
function nextActionAt(meta: ShareMeta): number | null {
  switch (meta.status) {
    case 'uploading':
      return meta.uploadDeadline;
    case 'ready':
      return meta.expiresAt;
    default:
      return meta.purgeAt;
  }
}

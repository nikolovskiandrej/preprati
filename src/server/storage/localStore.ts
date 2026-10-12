import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomId } from '../../shared/encoding';
import { assertSafeKey, StorageError, type BlobStore, type StoredObjectInfo } from './types';

/**
 * Filesystem adapter for development and single-server deployments with a
 * persistent disk. Writes are atomic (temp file + rename) so readers never
 * observe partially written objects, and everything is created owner-only.
 */
export class LocalBlobStore implements BlobStore {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.removeStaleTempFiles(this.root);
  }

  async healthCheck(): Promise<boolean> {
    const probe = path.join(this.root, `.probe-${randomId()}`);
    try {
      await fs.writeFile(probe, 'ok', { mode: 0o600 });
      await fs.rm(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const target = this.resolve(key);
    const tmp = `${target}.${randomId()}.tmp`;
    try {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await fs.rename(tmp, target);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw new StorageError('Failed to write object', { cause: error });
    }
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new StorageError('Failed to read object', { cause: error });
    }
  }

  async getStream(key: string) {
    const file = this.resolve(key);
    try {
      const stats = await fs.stat(file);
      if (!stats.isFile()) return null;
      return { stream: createReadStream(file), size: stats.size };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new StorageError('Failed to open object', { cause: error });
    }
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    try {
      const stats = await fs.stat(this.resolve(key));
      if (!stats.isFile()) return null;
      return { key, size: stats.size, modifiedAt: stats.mtimeMs };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new StorageError('Failed to stat object', { cause: error });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.rm(this.resolve(key), { force: true });
    } catch (error) {
      throw new StorageError('Failed to delete object', { cause: error });
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertSafeKey(prefix, { prefix: true });
    const dir = this.resolveDir(prefix);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      throw new StorageError('Failed to delete prefix', { cause: error });
    }
  }

  async *list(prefix: string): AsyncIterable<StoredObjectInfo> {
    assertSafeKey(prefix, { prefix: true });
    const dir = this.resolveDir(prefix);
    yield* this.walk(dir, prefix);
  }

  async *listChildren(prefix: string): AsyncIterable<string> {
    assertSafeKey(prefix, { prefix: true });
    let entries;
    try {
      entries = await fs.readdir(this.resolveDir(prefix), { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw new StorageError('Failed to list prefix', { cause: error });
    }
    for (const entry of entries) {
      if (entry.isDirectory()) yield entry.name;
    }
  }

  private async *walk(dir: string, keyPrefix: string): AsyncIterable<StoredObjectInfo> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw new StorageError('Failed to list objects', { cause: error });
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(full, `${keyPrefix}${entry.name}/`);
      } else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
        const stats = await fs.stat(full).catch(() => null);
        if (stats)
          yield { key: `${keyPrefix}${entry.name}`, size: stats.size, modifiedAt: stats.mtimeMs };
      }
    }
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new StorageError('Invalid storage key');
    return full;
  }

  private resolveDir(prefix: string): string {
    const full = path.resolve(this.root, prefix);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new StorageError('Invalid storage prefix');
    }
    return full;
  }

  /** Removes temp files left behind by a crash during an atomic write. */
  private async removeStaleTempFiles(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await this.removeStaleTempFiles(full);
      else if (entry.name.endsWith('.tmp'))
        await fs.rm(full, { force: true }).catch(() => undefined);
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: string }).code === 'ENOENT' ||
      (error as { code?: string }).code === 'ENOTDIR')
  );
}

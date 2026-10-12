/**
 * Relay mode's storage, in memory: packages are kept as the original files.
 * Uploads can be held back (`hold`) or made to fail (`failUpload`).
 */
import {
  RelayStorageError,
  type RelayPackage,
  type RelayStorage,
} from '../../src/client/transfer/relay';
import { randomId, randomSecret } from '../../src/shared/encoding';

export class MemoryStorage implements RelayStorage {
  readonly packages = new Map<string, { files: File[]; secret: string }>();
  readonly removed: string[] = [];
  readonly secrets: string[] = [];
  hold: Promise<void> | null = null;
  failUpload: RelayStorageError | null = null;

  async upload(
    files: File[],
    { signal, onProgress }: { signal: AbortSignal; onProgress: (bytes: number) => void },
  ): Promise<RelayPackage> {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    // Like the share API, which estimates bytes of a chunk still in flight.
    onProgress(total / 3);
    onProgress(Math.floor(total / 2));
    await this.hold;
    if (signal.aborted) throw new RelayStorageError('aborted');
    if (this.failUpload) throw this.failUpload;
    onProgress(total);
    const pkg = { id: randomId(), ownerToken: randomSecret(), secret: randomSecret() };
    this.packages.set(pkg.id, { files, secret: pkg.secret });
    this.secrets.push(pkg.secret);
    return pkg;
  }

  async download(
    pkg: { id: string; secret: string },
    { onProgress }: { signal: AbortSignal; onProgress: (bytes: number) => void },
  ) {
    const stored = this.packages.get(pkg.id);
    if (!stored || stored.secret !== pkg.secret) throw new RelayStorageError('corrupted');
    const total = stored.files.reduce((sum, file) => sum + file.size, 0);
    onProgress(total / 3);
    onProgress(total);
    return stored.files.map((file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
      blob: file as Blob,
    }));
  }

  async remove(pkg: RelayPackage): Promise<void> {
    this.packages.delete(pkg.id);
    this.removed.push(pkg.id);
  }
}

import type { ServerConfig } from '../config';
import type { KvStore } from '../kv';
import { KvMetaStore } from './kvMetaStore';
import { LocalBlobStore } from './localStore';
import { S3BlobStore } from './s3Store';
import type { BlobStore } from './types';
import { VercelBlobStore } from './vercelBlobStore';

export type { BlobStore, StoredObjectInfo } from './types';
export { StorageError } from './types';

/**
 * Creates the storage adapter selected by STORAGE_DRIVER, or null when sharing
 * is off. In serverless mode package metadata moves to the shared KV store so
 * every function instance sees the same state.
 */
export function createBlobStore(config: ServerConfig, kv: KvStore | null = null): BlobStore | null {
  let store: BlobStore;
  switch (config.share.driver) {
    case 'local':
      store = new LocalBlobStore(config.storage.localDir);
      break;
    case 's3':
      store = new S3BlobStore(config.storage.s3);
      break;
    case 'vercel-blob':
      store = new VercelBlobStore({
        token: config.storage.vercelBlob.token,
        prefix: config.storage.vercelBlob.prefix,
        monthlyWriteBudget: config.storage.vercelBlob.monthlyWriteBudget,
        kv,
      });
      break;
    default:
      return null;
  }
  return config.serverless && kv ? new KvMetaStore(store, kv) : store;
}

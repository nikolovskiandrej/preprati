import { Readable } from 'node:stream';
import type * as S3Sdk from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ServerConfig } from '../config';
import { assertSafeKey, StorageError, type BlobStore, type StoredObjectInfo } from './types';

type S3Module = typeof S3Sdk;

/**
 * S3-compatible object storage adapter (AWS S3, Cloudflare R2, MinIO,
 * Backblaze B2, …). The SDK is imported lazily so deployments using the local
 * filesystem never load it. Credentials stay on the server.
 *
 * Recommended bucket setup: private bucket, no public access, and a lifecycle
 * rule that expires objects under the configured prefix after a few days as a
 * safety net in addition to preprati.'s own cleanup job.
 */
export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;
  private sdk: S3Module | null = null;
  private client: S3Client | null = null;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(private readonly settings: ServerConfig['storage']['s3']) {
    if (!settings.bucket) throw new StorageError('S3 bucket is not configured');
    this.bucket = settings.bucket;
    this.prefix = settings.prefix;
  }

  async init(): Promise<void> {
    const sdk = await this.load();
    const client = this.getClient();
    try {
      await client.send(new sdk.HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      throw new StorageError('S3 bucket is not reachable with the configured credentials', {
        cause: error,
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const sdk = await this.load();
      await this.getClient().send(new sdk.HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    assertSafeKey(key);
    const sdk = await this.load();
    try {
      await this.getClient().send(
        new sdk.PutObjectCommand({
          Bucket: this.bucket,
          Key: this.prefix + key,
          Body: data,
          ContentLength: data.byteLength,
          ContentType: key.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        }),
      );
    } catch (error) {
      throw new StorageError('Failed to write object', { cause: error });
    }
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    const object = await this.getStream(key);
    if (!object) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  }

  async getStream(key: string): Promise<{ stream: Readable; size: number } | null> {
    assertSafeKey(key);
    const sdk = await this.load();
    try {
      const result = await this.getClient().send(
        new sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }),
      );
      const body = result.Body;
      if (!body) return null;
      const stream = body instanceof Readable ? body : Readable.fromWeb(body as never);
      return { stream, size: Number(result.ContentLength ?? 0) };
    } catch (error) {
      if (isMissing(error)) return null;
      throw new StorageError('Failed to read object', { cause: error });
    }
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    assertSafeKey(key);
    const sdk = await this.load();
    try {
      const result = await this.getClient().send(
        new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }),
      );
      return {
        key,
        size: Number(result.ContentLength ?? 0),
        modifiedAt: result.LastModified?.getTime() ?? 0,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw new StorageError('Failed to stat object', { cause: error });
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const sdk = await this.load();
    try {
      await this.getClient().send(
        new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }),
      );
    } catch (error) {
      if (isMissing(error)) return;
      throw new StorageError('Failed to delete object', { cause: error });
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertSafeKey(prefix, { prefix: true });
    const sdk = await this.load();
    const batch: string[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const objects = batch.splice(0, batch.length).map((Key) => ({ Key }));
      try {
        const result = await this.getClient().send(
          new sdk.DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        if (result.Errors && result.Errors.length > 0) {
          throw new StorageError(`Failed to delete ${result.Errors.length} objects`);
        }
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError('Failed to delete objects', { cause: error });
      }
    };
    for await (const object of this.listRaw(this.prefix + prefix)) {
      batch.push(object.Key);
      if (batch.length === 1000) await flush();
    }
    await flush();
  }

  async *list(prefix: string): AsyncIterable<StoredObjectInfo> {
    assertSafeKey(prefix, { prefix: true });
    for await (const object of this.listRaw(this.prefix + prefix)) {
      yield {
        key: object.Key.slice(this.prefix.length),
        size: object.Size,
        modifiedAt: object.LastModified,
      };
    }
  }

  async *listChildren(prefix: string): AsyncIterable<string> {
    assertSafeKey(prefix, { prefix: true });
    const sdk = await this.load();
    const fullPrefix = this.prefix + prefix;
    let token: string | undefined;
    do {
      let result;
      try {
        result = await this.getClient().send(
          new sdk.ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: fullPrefix,
            Delimiter: '/',
            ContinuationToken: token,
          }),
        );
      } catch (error) {
        throw new StorageError('Failed to list prefixes', { cause: error });
      }
      for (const common of result.CommonPrefixes ?? []) {
        const name = common.Prefix?.slice(fullPrefix.length).replace(/\/$/, '');
        if (name) yield name;
      }
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (token);
  }

  async close(): Promise<void> {
    this.client?.destroy();
    this.client = null;
  }

  private async *listRaw(
    fullPrefix: string,
  ): AsyncIterable<{ Key: string; Size: number; LastModified: number }> {
    const sdk = await this.load();
    let token: string | undefined;
    do {
      let result;
      try {
        result = await this.getClient().send(
          new sdk.ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: fullPrefix,
            ContinuationToken: token,
          }),
        );
      } catch (error) {
        throw new StorageError('Failed to list objects', { cause: error });
      }
      for (const object of result.Contents ?? []) {
        if (!object.Key) continue;
        yield {
          Key: object.Key,
          Size: Number(object.Size ?? 0),
          LastModified: object.LastModified?.getTime() ?? 0,
        };
      }
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (token);
  }

  private async load(): Promise<S3Module> {
    if (!this.sdk) {
      try {
        this.sdk = await import('@aws-sdk/client-s3');
      } catch (error) {
        throw new StorageError('The @aws-sdk/client-s3 package is required for STORAGE_DRIVER=s3', {
          cause: error,
        });
      }
    }
    return this.sdk;
  }

  private getClient(): S3Client {
    if (!this.sdk) throw new StorageError('S3 SDK not loaded');
    if (!this.client) {
      const { accessKeyId, secretAccessKey, endpoint, region, forcePathStyle } = this.settings;
      this.client = new this.sdk.S3Client({
        region,
        forcePathStyle,
        ...(endpoint ? { endpoint } : {}),
        ...(accessKeyId && secretAccessKey
          ? { credentials: { accessKeyId, secretAccessKey } }
          : {}),
      });
    }
    return this.client;
  }
}

function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

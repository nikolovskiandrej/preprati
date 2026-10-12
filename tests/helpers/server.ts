/**
 * Boots the real backend on an ephemeral port with a throwaway storage
 * directory, for integration tests.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildApp, type PrepratiApp } from '../../src/server/app';
import { loadConfig, type ServerConfig } from '../../src/server/config';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  body: Buffer | null;
}

export interface TestServer {
  url: string;
  /** Every request the server received (only when `record` is enabled). */
  requests: RecordedRequest[];
  wsUrl: string;
  config: ServerConfig;
  storageDir: string;
  instance: PrepratiApp;
  close(): Promise<void>;
}

export async function startTestServer(
  env: Record<string, string> = {},
  options: {
    now?: () => number;
    record?: boolean;
    /** Return an HTTP status to fail a request on purpose (fault injection). */
    fail?: (request: { method: string; url: string }) => number | null;
  } = {},
): Promise<TestServer> {
  const storageDir = await mkdtemp(path.join(tmpdir(), 'preprati-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    STORAGE_DRIVER: 'local',
    STORAGE_DIR: storageDir,
    SHARE_CHUNK_SIZE: '64KiB',
    CLEANUP_INTERVAL: '1h',
    STUN_URLS: '',
    ...env,
  });
  const instance = await buildApp(config, { logger: false, now: options.now });
  const requests: RecordedRequest[] = [];
  if (options.fail) {
    const fail = options.fail;
    // After body parsing, like a genuine server-side rejection.
    instance.app.addHook('preHandler', async (request, reply) => {
      const status = fail({ method: request.method, url: request.url });
      if (status)
        return reply
          .code(status)
          .send({ error: { code: 'too-large', message: 'Injected failure' } });
    });
  }
  if (options.record) {
    instance.app.addHook('preHandler', async (request) => {
      const body = request.body;
      requests.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body:
          body === undefined || body === null
            ? null
            : Buffer.isBuffer(body)
              ? body
              : Buffer.from(JSON.stringify(body)),
      });
    });
  }
  await instance.app.listen({ host: '127.0.0.1', port: 0 });
  await instance.shareReady;
  const { port } = instance.app.server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    config,
    storageDir,
    instance,
    async close() {
      // Aborted uploads can leave half-sent requests behind; don't wait for them in tests.
      instance.app.server.closeAllConnections();
      await instance.app.close();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

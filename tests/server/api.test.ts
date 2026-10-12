import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHARE_CHUNK_OVERHEAD } from '../../src/shared/constants';
import type { PublicConfig } from '../../src/shared/shareApi';
import { startTestServer, type TestServer } from '../helpers/server';

describe('HTTP API', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({
      RATE_LIMIT_SHARE_CREATE: '3',
      NOTEA_URL: 'https://notea.example/',
    });
  });
  afterAll(() => server.close());

  const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('publishes runtime configuration without secrets', async () => {
    const response = await fetch(`${server.url}/api/config`);
    expect(response.status).toBe(200);
    const config = (await response.json()) as PublicConfig;
    expect(config.share).toMatchObject({
      enabled: true,
      chunkBytes: 64 * 1024,
      ttlSeconds: 86_400,
    });
    expect(config.quickTransfer.pairingTtlSeconds).toBe(600);
    expect(config.attribution.url).toBe('https://notea.example/');
    expect(JSON.stringify(config)).not.toMatch(/secret|password|storage_dir|STORAGE/i);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('sends hardened security headers', async () => {
    const response = await fetch(`${server.url}/api/health`);
    expect(await response.json()).toMatchObject({ status: 'ok', share: 'ok' });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('rejects requests from foreign origins', async () => {
    const response = await fetch(`${server.url}/api/config`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
    const preflight = await fetch(`${server.url}/api/shares`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('runs the share upload/download lifecycle over HTTP', async () => {
    const lastPlain = 1000;
    const created = await fetch(
      `${server.url}/api/shares`,
      json({
        chunkBytes: 65_536,
        chunkCount: 1,
        cipherBytes: lastPlain + SHARE_CHUNK_OVERHEAD,
        manifestBytes: 540,
      }),
    );
    expect(created.status).toBe(201);
    const { id, ownerToken } = (await created.json()) as { id: string; ownerToken: string };
    const auth = {
      authorization: `Bearer ${ownerToken}`,
      'content-type': 'application/octet-stream',
    };

    const chunk = crypto.getRandomValues(new Uint8Array(lastPlain + SHARE_CHUNK_OVERHEAD));
    expect(
      (
        await fetch(`${server.url}/api/shares/${id}/manifest`, {
          method: 'PUT',
          headers: auth,
          body: new Uint8Array(540),
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await fetch(`${server.url}/api/shares/${id}/chunks/0`, {
          method: 'PUT',
          headers: auth,
          body: chunk,
        })
      ).status,
    ).toBe(204);
    // Unauthenticated uploads are refused.
    expect(
      (
        await fetch(`${server.url}/api/shares/${id}/chunks/0`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: chunk,
        })
      ).status,
    ).toBe(401);

    const finalized = await fetch(`${server.url}/api/shares/${id}/finalize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(finalized.status).toBe(200);

    const download = await fetch(`${server.url}/api/shares/${id}/chunks/0`);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(chunk);

    const deleted = await fetch(`${server.url}/api/shares/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(deleted.status).toBe(204);
    const gone = await fetch(`${server.url}/api/shares/${id}`);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ error: { code: 'deleted' } });
  });

  it('returns 404 for unknown or malformed share ids without hitting storage paths', async () => {
    expect((await fetch(`${server.url}/api/shares/AAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/shares/..%2F..%2Fetc`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/shares/AAAAAAAAAAAAAAAAAAAAAA/chunks/-1`)).status).toBe(
      400,
    );
  });

  it('refuses oversized request bodies', async () => {
    const created = await fetch(
      `${server.url}/api/shares`,
      json({
        chunkBytes: 65_536,
        chunkCount: 1,
        cipherBytes: 100 + SHARE_CHUNK_OVERHEAD,
        manifestBytes: 540,
      }),
    );
    const { id, ownerToken } = (await created.json()) as { id: string; ownerToken: string };
    const response = await fetch(`${server.url}/api/shares/${id}/chunks/0`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(65_536 + SHARE_CHUNK_OVERHEAD + 1),
    });
    expect(response.status).toBe(413);
  });

  it('rate limits share creation per client', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const response = await fetch(
        `${server.url}/api/shares`,
        json({ chunkBytes: 65_536, chunkCount: 0, cipherBytes: 0, manifestBytes: 540 }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });
});

describe('HTTP API without storage', () => {
  it('reports that hosted sharing is not configured instead of pretending', async () => {
    const server = await startTestServer({ NODE_ENV: 'production', STORAGE_DRIVER: '' });
    try {
      const config = (await (await fetch(`${server.url}/api/config`)).json()) as PublicConfig;
      expect(config.share).toMatchObject({ enabled: false, reason: 'not-configured' });
      const create = await fetch(`${server.url}/api/shares`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(create.status).toBe(503);
      expect(await create.json()).toMatchObject({ error: { code: 'share-disabled' } });
    } finally {
      await server.close();
    }
  });
});

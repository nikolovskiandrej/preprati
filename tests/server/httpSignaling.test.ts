import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '../../src/shared/signaling';
import { startTestServer, type TestServer } from '../helpers/server';

describe('HTTP signaling routes', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({
      SIGNALING_TRANSPORT: 'http',
      CRON_SECRET: 'cron-secret-for-tests-0123456789',
    });
  });
  afterAll(() => server.close());

  const connect = async () => {
    const response = await fetch(`${server.url}/api/signal/connect`, { method: 'POST' });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return (await response.json()) as { connectionId: string; token: string };
  };

  const headers = (
    c: { connectionId: string; token: string },
    extra: Record<string, string> = {},
  ) => ({
    Authorization: `Bearer ${c.token}`,
    'X-Signal-Connection': c.connectionId,
    ...extra,
  });

  const send = async (
    c: { connectionId: string; token: string },
    message: unknown,
    seq?: number,
  ) => {
    const response = await fetch(`${server.url}/api/signal/send`, {
      method: 'POST',
      headers: headers(c, {
        'Content-Type': 'application/json',
        ...(seq ? { 'X-Signal-Seq': String(seq) } : {}),
      }),
      body: JSON.stringify(message),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { messages: ServerMessage[] }).messages;
  };

  const poll = async (c: { connectionId: string; token: string }) => {
    const response = await fetch(`${server.url}/api/signal/poll`, { headers: headers(c) });
    expect(response.status).toBe(200);
    return ((await response.json()) as { messages: ServerMessage[] }).messages;
  };

  it('advertises HTTP signaling and does not offer the WebSocket endpoint', async () => {
    const config = (await (await fetch(`${server.url}/api/config`)).json()) as {
      quickTransfer: { signaling: string };
    };
    expect(config.quickTransfer.signaling).toBe('http');
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(server.wsUrl);
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      socket.once('open', () => reject(new Error('WebSocket signaling should be off')));
      socket.once('error', () => undefined);
    });
    expect(status).toBe(404);
  });

  it('pairs two devices and relays messages', async () => {
    const host = await connect();
    const created = await send(
      host,
      { type: 'create-session', role: 'receiver', device: { label: 'Laptop' } },
      1,
    );
    expect(created).toEqual([
      expect.objectContaining({ type: 'session-created', role: 'receiver' }),
    ]);
    const sessionId = (created[0] as Extract<ServerMessage, { type: 'session-created' }>).sessionId;

    const guest = await connect();
    const joined = await send(
      guest,
      { type: 'join-session', target: { via: 'link', sessionId }, device: { label: 'Phone' } },
      1,
    );
    expect(joined).toEqual([
      expect.objectContaining({ type: 'session-joined', role: 'sender', awaitingApproval: false }),
    ]);
    expect(await poll(host)).toEqual([
      { type: 'peer-joined', peer: { label: 'Phone' }, via: 'link', needsApproval: false },
    ]);

    await send(guest, { type: 'signal', payload: { kind: 'candidate', candidate: null } }, 2);
    expect(await poll(host)).toEqual([
      { type: 'signal', payload: { kind: 'candidate', candidate: null } },
    ]);
  });

  it('handles a retried send only once', async () => {
    const host = await connect();
    const first = await send(
      host,
      { type: 'create-session', role: 'sender', device: { label: 'Laptop' } },
      1,
    );
    expect(first).toEqual([expect.objectContaining({ type: 'session-created' })]);
    // Same message number again (the first response was "lost"): no second session, no error.
    expect(
      await send(host, { type: 'create-session', role: 'sender', device: { label: 'Laptop' } }, 1),
    ).toEqual([]);
    expect(
      await send(host, { type: 'create-session', role: 'sender', device: { label: 'Laptop' } }, 2),
    ).toEqual([{ type: 'error', code: 'already-in-session' }]);
  });

  it('rejects requests without valid credentials', async () => {
    const real = await connect();
    const attempts: RequestInit[] = [
      {},
      { headers: { Authorization: `Bearer ${real.token}` } },
      {
        headers: {
          Authorization: `Bearer ${'A'.repeat(43)}`,
          'X-Signal-Connection': real.connectionId,
        },
      },
    ];
    for (const init of attempts) {
      const response = await fetch(`${server.url}/api/signal/poll`, init);
      expect(response.status).toBe(401);
    }
  });

  it('answers malformed messages with an error message', async () => {
    const c = await connect();
    expect(await send(c, { type: 'create-session', role: 'boss' })).toEqual([
      { type: 'error', code: 'invalid-message' },
    ]);
  });

  it('accepts a sendBeacon-style disconnect and tells the peer', async () => {
    const host = await connect();
    const created = await send(
      host,
      { type: 'create-session', role: 'receiver', device: { label: 'Laptop' } },
      1,
    );
    const sessionId = (created[0] as Extract<ServerMessage, { type: 'session-created' }>).sessionId;
    const guest = await connect();
    await send(
      guest,
      { type: 'join-session', target: { via: 'link', sessionId }, device: { label: 'Phone' } },
      1,
    );
    await poll(host);

    const beacon = await fetch(`${server.url}/api/signal/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(guest),
    });
    expect(beacon.status).toBe(204);
    expect(await poll(host)).toEqual([{ type: 'peer-left' }]);
    expect((await fetch(`${server.url}/api/signal/poll`, { headers: headers(guest) })).status).toBe(
      401,
    );
  });

  it('protects the cleanup endpoint with the cron secret', async () => {
    expect((await fetch(`${server.url}/api/cron/cleanup`)).status).toBe(401);
    expect(
      (
        await fetch(`${server.url}/api/cron/cleanup`, {
          headers: { Authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401);
    const response = await fetch(`${server.url}/api/cron/cleanup`, {
      headers: { Authorization: 'Bearer cron-secret-for-tests-0123456789' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      expired: 0,
      abandoned: 0,
      purged: 0,
      orphans: 0,
    });
  });
});

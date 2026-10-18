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

  it('handles a batch in order, and each message once when a retry overlaps it', async () => {
    const host = await connect();
    const guest = await connect();
    const [created] = await send(
      host,
      { type: 'create-session', role: 'receiver', device: { label: 'Laptop' } },
      1,
    );
    const sessionId = (created as Extract<ServerMessage, { type: 'session-created' }>).sessionId;
    const candidate = (port: number) => ({
      type: 'signal',
      payload: {
        kind: 'candidate',
        candidate: { candidate: `candidate:1 1 udp 1 192.0.2.1 ${port} typ host`, sdpMid: '0' },
      },
    });
    // Joining and the first signals in one request: the join counts for the signals after it.
    const joined = await send(
      guest,
      [
        { type: 'join-session', target: { via: 'link', sessionId }, device: { label: 'Phone' } },
        candidate(5000),
        candidate(5001),
      ],
      1,
    );
    expect(joined.map((m) => m.type)).toEqual(['session-joined']);
    // The response to that was "lost": the retry carries the same messages plus a new one.
    await send(
      guest,
      [
        { type: 'join-session', target: { via: 'link', sessionId }, device: { label: 'Phone' } },
        candidate(5000),
        candidate(5001),
        candidate(5002),
      ],
      1,
    );
    const relayed = (await poll(host)).filter((m) => m.type === 'signal');
    expect(
      relayed.map((m) =>
        m.type === 'signal' && m.payload.kind === 'candidate'
          ? m.payload.candidate?.candidate.split(' ')[5]
          : null,
      ),
    ).toEqual(['5000', '5001', '5002']);
  });

  it('refuses an oversized batch whole, and reports invalid items in one', async () => {
    const c = await connect();
    const pings = Array.from({ length: 33 }, () => ({ type: 'ping' }));
    expect(await send(c, pings, 1)).toEqual([{ type: 'error', code: 'invalid-message' }]);
    expect(await send(c, [{ type: 'ping' }, { type: 'bogus' }], 40)).toEqual([
      { type: 'error', code: 'invalid-message' },
      { type: 'pong' },
    ]);
  });

  it('relays signals only between the two members of a paired session', async () => {
    const host = await connect();
    const guest = await connect();
    const [created] = await send(
      host,
      { type: 'create-session', role: 'sender', device: { label: 'Laptop' } },
      1,
    );
    const code = (created as Extract<ServerMessage, { type: 'session-created' }>).code;
    // A code join to a sending host waits for approval: no signals until then.
    await send(
      guest,
      { type: 'join-session', target: { via: 'code', code }, device: { label: 'Phone' } },
      1,
    );
    expect(
      await send(guest, { type: 'signal', payload: { kind: 'retry', attempt: 1 } }, 2),
    ).toEqual([{ type: 'error', code: 'not-allowed' }]);
    expect((await poll(host)).map((m) => m.type)).toEqual(['peer-joined']);
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

    // Like a browser's beacon under this site's no-referrer policy: no CORS, Origin "null".
    const beacon = await fetch(`${server.url}/api/signal/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'null' },
      body: JSON.stringify(guest),
    });
    expect(beacon.status).toBe(204);
    // The guest left before anything moved: the host may wait for another device.
    expect(await poll(host)).toEqual([
      { type: 'peer-left', reason: 'left', expiresAt: expect.any(Number) },
    ]);
    expect((await fetch(`${server.url}/api/signal/poll`, { headers: headers(guest) })).status).toBe(
      401,
    );
  });

  it('still refuses an opaque origin everywhere but the disconnect beacon', async () => {
    const response = await fetch(`${server.url}/api/signal/connect`, {
      method: 'POST',
      headers: { Origin: 'null' },
    });
    expect(response.status).toBe(403);
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

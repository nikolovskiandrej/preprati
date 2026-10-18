// @vitest-environment jsdom
/**
 * The browser's HTTP polling transport against the real backend.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpSignalingClient } from '../../src/client/transfer/httpSignalingClient';
import type { ServerMessage } from '../../src/shared/signaling';
import { startTestServer, type TestServer } from '../helpers/server';

function collector(client: HttpSignalingClient) {
  const messages: ServerMessage[] = [];
  client.onMessage((message) => messages.push(message));
  return {
    messages,
    async next<T extends ServerMessage['type']>(
      type: T,
      ms = 5000,
    ): Promise<Extract<ServerMessage, { type: T }>> {
      const start = Date.now();
      for (;;) {
        const index = messages.findIndex((message) => message.type === type);
        if (index >= 0) return messages.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
        if (Date.now() - start > ms)
          throw new Error(`timed out waiting for ${type}; have ${JSON.stringify(messages)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

describe('HttpSignalingClient', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({ SIGNALING_TRANSPORT: 'http' }, { record: true });
  });
  afterAll(() => server.close());

  it('creates, joins and relays in order, then reports departure', async () => {
    const host = new HttpSignalingClient(server.url);
    const guest = new HttpSignalingClient(server.url);
    const hostInbox = collector(host);
    const guestInbox = collector(guest);
    await host.connect();
    await guest.connect();
    expect(host.isOpen).toBe(true);

    host.send({ type: 'create-session', role: 'sender', device: { label: 'Laptop' } });
    const created = await hostInbox.next('session-created');
    guest.send({
      type: 'join-session',
      target: { via: 'link', sessionId: created.sessionId },
      device: { label: 'Phone' },
    });
    await guestInbox.next('session-joined');
    await hostInbox.next('peer-joined'); // arrives by polling

    // A burst of sends is delivered in order (offer before candidates).
    const payloads = [
      { kind: 'description' as const, description: { type: 'offer' as const, sdp: 'v=0' } },
      ...Array.from({ length: 5 }, (_, i) => ({
        kind: 'candidate' as const,
        candidate: {
          candidate: `candidate:${i} 1 udp 1 192.0.2.1 ${5000 + i} typ host`,
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      })),
    ];
    for (const payload of payloads) host.send({ type: 'signal', payload });
    const relayed: unknown[] = [];
    while (relayed.length < payloads.length)
      relayed.push((await guestInbox.next('signal')).payload);
    expect(relayed).toEqual(payloads);

    // Each connection numbers its messages 1, 2, 3… so retries can be recognised. A request
    // carries the number of its first message; what queued up meanwhile shares a request.
    const byConnection = new Map<string, Array<{ seq: number; count: number }>>();
    for (const request of server.requests.filter((r) => r.url === '/api/signal/send')) {
      const id = String(request.headers['x-signal-connection']);
      const body: unknown = JSON.parse(request.body!.toString());
      byConnection.set(id, [
        ...(byConnection.get(id) ?? []),
        {
          seq: Number(request.headers['x-signal-seq']),
          count: Array.isArray(body) ? body.length : 1,
        },
      ]);
    }
    const sends = [...byConnection.values()];
    expect(sends.map((requests) => requests.reduce((n, r) => n + r.count, 0)).sort()).toEqual([
      1,
      payloads.length + 1,
    ]);
    for (const requests of sends) {
      let next = 1;
      for (const { seq, count } of requests) {
        expect(seq).toBe(next);
        next += count;
      }
    }
    // The offer went out at once; the candidates behind it shared the next request.
    const hostRequests = sends.find((requests) => requests.length > 1)!;
    expect(hostRequests.length).toBeLessThan(payloads.length + 1);

    guest.close(); // sends the disconnect beacon (fetch keepalive in jsdom)
    expect(guest.isOpen).toBe(false);
    await hostInbox.next('peer-left');
    host.close();
  });

  it('closes with "closed" when the server no longer knows the connection', async () => {
    const client = new HttpSignalingClient(server.url);
    await client.connect();
    const reason = new Promise((resolve) => client.onClose(resolve));
    // Forget the connection server-side, as if its presence had lapsed.
    const credentials = (
      client as unknown as { credentials: { connectionId: string; token: string } }
    ).credentials;
    await fetch(`${server.url}/api/signal/disconnect`, {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    await expect(reason).resolves.toBe('closed');
    expect(client.isOpen).toBe(false);
  });

  it('gets messages again when a response is lost on the way', async () => {
    const host = new HttpSignalingClient(server.url);
    const guest = new HttpSignalingClient(server.url);
    const hostInbox = collector(host);
    const guestInbox = collector(guest);
    await host.connect();
    await guest.connect();
    host.send({ type: 'create-session', role: 'receiver', device: { label: 'Laptop' } });
    const created = await hostInbox.next('session-created');
    guest.send({
      type: 'join-session',
      target: { via: 'link', sessionId: created.sessionId },
      device: { label: 'Phone' },
    });
    await guestInbox.next('session-joined');
    await hostInbox.next('peer-joined');

    // The server answers the guest's next poll, but the answer never arrives (a mobile
    // network switching cells, a dropped connection): the request fails client-side.
    const guestId = (guest as unknown as { credentials: { connectionId: string } }).credentials
      .connectionId;
    const realFetch = globalThis.fetch;
    let lost = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      const headers = new Headers(init?.headers);
      if (lost === 0 && headers.get('X-Signal-Connection') === guestId) {
        const body = (await response.clone().json()) as { messages?: Array<{ type: string }> };
        if (body.messages?.some((message) => message.type === 'signal')) {
          lost += 1;
          throw new TypeError('Failed to fetch');
        }
      }
      return response;
    });
    const offer = {
      kind: 'description' as const,
      description: { type: 'offer' as const, sdp: 'v=0' },
    };
    host.send({ type: 'signal', payload: offer });

    expect((await guestInbox.next('signal', 10_000)).payload).toEqual(offer);
    expect(lost).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_500)); // a few more polls
    expect(guestInbox.messages.filter((message) => message.type === 'signal')).toEqual([]);
    vi.restoreAllMocks();
    host.close();
    guest.close();
  });

  it('rejects connect when signaling is unavailable', async () => {
    const client = new HttpSignalingClient('http://127.0.0.1:9'); // discard port: nothing listens
    await expect(client.connect(2000)).rejects.toBeTruthy();
    expect(client.isOpen).toBe(false);
  });
});

describe('HttpSignalingClient pacing', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A fake server: counts polls, answers with the given batches, records acknowledgements. */
  function fakeServer(batches: Array<{ messages: unknown[]; firstSeq: number }> = []) {
    const polls: number[] = [];
    const acks: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/signal/connect'))
        return Response.json(
          { connectionId: 'c'.repeat(22), token: 't'.repeat(43) },
          { status: 201 },
        );
      acks.push(new Headers(init?.headers).get('X-Signal-Ack') ?? '');
      if (url.endsWith('/api/signal/poll')) polls.push(Date.now());
      return Response.json(batches.shift() ?? { messages: [], firstSeq: 0 });
    });
    return { polls, acks };
  }

  it('polls fast while active, then at the pace the session asks for', async () => {
    vi.useFakeTimers();
    const { polls } = fakeServer();
    const client = new HttpSignalingClient('http://signal.test');
    await client.connect();
    await vi.advanceTimersByTimeAsync(6_000);
    const active = polls.length;
    expect(active).toBeGreaterThanOrEqual(12); // every 400 ms right after connecting

    await vi.advanceTimersByTimeAsync(6_000);
    expect(polls.length - active).toBeLessThanOrEqual(5); // then every 1.5 s while pairing

    client.setPace('quiet');
    await vi.advanceTimersByTimeAsync(2_000); // let the 1.5 s poll already scheduled run
    const quietStart = polls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls.length - quietStart).toBe(2); // every 15 s once the devices talk directly

    const beforeNudge = polls.length;
    client.setPace('normal'); // e.g. the direct path dropped: check right away
    await vi.advanceTimersByTimeAsync(10);
    expect(polls.length).toBe(beforeNudge + 1);
    client.close();
  });

  it('polls steadily during a relay transfer, and at once when the page returns', async () => {
    vi.useFakeTimers();
    const { polls } = fakeServer();
    const client = new HttpSignalingClient('http://signal.test');
    await client.connect();
    client.setPace('live');
    client.send({ type: 'ping' }); // activity would normally mean 400 ms polling
    await vi.advanceTimersByTimeAsync(2_000);
    const start = polls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls.length - start).toBeGreaterThanOrEqual(9); // about once per second…
    expect(polls.length - start).toBeLessThanOrEqual(11); // …not every 400 ms

    client.setPace('quiet');
    await vi.advanceTimersByTimeAsync(2_000);
    const hidden = polls.length;
    // A phone brings the page back after timers were paused in the background.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10);
    expect(polls.length).toBe(hidden + 1);
    client.close();
  });

  it('acknowledges what it handled and skips messages it already has', async () => {
    vi.useFakeTimers();
    const left = { type: 'peer-left' };
    const { acks } = fakeServer([
      { messages: [left], firstSeq: 1 },
      { messages: [left, { type: 'session-expired' }], firstSeq: 1 }, // overlapping redelivery
    ]);
    const client = new HttpSignalingClient('http://signal.test');
    const received: string[] = [];
    client.onMessage((message) => received.push(message.type));
    await client.connect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(received).toEqual(['peer-left', 'session-expired']);
    expect(acks.slice(0, 3)).toEqual(['0', '1', '2']);
    client.close();
  });

  it('reports the channel closed when the page goes into the back/forward cache', async () => {
    vi.useFakeTimers();
    fakeServer();
    const client = new HttpSignalingClient('http://signal.test');
    const closed: string[] = [];
    client.onClose((reason) => closed.push(reason));
    await client.connect();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    expect(client.isOpen).toBe(false);
    expect(closed).toEqual(['closed']);
    const disconnects = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/api/signal/disconnect'));
    expect(disconnects).toHaveLength(1); // the server ends the session for the other device
    client.close();
  });
});

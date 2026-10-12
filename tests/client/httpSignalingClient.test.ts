// @vitest-environment jsdom
/**
 * The browser's HTTP polling transport against the real backend.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

    // Each connection numbers its sends 1, 2, 3… so retries can be recognised.
    const byConnection = new Map<string, number[]>();
    for (const request of server.requests.filter((r) => r.url === '/api/signal/send')) {
      const id = String(request.headers['x-signal-connection']);
      byConnection.set(id, [
        ...(byConnection.get(id) ?? []),
        Number(request.headers['x-signal-seq']),
      ]);
    }
    expect([...byConnection.values()].map((seqs) => seqs.length).sort()).toEqual([
      1,
      payloads.length + 1,
    ]);
    for (const seqs of byConnection.values()) expect(seqs).toEqual(seqs.map((_, i) => i + 1));

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

  it('rejects connect when signaling is unavailable', async () => {
    const client = new HttpSignalingClient('http://127.0.0.1:9'); // discard port: nothing listens
    await expect(client.connect(2000)).rejects.toBeTruthy();
    expect(client.isOpen).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '../../src/shared/signaling';
import { startTestServer, type TestServer } from '../helpers/server';

class Client {
  readonly messages: ServerMessage[] = [];
  private waiters: Array<{ type: string; resolve: (m: ServerMessage) => void }> = [];
  closed: Promise<number>;

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.type === message.type) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    this.closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)));
  }

  static async connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
    const socket = new WebSocket(url, { headers });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
      socket.once('unexpected-response', (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode}`)),
      );
    });
    return new Client(socket);
  }

  send(message: unknown) {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  next<T extends ServerMessage['type']>(
    type: T,
    ms = 3000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const existing = this.messages.find((m) => m.type === type);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return Promise.resolve(existing as Extract<ServerMessage, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), ms);
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(timer);
          this.messages.splice(this.messages.indexOf(m), 1);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  close() {
    this.socket.close();
  }
}

describe('signaling WebSocket', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({
      SESSION_PAIRING_TTL: '1s',
      RATE_LIMIT_JOIN_FAILURES: '3',
      WS_MAX_MESSAGE_SIZE: '8KiB',
    });
  });
  afterAll(() => server.close());

  it('pairs two devices by code and relays negotiation messages', async () => {
    const host = await Client.connect(server.wsUrl);
    const guest = await Client.connect(server.wsUrl);
    host.send({ type: 'create-session', role: 'receiver', device: { label: 'Mac · Chrome' } });
    const created = await host.next('session-created');
    guest.send({
      type: 'join-session',
      target: { via: 'code', code: created.code },
      device: { label: 'iPhone · Safari' },
    });
    expect((await guest.next('session-joined')).role).toBe('sender');
    expect((await host.next('peer-joined')).peer.label).toBe('iPhone · Safari');
    host.send({
      type: 'signal',
      payload: { kind: 'description', description: { type: 'offer', sdp: 'v=0\r\n' } },
    });
    expect((await guest.next('signal')).payload).toMatchObject({ kind: 'description' });
    guest.close();
    await host.next('peer-left');
    host.close();
  });

  it('tells a page that closed apart from a connection that dropped', async () => {
    const pairUp = async () => {
      const host = await Client.connect(server.wsUrl);
      const guest = await Client.connect(server.wsUrl);
      host.send({ type: 'create-session', role: 'receiver', device: { label: 'Laptop' } });
      const created = await host.next('session-created');
      guest.send({
        type: 'join-session',
        target: { via: 'link', sessionId: created.sessionId },
        device: { label: 'Phone' },
      });
      await host.next('peer-joined');
      return { host, guest };
    };

    const closed = await pairUp();
    closed.guest.socket.close(1001); // what browsers send when a page goes away
    expect(await closed.host.next('peer-left')).toEqual({ type: 'peer-left', reason: 'left' });
    closed.host.close();

    const dropped = await pairUp();
    dropped.guest.socket.terminate(); // no close frame: the network went away
    expect(await dropped.host.next('peer-left')).toEqual({ type: 'peer-left', reason: 'gone' });
    dropped.host.close();
  });

  it('expires sessions that nobody joins (server-enforced)', async () => {
    const host = await Client.connect(server.wsUrl);
    host.send({ type: 'create-session', role: 'sender', device: { label: 'A' } });
    const created = await host.next('session-created');
    await host.next('session-expired', 3000);
    const late = await Client.connect(server.wsUrl);
    late.send({
      type: 'join-session',
      target: { via: 'link', sessionId: created.sessionId },
      device: { label: 'B' },
    });
    expect((await late.next('error')).code).toBe('session-not-found');
    host.close();
    late.close();
  });

  it('answers malformed messages with errors and disconnects persistent offenders', async () => {
    const client = await Client.connect(server.wsUrl);
    client.send('not json');
    expect((await client.next('error')).code).toBe('invalid-message');
    client.send({ type: 'create-session', role: 'admin', device: { label: 'x' } });
    expect((await client.next('error')).code).toBe('invalid-message');
    client.send({
      type: 'signal',
      payload: { kind: 'description', description: { type: 'offer', sdp: 'x' } },
    });
    expect((await client.next('error')).code).toBe('not-in-session');
    for (let i = 0; i < 5; i++) client.send('{');
    expect(await client.closed).toBe(4400);
  });

  it('closes connections that send oversized messages', async () => {
    const client = await Client.connect(server.wsUrl);
    client.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(20_000) }));
    expect(await client.closed).toBe(1009);
  });

  it('slows down pairing-code guessing', async () => {
    // Own server: join failures are counted per IP and every test client is 127.0.0.1.
    const isolated = await startTestServer({ RATE_LIMIT_JOIN_FAILURES: '3' });
    const guesser = await Client.connect(isolated.wsUrl);
    const codes = ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD'];
    const results: string[] = [];
    for (const code of codes) {
      guesser.send({ type: 'join-session', target: { via: 'code', code }, device: { label: 'x' } });
      results.push((await guesser.next('error')).code);
    }
    expect(results.slice(0, 3)).toEqual([
      'session-not-found',
      'session-not-found',
      'session-not-found',
    ]);
    expect(results[3]).toBe('rate-limited');
    guesser.close();
    await isolated.close();
  });

  it('refuses WebSocket upgrades from foreign origins', async () => {
    await expect(Client.connect(server.wsUrl, { origin: 'https://evil.example' })).rejects.toThrow(
      'HTTP 403',
    );
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryKv } from '../../src/server/kv';
import {
  PollingSignaling,
  type PollingConnection,
} from '../../src/server/signaling/pollingSignaling';
import type { ClientMessage, ServerMessage } from '../../src/shared/signaling';

const PAIRING_TTL = 60_000;
const PRESENCE_TTL = 30_000;

describe('PollingSignaling', () => {
  let now: number;
  let kv: MemoryKv;
  let signaling: PollingSignaling;

  /** A device: credentials plus helpers that go through authenticate() like the HTTP routes. */
  const device = async (ip = '203.0.113.1') => {
    const credentials = await signaling.connect(ip);
    const auth = async (): Promise<PollingConnection> => {
      const record = await signaling.authenticate(credentials.connectionId, credentials.token);
      if (!record) throw new Error('not authenticated');
      return record;
    };
    return {
      ...credentials,
      send: async (message: ClientMessage) => signaling.handle(await auth(), message),
      poll: async (): Promise<ServerMessage[]> => signaling.poll(await auth()),
      leave: async () => signaling.disconnect(await auth()),
    };
  };

  const label = (name: string) => ({ label: name });

  type Device = Awaited<ReturnType<typeof device>>;
  /** Advances the clock in 10 s steps while the given devices keep polling; returns what they received. */
  const advance = async (ms: number, ...devices: Device[]): Promise<ServerMessage[][]> => {
    const received: ServerMessage[][] = devices.map(() => []);
    for (let left = ms; left > 0; left -= 10_000) {
      now += Math.min(10_000, left);
      for (const [index, polling] of devices.entries())
        received[index]!.push(...(await polling.poll()));
    }
    return received;
  };

  beforeEach(() => {
    now = 1_800_000_000_000;
    kv = new MemoryKv(() => now);
    signaling = new PollingSignaling(kv, {
      pairingTtlMs: PAIRING_TTL,
      maxLifetimeMs: 60 * 60_000,
      presenceTtlMs: PRESENCE_TTL,
      maxSessionsPerIpPer10Min: 3,
      joinFailuresPer10Min: 2,
      iceServers: () => [{ urls: ['stun:stun.example.test:3478'] }],
      now: () => now,
    });
  });

  /** Host creates a session; returns the host device and its session-created message. */
  const hostSession = async (role: 'sender' | 'receiver' = 'sender') => {
    const host = await device();
    await host.send({ type: 'create-session', role, device: label('Laptop') });
    const [created] = await host.poll();
    if (created?.type !== 'session-created') throw new Error(`unexpected ${created?.type}`);
    return { host, created };
  };

  it('pairs two devices by link and relays signals both ways', async () => {
    const { host, created } = await hostSession('sender');
    expect(created).toMatchObject({ role: 'sender', expiresAt: now + PAIRING_TTL });
    expect(created.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(created.iceServers).toHaveLength(1);

    const guest = await device('198.51.100.7');
    await guest.send({
      type: 'join-session',
      target: { via: 'link', sessionId: created.sessionId },
      device: label('Phone'),
    });
    expect(await guest.poll()).toEqual([
      expect.objectContaining({
        type: 'session-joined',
        role: 'receiver',
        peer: label('Laptop'),
        awaitingApproval: false,
      }),
    ]);
    expect(await host.poll()).toEqual([
      { type: 'peer-joined', peer: label('Phone'), via: 'link', needsApproval: false },
    ]);

    const offer = {
      kind: 'description' as const,
      description: { type: 'offer' as const, sdp: 'v=0 offer' },
    };
    await host.send({ type: 'signal', payload: offer });
    await host.send({ type: 'signal', payload: { kind: 'candidate', candidate: null } });
    // Order is preserved: the offer arrives before its candidates.
    expect(await guest.poll()).toEqual([
      { type: 'signal', payload: offer },
      { type: 'signal', payload: { kind: 'candidate', candidate: null } },
    ]);
    const answer = {
      kind: 'description' as const,
      description: { type: 'answer' as const, sdp: 'v=0 answer' },
    };
    await guest.send({ type: 'signal', payload: answer });
    expect(await host.poll()).toEqual([{ type: 'signal', payload: answer }]);

    // The inbox is drained by each poll.
    expect(await host.poll()).toEqual([]);
  });

  it('asks a sending host to approve devices that join by code', async () => {
    const { host, created } = await hostSession('sender');
    const guest = await device();
    await guest.send({
      type: 'join-session',
      target: { via: 'code', code: created.code },
      device: label('Tablet'),
    });
    expect(await guest.poll()).toEqual([
      expect.objectContaining({ type: 'session-joined', awaitingApproval: true }),
    ]);
    expect(await host.poll()).toEqual([
      { type: 'peer-joined', peer: label('Tablet'), via: 'code', needsApproval: true },
    ]);

    // Nothing is relayed before approval.
    await guest.send({ type: 'signal', payload: { kind: 'candidate', candidate: null } });
    expect(await guest.poll()).toEqual([{ type: 'error', code: 'not-allowed' }]);
    expect(await host.poll()).toEqual([]);

    await host.send({ type: 'approve-peer' });
    expect(await guest.poll()).toEqual([{ type: 'peer-approved' }]);
    await guest.send({ type: 'signal', payload: { kind: 'candidate', candidate: null } });
    expect(await host.poll()).toEqual([
      { type: 'signal', payload: { kind: 'candidate', candidate: null } },
    ]);
  });

  it('lets the host decline, after which another device may join', async () => {
    const { host, created } = await hostSession('sender');
    const first = await device();
    await first.send({
      type: 'join-session',
      target: { via: 'code', code: created.code },
      device: label('Unknown'),
    });
    await first.poll();
    await host.poll();
    await host.send({ type: 'decline-peer' });
    expect(await first.poll()).toEqual([{ type: 'peer-declined' }]);

    const second = await device();
    await second.send({
      type: 'join-session',
      target: { via: 'code', code: created.code },
      device: label('Phone'),
    });
    expect(await second.poll()).toEqual([expect.objectContaining({ type: 'session-joined' })]);
  });

  it('accepts exactly one guest', async () => {
    const { created } = await hostSession('receiver');
    const guest = await device();
    await guest.send({
      type: 'join-session',
      target: { via: 'link', sessionId: created.sessionId },
      device: label('A'),
    });
    const extra = await device();
    await extra.send({
      type: 'join-session',
      target: { via: 'link', sessionId: created.sessionId },
      device: label('B'),
    });
    expect(await extra.poll()).toEqual([{ type: 'error', code: 'session-full' }]);
  });

  it('expires unpaired sessions lazily, when the host polls', async () => {
    const { host, created } = await hostSession();
    expect(await advance(PAIRING_TTL - 1, host)).toEqual([[]]);
    now += 1;
    expect(await host.poll()).toEqual([{ type: 'session-expired' }]);
    const late = await device();
    await late.send({
      type: 'join-session',
      target: { via: 'code', code: created.code },
      device: label('Late'),
    });
    expect(await late.poll()).toEqual([{ type: 'error', code: 'session-not-found' }]);
  });

  it('keeps a paired session alive past the pairing window', async () => {
    const { host, created } = await hostSession('receiver');
    const guest = await device();
    await guest.send({
      type: 'join-session',
      target: { via: 'link', sessionId: created.sessionId },
      device: label('Phone'),
    });
    await guest.poll();
    await host.poll();
    expect(await advance(3 * PAIRING_TTL, host, guest)).toEqual([[], []]);
  });

  it('tells the other device when a peer stops polling', async () => {
    const { host, created } = await hostSession('receiver');
    const guest = await device();
    await guest.send({
      type: 'join-session',
      target: { via: 'link', sessionId: created.sessionId },
      device: label('Phone'),
    });
    await guest.poll();
    await host.poll();
    now += PRESENCE_TTL - 1_000;
    expect(await host.poll()).toEqual([]);
    now += 2_000; // the guest's presence has lapsed, the host's was just refreshed
    expect(await host.poll()).toEqual([{ type: 'peer-left' }]);
  });

  it('reports an explicit disconnect to the other device', async () => {
    const { host, created } = await hostSession('receiver');
    const guest = await device();
    await guest.send({
      type: 'join-session',
      target: { via: 'link', sessionId: created.sessionId },
      device: label('Phone'),
    });
    await host.poll();
    await guest.leave();
    expect(await host.poll()).toEqual([{ type: 'peer-left' }]);
    expect(await signaling.authenticate(guest.connectionId, guest.token)).toBeNull();
  });

  it('frees the slot when a guest awaiting approval walks away', async () => {
    const { host, created } = await hostSession('sender');
    const guest = await device();
    await guest.send({
      type: 'join-session',
      target: { via: 'code', code: created.code },
      device: label('Phone'),
    });
    await host.poll();
    await guest.send({ type: 'leave-session' });
    expect(await host.poll()).toEqual([{ type: 'peer-left' }]);
    const next = await device();
    await next.send({
      type: 'join-session',
      target: { via: 'code', code: created.code },
      device: label('Tablet'),
    });
    expect(await next.poll()).toEqual([expect.objectContaining({ type: 'session-joined' })]);
  });

  it('rejects unknown or forged credentials', async () => {
    const real = await device();
    expect(await signaling.authenticate(real.connectionId, 'A'.repeat(43))).toBeNull();
    expect(await signaling.authenticate('B'.repeat(22), real.token)).toBeNull();
    expect(await signaling.authenticate('../../etc', real.token)).toBeNull();
    expect(await signaling.authenticate(real.connectionId, real.token)).not.toBeNull();
    now += PRESENCE_TTL;
    expect(await signaling.authenticate(real.connectionId, real.token)).toBeNull();
  });

  it('rate-limits session creation and failed joins per IP', async () => {
    const host = await device('192.0.2.50');
    for (let i = 0; i < 3; i++) {
      await host.send({ type: 'create-session', role: 'sender', device: label('Laptop') });
      await host.send({ type: 'leave-session' });
    }
    await host.send({ type: 'create-session', role: 'sender', device: label('Laptop') });
    expect((await host.poll()).at(-1)).toEqual({ type: 'error', code: 'rate-limited' });

    const guesser = await device('192.0.2.99');
    for (const code of ['AAAAAA', 'BBBBBB']) {
      await guesser.send({
        type: 'join-session',
        target: { via: 'code', code },
        device: label('X'),
      });
    }
    await guesser.send({
      type: 'join-session',
      target: { via: 'code', code: 'CCCCCC' },
      device: label('X'),
    });
    const replies = await guesser.poll();
    expect(replies.slice(0, 2)).toEqual([
      { type: 'error', code: 'session-not-found' },
      { type: 'error', code: 'session-not-found' },
    ]);
    expect(replies[2]).toMatchObject({ type: 'error', code: 'rate-limited' });
  });

  it('claims each message number only once', async () => {
    const client = await device();
    expect(await signaling.claimSequence(client.connectionId, 1)).toBe(true);
    expect(await signaling.claimSequence(client.connectionId, 1)).toBe(false);
    expect(await signaling.claimSequence(client.connectionId, 2)).toBe(true);
  });

  it('leaves no state behind once a session ends', async () => {
    const { host, created } = await hostSession('receiver');
    const guest = await device();
    await guest.send({
      type: 'join-session',
      target: { via: 'link', sessionId: created.sessionId },
      device: label('Phone'),
    });
    await host.leave();
    await guest.leave();
    expect(await kv.exists(`sig:s:${created.sessionId}`)).toBe(false);
    expect(await kv.exists(`sig:k:${created.code}`)).toBe(false);
    expect(await kv.exists(`sig:g:${created.sessionId}`)).toBe(false);
  });
});

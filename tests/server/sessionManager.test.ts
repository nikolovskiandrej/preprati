import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionManager,
  randomCode,
  type SignalingPeer,
} from '../../src/server/signaling/sessionManager';
import { PAIRING_CODE_PATTERN } from '../../src/shared/constants';
import type { ServerMessage } from '../../src/shared/signaling';

class FakePeer implements SignalingPeer {
  readonly messages: ServerMessage[] = [];
  constructor(
    readonly connectionId: string,
    readonly ip = '10.0.0.1',
  ) {}
  send(message: ServerMessage) {
    this.messages.push(message);
  }
  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return [...this.messages].reverse().find((m) => m.type === type) as
      Extract<ServerMessage, { type: T }> | undefined;
  }
}

const device = (label: string) => ({ label });

function manager(overrides: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  return new SessionManager({
    pairingTtlMs: 10 * 60_000,
    maxLifetimeMs: 60 * 60_000,
    maxSessions: 100,
    maxSessionsPerIp: 3,
    iceServers: () => [{ urls: 'stun:stun.example.com' }],
    ...overrides,
  });
}

describe('SessionManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('creates a session with an unguessable id and a typable code', () => {
    const sessions = manager();
    const host = new FakePeer('h');
    expect(sessions.createSession(host, 'receiver', device('Mac · Chrome'))).toEqual({ ok: true });
    const created = host.last('session-created')!;
    expect(created.sessionId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.code).toMatch(PAIRING_CODE_PATTERN);
    expect(created.expiresAt).toBe(Date.now() + 10 * 60_000);
  });

  it('pairs a guest joining by link and relays signaling both ways', () => {
    const sessions = manager();
    const host = new FakePeer('h');
    const guest = new FakePeer('g');
    sessions.createSession(host, 'receiver', device('Mac · Chrome'));
    const { sessionId } = host.last('session-created')!;
    expect(
      sessions.joinSession(guest, { via: 'link', sessionId }, device('iPhone · Safari')),
    ).toEqual({ ok: true });
    expect(guest.last('session-joined')).toMatchObject({
      role: 'sender',
      awaitingApproval: false,
      peer: { label: 'Mac · Chrome' },
    });
    expect(host.last('peer-joined')).toMatchObject({
      via: 'link',
      needsApproval: false,
      peer: { label: 'iPhone · Safari' },
    });

    const payload = { kind: 'description', description: { type: 'offer', sdp: 'v=0' } } as const;
    expect(sessions.relay(host, payload)).toEqual({ ok: true });
    expect(guest.last('signal')?.payload).toEqual(payload);
    expect(sessions.relay(guest, { kind: 'candidate', candidate: null })).toEqual({ ok: true });
    expect(host.last('signal')?.payload).toEqual({ kind: 'candidate', candidate: null });
  });

  it('requires host approval when a guest uses the short code to receive files', () => {
    const sessions = manager();
    const host = new FakePeer('h');
    const guest = new FakePeer('g');
    sessions.createSession(host, 'sender', device('Mac'));
    const { code } = host.last('session-created')!;
    sessions.joinSession(guest, { via: 'code', code }, device('Phone'));
    expect(host.last('peer-joined')?.needsApproval).toBe(true);
    expect(guest.last('session-joined')?.awaitingApproval).toBe(true);
    // No signaling may flow before approval.
    expect(sessions.relay(host, { kind: 'candidate', candidate: null })).toEqual({
      ok: false,
      code: 'not-allowed',
    });
    expect(sessions.approvePeer(guest)).toEqual({ ok: false, code: 'not-allowed' }); // only the host approves
    expect(sessions.approvePeer(host)).toEqual({ ok: true });
    expect(guest.last('peer-approved')).toBeDefined();
    expect(sessions.relay(host, { kind: 'candidate', candidate: null })).toEqual({ ok: true });
  });

  it('lets the host decline a device, which frees the session for the right one', () => {
    const sessions = manager();
    const host = new FakePeer('h');
    const intruder = new FakePeer('x');
    const phone = new FakePeer('p');
    sessions.createSession(host, 'sender', device('Mac'));
    const { code } = host.last('session-created')!;
    sessions.joinSession(intruder, { via: 'code', code }, device('Unknown'));
    expect(sessions.declinePeer(host)).toEqual({ ok: true });
    expect(intruder.last('peer-declined')).toBeDefined();
    expect(sessions.relay(intruder, { kind: 'candidate', candidate: null })).toEqual({
      ok: false,
      code: 'not-in-session',
    });
    expect(sessions.joinSession(phone, { via: 'code', code }, device('Phone'))).toEqual({
      ok: true,
    });
  });

  it('rejects unknown sessions, full sessions and double membership', () => {
    const sessions = manager();
    const host = new FakePeer('h');
    sessions.createSession(host, 'receiver', device('A'));
    const { sessionId, code } = host.last('session-created')!;
    expect(
      sessions.joinSession(
        new FakePeer('n'),
        { via: 'link', sessionId: 'AAAAAAAAAAAAAAAAAAAAAA' },
        device('B'),
      ),
    ).toEqual({
      ok: false,
      code: 'session-not-found',
    });
    sessions.joinSession(new FakePeer('g1'), { via: 'link', sessionId }, device('B'));
    expect(sessions.joinSession(new FakePeer('g2'), { via: 'code', code }, device('C'))).toEqual({
      ok: false,
      code: 'session-full',
    });
    expect(sessions.createSession(host, 'sender', device('A'))).toEqual({
      ok: false,
      code: 'already-in-session',
    });
  });

  it('expires a session that nobody joined, but never cuts off a paired one', () => {
    const sessions = manager({ pairingTtlMs: 1000 });
    const lonely = new FakePeer('h1');
    sessions.createSession(lonely, 'receiver', device('A'));
    const paired = new FakePeer('h2', '10.0.0.2');
    const guest = new FakePeer('g');
    sessions.createSession(paired, 'receiver', device('B'));
    sessions.joinSession(
      guest,
      { via: 'link', sessionId: paired.last('session-created')!.sessionId },
      device('C'),
    );

    vi.advanceTimersByTime(1500);
    expect(lonely.last('session-expired')).toBeDefined();
    expect(paired.last('session-expired')).toBeUndefined();
    expect(sessions.sessionCount).toBe(1);
    expect(
      sessions.joinSession(
        new FakePeer('late'),
        { via: 'link', sessionId: lonely.last('session-created')!.sessionId },
        device('D'),
      ),
    ).toEqual({
      ok: false,
      code: 'session-not-found',
    });
  });

  it('closes sessions that exceed the maximum lifetime', () => {
    const sessions = manager({ maxLifetimeMs: 5000 });
    const host = new FakePeer('h');
    sessions.createSession(host, 'receiver', device('A'));
    vi.advanceTimersByTime(5001);
    expect(host.last('session-closed')).toEqual({
      type: 'session-closed',
      reason: 'lifetime-exceeded',
    });
    expect(sessions.sessionCount).toBe(0);
  });

  it('tells the remaining device when the other one leaves and cleans up', () => {
    const sessions = manager();
    const host = new FakePeer('h');
    const guest = new FakePeer('g');
    sessions.createSession(host, 'receiver', device('A'));
    sessions.joinSession(
      guest,
      { via: 'link', sessionId: host.last('session-created')!.sessionId },
      device('B'),
    );
    sessions.leave(guest);
    expect(host.last('peer-left')).toBeDefined();
    expect(sessions.sessionCount).toBe(0);
    sessions.leave(guest); // idempotent
  });

  it('limits concurrent sessions per IP and in total', () => {
    const sessions = manager({ maxSessionsPerIp: 2, maxSessions: 3 });
    expect(sessions.createSession(new FakePeer('a'), 'sender', device('A')).ok).toBe(true);
    expect(sessions.createSession(new FakePeer('b'), 'sender', device('A')).ok).toBe(true);
    expect(sessions.createSession(new FakePeer('c'), 'sender', device('A'))).toEqual({
      ok: false,
      code: 'rate-limited',
    });
    expect(sessions.createSession(new FakePeer('d', '10.9.9.9'), 'sender', device('A')).ok).toBe(
      true,
    );
    expect(sessions.createSession(new FakePeer('e', '10.8.8.8'), 'sender', device('A'))).toEqual({
      ok: false,
      code: 'server-busy',
    });
  });

  it('draws pairing codes uniformly from the unambiguous alphabet', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 3000; i++)
      for (const char of randomCode()) counts.set(char, (counts.get(char) ?? 0) + 1);
    expect([...counts.keys()].every((c) => 'ABCDEFGHJKMNPQRSTVWXYZ23456789'.includes(c))).toBe(
      true,
    );
    expect(counts.size).toBe(30);
  });
});

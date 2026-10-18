/**
 * Quick Transfer pairing sessions.
 *
 * A session has exactly two members: the host (who created it and shows the
 * QR code / pairing code) and one guest. The manager is transport-agnostic —
 * it talks to peers through the small `SignalingPeer` interface, which makes
 * it straightforward to unit-test without sockets.
 *
 * Lifecycle
 *   waiting ──join──▶ paired                      (link join, or code join to a receiving host)
 *   waiting ──join──▶ pending-approval ──approve──▶ paired
 *                                      └─decline──▶ waiting
 *   waiting ──pairing TTL──▶ expired (destroyed)
 *   any ──host/guest leaves──▶ destroyed (the other side gets `peer-left`)
 *   any ──max lifetime──▶ destroyed (`session-closed`)
 *
 * The pairing TTL only applies while waiting for a peer: once two devices are
 * paired, an active transfer is never cut off by the pairing countdown.
 * File contents never pass through here.
 */
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from '../../shared/constants';
import { randomBytes, randomId } from '../../shared/encoding';
import type {
  DeviceInfo,
  IceServerConfig,
  JoinTarget,
  ServerMessage,
  SignalingErrorCode,
  SignalPayload,
  TransferRole,
} from '../../shared/signaling';
import { recoveryStep, sessionTag, type SignalingLog } from './events';

export interface SignalingPeer {
  readonly connectionId: string;
  readonly ip: string;
  send(message: ServerMessage): void;
}

type SessionState = 'waiting' | 'pending-approval' | 'paired';

interface Session {
  id: string;
  code: string;
  hostRole: TransferRole;
  host: SignalingPeer;
  hostDevice: DeviceInfo;
  guest: SignalingPeer | null;
  guestDevice: DeviceInfo | null;
  state: SessionState;
  createdAt: number;
  pairingExpiresAt: number;
  pairingTimer: ReturnType<typeof setTimeout> | null;
  lifetimeTimer: ReturnType<typeof setTimeout>;
}

export interface SessionManagerOptions {
  pairingTtlMs: number;
  maxLifetimeMs: number;
  maxSessions: number;
  maxSessionsPerIp: number;
  iceServers: (sessionId: string) => IceServerConfig[];
  now?: () => number;
  /** Lifecycle events for the server log (see ./events.ts). */
  log?: SignalingLog;
}

export type SessionResult = { ok: true } | { ok: false; code: SignalingErrorCode };

const opposite = (role: TransferRole): TransferRole => (role === 'sender' ? 'receiver' : 'sender');

/** Minimum time a host gets to approve a device that joined with the short code. */
const APPROVAL_WINDOW_MS = 2 * 60_000;

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly byCode = new Map<string, string>();
  private readonly byPeer = new Map<string, Session>();
  private readonly perIp = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: SignalingLog;

  constructor(private readonly options: SessionManagerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  isInSession(peer: SignalingPeer): boolean {
    return this.byPeer.has(peer.connectionId);
  }

  createSession(peer: SignalingPeer, role: TransferRole, device: DeviceInfo): SessionResult {
    if (this.byPeer.has(peer.connectionId)) return { ok: false, code: 'already-in-session' };
    if (this.sessions.size >= this.options.maxSessions) return { ok: false, code: 'server-busy' };
    if ((this.perIp.get(peer.ip) ?? 0) >= this.options.maxSessionsPerIp) {
      return { ok: false, code: 'rate-limited' };
    }

    const now = this.now();
    const id = this.uniqueId();
    const code = this.uniqueCode();
    const session: Session = {
      id,
      code,
      hostRole: role,
      host: peer,
      hostDevice: device,
      guest: null,
      guestDevice: null,
      state: 'waiting',
      createdAt: now,
      pairingExpiresAt: now + this.options.pairingTtlMs,
      pairingTimer: null,
      lifetimeTimer: setTimeout(() => this.closeForLifetime(session), this.options.maxLifetimeMs),
    };
    this.armPairingTimer(session);
    this.sessions.set(id, session);
    this.byCode.set(code, id);
    this.byPeer.set(peer.connectionId, session);
    this.perIp.set(peer.ip, (this.perIp.get(peer.ip) ?? 0) + 1);
    this.log('session-created', { session: sessionTag(id), role, transport: 'websocket' });

    peer.send({
      type: 'session-created',
      sessionId: id,
      code,
      role,
      expiresAt: session.pairingExpiresAt,
      iceServers: this.options.iceServers(id),
    });
    return { ok: true };
  }

  joinSession(peer: SignalingPeer, target: JoinTarget, device: DeviceInfo): SessionResult {
    if (this.byPeer.has(peer.connectionId)) return { ok: false, code: 'already-in-session' };
    const sessionId = target.via === 'link' ? target.sessionId : this.byCode.get(target.code);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      this.log('join-failed', { reason: 'session-not-found' });
      return { ok: false, code: 'session-not-found' };
    }
    if (session.state === 'waiting' && this.now() >= session.pairingExpiresAt) {
      this.log('join-failed', { reason: 'session-expired' });
      this.expire(session);
      return { ok: false, code: 'session-expired' };
    }
    if (session.guest) {
      this.log('join-failed', { session: sessionTag(session.id), reason: 'session-full' });
      return { ok: false, code: 'session-full' };
    }

    const needsApproval = target.via === 'code' && session.hostRole === 'sender';
    session.guest = peer;
    session.guestDevice = device;
    session.state = needsApproval ? 'pending-approval' : 'paired';
    this.byPeer.set(peer.connectionId, session);
    if (!needsApproval) {
      this.clearPairingTimer(session);
    } else {
      // Give the host a fair chance to approve a device that joined just before the deadline.
      const approvalDeadline = this.now() + APPROVAL_WINDOW_MS;
      if (session.pairingExpiresAt < approvalDeadline) {
        session.pairingExpiresAt = approvalDeadline;
        this.armPairingTimer(session);
      }
    }
    this.log('device-joined', {
      session: sessionTag(session.id),
      via: target.via,
      approval: needsApproval,
    });

    peer.send({
      type: 'session-joined',
      sessionId: session.id,
      role: opposite(session.hostRole),
      peer: session.hostDevice,
      awaitingApproval: needsApproval,
      iceServers: this.options.iceServers(session.id),
    });
    session.host.send({ type: 'peer-joined', peer: device, via: target.via, needsApproval });
    return { ok: true };
  }

  approvePeer(peer: SignalingPeer): SessionResult {
    const session = this.byPeer.get(peer.connectionId);
    if (!session) return { ok: false, code: 'not-in-session' };
    if (session.host !== peer || session.state !== 'pending-approval' || !session.guest) {
      return { ok: false, code: 'not-allowed' };
    }
    session.state = 'paired';
    this.clearPairingTimer(session);
    this.log('peer-approved', { session: sessionTag(session.id) });
    session.guest.send({ type: 'peer-approved' });
    return { ok: true };
  }

  declinePeer(peer: SignalingPeer): SessionResult {
    const session = this.byPeer.get(peer.connectionId);
    if (!session) return { ok: false, code: 'not-in-session' };
    if (session.host !== peer || session.state !== 'pending-approval' || !session.guest) {
      return { ok: false, code: 'not-allowed' };
    }
    const guest = session.guest;
    this.byPeer.delete(guest.connectionId);
    session.guest = null;
    session.guestDevice = null;
    session.state = 'waiting';
    this.log('peer-declined', { session: sessionTag(session.id) });
    guest.send({ type: 'peer-declined' });
    // The original pairing window still applies to the next device.
    if (this.now() >= session.pairingExpiresAt) this.expire(session);
    return { ok: true };
  }

  relay(peer: SignalingPeer, payload: SignalPayload): SessionResult {
    const session = this.byPeer.get(peer.connectionId);
    if (!session) return { ok: false, code: 'not-in-session' };
    if (session.state !== 'paired' || !session.guest) return { ok: false, code: 'not-allowed' };
    const target = session.host === peer ? session.guest : session.host;
    const step = recoveryStep(payload);
    if (step) this.log('recovery', { session: sessionTag(session.id), ...step });
    target.send({ type: 'signal', payload });
    return { ok: true };
  }

  /**
   * Called on explicit leave (`left`) and when a socket closes: `left` for a
   * normal close (page closed, session ended), `gone` when it dropped.
   * Idempotent.
   */
  leave(peer: SignalingPeer, reason: 'left' | 'gone' = 'left'): void {
    const session = this.byPeer.get(peer.connectionId);
    if (!session) return;
    const other = session.host === peer ? session.guest : session.host;
    this.log('peer-left', {
      session: sessionTag(session.id),
      reason,
      by: session.host === peer ? 'host' : 'guest',
    });
    if (session.host !== peer && session.state === 'pending-approval') {
      // A guest awaiting approval walked away: let the next device join.
      this.byPeer.delete(peer.connectionId);
      session.guest = null;
      session.guestDevice = null;
      session.state = 'waiting';
      session.host.send({ type: 'peer-left', reason });
      if (this.now() >= session.pairingExpiresAt) this.expire(session);
      return;
    }
    other?.send({ type: 'peer-left', reason });
    this.destroy(session);
  }

  /** Closes everything (server shutdown). */
  shutdown(): void {
    for (const session of [...this.sessions.values()]) {
      session.host.send({ type: 'session-closed', reason: 'server-shutdown' });
      session.guest?.send({ type: 'session-closed', reason: 'server-shutdown' });
      this.destroy(session);
    }
  }

  private expire(session: Session): void {
    this.log('session-expired', { session: sessionTag(session.id) });
    session.host.send({ type: 'session-expired' });
    session.guest?.send({ type: 'session-expired' });
    this.destroy(session);
  }

  private closeForLifetime(session: Session): void {
    if (!this.sessions.has(session.id)) return;
    this.log('session-closed', { session: sessionTag(session.id), reason: 'lifetime-exceeded' });
    session.host.send({ type: 'session-closed', reason: 'lifetime-exceeded' });
    session.guest?.send({ type: 'session-closed', reason: 'lifetime-exceeded' });
    this.destroy(session);
  }

  private armPairingTimer(session: Session): void {
    this.clearPairingTimer(session);
    const delay = Math.max(0, session.pairingExpiresAt - this.now());
    session.pairingTimer = setTimeout(() => {
      session.pairingTimer = null;
      if (this.sessions.has(session.id) && session.state !== 'paired') this.expire(session);
    }, delay);
  }

  private clearPairingTimer(session: Session): void {
    if (session.pairingTimer) clearTimeout(session.pairingTimer);
    session.pairingTimer = null;
  }

  private destroy(session: Session): void {
    if (!this.sessions.delete(session.id)) return;
    this.clearPairingTimer(session);
    clearTimeout(session.lifetimeTimer);
    this.byCode.delete(session.code);
    this.byPeer.delete(session.host.connectionId);
    if (session.guest) this.byPeer.delete(session.guest.connectionId);
    const count = (this.perIp.get(session.host.ip) ?? 1) - 1;
    if (count <= 0) this.perIp.delete(session.host.ip);
    else this.perIp.set(session.host.ip, count);
  }

  private uniqueId(): string {
    let id = randomId();
    while (this.sessions.has(id)) id = randomId();
    return id;
  }

  private uniqueCode(): string {
    for (;;) {
      const code = randomCode();
      if (!this.byCode.has(code)) return code;
    }
  }
}

/** Uniformly random pairing code (rejection sampling avoids modulo bias). */
export function randomCode(): string {
  const alphabet = PAIRING_CODE_ALPHABET;
  const limit = 256 - (256 % alphabet.length);
  let code = '';
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const byte of randomBytes(PAIRING_CODE_LENGTH * 2)) {
      if (byte < limit) code += alphabet[byte % alphabet.length];
      if (code.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return code;
}

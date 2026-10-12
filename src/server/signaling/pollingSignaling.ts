/**
 * Signaling over plain HTTP for serverless platforms (e.g. Vercel), where two
 * devices' requests may be served by different function instances.
 *
 * It implements the same session state machine and the same server messages
 * as the WebSocket `SessionManager`, but keeps all state in a shared KvStore:
 *
 *   sig:c:<conn>   connection (token hash, IP, session membership) — TTL = presence window
 *   sig:i:<conn>   inbox of numbered ServerMessages for that connection
 *   sig:n:<conn>   the inbox's message counter
 *   sig:s:<id>     session (host, role, code, pairing deadline)    — TTL = max lifetime
 *   sig:g:<id>     guest slot, claimed atomically with SET NX
 *   sig:a:<id>     "approved" flag (paired)
 *   sig:k:<code>   pairing code → session id
 *   sig:q:<conn>:<n>  "message n already handled" (makes retried sends idempotent)
 *
 * Clients send messages with POST and fetch their inbox by polling. Inbox
 * messages are numbered and stay queued until the client acknowledges them
 * (`ack` on its next request), so a response lost on a flaky mobile network
 * is delivered again instead of silently dropping an offer or a candidate.
 * There are no timers: pairing expiry and vanished peers are detected lazily
 * when the remaining device polls. Every key has a TTL, so abandoned state
 * disappears.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { randomId, randomSecret } from '../../shared/encoding';
import type {
  ClientMessage,
  DeviceInfo,
  IceServerConfig,
  JoinTarget,
  ServerMessage,
  SignalingErrorCode,
  SignalPayload,
  TransferRole,
} from '../../shared/signaling';
import type { KvStore } from '../kv';
import { randomCode } from './sessionManager';

interface ConnRecord {
  id: string;
  tokenHash: string;
  ip: string;
  sessionId: string | null;
  role: 'host' | 'guest' | null;
}

interface SessionRecord {
  id: string;
  code: string;
  hostRole: TransferRole;
  hostConn: string;
  hostDevice: DeviceInfo;
  createdAt: number;
  pairingExpiresAt: number;
}

interface GuestRecord {
  conn: string;
  device: DeviceInfo;
  via: 'link' | 'code';
}

export interface PollingSignalingOptions {
  pairingTtlMs: number;
  maxLifetimeMs: number;
  /** A connection that has not polled for this long is considered gone. */
  presenceTtlMs?: number;
  maxSessionsPerIpPer10Min: number;
  joinFailuresPer10Min: number;
  iceServers: (sessionId: string) => IceServerConfig[];
  now?: () => number;
}

const APPROVAL_WINDOW_MS = 2 * 60_000;
const INBOX_TTL_MS = 10 * 60_000;
const WINDOW_10_MIN = 10 * 60_000;

const opposite = (role: TransferRole): TransferRole => (role === 'sender' ? 'receiver' : 'sender');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

const K = {
  conn: (id: string) => `sig:c:${id}`,
  inbox: (id: string) => `sig:i:${id}`,
  counter: (id: string) => `sig:n:${id}`,
  session: (id: string) => `sig:s:${id}`,
  guest: (id: string) => `sig:g:${id}`,
  approved: (id: string) => `sig:a:${id}`,
  code: (code: string) => `sig:k:${code}`,
  sequence: (id: string, seq: number) => `sig:q:${id}:${seq}`,
  createdBy: (ip: string) => `sig:rl:create:${ip}`,
  joinFailures: (ip: string) => `sig:rl:join:${ip}`,
};

/** Inbox messages for one connection; message `i` has number `firstSeq + i`. */
export interface InboxBatch {
  messages: ServerMessage[];
  firstSeq: number;
}

export class PollingSignaling {
  private readonly now: () => number;
  private readonly presenceTtlMs: number;

  constructor(
    private readonly kv: KvStore,
    private readonly options: PollingSignalingOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.presenceTtlMs = options.presenceTtlMs ?? 150_000;
  }

  /** Registers a new client connection and returns its credentials. */
  async connect(ip: string): Promise<{ connectionId: string; token: string }> {
    const connectionId = randomId();
    const token = randomSecret();
    const record: ConnRecord = {
      id: connectionId,
      tokenHash: hash(token),
      ip,
      sessionId: null,
      role: null,
    };
    await this.kv.setJson(K.conn(connectionId), record, { ttlMs: this.presenceTtlMs });
    return { connectionId, token };
  }

  /** Validates credentials and refreshes the connection's presence. */
  async authenticate(connectionId: string, token: string): Promise<ConnRecord | null> {
    if (!/^[A-Za-z0-9_-]{22}$/.test(connectionId) || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return null;
    const record = await this.kv.getJson<ConnRecord>(K.conn(connectionId), {
      refreshTtlMs: this.presenceTtlMs,
    });
    if (!record) return null;
    const expected = Buffer.from(record.tokenHash, 'hex');
    const actual = Buffer.from(hash(token), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return record;
  }

  /**
   * Returns true the first time a connection's message number `seq` is seen.
   * A client that retries a send whose response was lost must not create a
   * second session or deliver an offer twice.
   */
  claimSequence(connectionId: string, seq: number): Promise<boolean> {
    return this.kv.setJson(K.sequence(connectionId, seq), 1, {
      ttlMs: INBOX_TTL_MS,
      ifNotExists: true,
    });
  }

  /** Handles one client message; replies are queued in the relevant inboxes. */
  async handle(conn: ConnRecord, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'ping':
        return this.send(conn.id, { type: 'pong' });
      case 'create-session':
        return this.createSession(conn, message.role, message.device);
      case 'join-session':
        return this.joinSession(conn, message.target, message.device);
      case 'approve-peer':
        return this.approve(conn);
      case 'decline-peer':
        return this.decline(conn);
      case 'signal':
        return this.relay(conn, message.payload);
      case 'leave-session':
        return this.leave(conn);
    }
  }

  /** Lazily applies expiry/departure rules, then reads the inbox (see `read`). */
  async poll(conn: ConnRecord, ack: number | null = null): Promise<InboxBatch> {
    if (conn.sessionId) await this.checkSession(conn);
    return this.read(conn.id, ack);
  }

  /**
   * Returns the inbox messages numbered above `ack` and forgets those up to
   * it. Without an acknowledgement (older clients) returned messages are
   * removed right away.
   */
  async read(connectionId: string, ack: number | null = null): Promise<InboxBatch> {
    const { first, items } = await this.kv.inboxRead<ServerMessage>(
      K.inbox(connectionId),
      K.counter(connectionId),
      ack,
      INBOX_TTL_MS,
    );
    return { messages: items, firstSeq: first };
  }

  /** Queues an error for a connection (e.g. a message that failed validation). */
  reportError(connectionId: string, code: SignalingErrorCode): Promise<void> {
    return this.send(connectionId, { type: 'error', code });
  }

  /** The client is going away for good (tab closed, session ended). */
  async disconnect(conn: ConnRecord): Promise<void> {
    await this.leave(conn);
    await this.kv.del(K.conn(conn.id), K.inbox(conn.id), K.counter(conn.id));
  }

  /* ------------------------------------------------------------------------ */

  private async createSession(
    conn: ConnRecord,
    role: TransferRole,
    device: DeviceInfo,
  ): Promise<void> {
    if (conn.sessionId) return this.error(conn, 'already-in-session');
    const created = await this.kv.incrBy(K.createdBy(conn.ip), 1, WINDOW_10_MIN);
    if (created > this.options.maxSessionsPerIpPer10Min) return this.error(conn, 'rate-limited');

    const now = this.now();
    const id = randomId();
    let code: string | null = null;
    for (let attempt = 0; attempt < 6 && !code; attempt++) {
      const candidate = randomCode();
      const claimed = await this.kv.setJson(K.code(candidate), id, {
        ttlMs: this.options.pairingTtlMs + APPROVAL_WINDOW_MS,
        ifNotExists: true,
      });
      if (claimed) code = candidate;
    }
    if (!code) return this.error(conn, 'server-busy');

    const session: SessionRecord = {
      id,
      code,
      hostRole: role,
      hostConn: conn.id,
      hostDevice: device,
      createdAt: now,
      pairingExpiresAt: now + this.options.pairingTtlMs,
    };
    await this.kv.setJson(K.session(id), session, { ttlMs: this.options.maxLifetimeMs });
    await this.saveConn({ ...conn, sessionId: id, role: 'host' });
    await this.send(conn.id, {
      type: 'session-created',
      sessionId: id,
      code,
      role,
      expiresAt: session.pairingExpiresAt,
      iceServers: this.options.iceServers(id),
    });
  }

  private async joinSession(
    conn: ConnRecord,
    target: JoinTarget,
    device: DeviceInfo,
  ): Promise<void> {
    if (conn.sessionId) return this.error(conn, 'already-in-session');
    const failures = (await this.kv.getJson<number>(K.joinFailures(conn.ip))) ?? 0;
    if (failures >= this.options.joinFailuresPer10Min)
      return this.send(conn.id, { type: 'error', code: 'rate-limited', retryAfterMs: 60_000 });

    const sessionId =
      target.via === 'link' ? target.sessionId : await this.kv.getJson<string>(K.code(target.code));
    const session = sessionId ? await this.kv.getJson<SessionRecord>(K.session(sessionId)) : null;
    if (!session) return this.joinFailed(conn, 'session-not-found');

    const existingGuest = await this.kv.getJson<GuestRecord>(K.guest(session.id));
    if (!existingGuest && this.now() >= session.pairingExpiresAt) {
      await this.expire(session);
      return this.joinFailed(conn, 'session-expired');
    }
    const needsApproval = target.via === 'code' && session.hostRole === 'sender';
    const claimed = await this.kv.setJson(
      K.guest(session.id),
      { conn: conn.id, device, via: target.via } satisfies GuestRecord,
      { ifNotExists: true, ttlMs: this.options.maxLifetimeMs },
    );
    if (!claimed) return this.error(conn, 'session-full');

    if (!needsApproval) {
      await this.kv.setJson(K.approved(session.id), true, { ttlMs: this.options.maxLifetimeMs });
    } else {
      const approvalDeadline = this.now() + APPROVAL_WINDOW_MS;
      if (session.pairingExpiresAt < approvalDeadline) {
        await this.kv.setJson(
          K.session(session.id),
          { ...session, pairingExpiresAt: approvalDeadline },
          { ttlMs: this.options.maxLifetimeMs },
        );
      }
    }
    await this.saveConn({ ...conn, sessionId: session.id, role: 'guest' });
    await this.send(conn.id, {
      type: 'session-joined',
      sessionId: session.id,
      role: opposite(session.hostRole),
      peer: session.hostDevice,
      awaitingApproval: needsApproval,
      iceServers: this.options.iceServers(session.id),
    });
    await this.send(session.hostConn, {
      type: 'peer-joined',
      peer: device,
      via: target.via,
      needsApproval,
    });
  }

  private async approve(conn: ConnRecord): Promise<void> {
    const context = await this.hostContext(conn);
    if (!context) return;
    const { session, guest } = context;
    if (!guest || (await this.kv.exists(K.approved(session.id))))
      return this.error(conn, 'not-allowed');
    await this.kv.setJson(K.approved(session.id), true, { ttlMs: this.options.maxLifetimeMs });
    await this.send(guest.conn, { type: 'peer-approved' });
  }

  private async decline(conn: ConnRecord): Promise<void> {
    const context = await this.hostContext(conn);
    if (!context) return;
    const { session, guest } = context;
    if (!guest || (await this.kv.exists(K.approved(session.id))))
      return this.error(conn, 'not-allowed');
    await this.removeGuest(session, guest);
    await this.send(guest.conn, { type: 'peer-declined' });
    if (this.now() >= session.pairingExpiresAt) await this.expire(session);
  }

  private async relay(conn: ConnRecord, payload: SignalPayload): Promise<void> {
    if (!conn.sessionId) return this.error(conn, 'not-in-session');
    const session = await this.kv.getJson<SessionRecord>(K.session(conn.sessionId));
    if (!session) return this.error(conn, 'not-in-session');
    const guest = await this.kv.getJson<GuestRecord>(K.guest(session.id));
    if (!guest || !(await this.kv.exists(K.approved(session.id))))
      return this.error(conn, 'not-allowed');
    const target = conn.id === session.hostConn ? guest.conn : session.hostConn;
    await this.send(target, { type: 'signal', payload });
  }

  private async leave(conn: ConnRecord): Promise<void> {
    if (!conn.sessionId) return;
    const session = await this.kv.getJson<SessionRecord>(K.session(conn.sessionId));
    await this.saveConn({ ...conn, sessionId: null, role: null });
    if (!session) return;
    const guest = await this.kv.getJson<GuestRecord>(K.guest(session.id));
    const approved = await this.kv.exists(K.approved(session.id));
    if (conn.id !== session.hostConn && !approved && guest?.conn === conn.id) {
      // A guest awaiting approval walked away: the next device may join.
      await this.kv.del(K.guest(session.id));
      await this.send(session.hostConn, { type: 'peer-left', reason: 'left' });
      return;
    }
    const other = conn.id === session.hostConn ? guest?.conn : session.hostConn;
    if (other) await this.send(other, { type: 'peer-left', reason: 'left' });
    await this.destroy(session, guest);
  }

  /** Detects pairing expiry and vanished peers for the polling connection. */
  private async checkSession(conn: ConnRecord): Promise<void> {
    const id = conn.sessionId!;
    const [session, guest, approved] = (await this.kv.getMany([
      K.session(id),
      K.guest(id),
      K.approved(id),
    ])) as [SessionRecord | null, GuestRecord | null, true | null];
    if (!session) {
      await this.saveConn({ ...conn, sessionId: null, role: null });
      return;
    }
    // Until the devices are paired, the pairing deadline applies — also while a code join
    // waits for the host's approval (the WebSocket SessionManager does the same with a timer).
    if (!approved && this.now() >= session.pairingExpiresAt) {
      await this.expire(session);
      return;
    }
    if (conn.id === session.hostConn) {
      if (!guest) return;
      if (!(await this.kv.exists(K.conn(guest.conn)))) {
        if (approved) {
          await this.send(conn.id, { type: 'peer-left', reason: 'gone' });
          await this.destroy(session, guest);
        } else {
          await this.removeGuest(session, guest);
          await this.send(conn.id, { type: 'peer-left', reason: 'gone' });
        }
      }
      return;
    }
    if (!(await this.kv.exists(K.conn(session.hostConn)))) {
      await this.send(conn.id, { type: 'peer-left', reason: 'gone' });
      await this.destroy(session, guest);
    }
  }

  private async hostContext(
    conn: ConnRecord,
  ): Promise<{ session: SessionRecord; guest: GuestRecord | null } | null> {
    if (!conn.sessionId) {
      await this.error(conn, 'not-in-session');
      return null;
    }
    const session = await this.kv.getJson<SessionRecord>(K.session(conn.sessionId));
    if (!session) {
      await this.error(conn, 'not-in-session');
      return null;
    }
    if (session.hostConn !== conn.id) {
      await this.error(conn, 'not-allowed');
      return null;
    }
    return { session, guest: await this.kv.getJson<GuestRecord>(K.guest(session.id)) };
  }

  private async removeGuest(session: SessionRecord, guest: GuestRecord): Promise<void> {
    await this.kv.del(K.guest(session.id));
    const guestConn = await this.kv.getJson<ConnRecord>(K.conn(guest.conn));
    if (guestConn) await this.saveConn({ ...guestConn, sessionId: null, role: null });
  }

  private async expire(session: SessionRecord): Promise<void> {
    const guest = await this.kv.getJson<GuestRecord>(K.guest(session.id));
    await this.send(session.hostConn, { type: 'session-expired' });
    if (guest) await this.send(guest.conn, { type: 'session-expired' });
    await this.destroy(session, guest);
  }

  private async destroy(session: SessionRecord, guest: GuestRecord | null): Promise<void> {
    await this.kv.del(
      K.session(session.id),
      K.guest(session.id),
      K.approved(session.id),
      K.code(session.code),
    );
    for (const id of [session.hostConn, guest?.conn]) {
      if (!id) continue;
      const record = await this.kv.getJson<ConnRecord>(K.conn(id));
      if (record?.sessionId === session.id)
        await this.saveConn({ ...record, sessionId: null, role: null });
    }
  }

  private async joinFailed(
    conn: ConnRecord,
    code: 'session-not-found' | 'session-expired',
  ): Promise<void> {
    await this.kv.incrBy(K.joinFailures(conn.ip), 1, WINDOW_10_MIN);
    await this.error(conn, code);
  }

  private async saveConn(record: ConnRecord): Promise<void> {
    await this.kv.setJson(K.conn(record.id), record, { ttlMs: this.presenceTtlMs });
  }

  private async send(connectionId: string, message: ServerMessage): Promise<void> {
    await this.kv.inboxPush(K.inbox(connectionId), K.counter(connectionId), message, INBOX_TTL_MS);
  }

  private error(conn: ConnRecord, code: SignalingErrorCode): Promise<void> {
    return this.send(conn.id, { type: 'error', code });
  }
}

export type { ConnRecord as PollingConnection };

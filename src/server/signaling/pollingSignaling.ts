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
 *   sig:s:<id>     session (host, role, code, pairing deadline, locked) — TTL = max lifetime
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
 *
 * A guest that leaves (or goes silent) before any files moved doesn't end the
 * session: it waits for another device again, with the same link and code —
 * a link opened first in an app's built-in browser, a reloaded page, or the
 * wrong device must not use it up. Once the host reports that files are
 * moving (`lock-session`), the guest's departure ends the session, so one
 * link never delivers the files to a second device.
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
import { recoveryStep, sessionTag, type SignalingLog } from './events';
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
  /** Files have moved: the guest's departure ends the session. */
  locked?: boolean;
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
  /** Lifecycle events for the server log (see ./events.ts). */
  log?: SignalingLog;
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

/** One message of a client's batch, with its per-connection number (if the client sent one). */
export interface NumberedMessage {
  seq: number | null;
  message: ClientMessage;
}

/** Where a session member's signals go, looked up once per batch. */
interface RelayTarget {
  sessionId: string;
  target: string;
}

export class PollingSignaling {
  private readonly now: () => number;
  private readonly presenceTtlMs: number;
  private readonly log: SignalingLog;

  constructor(
    private readonly kv: KvStore,
    private readonly options: PollingSignalingOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.presenceTtlMs = options.presenceTtlMs ?? 150_000;
    this.log = options.log ?? (() => undefined);
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

  /**
   * Handles one client message; replies are queued in the relevant inboxes.
   * Returns the connection as it is afterwards (creating, joining or leaving
   * a session changes its membership).
   */
  async handle(conn: ConnRecord, message: ClientMessage): Promise<ConnRecord> {
    switch (message.type) {
      case 'ping':
        await this.send(conn.id, { type: 'pong' });
        return conn;
      case 'create-session':
        return this.createSession(conn, message.role, message.device);
      case 'join-session':
        return this.joinSession(conn, message.target, message.device);
      case 'approve-peer':
        await this.approve(conn);
        return conn;
      case 'decline-peer':
        await this.decline(conn);
        return conn;
      case 'lock-session':
        await this.lock(conn);
        return conn;
      case 'signal':
        await this.relay(conn, message.payload);
        return conn;
      case 'leave-session':
        await this.leave(conn);
        return { ...conn, sessionId: null, role: null };
    }
  }

  /**
   * Handles a client's messages in order, each once: a message whose number
   * was already handled (a retried request) is skipped. Consecutive signals
   * share one lookup of where they go, so a batch of ICE candidates costs
   * little more than one.
   */
  async handleBatch(conn: ConnRecord, batch: NumberedMessage[]): Promise<void> {
    let current = conn;
    let target: RelayTarget | null = null;
    for (const { seq, message } of batch) {
      if (seq !== null && !(await this.claimSequence(current.id, seq))) continue;
      if (message.type !== 'signal') {
        target = null;
        current = await this.handle(current, message);
        continue;
      }
      if (!target || target.sessionId !== current.sessionId) {
        target = await this.relayTarget(current);
        if (!target) continue; // the error is queued for the client
      }
      this.logRecovery(target.sessionId, message.payload);
      await this.send(target.target, { type: 'signal', payload: message.payload });
    }
  }

  private logRecovery(sessionId: string, payload: SignalPayload): void {
    const step = recoveryStep(payload);
    if (step) this.log('recovery', { session: sessionTag(sessionId), ...step });
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
  ): Promise<ConnRecord> {
    if (conn.sessionId) return this.fail(conn, 'already-in-session');
    const created = await this.kv.incrBy(K.createdBy(conn.ip), 1, WINDOW_10_MIN);
    if (created > this.options.maxSessionsPerIpPer10Min) return this.fail(conn, 'rate-limited');

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
    if (!code) return this.fail(conn, 'server-busy');

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
    const joined: ConnRecord = { ...conn, sessionId: id, role: 'host' };
    await this.saveConn(joined);
    this.log('session-created', { session: sessionTag(id), role, transport: 'http' });
    await this.send(conn.id, {
      type: 'session-created',
      sessionId: id,
      code,
      role,
      expiresAt: session.pairingExpiresAt,
      iceServers: this.options.iceServers(id),
    });
    return joined;
  }

  private async joinSession(
    conn: ConnRecord,
    target: JoinTarget,
    device: DeviceInfo,
  ): Promise<ConnRecord> {
    if (conn.sessionId) return this.fail(conn, 'already-in-session');
    const failures = (await this.kv.getJson<number>(K.joinFailures(conn.ip))) ?? 0;
    if (failures >= this.options.joinFailuresPer10Min) {
      await this.send(conn.id, { type: 'error', code: 'rate-limited', retryAfterMs: 60_000 });
      return conn;
    }

    const sessionId =
      target.via === 'link' ? target.sessionId : await this.kv.getJson<string>(K.code(target.code));
    const session = sessionId ? await this.kv.getJson<SessionRecord>(K.session(sessionId)) : null;
    if (!session) {
      await this.joinFailed(conn, 'session-not-found');
      return conn;
    }

    const existingGuest = await this.kv.getJson<GuestRecord>(K.guest(session.id));
    if (!existingGuest && this.now() >= session.pairingExpiresAt) {
      await this.expire(session);
      await this.joinFailed(conn, 'session-expired');
      return conn;
    }
    const needsApproval = target.via === 'code' && session.hostRole === 'sender';
    const claimed = await this.kv.setJson(
      K.guest(session.id),
      { conn: conn.id, device, via: target.via } satisfies GuestRecord,
      { ifNotExists: true, ttlMs: this.options.maxLifetimeMs },
    );
    if (!claimed) {
      this.log('join-failed', { session: sessionTag(session.id), reason: 'session-full' });
      return this.fail(conn, 'session-full');
    }

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
    const joined: ConnRecord = { ...conn, sessionId: session.id, role: 'guest' };
    await this.saveConn(joined);
    this.log('device-joined', {
      session: sessionTag(session.id),
      via: target.via,
      approval: needsApproval,
    });
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
    return joined;
  }

  private async approve(conn: ConnRecord): Promise<void> {
    const context = await this.hostContext(conn);
    if (!context) return;
    const { session, guest } = context;
    if (!guest || (await this.kv.exists(K.approved(session.id))))
      return this.error(conn, 'not-allowed');
    await this.kv.setJson(K.approved(session.id), true, { ttlMs: this.options.maxLifetimeMs });
    this.log('peer-approved', { session: sessionTag(session.id) });
    await this.send(guest.conn, { type: 'peer-approved' });
  }

  private async decline(conn: ConnRecord): Promise<void> {
    const context = await this.hostContext(conn);
    if (!context) return;
    const { session, guest } = context;
    if (!guest || (await this.kv.exists(K.approved(session.id))))
      return this.error(conn, 'not-allowed');
    await this.removeGuest(session, guest);
    this.log('peer-declined', { session: sessionTag(session.id) });
    await this.send(guest.conn, { type: 'peer-declined' });
    if (this.now() >= session.pairingExpiresAt) await this.expire(session);
  }

  private async lock(conn: ConnRecord): Promise<void> {
    const context = await this.hostContext(conn);
    if (!context || context.session.locked) return;
    await this.kv.setJson(
      K.session(context.session.id),
      { ...context.session, locked: true },
      { ttlMs: this.options.maxLifetimeMs },
    );
    this.log('session-locked', { session: sessionTag(context.session.id) });
  }

  private async relay(conn: ConnRecord, payload: SignalPayload): Promise<void> {
    const target = await this.relayTarget(conn);
    if (!target) return;
    this.logRecovery(target.sessionId, payload);
    await this.send(target.target, { type: 'signal', payload });
  }

  /** The other member of a paired session, or null (with an error queued for the client). */
  private async relayTarget(conn: ConnRecord): Promise<RelayTarget | null> {
    if (!conn.sessionId) {
      await this.error(conn, 'not-in-session');
      return null;
    }
    const [session, guest, approved] = (await this.kv.getMany([
      K.session(conn.sessionId),
      K.guest(conn.sessionId),
      K.approved(conn.sessionId),
    ])) as [SessionRecord | null, GuestRecord | null, true | null];
    if (!session) {
      await this.error(conn, 'not-in-session');
      return null;
    }
    // Only the two members of a paired session exchange signals.
    const member = conn.id === session.hostConn || conn.id === guest?.conn;
    if (!guest || !approved || !member) {
      await this.error(conn, 'not-allowed');
      return null;
    }
    return {
      sessionId: session.id,
      target: conn.id === session.hostConn ? guest.conn : session.hostConn,
    };
  }

  private async leave(conn: ConnRecord): Promise<void> {
    if (!conn.sessionId) return;
    const session = await this.kv.getJson<SessionRecord>(K.session(conn.sessionId));
    await this.saveConn({ ...conn, sessionId: null, role: null });
    if (!session) return;
    const guest = await this.kv.getJson<GuestRecord>(K.guest(session.id));
    const approved = await this.kv.exists(K.approved(session.id));
    const by = conn.id === session.hostConn ? 'host' : 'guest';
    this.log('peer-left', { session: sessionTag(session.id), reason: 'left', by });
    if (conn.id !== session.hostConn && !approved && guest?.conn === conn.id) {
      // A guest awaiting approval walked away: the next device may join.
      await this.kv.del(K.guest(session.id));
      await this.send(session.hostConn, { type: 'peer-left', reason: 'left' });
      return;
    }
    if (conn.id !== session.hostConn && guest?.conn === conn.id && !session.locked) {
      await this.reopen(session, guest, 'left');
      return;
    }
    const other = conn.id === session.hostConn ? guest?.conn : session.hostConn;
    if (other) await this.send(other, { type: 'peer-left', reason: 'left' });
    await this.destroy(session, guest);
  }

  /**
   * The guest left before any files moved: the session waits for another
   * device again, with the same link and code and a fresh pairing window.
   */
  private async reopen(
    session: SessionRecord,
    guest: GuestRecord,
    reason: 'left' | 'gone',
  ): Promise<void> {
    const pairingExpiresAt = Math.max(
      session.pairingExpiresAt,
      this.now() + this.options.pairingTtlMs,
    );
    await this.removeGuest(session, guest);
    await this.kv.del(K.approved(session.id));
    await this.kv.setJson(
      K.session(session.id),
      { ...session, pairingExpiresAt },
      { ttlMs: this.options.maxLifetimeMs },
    );
    await this.kv.setJson(K.code(session.code), session.id, {
      ttlMs: pairingExpiresAt - this.now() + APPROVAL_WINDOW_MS,
    });
    this.log('session-reopened', { session: sessionTag(session.id), reason });
    await this.send(session.hostConn, {
      type: 'peer-left',
      reason,
      expiresAt: pairingExpiresAt,
    });
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
        this.log('peer-left', { session: sessionTag(id), reason: 'gone', by: 'guest' });
        if (approved && !session.locked) {
          await this.reopen(session, guest, 'gone');
        } else if (approved) {
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
      this.log('peer-left', { session: sessionTag(id), reason: 'gone', by: 'host' });
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
    this.log('session-expired', { session: sessionTag(session.id) });
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
    this.log('join-failed', { reason: code });
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

  /** Queues an error and leaves the connection as it was. */
  private async fail(conn: ConnRecord, code: SignalingErrorCode): Promise<ConnRecord> {
    await this.error(conn, code);
    return conn;
  }
}

export type { ConnRecord as PollingConnection };

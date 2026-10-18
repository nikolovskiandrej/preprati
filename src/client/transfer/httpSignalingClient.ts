/**
 * Signaling over HTTP polling, for deployments on serverless platforms where
 * long-lived WebSockets are not a good fit. Same messages as the WebSocket
 * transport (see src/shared/signaling.ts).
 *
 * - Outgoing messages are POSTed strictly in order (an offer must arrive
 *   before its ICE candidates). Whatever queued up while a request was in
 *   flight goes out together in the next one, so a burst of ICE candidates
 *   costs one or two round trips instead of one each. Each response carries
 *   any queued replies.
 * - Incoming messages are numbered by the server and stay queued until a
 *   later request acknowledges them (`X-Signal-Ack`). A response lost on a
 *   flaky network is therefore delivered again, and duplicates from
 *   overlapping requests are skipped: every message is handled once, in order.
 * - The inbox is polled every 400 ms while messages are flowing; otherwise at
 *   the pace QuickSession sets: 1.5 s while pairing, a steady 1 s during a
 *   relay-mode transfer (its progress messages would otherwise keep the fast
 *   pace going for minutes), 5 s after a failed attempt, 15 s once the
 *   devices talk directly (presence only).
 * - A page that comes back to the foreground checks right away: phones pause
 *   timers in the background.
 * - Closing the page sends a `sendBeacon` disconnect so the other device
 *   learns right away; otherwise the server notices after a few minutes. A
 *   page kept in the back/forward cache is disconnected the same way and
 *   reports the closed channel, so it never comes back showing a session the
 *   server has already ended.
 */
import {
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '../../shared/signaling';
import { apiBaseUrl } from '../lib/env';
import type { SignalingCloseReason, SignalingPace, SignalingTransport } from './signalingClient';

const ACTIVE_INTERVAL_MS = 400;
const ACTIVE_WINDOW_MS = 6000;
const PACE_INTERVAL_MS: Record<SignalingPace, number> = {
  normal: 1500,
  live: 1000,
  standby: 5000,
  quiet: 15_000,
};
const MAX_CONSECUTIVE_FAILURES = 8;
/** Most messages per request (the server's limit) and their combined size. */
const MAX_BATCH_MESSAGES = 32;
const MAX_BATCH_CHARS = 56 * 1024;

interface Credentials {
  connectionId: string;
  token: string;
}

interface Batch {
  messages: unknown[];
  firstSeq: number;
}

export class HttpSignalingClient implements SignalingTransport {
  private credentials: Credentials | null = null;
  private readonly messageListeners = new Set<(message: ServerMessage) => void>();
  private readonly closeListeners = new Set<(reason: SignalingCloseReason) => void>();
  private outbox: { seq: number; message: ClientMessage }[] = [];
  private nextSeq = 1;
  /** Number of the last inbox message handled (acknowledged on every request). */
  private lastReceived = 0;
  private sending = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private failures = 0;
  private lastActivity = 0;
  private pace: SignalingPace = 'normal';
  private closed = false;

  constructor(private readonly baseUrl: string = apiBaseUrl()) {}

  async connect(timeoutMs = 10_000): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/signal/connect`, {
        method: 'POST',
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error(`Signaling unavailable (${response.status})`);
      const body = (await response.json()) as Credentials;
      if (typeof body.connectionId !== 'string' || typeof body.token !== 'string')
        throw new Error('Invalid response');
      this.credentials = body;
    } finally {
      clearTimeout(timer);
    }
    this.lastActivity = Date.now();
    window.addEventListener('pagehide', this.handlePageHide);
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.schedulePoll(0);
  }

  get isOpen(): boolean {
    return !this.closed && this.credentials !== null;
  }

  send(message: ClientMessage): boolean {
    if (!this.isOpen) return false;
    this.outbox.push({ seq: this.nextSeq++, message });
    this.lastActivity = Date.now();
    void this.flush();
    return true;
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (reason: SignalingCloseReason) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Polls faster or slower; switching to a faster pace checks right away. */
  setPace(pace: SignalingPace): void {
    const faster = PACE_INTERVAL_MS[pace] < PACE_INTERVAL_MS[this.pace];
    this.pace = pace;
    if (faster && !this.polling) this.schedulePoll(0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.beaconDisconnect();
    this.messageListeners.clear();
    this.closeListeners.clear();
  }

  /* ------------------------------------------------------------------------ */

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.credentials!.token}`,
      'X-Signal-Connection': this.credentials!.connectionId,
      'X-Signal-Ack': String(this.lastReceived),
    };
  }

  private async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.outbox.length > 0 && this.isOpen) {
        const count = this.batchSize();
        const messages = this.outbox.slice(0, count).map((entry) => entry.message);
        // A retried request keeps its numbers, so the server skips what it already handled.
        const replies = await this.request(
          'POST',
          '/api/signal/send',
          count === 1 ? messages[0] : messages,
          { 'X-Signal-Seq': String(this.outbox[0]!.seq) },
        );
        if (replies === null) return; // failure handling scheduled a retry or closed
        this.outbox.splice(0, count);
        this.deliver(replies);
      }
    } finally {
      this.sending = false;
    }
  }

  /** How many queued messages fit into the next request (always at least one). */
  private batchSize(): number {
    let chars = 0;
    let count = 0;
    for (const { message } of this.outbox) {
      chars += JSON.stringify(message).length + 1;
      if (count > 0 && (chars > MAX_BATCH_CHARS || count >= MAX_BATCH_MESSAGES)) break;
      count += 1;
    }
    return count;
  }

  private schedulePoll(delay: number): void {
    if (this.closed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private nextInterval(): number {
    if (this.failures > 0) return Math.min(10_000, 500 * 2 ** this.failures);
    if (this.pace !== 'live' && Date.now() - this.lastActivity < ACTIVE_WINDOW_MS)
      return ACTIVE_INTERVAL_MS;
    return PACE_INTERVAL_MS[this.pace];
  }

  private async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const batch = await this.request('GET', '/api/signal/poll');
      if (batch) this.deliver(batch);
    } finally {
      this.polling = false;
      this.schedulePoll(this.nextInterval());
    }
  }

  /** Performs a request; returns null on failure (after updating failure state). */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Batch | null> {
    if (!this.credentials) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers:
          body === undefined
            ? this.headers()
            : { ...this.headers(), ...extraHeaders, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (response.status === 401) {
        // The server forgot this connection (expired presence): signaling is over.
        this.finish('closed');
        return null;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { messages?: unknown; firstSeq?: unknown };
      this.failures = 0;
      return {
        messages: Array.isArray(payload.messages) ? payload.messages : [],
        firstSeq: typeof payload.firstSeq === 'number' ? payload.firstSeq : 0,
      };
    } catch {
      this.failures += 1;
      if (this.failures >= MAX_CONSECUTIVE_FAILURES) this.finish('error');
      else if (method === 'POST')
        setTimeout(() => void this.flush(), Math.min(10_000, 500 * 2 ** this.failures));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Hands new messages to the listeners, skipping any already handled. */
  private deliver(batch: Batch): void {
    batch.messages.forEach((raw, index) => {
      if (this.closed) return;
      const seq = batch.firstSeq > 0 ? batch.firstSeq + index : 0;
      if (seq > 0) {
        if (seq <= this.lastReceived) return; // delivered by an overlapping request
        this.lastReceived = seq;
      }
      this.lastActivity = Date.now();
      const parsed = ServerMessageSchema.safeParse(raw);
      if (!parsed.success || parsed.data.type === 'pong') return;
      for (const listener of [...this.messageListeners]) listener(parsed.data);
    });
  }

  private readonly handlePageHide = (event: PageTransitionEvent) => {
    this.beaconDisconnect();
    if (event.persisted) this.finish('closed');
  };

  /** Back in the foreground: whatever arrived while timers were paused is fetched at once. */
  private readonly handleVisibility = () => {
    if (document.visibilityState === 'visible' && !this.polling) this.schedulePoll(0);
  };

  private beaconDisconnect(): void {
    if (!this.credentials) return;
    const payload = JSON.stringify(this.credentials);
    const url = `${this.baseUrl}/api/signal/disconnect`;
    try {
      if (!navigator.sendBeacon?.(url, payload)) {
        void fetch(url, {
          method: 'POST',
          body: payload,
          keepalive: true,
          credentials: 'omit',
        }).catch(() => undefined);
      }
    } catch {
      // Best effort: the server also notices missing presence.
    }
    this.credentials = null;
  }

  private stop(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    window.removeEventListener('pagehide', this.handlePageHide);
    document.removeEventListener('visibilitychange', this.handleVisibility);
  }

  private finish(reason: SignalingCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    this.messageListeners.clear();
    for (const listener of listeners) listener(reason);
  }
}

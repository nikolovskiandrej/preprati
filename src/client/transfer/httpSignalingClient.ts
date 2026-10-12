/**
 * Signaling over HTTP polling, for deployments on serverless platforms where
 * long-lived WebSockets are not a good fit. Same messages as the WebSocket
 * transport (see src/shared/signaling.ts).
 *
 * - Outgoing messages are POSTed strictly in order (an offer must arrive
 *   before its ICE candidates); each response carries any queued replies.
 * - The inbox is polled every 400 ms while messages are flowing, 1.5 s when
 *   idle, and every 5 s in "quiet" mode once the direct connection is up.
 * - Closing the page sends a `sendBeacon` disconnect so the other device
 *   learns right away; otherwise the server notices after a few minutes.
 */
import {
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '../../shared/signaling';
import { apiBaseUrl } from '../lib/env';
import type { SignalingCloseReason, SignalingTransport } from './signalingClient';

const ACTIVE_INTERVAL_MS = 400;
const IDLE_INTERVAL_MS = 1500;
const QUIET_INTERVAL_MS = 5000;
const ACTIVE_WINDOW_MS = 6000;
const MAX_CONSECUTIVE_FAILURES = 8;

interface Credentials {
  connectionId: string;
  token: string;
}

export class HttpSignalingClient implements SignalingTransport {
  private credentials: Credentials | null = null;
  private readonly messageListeners = new Set<(message: ServerMessage) => void>();
  private readonly closeListeners = new Set<(reason: SignalingCloseReason) => void>();
  private outbox: { seq: number; message: ClientMessage }[] = [];
  private nextSeq = 1;
  private sending = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private failures = 0;
  private lastActivity = 0;
  private quiet = false;
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

  /** Slows polling down once peers talk directly (presence only). */
  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
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
    };
  }

  private async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.outbox.length > 0 && this.isOpen) {
        const { seq, message } = this.outbox[0]!;
        const messages = await this.request('POST', '/api/signal/send', message, {
          'X-Signal-Seq': String(seq),
        });
        if (messages === null) return; // failure handling scheduled a retry or closed
        this.outbox.shift();
        this.deliver(messages);
      }
    } finally {
      this.sending = false;
    }
  }

  private schedulePoll(delay: number): void {
    if (this.closed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private nextInterval(): number {
    if (this.failures > 0) return Math.min(10_000, 500 * 2 ** this.failures);
    if (this.quiet) return QUIET_INTERVAL_MS;
    return Date.now() - this.lastActivity < ACTIVE_WINDOW_MS
      ? ACTIVE_INTERVAL_MS
      : IDLE_INTERVAL_MS;
  }

  private async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const messages = await this.request('GET', '/api/signal/poll');
      if (messages) this.deliver(messages);
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
  ): Promise<ServerMessage[] | null> {
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
      const payload = (await response.json()) as { messages?: unknown[] };
      this.failures = 0;
      return (payload.messages ?? []).flatMap((raw) => {
        const parsed = ServerMessageSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      });
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

  private deliver(messages: ServerMessage[]): void {
    if (messages.length > 0) this.lastActivity = Date.now();
    for (const message of messages) {
      if (message.type === 'pong') continue;
      for (const listener of [...this.messageListeners]) listener(message);
    }
  }

  private readonly handlePageHide = () => this.beaconDisconnect();

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

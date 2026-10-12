/**
 * WebSocket client for the signaling server. Messages in both directions are
 * validated with the shared schemas; an application-level ping detects dead
 * connections (browsers cannot see WebSocket ping frames).
 */
import {
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '../../shared/signaling';

export type SignalingCloseReason = 'closed' | 'timeout' | 'error';

/** A signaling channel: WebSocket (default) or HTTP polling (serverless hosts). */
export interface SignalingTransport {
  /** Opens the channel; rejects if it cannot connect within `timeoutMs`. */
  connect(timeoutMs?: number): Promise<void>;
  readonly isOpen: boolean;
  send(message: ClientMessage): boolean;
  onMessage(listener: (message: ServerMessage) => void): () => void;
  onClose(listener: (reason: SignalingCloseReason) => void): () => void;
  /** Hint that the peers now talk directly, so signaling may idle. */
  setQuiet?(quiet: boolean): void;
  close(): void;
}

const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;

export class SignalingClient implements SignalingTransport {
  private socket: WebSocket | null = null;
  private readonly messageListeners = new Set<(message: ServerMessage) => void>();
  private readonly closeListeners = new Set<(reason: SignalingCloseReason) => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly url: string) {}

  /** Opens the socket; rejects if it cannot connect within `timeoutMs`. */
  connect(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        reject(error);
        return;
      }
      this.socket = socket;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error('Signaling connection timed out'));
      }, timeoutMs);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.startHeartbeat();
        resolve();
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Signaling connection failed'));
        }
      };
      socket.onclose = () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error('Signaling connection closed'));
          return;
        }
        this.finish('closed');
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let json: unknown;
        try {
          json = JSON.parse(event.data);
        } catch {
          return;
        }
        const parsed = ServerMessageSchema.safeParse(json);
        if (!parsed.success) return;
        if (parsed.data.type === 'pong') {
          if (this.pongTimer) clearTimeout(this.pongTimer);
          this.pongTimer = null;
          return;
        }
        for (const listener of [...this.messageListeners]) listener(parsed.data);
      };
    });
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.messageListeners.clear();
    this.closeListeners.clear();
    const socket = this.socket;
    this.socket = null;
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close(1000);
    }
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (!this.send({ type: 'ping' })) return;
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        this.socket?.close();
        this.finish('timeout');
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  private finish(reason: SignalingCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    this.messageListeners.clear();
    for (const listener of listeners) listener(reason);
  }
}

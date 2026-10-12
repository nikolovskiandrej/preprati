/**
 * QuickSession — owns one Quick Transfer session end to end: signaling
 * socket, peer connection, transfer engine and the resulting files. UI code
 * subscribes to immutable state snapshots and calls the action methods.
 *
 * Phase order (host):  idle → creating-session → waiting-for-peer
 *                      [→ approval-required] → peer-connected → connecting
 *                      → connected → awaiting-acceptance → transferring → completed
 * Phase order (guest): idle → joining [→ awaiting-approval] → peer-connected
 *                      → connecting → connected → …
 * Terminal/side phases: rejected, cancelled (connection stays up; another
 * transfer can follow), expired, disconnected, failed.
 *
 * A failed connection attempt can be retried within the same session
 * ("Try again", up to MAX_CONNECTION_ATTEMPTS): both devices stay paired and
 * renegotiate from scratch as attempt n+1. Signals carry their attempt, so
 * late messages from an abandoned attempt are dropped. Once the data channel
 * is open, the connection no longer depends on signaling: drops are repaired
 * with ICE restarts (see PeerLink) and the other device's departure is
 * reported by the channel itself.
 *
 * When the devices can't connect directly, the sender can switch the session
 * to relay mode ("Send through preprati."): the files travel as a temporary,
 * end-to-end encrypted share package instead (see ./relay.ts), and the rest
 * of the session — offer, accept, progress, received files — stays the same.
 *
 * File names and contents only ever travel over the encrypted data channel
 * or, in relay mode, encrypted end to end; the signaling server sees device
 * labels, WebRTC negotiation and ciphertext only.
 */
import { MAX_CONNECTION_ATTEMPTS } from '../../shared/constants';
import { appUrl, isSecureContextAvailable, isWebRtcAvailable, signalingUrl } from '../lib/env';
import { loadPublicConfig } from '../lib/runtimeConfig';
import { deviceLabel } from '../lib/device';
import { RateMeter, type RateEstimate } from '../lib/rateMeter';
import type {
  IceServerConfig,
  JoinTarget,
  ServerMessage,
  SignalingErrorCode,
  SignalPayload,
  TransferRole,
} from '../../shared/signaling';
import {
  classifyFailure,
  emptySummary,
  type ConnectionDiagnostics,
  type FailureCause,
} from './diagnostics';
import {
  TransferEngine,
  type EngineEvent,
  type FileTransport,
  type ReceivedFile,
  type TransferSnapshot,
} from './engine';
import { countIceServers, toRtcIceServers } from './iceConfig';
import { PeerLink, type ConnectionRoute } from './peerLink';
import { HttpSignalingClient } from './httpSignalingClient';
import { RelayEngine, type RelayLimits, type RelayStorage } from './relay';
import {
  createRelayKeyPair,
  deriveRelayKey,
  type RelayKeyPair,
  type RelaySide,
} from './relayCrypto';
import { shareRelayStorage } from './relayStorage';
import { SignalingClient, type SignalingPace, type SignalingTransport } from './signalingClient';

export type QuickPhase =
  | 'idle'
  | 'creating-session'
  | 'waiting-for-peer'
  | 'approval-required'
  | 'joining'
  | 'awaiting-approval'
  | 'peer-connected'
  | 'connecting'
  | 'connected'
  | 'awaiting-acceptance'
  | 'transferring'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'disconnected'
  | 'failed';

export type QuickErrorCode =
  | 'unsupported'
  | 'signaling-unavailable'
  | 'session-not-found'
  | 'session-expired'
  | 'session-full'
  | 'rate-limited'
  | 'server-busy'
  | 'declined'
  | 'peer-left'
  | 'peer-ended'
  | 'connection-failed'
  /** The sender proposed relay mode and the other device never answered. */
  | 'relay-unanswered'
  | 'connection-lost'
  | 'protocol-error'
  | 'file-read-failed'
  | 'version-mismatch'
  | 'internal';

type LinkPhase = Exclude<
  QuickPhase,
  'awaiting-acceptance' | 'transferring' | 'completed' | 'rejected' | 'cancelled'
>;

export interface QuickSessionInfo {
  id: string;
  code: string;
  expiresAt: number;
  link: string;
}

export interface QuickState {
  phase: QuickPhase;
  isHost: boolean;
  role: TransferRole | null;
  session: QuickSessionInfo | null;
  peer: { label: string; via: 'link' | 'code' | null } | null;
  route: ConnectionRoute | null;
  /** The direct connection dropped and is being repaired. */
  reconnecting: boolean;
  /** Files chosen by the sender that have not been offered yet. */
  pendingFiles: File[];
  transfer: TransferSnapshot | null;
  /** Speed/ETA of the active transfer, once meaningful. */
  rate: RateEstimate | null;
  /** Files received during this session (receiver side). */
  received: ReceivedFile[];
  error: QuickErrorCode | null;
  /** Why the last connection attempt failed (set with `error: 'connection-failed'`). */
  failure: { cause: FailureCause; diagnostics: ConnectionDiagnostics } | null;
  /** "Try again" can reconnect within this session, without a new code. */
  canRetry: boolean;
  /**
   * Relay mode is available on this server and in this browser: its size
   * limits, and how long a package may stay stored at most.
   */
  relay: { limits: RelayLimits; ttlSeconds: number } | null;
  /** The sender can switch this session to relay mode now ("Send through preprati."). */
  canRelay: boolean;
}

export interface QuickSessionOptions {
  /** Host-sender convenience: offer the selected files as soon as the peer is ready. */
  autoOffer?: boolean;
  /** WebSocket signaling endpoint (defaults to this origin). */
  signalingUrl?: string;
  /** Overrides transport selection (tests). */
  createSignaling?: () => SignalingTransport;
  /** Overrides relay mode's storage and limits, read from the server otherwise (tests). */
  relay?: RelaySetup;
}

interface RelaySetup {
  storage: RelayStorage;
  limits: RelayLimits;
  ttlSeconds: number;
  /** How long a relay proposal waits for the other device's answer. */
  answerTimeoutMs?: number;
}

const INITIAL: QuickState = {
  phase: 'idle',
  isHost: false,
  role: null,
  session: null,
  peer: null,
  route: null,
  reconnecting: false,
  pendingFiles: [],
  transfer: null,
  rate: null,
  received: [],
  error: null,
  failure: null,
  canRetry: false,
  relay: null,
  canRelay: false,
};

/** Longest wait for the server to confirm a new or joined session. */
const SETUP_TIMEOUT_MS = 20_000;
/** After a failed attempt, how long "Try again" stays possible (signaling idles meanwhile). */
const RETRY_WINDOW_MS = 5 * 60_000;
/** A guest that asked for another attempt waits this long for the host's new offer. */
const RETRY_WAIT_MS = 30_000;
/** A sender that proposed relay mode waits this long for the other device's answer. */
const RELAY_WAIT_MS = 20_000;
/** Relay messages kept while the relay is still being set up (only a few can be early). */
const MAX_PENDING_RELAY_MESSAGES = 32;

/** Every field that describes one connection, reset whenever a new one starts. */
const FRESH_CONNECTION = {
  route: null,
  reconnecting: false,
  error: null,
  failure: null,
} satisfies Partial<QuickState>;

const attemptOf = (payload: SignalPayload): number =>
  'attempt' in payload ? (payload.attempt ?? 0) : 0;

type SessionTimer = 'setup' | 'retry-window' | 'retry-wait' | 'relay-wait';

function mapSignalingError(code: SignalingErrorCode): QuickErrorCode {
  switch (code) {
    case 'session-not-found':
    case 'session-expired':
    case 'session-full':
    case 'rate-limited':
    case 'server-busy':
      return code;
    default:
      return 'internal';
  }
}

export class QuickSession {
  private state: QuickState = INITIAL;
  private linkPhase: LinkPhase = 'idle';
  private readonly listeners = new Set<() => void>();
  private signaling: SignalingTransport | null = null;
  private peerLink: PeerLink | null = null;
  /** Moves the files: TransferEngine over the direct connection, RelayEngine in relay mode. */
  private engine: FileTransport | null = null;
  private iceServers: IceServerConfig[] = [];
  private sessionId: string | null = null;
  private relaySetup: RelaySetup | null = null;
  /** Sender: own key pair, from proposing relay mode until the receiver's half arrives. */
  private relayKeys: RelayKeyPair | null = null;
  private relayPending = false;
  /** Receiver: the sender's public key of the relay currently set up. */
  private relayPeerKey: string | null = null;
  /** Relay messages that arrived while the relay key was still being derived. */
  private pendingRelayMessages: Array<{ seq: number; data: string }> = [];
  /** Offer the selected files as soon as the relay is up (the sender chose "Send through"). */
  private offerWhenRelayReady = false;
  /** Signals that arrived before the peer connection they belong to exists. */
  private pendingSignals: SignalPayload[] = [];
  private peerSaidBye = false;
  private disposed = false;
  private readonly meter = new RateMeter();
  private meterTransferId: string | null = null;
  private generation = 0;
  /** Current connection attempt (0, then +1 per "Try again"). */
  private attempt = 0;
  private readonly timers = new Map<SessionTimer, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: QuickSessionOptions = {}) {
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', this.handleVisibility);
  }

  /* ------------------------------------------------------------------------ */
  /* Store interface (useSyncExternalStore)                                   */
  /* ------------------------------------------------------------------------ */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): QuickState => this.state;

  /* ------------------------------------------------------------------------ */
  /* Actions                                                                  */
  /* ------------------------------------------------------------------------ */

  /** Creates a new session on this device and waits for the other one to join. */
  async host(role: TransferRole): Promise<void> {
    if (!isWebRtcAvailable()) {
      this.update({ isHost: true, role, error: 'unsupported' }, 'failed');
      return;
    }
    const generation = this.resetConnection();
    this.update(
      { ...FRESH_CONNECTION, isHost: true, role, session: null, peer: null, transfer: null },
      'creating-session',
    );
    const client = await this.openSignaling(generation);
    if (!client) return;
    client.send({ type: 'create-session', role, device: { label: deviceLabel() } });
    this.armSetupTimeout(generation, 'creating-session');
    void this.loadRelaySetup(generation);
  }

  /** Joins a session from a link (session id) or a typed pairing code. */
  async join(target: JoinTarget): Promise<void> {
    if (!isWebRtcAvailable()) {
      this.update({ isHost: false, error: 'unsupported' }, 'failed');
      return;
    }
    const generation = this.resetConnection();
    this.update(
      { ...FRESH_CONNECTION, isHost: false, role: null, session: null, peer: null, transfer: null },
      'joining',
    );
    const client = await this.openSignaling(generation);
    if (!client) return;
    client.send({ type: 'join-session', target, device: { label: deviceLabel() } });
    this.armSetupTimeout(generation, 'joining');
    void this.loadRelaySetup(generation);
  }

  approvePeer(): void {
    if (this.linkPhase !== 'approval-required') return;
    this.signaling?.send({ type: 'approve-peer' });
    this.update({}, 'peer-connected');
    this.startPeer(true);
  }

  declinePeer(): void {
    if (this.linkPhase !== 'approval-required') return;
    this.signaling?.send({ type: 'decline-peer' });
    this.update({ peer: null }, 'waiting-for-peer');
  }

  /**
   * After a failed attempt: reconnects the same two devices without a new
   * code. The host renegotiates right away; a guest asks the host to.
   */
  retryConnection(): void {
    if (!this.state.canRetry || !this.signaling) return;
    this.clearTimer('retry-window');
    const next = this.attempt + 1;
    if (this.state.isHost) {
      this.startAttempt(next);
      return;
    }
    // Only the host offers, so ask it for the next attempt and wait for its offer.
    this.releasePeer();
    this.signaling.setPace?.('normal');
    this.signaling.send({ type: 'signal', payload: { kind: 'retry', attempt: next } });
    this.update(FRESH_CONNECTION, 'connecting');
    const generation = this.generation;
    this.setTimer('retry-wait', RETRY_WAIT_MS, () => {
      if (generation !== this.generation || this.peerLink || this.linkPhase !== 'connecting')
        return;
      // Nothing came back from the host: report it like an attempt that heard nothing.
      const servers = countIceServers(toRtcIceServers(this.iceServers));
      this.connectionFailed({
        attempt: next,
        stunServers: servers.stun,
        turnServers: servers.turn,
        local: emptySummary(),
        remote: emptySummary(),
        iceStates: [],
        durationMs: RETRY_WAIT_MS,
        restarts: 0,
        sameNetwork: false,
      });
    });
  }

  /**
   * Sender: sends the files through temporary, end-to-end encrypted storage
   * instead of a direct connection (which failed, or is taking too long).
   * The selected files are offered as soon as the other device is ready.
   */
  useRelay(): void {
    if (!this.state.canRelay || !this.signaling) return;
    const generation = this.generation;
    this.releasePeer(); // a direct attempt that is still trying
    this.clearTimer('retry-window');
    this.clearTimer('retry-wait');
    this.relayPending = true;
    this.offerWhenRelayReady = this.state.pendingFiles.length > 0;
    this.signaling.setPace?.('normal');
    this.update({ ...FRESH_CONNECTION, route: 'server' }, 'connecting');
    createRelayKeyPair()
      .then((keys) => {
        if (generation !== this.generation || !this.relayPending) return;
        this.relayKeys = keys;
        this.signaling?.send({
          type: 'signal',
          payload: { kind: 'relay-hello', key: keys.publicKey },
        });
        this.setTimer('relay-wait', this.relaySetup?.answerTimeoutMs ?? RELAY_WAIT_MS, () => {
          if (generation !== this.generation || !this.relayPending) return;
          this.relayPending = false;
          this.signaling?.setPace?.('standby');
          this.update({ ...FRESH_CONNECTION, error: 'relay-unanswered' }, 'failed');
        });
      })
      .catch(() => {
        if (generation !== this.generation) return;
        this.relayPending = false;
        this.update({ ...FRESH_CONNECTION, error: 'internal' }, 'failed');
      });
  }

  /** Sender: replaces the selection that will be offered next. */
  setFiles(files: File[]): void {
    if (this.engine?.busy) return;
    this.update({ pendingFiles: files });
    this.maybeAutoOffer();
  }

  /** Sender: offers the selected files to the connected device. */
  send(): boolean {
    const engine = this.engine;
    if (!engine || !engine.ready || engine.busy || this.state.pendingFiles.length === 0)
      return false;
    if (this.state.role !== 'sender') return false;
    const files = this.state.pendingFiles;
    engine.offer(files);
    this.update({ pendingFiles: [] });
    return true;
  }

  accept(): void {
    const transfer = this.state.transfer;
    if (transfer?.direction === 'incoming') this.engine?.accept(transfer.id);
  }

  reject(): void {
    const transfer = this.state.transfer;
    if (transfer?.direction === 'incoming') this.engine?.reject(transfer.id);
  }

  cancelTransfer(): void {
    this.engine?.cancel();
  }

  /** Leaves the session and releases every resource (and received files). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', this.handleVisibility);
    this.teardown(true);
    this.state = { ...INITIAL };
    this.listeners.clear();
  }

  /** Back in the foreground (phones pause background pages): repair a dropped path now. */
  private readonly handleVisibility = () => {
    if (document.visibilityState === 'visible') this.peerLink?.resume();
  };

  /* ------------------------------------------------------------------------ */
  /* Signaling                                                                */
  /* ------------------------------------------------------------------------ */

  private async openSignaling(generation: number): Promise<SignalingTransport | null> {
    const client = this.options.createSignaling?.() ?? (await this.createTransport());
    if (generation !== this.generation || this.disposed) return null;
    this.signaling = client;
    try {
      await client.connect();
    } catch {
      if (generation !== this.generation) return null;
      this.update({ error: 'signaling-unavailable' }, 'failed');
      return null;
    }
    if (generation !== this.generation || this.disposed) {
      client.close();
      return null;
    }
    client.onMessage((message) => this.handleServerMessage(message));
    client.onClose(() => {
      if (generation !== this.generation) return;
      this.signaling = null;
      if (this.engine instanceof RelayEngine) {
        this.handlePeerGone(); // relay mode can't go on without signaling
        return;
      }
      // A peer connection in progress may still finish (its candidates may all be
      // exchanged), and an open one no longer needs signaling at all.
      if (this.peerLink || this.isTerminal()) {
        this.update({}); // "Try again" needs signaling: refresh canRetry
        return;
      }
      this.update({ error: 'signaling-unavailable' }, 'failed');
    });
    return client;
  }

  /** WebSocket unless the server asks for HTTP polling (serverless deployments). */
  private async createTransport(): Promise<SignalingTransport> {
    const config = await loadPublicConfig().catch(() => null);
    if (config?.quickTransfer.signaling === 'http') return new HttpSignalingClient();
    return new SignalingClient(this.options.signalingUrl ?? signalingUrl());
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'session-created':
        this.clearTimer('setup');
        this.sessionId = message.sessionId;
        this.iceServers = message.iceServers;
        this.update(
          {
            role: message.role,
            session: {
              id: message.sessionId,
              code: message.code,
              expiresAt: message.expiresAt,
              link: appUrl(`/j/${message.sessionId}`),
            },
          },
          'waiting-for-peer',
        );
        return;
      case 'session-joined':
        this.clearTimer('setup');
        this.sessionId = message.sessionId;
        this.iceServers = message.iceServers;
        this.update(
          { role: message.role, peer: { label: message.peer.label, via: null } },
          message.awaitingApproval ? 'awaiting-approval' : 'peer-connected',
        );
        if (!message.awaitingApproval) this.startPeer(false);
        return;
      case 'peer-joined':
        this.update(
          { peer: { label: message.peer.label, via: message.via } },
          message.needsApproval ? 'approval-required' : 'peer-connected',
        );
        if (!message.needsApproval) this.startPeer(true);
        return;
      case 'peer-approved':
        this.update({}, 'peer-connected');
        this.startPeer(false);
        return;
      case 'peer-declined':
        this.closeSignaling();
        this.update({ error: 'declined' }, 'failed');
        return;
      case 'signal':
        this.routeSignal(message.payload);
        return;
      case 'peer-left':
        if (this.linkPhase === 'approval-required') {
          this.update({ peer: null }, 'waiting-for-peer');
          return;
        }
        if (this.engine instanceof RelayEngine) {
          // Relay mode lives on signaling: the other device leaving ends it. Leaving on
          // purpose is how a relaying device says goodbye.
          if (message.reason !== 'gone') this.peerSaidBye = true;
          this.handlePeerGone();
          return;
        }
        if (message.reason === 'gone' && this.peerLink?.isOpen) {
          // The other device went quiet on the signaling side (a phone that put the page in
          // the background, a dropped server connection), but the direct connection works
          // without signaling and reports a real departure itself (`bye`, the channel
          // closing, or ICE failing for good).
          this.closeSignaling();
          this.update({});
          return;
        }
        if (
          this.linkPhase === 'failed' &&
          (this.state.error === 'connection-failed' || this.state.error === 'relay-unanswered')
        ) {
          // Nobody is left to retry with; keep explaining the failure itself.
          this.closeSignaling();
          this.update({});
          return;
        }
        this.handlePeerGone();
        return;
      case 'session-expired':
        this.closeSignaling();
        this.update({ error: 'session-expired' }, 'expired');
        return;
      case 'session-closed':
        this.closeSignaling();
        if (this.peerLink?.isOpen) {
          this.update({});
          return; // the direct connection carries on
        }
        this.update(
          {
            error:
              message.reason === 'server-shutdown' ? 'signaling-unavailable' : 'session-expired',
          },
          'failed',
        );
        return;
      case 'error':
        this.handleSignalingError(message.code);
        return;
      case 'pong':
        return;
    }
  }

  private handleSignalingError(code: SignalingErrorCode): void {
    // Errors while setting up are fatal; later ones (e.g. a dropped relay) are not.
    if (this.linkPhase === 'creating-session' || this.linkPhase === 'joining') {
      this.clearTimer('setup');
      this.closeSignaling();
      this.update(
        { error: mapSignalingError(code) },
        code === 'session-expired' ? 'expired' : 'failed',
      );
    }
  }

  /** Hands a signal to the peer connection of its attempt (or keeps it until that exists). */
  private routeSignal(payload: SignalPayload): void {
    if (payload.kind === 'relay-hello') {
      void this.handleRelayHello(payload.key, payload.reply ?? null);
      return;
    }
    if (payload.kind === 'relay-message') {
      if (this.engine instanceof RelayEngine) this.engine.handleMessage(payload.seq, payload.data);
      else if (this.pendingRelayMessages.length < MAX_PENDING_RELAY_MESSAGES)
        this.pendingRelayMessages.push({ seq: payload.seq, data: payload.data });
      return;
    }
    if (payload.kind === 'retry') {
      // A guest asks for another attempt; the host decides the attempt numbers.
      if (
        this.state.isHost &&
        payload.attempt > this.attempt &&
        this.canStartAttempt(payload.attempt)
      )
        this.startAttempt(payload.attempt);
      return;
    }
    const attempt = attemptOf(payload);
    if (attempt < this.attempt) return; // from an abandoned attempt
    if (this.state.isHost) {
      if (attempt === this.attempt) void this.peerLink?.handleSignal(payload);
      return;
    }
    const isOffer = payload.kind === 'description' && payload.description.type === 'offer';
    if (isOffer && (attempt > this.attempt || !this.peerLink) && this.canStartAttempt(attempt)) {
      // The host started a new attempt (after "Try again" on either device).
      this.startAttempt(attempt, payload);
      return;
    }
    if (attempt === this.attempt && this.peerLink) void this.peerLink.handleSignal(payload);
    else this.pendingSignals.push(payload);
  }

  private canStartAttempt(attempt: number): boolean {
    return attempt < MAX_CONNECTION_ATTEMPTS && !!this.state.peer && !this.engine?.busy;
  }

  /** Replaces the current peer connection with a fresh negotiation as `attempt`. */
  private startAttempt(attempt: number, offer?: SignalPayload): void {
    this.releasePeer();
    this.clearTimer('retry-window');
    this.clearTimer('retry-wait');
    this.attempt = attempt;
    this.signaling?.setPace?.('normal');
    this.update(FRESH_CONNECTION, 'peer-connected');
    this.startPeer(this.state.isHost);
    if (offer) void this.peerLink?.handleSignal(offer);
  }

  /* ------------------------------------------------------------------------ */
  /* Peer connection                                                          */
  /* ------------------------------------------------------------------------ */

  private startPeer(isOfferer: boolean): void {
    if (this.peerLink) return;
    const generation = this.generation;
    let link: PeerLink;
    try {
      link = this.createPeerLink(isOfferer, generation);
    } catch {
      this.update({ error: 'connection-failed' }, 'failed');
      return;
    }
    this.peerLink = link;
    this.engine = new TransferEngine(link.channel, {
      getMaxMessageSize: () => link.maxMessageSize,
      onEvent: (event) => this.handleEngineEvent(event, generation, link),
    });
    this.update({}, 'connecting');
    // Signals that arrived early: apply this attempt's, keep any for a later one.
    const early = this.pendingSignals;
    this.pendingSignals = early.filter((payload) => attemptOf(payload) > this.attempt);
    for (const payload of early) {
      if (attemptOf(payload) === this.attempt) void link.handleSignal(payload);
    }
    link.start().catch(() => {
      if (generation === this.generation) {
        this.update({ error: 'connection-failed' }, 'failed');
        this.releasePeer();
      }
    });
  }

  /** Events of either engine; `link` is the direct connection (absent in relay mode). */
  private handleEngineEvent(event: EngineEvent, generation: number, link?: PeerLink): void {
    if (generation !== this.generation) return;
    switch (event.type) {
      case 'ready':
        if (link) {
          this.signaling?.setPace?.('quiet');
          this.update({}, 'connected');
          void link.route().then((route) => {
            if (generation === this.generation && this.peerLink === link) this.update({ route });
          });
        } else {
          this.signaling?.setPace?.('standby');
          this.update({ route: 'server' }, 'connected');
        }
        this.maybeAutoOffer();
        return;
      case 'version-mismatch':
        this.update({ error: 'version-mismatch' }, 'failed');
        this.releasePeer();
        return;
      case 'transfer': {
        const transfer = event.transfer;
        const meterKey = `${transfer.id}:${transfer.stage ?? ''}`;
        if (meterKey !== this.meterTransferId) {
          this.meter.reset();
          this.meterTransferId = meterKey;
        }
        const rate =
          transfer.status === 'transferring'
            ? this.meter.push(transfer.transferredBytes, transfer.totalBytes)
            : null;
        if (!link) this.signaling?.setPace?.(relayPace(transfer));
        this.update({ transfer, rate });
        return;
      }
      case 'file-received':
        this.update({ received: [...this.state.received, event.file] });
        return;
      case 'peer-bye':
        this.peerSaidBye = true;
        return;
      case 'channel-closed':
        this.handlePeerGone();
        return;
    }
  }

  private createPeerLink(isOfferer: boolean, generation: number): PeerLink {
    const attempt = this.attempt;
    const current = () => generation === this.generation && attempt === this.attempt;
    return new PeerLink({
      iceServers: this.iceServers,
      isOfferer,
      attempt,
      sendSignal: (payload) => this.signaling?.send({ type: 'signal', payload }),
      onOpen: () => {
        if (!current()) return;
        this.engine?.start();
      },
      onFailed: (_reason, diagnostics) => {
        if (!current()) return;
        this.releasePeer();
        this.connectionFailed(diagnostics);
      },
      onLost: () => {
        if (!current()) return;
        this.handlePeerGone();
      },
      onReconnecting: (reconnecting) => {
        if (!current()) return;
        // Restart offers and answers should travel fast; afterwards signaling idles again.
        this.signaling?.setPace?.(reconnecting ? 'normal' : 'quiet');
        this.update({ reconnecting });
      },
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Relay mode                                                               */
  /* ------------------------------------------------------------------------ */

  /** Relay mode needs Web Crypto and a server with share storage. */
  private async loadRelaySetup(generation: number): Promise<void> {
    let setup: RelaySetup | null = this.options.relay ?? null;
    if (!setup && isSecureContextAvailable()) {
      const config = await loadPublicConfig().catch(() => null);
      if (config?.share.enabled) {
        const share = config.share;
        setup = {
          storage: shareRelayStorage(share.chunkBytes),
          limits: {
            maxFiles: share.maxFiles,
            maxFileBytes: share.maxFileBytes,
            maxPackageBytes: share.maxPackageBytes,
          },
          ttlSeconds: share.ttlSeconds,
        };
      }
    }
    if (!setup || generation !== this.generation || this.disposed) return;
    this.relaySetup = setup;
    this.update({ relay: { limits: setup.limits, ttlSeconds: setup.ttlSeconds } });
  }

  /**
   * One half of the relay key agreement from the other device: a proposal
   * (from the sender) or an answer to one (from the receiver, `reply` naming
   * the proposal). A receiver answers with its own half and is ready; a
   * sender completes the proposal it made — also when the answer comes late.
   * A receiver accepts a new proposal at any time (the sender started over),
   * unless a transfer is running.
   */
  private async handleRelayHello(peerKey: string, reply: string | null): Promise<void> {
    const generation = this.generation;
    const setup = this.relaySetup;
    const sessionId = this.sessionId;
    if (!setup || !sessionId) return; // no relay here: the sender's proposal times out
    try {
      if (this.state.role === 'receiver') {
        if (reply || peerKey === this.relayPeerKey || this.engine?.busy) return;
        this.relayPeerKey = peerKey;
        const own = await createRelayKeyPair();
        const key = await deriveRelayKey(own, peerKey, {
          sessionId,
          senderKey: peerKey,
          receiverKey: own.publicKey,
        });
        if (generation !== this.generation || this.relayPeerKey !== peerKey) return;
        this.signaling?.send({
          type: 'signal',
          payload: { kind: 'relay-hello', key: own.publicKey, reply: peerKey },
        });
        this.startRelay(key, 'receiver', setup);
        return;
      }
      const own = this.relayKeys;
      if (!own || reply !== own.publicKey || this.engine instanceof RelayEngine) return;
      const key = await deriveRelayKey(own, peerKey, {
        sessionId,
        senderKey: own.publicKey,
        receiverKey: peerKey,
      });
      const waiting =
        this.relayPending ||
        (this.linkPhase === 'failed' && this.state.error === 'relay-unanswered');
      if (generation !== this.generation || this.relayKeys !== own || !waiting) return;
      this.startRelay(key, 'sender', setup);
    } catch {
      // An unusable key: ignore it (a sender's proposal then times out).
    }
  }

  private startRelay(key: CryptoKey, side: RelaySide, setup: RelaySetup): void {
    const generation = this.generation;
    this.releasePeer();
    this.clearTimer('retry-window');
    this.clearTimer('retry-wait');
    this.clearTimer('relay-wait');
    this.relayPending = false;
    this.relayKeys = null;
    const engine = new RelayEngine({
      side,
      key,
      storage: setup.storage,
      limits: setup.limits,
      send: (payload) => this.signaling?.send({ type: 'signal', payload }),
      onEvent: (event) => this.handleEngineEvent(event, generation),
    });
    this.engine = engine;
    this.update({ ...FRESH_CONNECTION, route: 'server' }, 'connecting');
    const early = this.pendingRelayMessages;
    this.pendingRelayMessages = [];
    for (const message of early) engine.handleMessage(message.seq, message.data);
    engine.start();
  }

  /** Reports a failed attempt and keeps signaling (slowly) for a possible "Try again". */
  private connectionFailed(diagnostics: ConnectionDiagnostics): void {
    this.update(
      {
        ...FRESH_CONNECTION,
        error: 'connection-failed',
        failure: { cause: classifyFailure(diagnostics), diagnostics },
      },
      'failed',
    );
    this.signaling?.setPace?.('standby');
    const generation = this.generation;
    this.setTimer('retry-window', RETRY_WINDOW_MS, () => {
      if (generation !== this.generation || this.linkPhase !== 'failed') return;
      this.closeSignaling();
      this.update({});
    });
  }

  private handlePeerGone(): void {
    if (this.isTerminal()) return;
    const error: QuickErrorCode = this.peerSaidBye
      ? 'peer-ended'
      : this.engine
        ? 'connection-lost'
        : 'peer-left';
    this.releasePeer();
    this.closeSignaling();
    this.update({ error, reconnecting: false }, 'disconnected');
  }

  private maybeAutoOffer(): void {
    if (this.state.role !== 'sender' || this.linkPhase !== 'connected') return;
    if (this.offerWhenRelayReady && this.engine instanceof RelayEngine) {
      this.offerWhenRelayReady = false;
      this.send();
      return;
    }
    if (!this.options.autoOffer || !this.state.isHost || this.state.transfer) return;
    this.send();
  }

  /* ------------------------------------------------------------------------ */
  /* Housekeeping                                                             */
  /* ------------------------------------------------------------------------ */

  private isTerminal(): boolean {
    return (
      this.linkPhase === 'expired' ||
      this.linkPhase === 'disconnected' ||
      this.linkPhase === 'failed'
    );
  }

  private resetConnection(): number {
    this.teardown(false);
    this.peerSaidBye = false;
    this.pendingSignals = [];
    this.attempt = 0;
    this.sessionId = null;
    this.relayKeys = null;
    this.relayPending = false;
    this.relayPeerKey = null;
    this.pendingRelayMessages = [];
    this.offerWhenRelayReady = false;
    this.generation += 1;
    return this.generation;
  }

  private teardown(sayGoodbye: boolean): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (sayGoodbye) this.engine?.sayGoodbye();
    if (this.signaling?.isOpen) this.signaling.send({ type: 'leave-session' });
    this.releasePeer();
    this.closeSignaling();
  }

  /** Fails a session that the server never confirmed. */
  private armSetupTimeout(generation: number, phase: 'creating-session' | 'joining'): void {
    this.setTimer('setup', SETUP_TIMEOUT_MS, () => {
      if (generation !== this.generation || this.linkPhase !== phase) return;
      this.closeSignaling();
      this.update({ error: 'signaling-unavailable' }, 'failed');
    });
  }

  private setTimer(name: SessionTimer, ms: number, callback: () => void): void {
    this.clearTimer(name);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        callback();
      }, ms),
    );
  }

  private clearTimer(name: SessionTimer): void {
    const timer = this.timers.get(name);
    if (timer) clearTimeout(timer);
    this.timers.delete(name);
  }

  private releasePeer(): void {
    this.engine?.dispose();
    this.engine = null;
    this.peerLink?.close();
    this.peerLink = null;
  }

  private closeSignaling(): void {
    this.signaling?.close();
    this.signaling = null;
  }

  private update(patch: Partial<QuickState>, linkPhase?: LinkPhase): void {
    if (this.disposed) return;
    if (linkPhase) this.linkPhase = linkPhase;
    const next: QuickState = { ...this.state, ...patch };
    next.phase = derivePhase(this.linkPhase, next.transfer);
    const failedToConnect =
      this.linkPhase === 'failed' &&
      (next.error === 'connection-failed' || next.error === 'relay-unanswered');
    next.canRetry =
      failedToConnect && !!this.signaling?.isOpen && this.attempt + 1 < MAX_CONNECTION_ATTEMPTS;
    next.canRelay =
      !!this.relaySetup &&
      next.role === 'sender' &&
      !!next.peer &&
      !!this.signaling?.isOpen &&
      !this.relayPending &&
      !(this.engine instanceof RelayEngine) &&
      (failedToConnect || this.linkPhase === 'peer-connected' || this.linkPhase === 'connecting');
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** How eagerly to poll in relay mode, where control messages travel over signaling. */
function relayPace(transfer: TransferSnapshot): SignalingPace {
  if (transfer.status === 'transferring') return 'live';
  if (transfer.status === 'offered' || transfer.status === 'awaiting-acceptance') return 'normal';
  return 'standby';
}

/** Public phase: the connection phase, refined by the transfer status once connected. */
export function derivePhase(linkPhase: LinkPhase, transfer: TransferSnapshot | null): QuickPhase {
  if (linkPhase !== 'connected' || !transfer) return linkPhase;
  switch (transfer.status) {
    case 'offered':
    case 'awaiting-acceptance':
      return 'awaiting-acceptance';
    case 'transferring':
      return 'transferring';
    case 'completed':
      return 'completed';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return transfer.error === 'connection-lost' ? 'disconnected' : 'failed';
  }
}

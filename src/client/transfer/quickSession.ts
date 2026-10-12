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
 * File names and contents only ever travel over the encrypted data channel;
 * the signaling server sees device labels and WebRTC negotiation only.
 */
import { appUrl, isWebRtcAvailable, signalingUrl } from '../lib/env';
import { loadPublicConfig } from '../lib/runtimeConfig';
import { deviceLabel } from '../lib/device';
import { RateMeter, type RateEstimate } from '../lib/rateMeter';
import type {
  IceServerConfig,
  JoinTarget,
  ServerMessage,
  SignalingErrorCode,
  TransferRole,
} from '../../shared/signaling';
import { TransferEngine, type ReceivedFile, type TransferSnapshot } from './engine';
import { PeerLink, type ConnectionRoute } from './peerLink';
import { HttpSignalingClient } from './httpSignalingClient';
import { SignalingClient, type SignalingTransport } from './signalingClient';

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
  /** Files chosen by the sender that have not been offered yet. */
  pendingFiles: File[];
  transfer: TransferSnapshot | null;
  /** Speed/ETA of the active transfer, once meaningful. */
  rate: RateEstimate | null;
  /** Files received during this session (receiver side). */
  received: ReceivedFile[];
  error: QuickErrorCode | null;
}

export interface QuickSessionOptions {
  /** Host-sender convenience: offer the selected files as soon as the peer is ready. */
  autoOffer?: boolean;
  /** WebSocket signaling endpoint (defaults to this origin). */
  signalingUrl?: string;
  /** Overrides transport selection (tests). */
  createSignaling?: () => SignalingTransport;
}

const INITIAL: QuickState = {
  phase: 'idle',
  isHost: false,
  role: null,
  session: null,
  peer: null,
  route: null,
  pendingFiles: [],
  transfer: null,
  rate: null,
  received: [],
  error: null,
};

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
  private engine: TransferEngine | null = null;
  private iceServers: IceServerConfig[] = [];
  private pendingSignals: ServerMessage[] = [];
  private peerSaidBye = false;
  private disposed = false;
  private readonly meter = new RateMeter();
  private meterTransferId: string | null = null;
  private generation = 0;

  constructor(private readonly options: QuickSessionOptions = {}) {}

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
      { isHost: true, role, session: null, peer: null, route: null, transfer: null, error: null },
      'creating-session',
    );
    const client = await this.openSignaling(generation);
    if (!client) return;
    client.send({ type: 'create-session', role, device: { label: deviceLabel() } });
  }

  /** Joins a session from a link (session id) or a typed pairing code. */
  async join(target: JoinTarget): Promise<void> {
    if (!isWebRtcAvailable()) {
      this.update({ isHost: false, error: 'unsupported' }, 'failed');
      return;
    }
    const generation = this.resetConnection();
    this.update(
      {
        isHost: false,
        role: null,
        session: null,
        peer: null,
        route: null,
        transfer: null,
        error: null,
      },
      'joining',
    );
    const client = await this.openSignaling(generation);
    if (!client) return;
    client.send({ type: 'join-session', target, device: { label: deviceLabel() } });
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
    this.teardown(true);
    this.state = { ...INITIAL };
    this.listeners.clear();
  }

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
      // Once the data channel is up, the transfer no longer needs signaling.
      if (this.engine && this.peerLink) return;
      if (this.isTerminal()) return;
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
        if (this.peerLink) void this.peerLink.handleSignal(message.payload);
        else this.pendingSignals.push(message);
        return;
      case 'peer-left':
        if (this.linkPhase === 'approval-required') {
          this.update({ peer: null }, 'waiting-for-peer');
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
        if (this.engine && this.peerLink) return; // the direct connection carries on
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
      this.closeSignaling();
      this.update(
        { error: mapSignalingError(code) },
        code === 'session-expired' ? 'expired' : 'failed',
      );
    }
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
      onEvent: (event) => {
        if (generation !== this.generation) return;
        switch (event.type) {
          case 'ready':
            this.signaling?.setQuiet?.(true);
            this.update({}, 'connected');
            void link.route().then((route) => {
              if (generation === this.generation) this.update({ route });
            });
            this.maybeAutoOffer();
            return;
          case 'version-mismatch':
            this.update({ error: 'version-mismatch' }, 'failed');
            this.releasePeer();
            return;
          case 'transfer': {
            const transfer = event.transfer;
            if (transfer.id !== this.meterTransferId) {
              this.meter.reset();
              this.meterTransferId = transfer.id;
            }
            const rate =
              transfer.status === 'transferring'
                ? this.meter.push(transfer.transferredBytes, transfer.totalBytes)
                : null;
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
      },
    });
    this.update({}, 'connecting');
    for (const message of this.pendingSignals.splice(0)) {
      if (message.type === 'signal') void link.handleSignal(message.payload);
    }
    link.start().catch(() => {
      if (generation === this.generation) {
        this.update({ error: 'connection-failed' }, 'failed');
        this.releasePeer();
      }
    });
  }

  private createPeerLink(isOfferer: boolean, generation: number): PeerLink {
    return new PeerLink({
      iceServers: this.iceServers,
      isOfferer,
      sendSignal: (payload) => this.signaling?.send({ type: 'signal', payload }),
      onOpen: () => {
        if (generation !== this.generation) return;
        this.engine?.start();
      },
      onFailed: () => {
        if (generation !== this.generation) return;
        this.update({ error: 'connection-failed' }, 'failed');
        this.releasePeer();
      },
      onLost: () => {
        if (generation !== this.generation) return;
        this.handlePeerGone();
      },
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
    this.update({ error }, 'disconnected');
  }

  private maybeAutoOffer(): void {
    if (!this.options.autoOffer || !this.state.isHost || this.state.role !== 'sender') return;
    if (this.linkPhase !== 'connected' || this.state.transfer) return;
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
    this.generation += 1;
    return this.generation;
  }

  private teardown(sayGoodbye: boolean): void {
    if (sayGoodbye) this.engine?.sayGoodbye();
    if (this.signaling?.isOpen) this.signaling.send({ type: 'leave-session' });
    this.releasePeer();
    this.closeSignaling();
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
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
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

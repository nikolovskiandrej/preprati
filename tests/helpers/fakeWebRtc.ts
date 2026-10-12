/**
 * Test doubles for Quick Transfer's connection layer:
 *
 * - FakeNetwork + FakePeerConnection: a scriptable RTCPeerConnection with
 *   descriptions, trickled candidates, ICE state changes, ICE restarts, a
 *   negotiated data channel and getStats. The network decides whether two
 *   peer connections reach each other, so tests can model a working path, a
 *   blocked one (strict NATs) or a path that drops mid-transfer.
 * - LoopbackSignaling: an in-process signaling transport backed by the real
 *   SessionManager, dispatching messages exactly like the WebSocket route.
 *
 * Everything is asynchronous through setTimeout, so fake timers control it.
 */
import { vi } from 'vitest';
import { randomId } from '../../src/shared/encoding';
import {
  ClientMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '../../src/shared/signaling';
import { SessionManager, type SignalingPeer } from '../../src/server/signaling/sessionManager';
import type {
  SignalingCloseReason,
  SignalingPace,
  SignalingTransport,
} from '../../src/client/transfer/signalingClient';
import { FakeChannel } from './fakeChannel';

/* -------------------------------------------------------------------------- */
/* Data channel                                                               */
/* -------------------------------------------------------------------------- */

export class FakeDataChannel extends FakeChannel {
  constructor() {
    super();
    this.readyState = 'connecting';
  }

  open(): void {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.emit('open', new Event('open'));
  }

  /** Like browsers: messages sent before close() still arrive, and `close` fires as a task. */
  override close(): void {
    this.flush();
    for (const side of [this, this.peer]) {
      if (!side || side.readyState === 'closed') continue;
      side.readyState = 'closed';
      side.bufferedAmount = 0;
      setTimeout(() => (side as FakeDataChannel).emit('close', new Event('close')), 0);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Peer connection + network                                                  */
/* -------------------------------------------------------------------------- */

const ufragOf = (sdp: string | undefined) => /ufrag=(\S+)/.exec(sdp ?? '')?.[1] ?? null;

export class FakeNetwork {
  readonly peers: FakePeerConnection[] = [];
  /** Whether two peer connections can reach each other right now. */
  canConnect: (a: FakePeerConnection, b: FakePeerConnection) => boolean = () => true;
  /** Candidates a peer connection gathers (SDP candidate attributes). */
  candidatesFor: (pc: FakePeerConnection) => string[] = (pc) => [
    `candidate:1 1 udp 2113937151 ${pc.id}.local 50000 typ host generation 0`,
    `candidate:2 1 udp 1677729535 203.0.113.${pc.index + 1} 60000 typ srflx raddr 0.0.0.0 rport 0 generation 0`,
  ];
  /** How long failing connectivity checks take. */
  failAfterMs = 100;
  /** Candidate type reported by getStats for the selected pair. */
  route: 'host' | 'srflx' | 'relay' = 'srflx';

  /** Installs this network as the global RTCPeerConnection. */
  install(): this {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const network = this;
    vi.stubGlobal(
      'RTCPeerConnection',
      class extends FakePeerConnection {
        constructor(config: RTCConfiguration = {}) {
          super(network, config);
        }
      },
    );
    return this;
  }

  /** Drops the path between every connected pair (ICE goes "disconnected"). */
  dropLinks(): void {
    this.canConnect = () => false;
    for (const pc of this.peers)
      if (pc.iceConnectionState === 'connected') pc.setIce('disconnected');
  }

  /** Lets peer connections reach each other again (an ICE restart reconnects them). */
  restoreLinks(): void {
    this.canConnect = () => true;
  }

  peerOf(pc: FakePeerConnection): FakePeerConnection | undefined {
    const remote = pc.remoteUfrag;
    return this.peers.find((other) => other !== pc && !other.closed && other.localUfrag === remote);
  }
}

export class FakePeerConnection {
  readonly id: string;
  readonly index: number;
  readonly config: RTCConfiguration;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  signalingState: RTCSignalingState = 'stable';
  iceConnectionState: RTCIceConnectionState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly sctp = { maxMessageSize: 256 * 1024 };
  channel: FakeDataChannel | null = null;
  closed = false;
  /** Offer options of every createOffer call (to observe ICE restarts). */
  readonly offers: Array<RTCOfferOptions | undefined> = [];
  readonly addedCandidates: string[] = [];
  private generation = 0;
  private remoteCandidates: string[] = [];
  private checking: string | null = null;

  constructor(
    private readonly network: FakeNetwork,
    config: RTCConfiguration,
  ) {
    this.index = network.peers.length;
    this.id = `pc${this.index}`;
    this.config = config;
    network.peers.push(this);
  }

  get localUfrag(): string {
    return `${this.id}-g${this.generation}`;
  }

  get remoteUfrag(): string | null {
    return ufragOf(this.remoteDescription?.sdp);
  }

  createDataChannel(): FakeDataChannel {
    this.channel = new FakeDataChannel();
    return this.channel;
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offers.push(options);
    if (options?.iceRestart) this.generation += 1;
    return { type: 'offer', sdp: `v=0 fake ufrag=${this.localUfrag}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    // An offer with new ICE credentials (a restart) gets new credentials back.
    if (this.localDescription && ufragOf(this.localDescription.sdp) === this.localUfrag)
      this.generation += 1;
    return { type: 'answer', sdp: `v=0 fake ufrag=${this.localUfrag}` };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) throw new DOMException('closed', 'InvalidStateError');
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    const ufrag = this.localUfrag;
    setTimeout(() => {
      if (this.closed) return;
      for (const candidate of this.network.candidatesFor(this)) {
        const json = { candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: ufrag };
        this.onicecandidate?.({ candidate: { ...json, toJSON: () => json } });
      }
      this.onicecandidate?.({ candidate: null });
      this.maybeConnect();
    }, 0);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) throw new DOMException('closed', 'InvalidStateError');
    if (description.type === 'answer' && this.signalingState !== 'have-local-offer')
      throw new DOMException('no offer pending', 'InvalidStateError');
    if (ufragOf(description.sdp) !== this.remoteUfrag) this.remoteCandidates = [];
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.maybeConnect();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescription)
      throw new DOMException('no remote description', 'InvalidStateError');
    if (candidate.usernameFragment && candidate.usernameFragment !== this.remoteUfrag)
      throw new DOMException('unknown ufrag', 'OperationError');
    this.addedCandidates.push(candidate.candidate ?? '');
    this.remoteCandidates.push(candidate.candidate ?? '');
    this.maybeConnect();
  }

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    const type = this.network.route;
    return new Map<string, Record<string, unknown>>([
      ['T', { type: 'transport', selectedCandidatePairId: 'P' }],
      ['P', { type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' }],
      ['L', { type: 'local-candidate', candidateType: type }],
      ['R', { type: 'remote-candidate', candidateType: type }],
    ]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signalingState = 'closed';
    this.iceConnectionState = 'closed';
    this.connectionState = 'closed';
    this.channel?.close();
  }

  /** Sets the ICE state (and the derived connection state) and fires the events. */
  setIce(state: RTCIceConnectionState): void {
    if (this.closed || this.iceConnectionState === state) return;
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
    const connection: RTCPeerConnectionState =
      state === 'connected' || state === 'completed'
        ? 'connected'
        : state === 'checking'
          ? 'connecting'
          : state === 'failed'
            ? 'failed'
            : state === 'disconnected'
              ? 'disconnected'
              : this.connectionState;
    if (connection !== this.connectionState) {
      this.connectionState = connection;
      this.onconnectionstatechange?.();
    }
  }

  /** Runs connectivity checks once both sides have descriptions and candidates. */
  private maybeConnect(): void {
    if (this.closed || this.signalingState !== 'stable' || this.remoteCandidates.length === 0)
      return;
    const peer = this.network.peerOf(this);
    if (!peer || peer.remoteUfrag !== this.localUfrag || peer.signalingState !== 'stable') return;
    if (peer.remoteCandidates.length === 0) return;
    const key = [this.localUfrag, peer.localUfrag].sort().join('|');
    if (this.checking === key && peer.checking === key) return;
    this.checking = key;
    peer.checking = key;
    for (const side of [this, peer]) side.setIce('checking');
    const reachable = this.network.canConnect(this, peer);
    setTimeout(
      () => {
        if (this.closed || peer.closed || this.checking !== key) return;
        if (!reachable || !this.network.canConnect(this, peer)) {
          for (const side of [this, peer]) side.setIce('failed');
          return;
        }
        for (const side of [this, peer]) side.setIce('connected');
        if (this.channel && peer.channel && this.channel.readyState === 'connecting') {
          this.channel.peer = peer.channel;
          peer.channel.peer = this.channel;
          this.channel.open();
          peer.channel.open();
        }
      },
      reachable ? 10 : this.network.failAfterMs,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Signaling                                                                  */
/* -------------------------------------------------------------------------- */

/** The real SessionManager behind in-process transports (what the WebSocket route does). */
export class LoopbackSignaling {
  readonly sessions: SessionManager;
  readonly transports: LoopbackTransport[] = [];
  /** When false, the server swallows messages without answering (tests setup timeouts). */
  responsive = true;

  constructor(iceServers = [{ urls: ['stun:stun.example.test:3478'] }]) {
    this.sessions = new SessionManager({
      pairingTtlMs: 10 * 60_000,
      maxLifetimeMs: 12 * 3_600_000,
      maxSessions: 100,
      maxSessionsPerIp: 100,
      iceServers: () => iceServers,
    });
  }

  transport(): LoopbackTransport {
    const transport = new LoopbackTransport(this);
    this.transports.push(transport);
    return transport;
  }

  /** Every signal payload relayed so far, in order. */
  get relayed(): ClientMessage[] {
    return this.transports.flatMap((transport) =>
      transport.sent.filter((m) => m.type === 'signal'),
    );
  }
}

export class LoopbackTransport implements SignalingTransport {
  readonly sent: ClientMessage[] = [];
  readonly paces: SignalingPace[] = [];
  private readonly messageListeners = new Set<(message: ServerMessage) => void>();
  private readonly closeListeners = new Set<(reason: SignalingCloseReason) => void>();
  private open = false;
  readonly peer: SignalingPeer;

  constructor(private readonly server: LoopbackSignaling) {
    this.peer = {
      connectionId: randomId(),
      ip: '203.0.113.50',
      send: (message) => {
        setTimeout(() => {
          if (!this.open) return;
          for (const listener of [...this.messageListeners]) listener(message);
        }, 0);
      },
    };
  }

  async connect(): Promise<void> {
    this.open = true;
  }

  get isOpen(): boolean {
    return this.open;
  }

  send(message: ClientMessage): boolean {
    if (!this.open) return false;
    // Validated exactly like the server does (unknown fields are stripped).
    const parsed = ClientMessageSchema.parse(message);
    this.sent.push(parsed);
    if (!this.server.responsive) return true;
    const { sessions } = this.server;
    const fail = (result: { ok: boolean; code?: string }) => {
      if (!result.ok) this.peer.send({ type: 'error', code: result.code as never });
    };
    switch (parsed.type) {
      case 'create-session':
        fail(sessions.createSession(this.peer, parsed.role, parsed.device));
        break;
      case 'join-session':
        fail(sessions.joinSession(this.peer, parsed.target, parsed.device));
        break;
      case 'approve-peer':
        fail(sessions.approvePeer(this.peer));
        break;
      case 'decline-peer':
        fail(sessions.declinePeer(this.peer));
        break;
      case 'signal':
        fail(sessions.relay(this.peer, parsed.payload));
        break;
      case 'leave-session':
        sessions.leave(this.peer);
        break;
      case 'ping':
        this.peer.send({ type: 'pong' });
        break;
    }
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

  setPace(pace: SignalingPace): void {
    this.paces.push(pace);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.server.sessions.leave(this.peer);
    this.messageListeners.clear();
    this.closeListeners.clear();
  }

  /** The connection drops without the client closing it (network gone, server restart). */
  drop(): void {
    if (!this.open) return;
    this.open = false;
    this.server.sessions.leave(this.peer);
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    this.messageListeners.clear();
    for (const listener of listeners) listener('closed');
  }
}

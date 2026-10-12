/**
 * PeerLink — one RTCPeerConnection with a single pre-negotiated, reliable,
 * ordered data channel (id 0). The session host always creates the offer, so
 * there is no offer glare to resolve. Remote ICE candidates that arrive
 * before the remote description are queued.
 */
import type { IceServerConfig, SignalPayload } from '../../shared/signaling';

export type ConnectionRoute = 'direct' | 'relay' | 'unknown';
export type PeerFailure = 'ice-failed' | 'timeout';

export interface PeerLinkOptions {
  iceServers: IceServerConfig[];
  isOfferer: boolean;
  sendSignal: (payload: SignalPayload) => void;
  onOpen: () => void;
  /** The connection never came up. */
  onFailed: (reason: PeerFailure) => void;
  /** The connection was up and then dropped for good. */
  onLost: () => void;
  connectTimeoutMs?: number;
  disconnectGraceMs?: number;
}

export class PeerLink {
  readonly pc: RTCPeerConnection;
  readonly channel: RTCDataChannel;
  private readonly options: PeerLinkOptions;
  private remoteDescriptionSet = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private opened = false;
  private closed = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private signalChain: Promise<void> = Promise.resolve();

  constructor(options: PeerLinkOptions) {
    this.options = options;
    this.pc = new RTCPeerConnection({ iceServers: options.iceServers as RTCIceServer[] });
    this.channel = this.pc.createDataChannel('preprati', {
      negotiated: true,
      id: 0,
      ordered: true,
    });
    this.channel.binaryType = 'arraybuffer';

    this.pc.onicecandidate = (event) => {
      if (!event.candidate || !event.candidate.candidate) return;
      const json = event.candidate.toJSON();
      options.sendSignal({
        kind: 'candidate',
        candidate: {
          candidate: json.candidate ?? '',
          sdpMid: json.sdpMid ?? null,
          sdpMLineIndex: json.sdpMLineIndex ?? null,
          usernameFragment: json.usernameFragment ?? null,
        },
      });
    };
    this.pc.onconnectionstatechange = () => this.handleState(this.pc.connectionState);
    this.pc.oniceconnectionstatechange = () => {
      // Fallback for engines with incomplete `connectionState` support.
      const ice = this.pc.iceConnectionState;
      if (ice === 'failed') this.handleState('failed');
      else if (ice === 'disconnected') this.handleState('disconnected');
      else if (ice === 'connected' || ice === 'completed') this.handleState('connected');
    };
    this.channel.addEventListener('open', () => {
      if (this.closed || this.opened) return;
      this.opened = true;
      this.clearConnectTimer();
      options.onOpen();
    });
    this.channel.addEventListener('close', () => {
      if (this.closed) return;
      if (this.opened) this.fail('lost');
    });
  }

  /** Starts negotiation (offerer) and the connection timeout (both sides). */
  async start(): Promise<void> {
    this.connectTimer = setTimeout(() => {
      if (!this.opened) this.fail('timeout');
    }, this.options.connectTimeoutMs ?? 30_000);
    if (!this.options.isOfferer) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const local = this.pc.localDescription;
    if (local && !this.closed) {
      this.options.sendSignal({
        kind: 'description',
        description: { type: 'offer', sdp: local.sdp },
      });
    }
  }

  /** Applies remote signaling in arrival order. */
  handleSignal(payload: SignalPayload): Promise<void> {
    this.signalChain = this.signalChain
      .then(() => this.applySignal(payload))
      .catch(() => {
        // A broken offer/answer means this connection cannot be established.
        if (!this.opened) this.fail('ice-failed');
      });
    return this.signalChain;
  }

  private async applySignal(payload: SignalPayload): Promise<void> {
    if (this.closed) return;
    if (payload.kind === 'description') {
      const { description } = payload;
      if (description.type === 'offer' && this.options.isOfferer) return; // never expected
      await this.pc.setRemoteDescription(description);
      this.remoteDescriptionSet = true;
      const queued = this.pendingCandidates;
      this.pendingCandidates = [];
      for (const candidate of queued) await this.addCandidate(candidate);
      if (description.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        const local = this.pc.localDescription;
        if (local && !this.closed) {
          this.options.sendSignal({
            kind: 'description',
            description: { type: 'answer', sdp: local.sdp },
          });
        }
      }
      return;
    }
    if (!payload.candidate) return;
    const candidate: RTCIceCandidateInit = {
      candidate: payload.candidate.candidate,
      sdpMid: payload.candidate.sdpMid ?? null,
      sdpMLineIndex: payload.candidate.sdpMLineIndex ?? null,
      usernameFragment: payload.candidate.usernameFragment ?? null,
    };
    if (!this.remoteDescriptionSet) this.pendingCandidates.push(candidate);
    else await this.addCandidate(candidate);
  }

  private async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // Individual candidates may be unusable (e.g. mDNS names); ICE continues with the rest.
    }
  }

  /** Reports whether traffic flows directly between the devices or through a TURN relay. */
  async route(): Promise<ConnectionRoute> {
    try {
      const stats = await this.pc.getStats();
      let pair: Record<string, unknown> | undefined;
      stats.forEach((report: Record<string, unknown>) => {
        if (report.type === 'transport' && typeof report.selectedCandidatePairId === 'string') {
          pair = stats.get(report.selectedCandidatePairId) as Record<string, unknown> | undefined;
        }
      });
      if (!pair) {
        stats.forEach((report: Record<string, unknown>) => {
          if (
            report.type === 'candidate-pair' &&
            report.state === 'succeeded' &&
            (report.selected || report.nominated)
          ) {
            pair = report;
          }
        });
      }
      if (!pair) return 'unknown';
      const local = stats.get(pair.localCandidateId as string) as
        { candidateType?: string } | undefined;
      const remote = stats.get(pair.remoteCandidateId as string) as
        { candidateType?: string } | undefined;
      if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return 'relay';
      if (local?.candidateType || remote?.candidateType) return 'direct';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Largest message the remote accepts, when the browser exposes it. */
  get maxMessageSize(): number | undefined {
    const size = this.pc.sctp?.maxMessageSize;
    return size && Number.isFinite(size) && size > 0 ? size : undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearConnectTimer();
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    try {
      this.channel.close();
    } catch {
      /* already closed */
    }
    this.pc.close();
  }

  private handleState(state: RTCPeerConnectionState): void {
    if (this.closed) return;
    if (state === 'connected') {
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = null;
    } else if (state === 'disconnected') {
      // Often transient (Wi-Fi hiccup, network switch); give ICE a moment to recover.
      if (!this.graceTimer) {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          if (this.pc.connectionState !== 'connected')
            this.fail(this.opened ? 'lost' : 'ice-failed');
        }, this.options.disconnectGraceMs ?? 8_000);
      }
    } else if (state === 'failed') {
      this.fail(this.opened ? 'lost' : 'ice-failed');
    }
  }

  private fail(kind: 'lost' | PeerFailure): void {
    if (this.closed) return;
    const opened = this.opened;
    this.close();
    if (kind === 'lost' || opened) this.options.onLost();
    else this.options.onFailed(kind);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }
}

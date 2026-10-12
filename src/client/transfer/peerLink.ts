/**
 * PeerLink — one RTCPeerConnection with a single pre-negotiated, reliable,
 * ordered data channel (id 0). The session host always creates the offer, so
 * there is no offer glare to resolve. Remote ICE candidates that arrive
 * before the remote description are queued.
 *
 * Connecting: the attempt fails when ICE fails, or when nothing has opened
 * after `connectTimeoutMs`. The failure comes with diagnostics (see
 * ./diagnostics.ts) so the interface can say why.
 *
 * Staying connected: once the data channel has been open, a dropped network
 * path (Wi-Fi ↔ mobile data, a short outage) is repaired with an ICE restart:
 * the offerer renegotiates fresh candidates over signaling while the data
 * channel, and any transfer on it, stays open. Restarts are limited per drop
 * and bounded by `reconnectWindowMs`; after that the connection counts as lost.
 */
import type { IceServerConfig, NegotiationPayload, SignalPayload } from '../../shared/signaling';
import { CandidateLog, onSameNetwork, type ConnectionDiagnostics } from './diagnostics';
import { countIceServers, toRtcIceServers } from './iceConfig';

/**
 * How the devices are connected: `direct`, through a TURN `relay`, or — in
 * relay mode, without any WebRTC connection — through preprati.'s `server`
 * (encrypted temporary storage; see ./relay.ts).
 */
export type ConnectionRoute = 'direct' | 'relay' | 'server' | 'unknown';
export type PeerFailure = 'ice-failed' | 'timeout';

export interface PeerLinkOptions {
  iceServers: IceServerConfig[];
  isOfferer: boolean;
  /** Connection attempt this link belongs to; every outgoing signal carries it. */
  attempt?: number;
  sendSignal: (payload: NegotiationPayload) => void;
  onOpen: () => void;
  /** The connection never came up. */
  onFailed: (reason: PeerFailure, diagnostics: ConnectionDiagnostics) => void;
  /** The connection was up and then dropped for good. */
  onLost: () => void;
  /** The network path dropped and is being repaired (true), or works again (false). */
  onReconnecting?: (reconnecting: boolean) => void;
  connectTimeoutMs?: number;
  /** Before the channel first opens: how long ICE may stay "disconnected". */
  disconnectGraceMs?: number;
  /** After it opened: how long a dropped connection may take to recover. */
  reconnectWindowMs?: number;
  /** How long ICE may stay "disconnected" before the offerer restarts it. */
  restartDelayMs?: number;
}

/** ICE restarts per drop: one right away, one more if the first doesn't bring the path back. */
const MAX_RESTARTS_PER_DROP = 2;
const RESTART_RETRY_MS = 8_000;
/**
 * How long a dropped connection may take to come back. Generous on purpose:
 * a phone that briefly locks its screen or switches networks pauses the page,
 * and its transfer should survive that.
 */
const RECONNECT_WINDOW_MS = 45_000;

type TimerName = 'connect' | 'grace' | 'reconnect' | 'restart';

export class PeerLink {
  readonly pc: RTCPeerConnection;
  readonly channel: RTCDataChannel;
  readonly attempt: number;
  private readonly options: PeerLinkOptions;
  private readonly startedAt = Date.now();
  private readonly servers: { stun: number; turn: number };
  private readonly localCandidates = new CandidateLog();
  private readonly remoteCandidates = new CandidateLog();
  private readonly iceStates: ConnectionDiagnostics['iceStates'] = [];
  private readonly timers = new Map<TimerName, ReturnType<typeof setTimeout>>();
  private remoteDescriptionSet = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private opened = false;
  private closed = false;
  private reconnecting = false;
  private restartInFlight = false;
  private restartsThisDrop = 0;
  private restarts = 0;
  private signalChain: Promise<void> = Promise.resolve();

  constructor(options: PeerLinkOptions) {
    this.options = options;
    this.attempt = options.attempt ?? 0;
    const iceServers = toRtcIceServers(options.iceServers);
    this.servers = countIceServers(iceServers);
    this.pc = new RTCPeerConnection({ iceServers });
    this.channel = this.pc.createDataChannel('preprati', {
      negotiated: true,
      id: 0,
      ordered: true,
    });
    this.channel.binaryType = 'arraybuffer';

    this.pc.onicecandidate = (event) => {
      if (!event.candidate || !event.candidate.candidate) return;
      const json = event.candidate.toJSON();
      this.localCandidates.add(json.candidate ?? '');
      this.signal({
        kind: 'candidate',
        candidate: {
          candidate: json.candidate ?? '',
          sdpMid: json.sdpMid ?? null,
          sdpMLineIndex: json.sdpMLineIndex ?? null,
          usernameFragment: json.usernameFragment ?? null,
        },
      });
    };
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      this.iceStates.push({ state, atMs: Date.now() - this.startedAt });
      this.handleIceState(state);
    };
    // DTLS failures only surface here; ICE failures arrive (once) through iceconnectionstatechange.
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed' && this.pc.iceConnectionState !== 'failed')
        this.handleIceState('failed');
    };
    this.channel.addEventListener('open', () => {
      if (this.closed || this.opened) return;
      this.opened = true;
      this.clearTimer('connect');
      options.onOpen();
    });
    this.channel.addEventListener('close', () => {
      if (this.closed) return;
      if (this.opened) this.fail('lost');
    });
  }

  /** Starts negotiation (offerer) and the connection timeout (both sides). */
  async start(): Promise<void> {
    this.setTimer('connect', this.options.connectTimeoutMs ?? 30_000, () => {
      if (!this.opened) this.fail('timeout');
    });
    if (!this.options.isOfferer) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendLocalDescription();
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

  /** True once the data channel has opened and while the link is not closed. */
  get isOpen(): boolean {
    return this.opened && !this.closed;
  }

  /**
   * The page is in the foreground again. Phones pause background pages, so a
   * path that dropped meanwhile is repaired right away instead of after the
   * usual delays (one more restart is allowed even if the earlier ones ran out).
   */
  resume(): void {
    if (this.closed || !this.opened) return;
    const ice = this.pc.iceConnectionState;
    if (ice !== 'disconnected' && ice !== 'failed') return;
    this.beginReconnect();
    if (!this.options.isOfferer) return;
    this.restartsThisDrop = Math.min(this.restartsThisDrop, MAX_RESTARTS_PER_DROP - 1);
    this.restartIce();
  }

  /** What this attempt learned about both networks so far (no addresses). */
  diagnostics(): ConnectionDiagnostics {
    return {
      attempt: this.attempt,
      stunServers: this.servers.stun,
      turnServers: this.servers.turn,
      local: this.localCandidates.summary(),
      remote: this.remoteCandidates.summary(),
      iceStates: [...this.iceStates],
      durationMs: Date.now() - this.startedAt,
      restarts: this.restarts,
      sameNetwork: onSameNetwork(this.localCandidates, this.remoteCandidates),
    };
  }

  private async applySignal(payload: SignalPayload): Promise<void> {
    if (this.closed) return;
    if (payload.kind !== 'description' && payload.kind !== 'candidate') return; // the session's
    if (payload.kind === 'description') {
      const { description } = payload;
      if (description.type === 'offer' && this.options.isOfferer) return; // never expected
      await this.pc.setRemoteDescription(description);
      this.remoteDescriptionSet = true;
      const queued = this.pendingCandidates;
      this.pendingCandidates = [];
      for (const candidate of queued) await this.addCandidate(candidate);
      if (description.type === 'offer') {
        // The first offer, or an ICE restart after the connection dropped.
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendLocalDescription();
      }
      return;
    }
    if (!payload.candidate) return;
    this.remoteCandidates.add(payload.candidate.candidate);
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
      // Individual candidates may be unusable (e.g. mDNS names, or a previous ICE
      // generation after a restart); ICE continues with the rest.
    }
  }

  private sendLocalDescription(): void {
    const local = this.pc.localDescription;
    if (!local || this.closed) return;
    this.signal({
      kind: 'description',
      description: { type: local.type === 'answer' ? 'answer' : 'offer', sdp: local.sdp },
    });
  }

  private signal(payload: NegotiationPayload): void {
    this.options.sendSignal({ ...payload, attempt: this.attempt });
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
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
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

  private handleIceState(state: RTCIceConnectionState): void {
    if (this.closed) return;
    if (state === 'connected' || state === 'completed') {
      this.clearTimer('grace');
      if (this.reconnecting) this.recovered();
    } else if (state === 'disconnected') {
      if (this.opened) {
        this.beginReconnect();
      } else if (!this.timers.has('grace')) {
        // Before anything opened, a short "disconnected" is usually a Wi-Fi hiccup.
        this.setTimer('grace', this.options.disconnectGraceMs ?? 8_000, () => {
          const ice = this.pc.iceConnectionState;
          if (ice !== 'connected' && ice !== 'completed') this.fail('ice-failed');
        });
      }
    } else if (state === 'failed') {
      if (!this.opened) {
        this.fail('ice-failed');
        return;
      }
      this.beginReconnect();
      this.restartIce();
    }
  }

  private beginReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.restartsThisDrop = 0;
    this.options.onReconnecting?.(true);
    this.setTimer('reconnect', this.options.reconnectWindowMs ?? RECONNECT_WINDOW_MS, () =>
      this.fail('lost'),
    );
    if (this.options.isOfferer) {
      this.setTimer('restart', this.options.restartDelayMs ?? 2_500, () => this.restartIce());
    }
    // The answering side waits for the offerer's restart offer (see applySignal).
  }

  private recovered(): void {
    this.reconnecting = false;
    this.clearTimer('reconnect');
    this.clearTimer('restart');
    this.options.onReconnecting?.(false);
  }

  /** Offerer: renegotiates ICE (new credentials and candidates) on the same connection. */
  private restartIce(): void {
    if (this.closed || !this.reconnecting || !this.options.isOfferer || this.restartInFlight)
      return;
    this.clearTimer('restart');
    if (this.restartsThisDrop >= MAX_RESTARTS_PER_DROP) return; // the reconnect window decides
    if (this.pc.signalingState !== 'stable' || this.pc.iceConnectionState === 'checking') {
      // The previous restart is still waiting for its answer or running its checks.
      this.setTimer('restart', 1_000, () => this.restartIce());
      return;
    }
    this.restartsThisDrop += 1;
    this.restarts += 1;
    this.restartInFlight = true;
    this.signalChain = this.signalChain
      .then(async () => {
        if (this.closed) return;
        const offer = await this.pc.createOffer({ iceRestart: true });
        await this.pc.setLocalDescription(offer);
        this.sendLocalDescription();
      })
      .catch(() => {
        // The reconnect window still bounds how long we wait.
      })
      .finally(() => {
        this.restartInFlight = false;
      });
    this.setTimer('restart', RESTART_RETRY_MS, () => this.restartIce());
  }

  private fail(kind: 'lost' | PeerFailure): void {
    if (this.closed) return;
    const opened = this.opened;
    const diagnostics = this.diagnostics();
    this.close();
    if (kind === 'lost' || opened) this.options.onLost();
    else this.options.onFailed(kind, diagnostics);
  }

  private setTimer(name: TimerName, ms: number, callback: () => void): void {
    this.clearTimer(name);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        callback();
      }, ms),
    );
  }

  private clearTimer(name: TimerName): void {
    const timer = this.timers.get(name);
    if (timer) clearTimeout(timer);
    this.timers.delete(name);
  }
}

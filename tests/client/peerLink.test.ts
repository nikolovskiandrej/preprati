/**
 * PeerLink against a scripted network: negotiation, candidate queueing,
 * failure diagnostics, and ICE restarts after the path drops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyFailure, type ConnectionDiagnostics } from '../../src/client/transfer/diagnostics';
import { PeerLink, type PeerFailure } from '../../src/client/transfer/peerLink';
import type { SignalPayload } from '../../src/shared/signaling';
import { FakeNetwork, type FakePeerConnection } from '../helpers/fakeWebRtc';

const ICE = [{ urls: ['stun:stun.example.test:3478', 'stun:stun2.example.test:3478'] }];

interface Side {
  link: PeerLink;
  sent: SignalPayload[];
  opened: number;
  failed: Array<{ reason: PeerFailure; diagnostics: ConnectionDiagnostics }>;
  lost: number;
  reconnecting: boolean[];
}

describe('PeerLink', () => {
  let network: FakeNetwork;

  beforeEach(() => {
    vi.useFakeTimers();
    network = new FakeNetwork().install();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Two links whose signals reach each other asynchronously (optionally reordered by `deliver`). */
  function pair(
    options: { attempt?: number; deliver?: (to: Side, payloads: SignalPayload[]) => void } = {},
  ) {
    const make = (isOfferer: boolean): Side => {
      const side = {
        sent: [],
        opened: 0,
        failed: [],
        lost: 0,
        reconnecting: [],
      } as unknown as Side;
      side.link = new PeerLink({
        iceServers: ICE,
        isOfferer,
        attempt: options.attempt,
        sendSignal: (payload) => {
          side.sent.push(payload);
          const other = side === offerer ? answerer : offerer;
          setTimeout(() => {
            if (options.deliver) options.deliver(other, [payload]);
            else void other.link.handleSignal(payload);
          }, 0);
        },
        onOpen: () => side.opened++,
        onFailed: (reason, diagnostics) => side.failed.push({ reason, diagnostics }),
        onLost: () => side.lost++,
        onReconnecting: (value) => side.reconnecting.push(value),
      });
      return side;
    };
    const offerer = make(true);
    const answerer = make(false);
    return { offerer, answerer, pcs: network.peers as FakePeerConnection[] };
  }

  it('negotiates, tags every signal with its attempt and opens the channel', async () => {
    const { offerer, answerer } = pair({ attempt: 2 });
    await Promise.all([offerer.link.start(), answerer.link.start()]);
    await vi.advanceTimersByTimeAsync(100);

    expect([offerer.opened, answerer.opened]).toEqual([1, 1]);
    expect(offerer.link.isOpen).toBe(true);
    expect([...offerer.sent, ...answerer.sent].every((payload) => payload.attempt === 2)).toBe(
      true,
    );
    expect(offerer.sent[0]).toMatchObject({ kind: 'description', description: { type: 'offer' } });
    expect(answerer.sent[0]).toMatchObject({
      kind: 'description',
      description: { type: 'answer' },
    });
    expect(await offerer.link.route()).toBe('direct');

    const diagnostics = offerer.link.diagnostics();
    expect(diagnostics).toMatchObject({ attempt: 2, stunServers: 2, turnServers: 0, restarts: 0 });
    expect(diagnostics.local).toEqual({ host: 1, srflx: 1, relay: 0, strictNat: false });
    expect(diagnostics.remote).toEqual({ host: 1, srflx: 1, relay: 0, strictNat: false });
    expect(diagnostics.iceStates.map((entry) => entry.state)).toEqual(['checking', 'connected']);
    // Nothing that identifies a network leaves the diagnostics.
    expect(JSON.stringify(diagnostics)).not.toMatch(/203\.0\.113|\.local/);
  });

  it('queues candidates that arrive before the offer', async () => {
    const held: SignalPayload[] = [];
    const { offerer, answerer, pcs } = pair({
      deliver: (to, payloads) => {
        if (to === answerer && payloads[0]!.kind === 'description') {
          held.push(...payloads); // hold the offer back…
          return;
        }
        for (const payload of payloads) void to.link.handleSignal(payload);
      },
    });
    await Promise.all([offerer.link.start(), answerer.link.start()]);
    await vi.advanceTimersByTimeAsync(10);
    expect(pcs[1]!.addedCandidates).toEqual([]); // …so its candidates had to wait
    for (const payload of held) void answerer.link.handleSignal(payload);
    await vi.advanceTimersByTimeAsync(100);
    expect(pcs[1]!.addedCandidates).toHaveLength(2);
    expect([offerer.opened, answerer.opened]).toEqual([1, 1]);
  });

  it('explains a failure when the networks cannot reach each other', async () => {
    network.canConnect = () => false;
    const { offerer, answerer, pcs } = pair();
    await Promise.all([offerer.link.start(), answerer.link.start()]);
    await vi.advanceTimersByTimeAsync(500);

    expect(offerer.failed.map((failure) => failure.reason)).toEqual(['ice-failed']);
    expect(answerer.failed.map((failure) => failure.reason)).toEqual(['ice-failed']);
    expect(classifyFailure(offerer.failed[0]!.diagnostics)).toBe('incompatible-networks');
    // A connection that never opened is not restarted: the user decides ("Try again").
    expect(pcs[0]!.offers.filter((options) => options?.iceRestart)).toEqual([]);
    expect(pcs.every((pc) => pc.closed)).toBe(true);
  });

  it('tells which side found no public address', async () => {
    network.canConnect = () => false;
    network.candidatesFor = (pc) =>
      pc.index === 0
        ? [`candidate:1 1 udp 2113937151 ${pc.id}.local 50000 typ host generation 0`]
        : [
            `candidate:1 1 udp 2113937151 ${pc.id}.local 50000 typ host generation 0`,
            'candidate:2 1 udp 1677729535 198.51.100.7 61000 typ srflx raddr 0.0.0.0 rport 0 generation 0',
            'candidate:3 1 udp 1677729535 198.51.100.7 61004 typ srflx raddr 0.0.0.0 rport 0 generation 0',
          ];
    const { offerer, answerer } = pair();
    await Promise.all([offerer.link.start(), answerer.link.start()]);
    await vi.advanceTimersByTimeAsync(500);

    expect(classifyFailure(offerer.failed[0]!.diagnostics)).toBe('local-network');
    expect(classifyFailure(answerer.failed[0]!.diagnostics)).toBe('remote-network');
    // Two public ports for one socket: the answering side sits behind a strict NAT.
    expect(answerer.failed[0]!.diagnostics.local.strictNat).toBe(true);
    expect(offerer.failed[0]!.diagnostics.remote.strictNat).toBe(true);
  });

  it('repairs a dropped path with an ICE restart while the channel stays open', async () => {
    const { offerer, answerer, pcs } = pair();
    await Promise.all([offerer.link.start(), answerer.link.start()]);
    await vi.advanceTimersByTimeAsync(100);

    network.dropLinks();
    expect([offerer.reconnecting, answerer.reconnecting]).toEqual([[true], [true]]);
    await vi.advanceTimersByTimeAsync(1_000);
    network.restoreLinks();
    await vi.advanceTimersByTimeAsync(2_000); // the offerer restarts ICE after 2.5 s

    expect(pcs[0]!.offers.filter((options) => options?.iceRestart)).toHaveLength(1);
    expect([offerer.reconnecting, answerer.reconnecting]).toEqual([
      [true, false],
      [true, false],
    ]);
    expect([offerer.lost, answerer.lost]).toEqual([0, 0]);
    expect(offerer.link.channel.readyState).toBe('open');
    expect(offerer.link.diagnostics().restarts).toBe(1);
  });

  it('gives up when the path does not come back in time', async () => {
    const { offerer, answerer, pcs } = pair();
    await Promise.all([offerer.link.start(), answerer.link.start()]);
    await vi.advanceTimersByTimeAsync(100);

    network.dropLinks();
    await vi.advanceTimersByTimeAsync(24_000);
    expect([offerer.lost, answerer.lost]).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect([offerer.lost, answerer.lost]).toEqual([1, 1]);
    // Restarts are bounded per drop.
    expect(pcs[0]!.offers.filter((options) => options?.iceRestart).length).toBeLessThanOrEqual(2);
    expect(offerer.failed).toEqual([]);
  });

  it('times out when nothing ever connects', async () => {
    const lonely = new PeerLink({
      iceServers: ICE,
      isOfferer: true,
      sendSignal: () => undefined,
      onOpen: () => undefined,
      onFailed: (reason) => failures.push(reason),
      onLost: () => undefined,
    });
    const failures: PeerFailure[] = [];
    await lonely.start();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(failures).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(failures).toEqual(['timeout']);
  });

  it('skips unusable ICE servers instead of failing to construct', () => {
    const link = new PeerLink({
      iceServers: [
        { urls: 'stun:ok.example.test:3478' },
        { urls: 'https://not-ice.example' },
        { urls: ['turn:relay.example.test:3478'] }, // TURN without credentials
      ],
      isOfferer: true,
      sendSignal: () => undefined,
      onOpen: () => undefined,
      onFailed: () => undefined,
      onLost: () => undefined,
    });
    const pc = network.peers[0]!;
    expect(pc.config.iceServers).toEqual([{ urls: ['stun:ok.example.test:3478'] }]);
    expect(link.diagnostics()).toMatchObject({ stunServers: 1, turnServers: 0 });
    link.close();
  });
});

// @vitest-environment jsdom
/**
 * QuickSession end to end in-process: the real SessionManager relays
 * signaling, a scripted network decides what can connect. Covers connecting,
 * automatic recovery from a failed attempt (no button needed on either
 * device), explained failures in sync on both devices, "Try again" within the
 * same session, stale attempts, repairs after a dropped path and setup
 * timeouts. These sessions have no relay mode (see quickRelay.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CONNECTION_ATTEMPTS } from '../../src/shared/constants';
import { TransferEngine } from '../../src/client/transfer/engine';
import { QuickSession } from '../../src/client/transfer/quickSession';
import {
  FakeNetwork,
  LoopbackSignaling,
  type FakePeerConnection,
  type LoopbackTransport,
} from '../helpers/fakeWebRtc';

describe('QuickSession', () => {
  let network: FakeNetwork;
  let server: LoopbackSignaling;
  const sessions: QuickSession[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    network = new FakeNetwork().install();
    server = new LoopbackSignaling();
  });
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const settle = (ms = 300) => vi.advanceTimersByTimeAsync(ms);

  function device() {
    let transport: LoopbackTransport | null = null;
    const session = new QuickSession({
      createSignaling: () => (transport = server.transport()),
    });
    sessions.push(session);
    return {
      session,
      get state() {
        return session.getSnapshot();
      },
      get transport() {
        return transport!;
      },
    };
  }

  /** A receiving host and a sending guest that joined by link. */
  async function pairDevices() {
    const host = device();
    const guest = device();
    await host.session.host('receiver');
    await settle();
    await guest.session.join({ via: 'link', sessionId: host.state.session!.id });
    await settle();
    return { host, guest };
  }

  /** Records every phase a device goes through. */
  function phases(target: ReturnType<typeof device>) {
    const seen: string[] = [];
    target.session.subscribe(() => {
      const phase = target.state.phase;
      if (seen.at(-1) !== phase) seen.push(phase);
    });
    return seen;
  }

  /** The kinds of signal payloads relayed so far. */
  const relayedKinds = () =>
    server.relayed.map((message) => message.type === 'signal' && message.payload.kind);

  const lastPc = (index: 0 | 1) => {
    const pcs = network.peers.filter((pc) => pc.index % 2 === index) as FakePeerConnection[];
    return pcs[pcs.length - 1]!;
  };

  it('connects two devices and lets signaling idle once they talk directly', async () => {
    const { host, guest } = await pairDevices();
    expect(host.state.phase).toBe('connected');
    expect(guest.state.phase).toBe('connected');
    expect(host.state.route).toBe('direct');
    expect(host.transport.paces.at(-1)).toBe('quiet');
    expect(guest.transport.paces.at(-1)).toBe('quiet');
  });

  it('ends the session at once when the other device leaves on purpose', async () => {
    const { host, guest } = await pairDevices();
    server.sessions.leave(guest.transport.peer, 'left'); // e.g. its page was closed
    await settle(50);
    expect(host.state).toMatchObject({ phase: 'disconnected', error: 'connection-lost' });
  });

  it('keeps a working direct connection when the other device only went quiet', async () => {
    const { host, guest } = await pairDevices();
    // The server lost track of the guest (e.g. its page sat in the background, or its
    // server connection dropped), but the direct connection is fine.
    server.sessions.leave(guest.transport.peer, 'gone');
    await settle();
    expect(host.state.phase).toBe('connected');
    expect(host.state.error).toBeNull();

    // Files still flow…
    guest.session.setFiles([new File(['hello, other network'], 'note.txt')]);
    expect(guest.session.send()).toBe(true);
    await settle();
    host.session.accept();
    await settle(500);
    expect(host.state.phase).toBe('completed');
    expect(await host.state.received[0]!.blob.text()).toBe('hello, other network');

    // …and a real departure still arrives, over the data channel.
    guest.session.dispose();
    await settle();
    expect(host.state.phase).toBe('disconnected');
    expect(host.state.error).toBe('peer-ended');
  });

  it('connects after a failed first attempt without anyone pressing a button', async () => {
    // The first negotiation can't connect (a Wi-Fi hiccup, a device that answered late);
    // the next one can.
    let blocked = true;
    network.canConnect = () => !blocked;
    const host = device();
    const guest = device();
    const hostPhases = phases(host);
    const guestPhases = phases(guest);
    await host.session.host('receiver');
    await settle();
    await guest.session.join({ via: 'link', sessionId: host.state.session!.id });
    await settle(150); // the first attempt has failed on both devices…
    expect(network.peers.every((pc) => pc.closed)).toBe(true);
    expect(host.state).toMatchObject({ phase: 'connecting', recovering: true, error: null });
    expect(guest.state).toMatchObject({ phase: 'connecting', recovering: true, error: null });
    blocked = false;
    await settle(1_500); // …and the sender started the next one by itself
    expect(relayedKinds()).toContain('retry');
    expect(host.state).toMatchObject({ phase: 'connected', recovering: false, route: 'direct' });
    expect(guest.state).toMatchObject({ phase: 'connected', recovering: false, route: 'direct' });
    // Neither device ever showed an error.
    expect(hostPhases).not.toContain('failed');
    expect(guestPhases).not.toContain('failed');
    expect(network.peers).toHaveLength(4);
  });

  it('retries automatically when the sending device is the host, too', async () => {
    let blocked = true;
    network.canConnect = () => !blocked;
    const host = device();
    const guest = device();
    await host.session.host('sender');
    await settle();
    await guest.session.join({ via: 'link', sessionId: host.state.session!.id });
    await settle(150);
    expect(host.state.recovering).toBe(true);
    blocked = false;
    await settle(1_500);
    expect(relayedKinds()).not.toContain('retry'); // the host starts attempts itself
    expect(host.state.phase).toBe('connected');
    expect(guest.state.phase).toBe('connected');
  });

  it('explains a failure on both devices at once when nothing works, then "Try again"', async () => {
    network.canConnect = () => false;
    const { host, guest } = await pairDevices();
    await settle(1_500); // the automatic attempt fails too
    for (const side of [host, guest]) {
      expect(side.state).toMatchObject({
        phase: 'failed',
        error: 'connection-failed',
        canRetry: true,
        recovering: false,
      });
    }
    // The sender said it had nothing left to try, so the receiver didn't wait any longer.
    expect(relayedKinds()).toContain('gave-up');
    expect(host.state.failure?.cause).toBe('incompatible-networks');
    expect(host.state.failure?.diagnostics.attempt).toBe(1);
    expect(host.transport.paces.at(-1)).toBe('standby');

    network.restoreLinks();
    guest.session.retryConnection();
    expect(guest.state).toMatchObject({ phase: 'connecting', recovering: false });
    await settle();
    expect(host.state.phase).toBe('connected');
    expect(guest.state.phase).toBe('connected');
    expect(host.state.failure).toBeNull();
    // Attempts 0 and 1 (automatic) failed; "Try again" made attempt 2 on both sides.
    expect(lastPc(0).localDescription?.sdp).toContain('pc4');
    expect(network.peers).toHaveLength(6);
  });

  it('reconnects with "Try again" on the host', async () => {
    network.canConnect = () => false;
    const { host, guest } = await pairDevices();
    await settle(1_500);
    expect(host.state.canRetry).toBe(true);
    network.restoreLinks();
    host.session.retryConnection();
    await settle();
    expect(host.state.phase).toBe('connected');
    expect(guest.state.phase).toBe('connected');
  });

  it('drops signals that belong to an abandoned attempt', async () => {
    network.canConnect = () => false;
    const { host, guest } = await pairDevices();
    await settle(1_500);
    network.restoreLinks();
    host.session.retryConnection();
    await settle();
    expect(host.state.phase).toBe('connected');

    const stale = 'candidate:9 1 udp 2113937151 stale.local 40000 typ host generation 0';
    server.sessions.relay(guest.transport.peer, {
      kind: 'candidate',
      candidate: { candidate: stale, sdpMid: '0', sdpMLineIndex: 0 },
      attempt: 0,
    });
    await settle();
    expect(network.peers.flatMap((pc) => pc.addedCandidates)).not.toContain(stale);
    expect(host.state.phase).toBe('connected');
  });

  it('stops offering "Try again" after the last attempt', async () => {
    network.canConnect = () => false;
    const { host } = await pairDevices();
    await settle(1_500);
    let presses = 0;
    while (host.state.canRetry) {
      host.session.retryConnection();
      presses += 1;
      await settle(1_500);
      expect(host.state.phase).toBe('failed');
    }
    // Every negotiation counts, automatic ones included; the cap holds.
    expect(host.state.failure?.diagnostics.attempt).toBe(MAX_CONNECTION_ATTEMPTS - 1);
    expect(network.peers).toHaveLength(2 * MAX_CONNECTION_ATTEMPTS);
    expect(presses).toBeLessThan(MAX_CONNECTION_ATTEMPTS);
  });

  it('shows "reconnecting" while a dropped path is repaired', async () => {
    const { host, guest } = await pairDevices();
    network.dropLinks();
    expect(host.state.reconnecting).toBe(true);
    expect(guest.state.reconnecting).toBe(true);
    expect(host.transport.paces.at(-1)).toBe('normal'); // restart offers should travel fast
    network.restoreLinks();
    await settle(3_000);
    expect(host.state.reconnecting).toBe(false);
    expect(host.state.phase).toBe('connected');
    expect(host.transport.paces.at(-1)).toBe('quiet');
  });

  it('reports a lost connection when a dropped path never comes back', async () => {
    const { host, guest } = await pairDevices();
    network.dropLinks();
    await settle(44_000);
    expect(host.state).toMatchObject({ phase: 'connected', reconnecting: true });
    await settle(2_000);
    for (const device of [host, guest]) {
      expect(device.state).toMatchObject({
        phase: 'disconnected',
        error: 'connection-lost',
        reconnecting: false,
      });
    }
  });

  it('fails a session the server never confirms', async () => {
    server.responsive = false;
    const host = device();
    await host.session.host('receiver');
    await settle(19_000);
    expect(host.state.phase).toBe('creating-session');
    await settle(1_000);
    expect(host.state).toMatchObject({ phase: 'failed', error: 'signaling-unavailable' });
  });

  it('gives up on "Try again" when the host never answers', async () => {
    network.canConnect = () => false;
    const { guest } = await pairDevices();
    await settle(1_500);
    server.responsive = false;
    guest.session.retryConnection();
    await settle(29_000);
    expect(guest.state.phase).toBe('connecting');
    await settle(1_000);
    expect(guest.state).toMatchObject({ phase: 'failed', error: 'connection-failed' });
    expect(guest.state.failure?.cause).toBe('no-remote-details');
  });

  it('keeps explaining the failure when the other device leaves', async () => {
    network.canConnect = () => false;
    const { host, guest } = await pairDevices();
    await settle(1_500);
    guest.session.dispose();
    await settle();
    expect(host.state).toMatchObject({
      phase: 'failed',
      error: 'connection-failed',
      canRetry: false,
    });
  });

  it('stops waiting for the sender after a while if it never takes the next step', async () => {
    network.canConnect = () => false;
    const host = device();
    const guest = device();
    await host.session.host('receiver');
    await settle();
    await guest.session.join({ via: 'link', sessionId: host.state.session!.id });
    // The sender's messages stop reaching the server (its page froze, say).
    await settle(50);
    guest.transport.close = () => undefined;
    (guest.transport as unknown as { open: boolean }).open = false;
    await settle(150);
    expect(host.state).toMatchObject({ phase: 'connecting', recovering: true });
    await settle(29_000);
    expect(host.state.phase).toBe('connecting');
    await settle(1_000);
    expect(host.state).toMatchObject({ phase: 'failed', error: 'connection-failed' });
    expect(host.state.failure?.diagnostics.attempt).toBe(0);
  });

  it('ignores a "gave up" from an attempt that is already over', async () => {
    const { host, guest } = await pairDevices();
    expect(host.state.phase).toBe('connected');
    server.sessions.relay(guest.transport.peer, { kind: 'gave-up', attempt: 0 });
    await settle();
    expect(host.state.phase).toBe('connected');
    expect(host.state.error).toBeNull();
  });

  it('ignores a late offer from an abandoned attempt once connected', async () => {
    let blocked = true;
    network.canConnect = () => !blocked;
    const host = device();
    const guest = device();
    await host.session.host('sender');
    await settle();
    await guest.session.join({ via: 'link', sessionId: host.state.session!.id });
    await settle(150);
    blocked = false;
    await settle(1_500);
    expect(guest.state.phase).toBe('connected');
    const pcs = network.peers.length;
    // A delayed copy of attempt 0's offer.
    server.sessions.relay(host.transport.peer, {
      kind: 'description',
      description: { type: 'offer', sdp: 'v=0 fake ufrag=stale' },
      attempt: 0,
    });
    await settle();
    expect(guest.state.phase).toBe('connected');
    expect(network.peers).toHaveLength(pcs); // no new negotiation started
  });

  it('starts one session when asked twice in a row', async () => {
    const host = device();
    void host.session.host('receiver');
    await host.session.host('receiver');
    await settle();
    expect(host.state.phase).toBe('waiting-for-peer');
    expect(server.sessions.sessionCount).toBe(1);
  });

  it('takes the next step at once when only the receiver noticed the failure', async () => {
    network.canConnect = () => false;
    network.failAfterMs = 60_000; // the sender's browser would keep checking until its timeout
    const { host, guest } = await pairDevices();
    expect(guest.state.phase).toBe('connecting');
    // Only the receiving host's side reports the failure (say, its network blocks UDP).
    const hostPc = network.peers.find((pc) => !pc.closed && pc.localDescription?.type === 'offer');
    hostPc!.setIce('failed');
    await settle(1_500);
    expect(relayedKinds()).toContain('attempt-failed');
    expect(relayedKinds()).toContain('retry'); // the sender went on, ~29 s early
    expect(guest.state.recovering || guest.state.phase === 'connecting').toBe(true);
    expect(host.state.phase).not.toBe('failed');
  });

  it('doesn’t keep "connecting" forever when the channel opens but nothing answers on it', async () => {
    // Neither side's hello gets through on the first attempt.
    const start = vi.spyOn(TransferEngine.prototype, 'start').mockImplementation(() => undefined);
    const { host, guest } = await pairDevices();
    expect(guest.state.phase).toBe('connecting');
    await settle(14_000);
    expect(guest.state.phase).toBe('connecting');
    start.mockRestore();
    await settle(3_000); // the wait ran out, and the sender's automatic attempt connected
    expect(host.state.phase).toBe('connected');
    expect(guest.state.phase).toBe('connected');
    expect(relayedKinds()).toContain('retry');
  });
});

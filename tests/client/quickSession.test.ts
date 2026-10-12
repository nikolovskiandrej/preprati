// @vitest-environment jsdom
/**
 * QuickSession end to end in-process: the real SessionManager relays
 * signaling, a scripted network decides what can connect. Covers connecting,
 * explained failures, "Try again" within the same session, stale attempts,
 * repairs after a dropped path and setup timeouts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CONNECTION_ATTEMPTS } from '../../src/shared/constants';
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

  it('explains a failed connection and reconnects with "Try again" on the guest', async () => {
    network.canConnect = () => false;
    const { host, guest } = await pairDevices();
    expect(host.state).toMatchObject({
      phase: 'failed',
      error: 'connection-failed',
      canRetry: true,
    });
    expect(guest.state).toMatchObject({
      phase: 'failed',
      error: 'connection-failed',
      canRetry: true,
    });
    expect(host.state.failure?.cause).toBe('incompatible-networks');
    expect(host.transport.paces.at(-1)).toBe('standby');

    network.restoreLinks();
    guest.session.retryConnection();
    expect(guest.state.phase).toBe('connecting');
    await settle();
    expect(
      server.relayed.map((message) => message.type === 'signal' && message.payload.kind),
    ).toContain('retry');
    expect(host.state.phase).toBe('connected');
    expect(guest.state.phase).toBe('connected');
    expect(host.state.failure).toBeNull();
    // The second negotiation is attempt 1 on both sides.
    expect(lastPc(0).localDescription?.sdp).toContain('pc2');
    expect(network.peers).toHaveLength(4);
  });

  it('reconnects with "Try again" on the host', async () => {
    network.canConnect = () => false;
    const { host, guest } = await pairDevices();
    network.restoreLinks();
    host.session.retryConnection();
    await settle();
    expect(host.state.phase).toBe('connected');
    expect(guest.state.phase).toBe('connected');
  });

  it('drops signals that belong to an abandoned attempt', async () => {
    network.canConnect = () => false;
    const { host, guest } = await pairDevices();
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
    for (let attempt = 1; attempt < MAX_CONNECTION_ATTEMPTS; attempt++) {
      expect(host.state.canRetry).toBe(true);
      host.session.retryConnection();
      await settle();
      expect(host.state.failure?.diagnostics.attempt).toBe(attempt);
    }
    expect(host.state.canRetry).toBe(false);
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
    await settle(24_000);
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
    guest.session.dispose();
    await settle();
    expect(host.state).toMatchObject({
      phase: 'failed',
      error: 'connection-failed',
      canRetry: false,
    });
  });
});

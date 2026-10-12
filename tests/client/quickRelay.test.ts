// @vitest-environment jsdom
/**
 * Relay mode end to end in-process: the scripted network lets nothing
 * connect, the sender switches the session to "Send through preprati.", and
 * the files arrive through (in-memory) storage while the real SessionManager
 * relays the encrypted control messages. Real timers: the key agreement uses
 * real Web Crypto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransferRole } from '../../src/shared/signaling';
import { QuickSession, type QuickSessionOptions } from '../../src/client/transfer/quickSession';
import { createRelayKeyPair } from '../../src/client/transfer/relayCrypto';
import { FakeNetwork, LoopbackSignaling, type LoopbackTransport } from '../helpers/fakeWebRtc';
import { MemoryStorage } from '../helpers/memoryRelayStorage';

const LIMITS = { maxFiles: 100, maxFileBytes: 1_000_000, maxPackageBytes: 2_000_000 };

async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('QuickSession relay mode', () => {
  let network: FakeNetwork;
  let server: LoopbackSignaling;
  let storage: MemoryStorage;
  const sessions: QuickSession[] = [];

  beforeEach(() => {
    network = new FakeNetwork().install();
    network.canConnect = () => false; // e.g. one Wi-Fi that keeps its devices apart
    server = new LoopbackSignaling();
    storage = new MemoryStorage();
  });
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    vi.unstubAllGlobals();
  });

  type RelayOverrides = Partial<NonNullable<QuickSessionOptions['relay']>>;

  function device(options: QuickSessionOptions = {}, relay: RelayOverrides = {}) {
    let transport: LoopbackTransport | null = null;
    const session = new QuickSession({
      createSignaling: () => (transport = server.transport()),
      relay: { storage, limits: LIMITS, ttlSeconds: 86_400, ...relay },
      ...options,
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

  async function pair(
    hostRole: TransferRole,
    {
      host: hostOptions = {},
      guestRelay = {},
    }: { host?: QuickSessionOptions; guestRelay?: RelayOverrides } = {},
  ) {
    const host = device(hostOptions);
    const guest = device({}, guestRelay);
    await host.session.host(hostRole);
    await until(() => !!host.state.session);
    await guest.session.join({ via: 'link', sessionId: host.state.session!.id });
    return { host, guest };
  }

  async function pairFailed(hostRole: TransferRole, options: Parameters<typeof pair>[1] = {}) {
    const devices = await pair(hostRole, options);
    await until(
      () => devices.host.state.phase === 'failed' && devices.guest.state.phase === 'failed',
    );
    return devices;
  }

  it('sends the files through preprati. when the devices can’t connect directly', async () => {
    const { host, guest } = await pairFailed('receiver');
    // Only the sender can choose it; the receiver knows it exists.
    expect(host.state).toMatchObject({ error: 'connection-failed', canRelay: false });
    expect(host.state.relay).toEqual({ limits: LIMITS, ttlSeconds: 86_400 });
    expect(guest.state).toMatchObject({ role: 'sender', canRelay: true, canRetry: true });

    guest.session.setFiles([
      new File(['hello through the relay'], 'note.txt', { type: 'text/plain' }),
    ]);
    guest.session.useRelay();
    expect(guest.state).toMatchObject({ phase: 'connecting', route: 'server', canRelay: false });

    // The chosen files are offered as soon as both devices hold the key.
    await until(() => host.state.phase === 'awaiting-acceptance');
    expect(host.state.route).toBe('server');
    expect(host.state.transfer?.files.map((file) => file.name)).toEqual(['note.txt']);
    host.session.accept();
    await until(() => host.state.phase === 'completed' && guest.state.phase === 'completed');
    expect(await host.state.received[0]!.blob.text()).toBe('hello through the relay');
    expect(storage.packages.size).toBe(0); // deleted once delivered

    // End to end: the server relayed neither the file name nor the package key.
    const relayed = JSON.stringify(server.relayed);
    expect(relayed).not.toContain('note.txt');
    expect(relayed).not.toContain(storage.secrets[0]);
    // Signaling polls steadily while the transfer reports progress, and idles afterwards.
    expect(guest.transport.paces).toContain('live');
    expect(guest.transport.paces.at(-1)).toBe('standby');
    expect(host.transport.paces.at(-1)).toBe('standby');
  });

  it('offers a sending host’s files as soon as relay mode is up', async () => {
    const { host, guest } = await pairFailed('sender', { host: { autoOffer: true } });
    host.session.setFiles([new File(['abc'], 'a.txt')]);
    expect(host.state.canRelay).toBe(true);
    host.session.useRelay();
    await until(() => guest.state.phase === 'awaiting-acceptance');
    guest.session.accept();
    await until(() => guest.state.phase === 'completed' && host.state.phase === 'completed');
    expect(guest.state.received.map((file) => file.name)).toEqual(['a.txt']);
  });

  it('can replace a direct attempt that is still trying', async () => {
    network.failAfterMs = 60_000; // connectivity checks that would take a minute to fail
    const { host, guest } = await pair('receiver');
    await until(() => guest.state.phase === 'connecting' && host.state.phase === 'connecting');
    expect(guest.state.canRelay).toBe(true);
    guest.session.setFiles([new File(['quick'], 'q.txt')]);
    guest.session.useRelay();
    await until(() => host.state.phase === 'awaiting-acceptance');
    expect(network.peers.every((pc) => pc.closed)).toBe(true); // both direct attempts ended
    host.session.accept();
    await until(() => host.state.phase === 'completed');
  });

  it('tells the sender when the other device doesn’t answer, and lets it try again', async () => {
    const { host, guest } = await pairFailed('receiver', { guestRelay: { answerTimeoutMs: 300 } });
    // This receiver can't relay (no share storage on its side, say).
    (host.session as unknown as { relaySetup: null }).relaySetup = null;
    guest.session.setFiles([new File(['x'], 'x.txt')]);
    guest.session.useRelay();
    await until(() => guest.state.error === 'relay-unanswered');
    expect(guest.state).toMatchObject({ phase: 'failed', canRelay: true, canRetry: true });
  });

  it('completes relay mode when the answer comes after the sender stopped waiting', async () => {
    const { host, guest } = await pairFailed('receiver', { guestRelay: { answerTimeoutMs: 1 } });
    guest.session.setFiles([new File(['late'], 'late.txt')]);
    guest.session.useRelay();
    await until(() => host.state.phase === 'awaiting-acceptance');
    expect(guest.state).toMatchObject({ route: 'server', error: null });
    host.session.accept();
    await until(() => host.state.phase === 'completed');
  });

  it('ignores an answer meant for a proposal it didn’t make', async () => {
    const { host, guest } = await pairFailed('receiver', {
      guestRelay: { answerTimeoutMs: 5_000 },
    });
    (host.session as unknown as { relaySetup: null }).relaySetup = null; // the receiver stays silent
    guest.session.setFiles([new File(['x'], 'x.txt')]);
    guest.session.useRelay();
    await until(() =>
      server.relayed.some((m) => m.type === 'signal' && m.payload.kind === 'relay-hello'),
    );
    // An answer to some other proposal (an older one, or one the server made up).
    const [stranger, other] = [await createRelayKeyPair(), await createRelayKeyPair()];
    guest.transport.peer.send({
      type: 'signal',
      payload: { kind: 'relay-hello', key: stranger.publicKey, reply: other.publicKey },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(guest.state).toMatchObject({ phase: 'connecting', route: 'server' }); // still waiting
  });

  it('explains it when the other device leaves a relayed session', async () => {
    const { host, guest } = await pairFailed('receiver');
    guest.session.useRelay();
    await until(() => host.state.phase === 'connected' && guest.state.phase === 'connected');
    expect(host.state.route).toBe('server');
    guest.session.dispose(); // "End session" or a closed page
    await until(() => host.state.phase === 'disconnected');
    expect(host.state.error).toBe('peer-ended');
  });
});

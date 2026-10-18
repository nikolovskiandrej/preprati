// @vitest-environment jsdom
/**
 * What people see when two devices can't connect: while the app recovers on
 * its own, a status that says so (and asks for nothing); after that, a
 * cause-specific explanation, the actions that apply (relay mode first, where
 * it works), technical details on request, and the hand-off of the selected
 * files to Share Files.
 */
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { describeQuickError } from '../../src/client/features/quick/errors';
import { ConnectingStatus, QuickError, RelayNote } from '../../src/client/features/quick/panels';
import { handOffFiles, handedOffFiles } from '../../src/client/lib/handoff';
import ShareScreen from '../../src/client/screens/ShareScreen';
import type { ConnectionDiagnostics, FailureCause } from '../../src/client/transfer/diagnostics';
import type { QuickState } from '../../src/client/transfer/quickSession';
import { renderWithProviders } from './render';

const diagnostics: ConnectionDiagnostics = {
  attempt: 0,
  stunServers: 2,
  turnServers: 0,
  local: { host: 1, srflx: 1, relay: 0, strictNat: false },
  remote: { host: 1, srflx: 2, relay: 0, strictNat: true },
  iceStates: [
    { state: 'checking', atMs: 400 },
    { state: 'failed', atMs: 15_500 },
  ],
  durationMs: 15_600,
  restarts: 0,
  sameNetwork: false,
};

function failedState(cause: FailureCause, overrides: Partial<QuickState> = {}): QuickState {
  return {
    phase: 'failed',
    isHost: true,
    role: 'sender',
    session: null,
    peer: { label: 'Android · Chrome', via: 'link' },
    route: null,
    reconnecting: false,
    recovering: false,
    pendingFiles: [],
    transfer: null,
    rate: null,
    received: [],
    error: 'connection-failed',
    failure: { cause, diagnostics },
    canRetry: true,
    relay: null,
    canRelay: false,
    ...overrides,
  };
}

describe('a failed connection', () => {
  it.each([
    ['incompatible-networks', /their networks don’t allow a direct connection/],
    ['local-network', /This device’s network blocks direct connections/],
    ['remote-network', /The other device’s network blocks direct connections/],
    ['no-remote-details', /didn’t answer in time/],
    ['same-network-only', /connects devices directly only when they’re on the same network/],
    ['same-network-blocked', /Both devices are on the same network, but it doesn’t let them/],
  ] as const)('explains %s in plain language', (cause, message) => {
    const view = describeQuickError(failedState(cause))!;
    renderWithProviders(<QuickError view={view} device="Android · Chrome" actions={null} />);
    expect(screen.getByText('Couldn’t connect the devices')).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('points senders and receivers to a share link only where sharing works', () => {
    const sender = describeQuickError(failedState('incompatible-networks'), {
      shareAvailable: true,
    })!;
    expect(sender.hint).toBe('errors.connectionLinkSender');
    expect(sender.connection).toEqual({ canRetry: true, canRelay: false, diagnostics });
    const receiver = describeQuickError(
      failedState('incompatible-networks', { role: 'receiver' }),
      {
        shareAvailable: true,
      },
    )!;
    expect(receiver.hint).toBe('errors.connectionLinkReceiver');
    expect(describeQuickError(failedState('incompatible-networks'))!.hint).toBeUndefined();
  });

  const relay = {
    limits: { maxFiles: 100, maxFileBytes: 100_000_000, maxPackageBytes: 100_000_000 },
    ttlSeconds: 86_400,
  };

  it('offers relay mode to the sender, and no relay instructions to the receiver', () => {
    const sender = describeQuickError(
      failedState('same-network-blocked', { relay, canRelay: true }),
      { shareAvailable: true },
    )!;
    expect(sender.connection).toMatchObject({ canRetry: true, canRelay: true });
    expect(sender.hint).toBeUndefined(); // the button says it

    // The sending device switches to relay mode by itself when it can; a failure that still
    // reaches the receiver is one that relay mode couldn't fix, so it isn't suggested there.
    const receiver = describeQuickError(
      failedState('same-network-blocked', { role: 'receiver', isHost: false, relay }),
      { shareAvailable: true },
    )!;
    expect(receiver.hint).toBe('errors.connectionLinkReceiver');
    renderWithProviders(<QuickError view={receiver} device="Android · Chrome" actions={null} />);
    expect(screen.queryByText(/choose “Send through preprati.”/)).not.toBeInTheDocument();
  });

  it('explains what relay mode does with the files, and its size limit', () => {
    const files = [new File(['x'.repeat(10)], 'a.txt')];
    const { unmount } = renderWithProviders(
      <RelayNote device="Android · Chrome" relay={relay} files={files} />,
    );
    expect(
      screen.getByText(
        /keeps them only until Android · Chrome has them, and never longer than 24 hours/,
      ),
    ).toBeInTheDocument();
    unmount();
    const tooLarge = { ...relay, limits: { ...relay.limits, maxPackageBytes: 5, maxFileBytes: 5 } };
    renderWithProviders(<RelayNote device="Android · Chrome" relay={tooLarge} files={files} />);
    expect(screen.getByText(/Up to 5 B can go through preprati. at once/)).toBeInTheDocument();
  });

  it('shows what each side found on request, without addresses', async () => {
    const user = userEvent.setup();
    const view = describeQuickError(failedState('incompatible-networks'))!;
    renderWithProviders(<QuickError view={view} device="Android · Chrome" actions={null} />);
    const toggle = screen.getByText('Connection details');
    expect(screen.getByText('Public address found (strict NAT)')).not.toBeVisible();
    await user.click(toggle);
    expect(screen.getByText('This device').nextSibling).toHaveTextContent('Public address found');
    expect(screen.getByText('Other device').nextSibling).toHaveTextContent(
      'Public address found (strict NAT)',
    );
    expect(screen.getByText('Relay server').nextSibling).toHaveTextContent(
      'Not set up on this server',
    );
    expect(screen.getByText('Network').nextSibling).toHaveTextContent(
      'Different from the other device',
    );
    expect(screen.getByText('Attempt 1, stopped after 16 s')).toBeVisible();
  });

  it('is described in Macedonian too', () => {
    const view = describeQuickError(failedState('local-network'))!;
    renderWithProviders(<QuickError view={view} device="Android · Chrome" actions={null} />, {
      locale: 'mk',
    });
    expect(screen.getByText('Уредите не можеа да се поврзат')).toBeInTheDocument();
    expect(screen.getByText(/Мрежата на овој уред блокира/)).toBeInTheDocument();
    expect(screen.getByText('Детали за врската')).toBeInTheDocument();
  });

  it('hands the selected files over to Share Files', () => {
    handOffFiles([new File(['report'], 'report.pdf', { type: 'application/pdf' })]);
    renderWithProviders(<ShareScreen />, { path: '/share' });
    expect(screen.getByText('report')).toBeInTheDocument(); // the name, shown without extension
    expect(screen.getByText(/1 file selected/)).toBeInTheDocument();
    expect(handedOffFiles()).toEqual([]); // used once
  });

  it('says the app is trying another way, with nothing to press, while it recovers', () => {
    const action = <button type="button">Send through preprati. instead</button>;
    const { unmount } = renderWithProviders(
      <ConnectingStatus device="Android · Chrome" recovering slowAction={action} />,
    );
    expect(screen.getByText('Connecting to Android · Chrome…')).toBeInTheDocument();
    expect(screen.getByText(/trying another way\. You don’t need to do anything/)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<ConnectingStatus device="Android · Chrome" recovering viaServer />);
    expect(screen.getByText('Connecting to Android · Chrome through preprati.…')).toBeVisible();
    expect(screen.getByText(/A direct connection wasn’t possible/)).toBeVisible();
  });

  it('tells a slow connection that it will switch by itself when it can', () => {
    vi.useFakeTimers();
    try {
      renderWithProviders(<ConnectingStatus device="Android · Chrome" autoFallback />);
      expect(screen.getByText('Setting up a direct, encrypted connection.')).toBeVisible();
      act(() => void vi.advanceTimersByTime(9_000));
      expect(screen.getByText(/switches to another way on its own/)).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });
});

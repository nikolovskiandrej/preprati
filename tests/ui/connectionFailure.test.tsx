// @vitest-environment jsdom
/**
 * What people see when two devices can't connect: a cause-specific
 * explanation, the actions that apply, technical details on request, and
 * the hand-off of the selected files to Share Files.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { describeQuickError } from '../../src/client/features/quick/errors';
import { QuickError } from '../../src/client/features/quick/panels';
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
    pendingFiles: [],
    transfer: null,
    rate: null,
    received: [],
    error: 'connection-failed',
    failure: { cause, diagnostics },
    canRetry: true,
    ...overrides,
  };
}

describe('a failed connection', () => {
  it.each([
    ['incompatible-networks', /their networks don’t allow a direct connection/],
    ['local-network', /This device’s network blocks direct connections/],
    ['remote-network', /The other device’s network blocks direct connections/],
    ['no-remote-details', /didn’t answer in time/],
    ['same-network-only', /only connects devices on the same network/],
  ] as const)('explains %s in plain language', (cause, message) => {
    const view = describeQuickError(failedState(cause))!;
    renderWithProviders(<QuickError view={view} actions={null} />);
    expect(screen.getByText('Couldn’t connect the devices')).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('points senders and receivers to a share link only where sharing works', () => {
    const sender = describeQuickError(failedState('incompatible-networks'), {
      shareAvailable: true,
    })!;
    expect(sender.hint).toBe('errors.connectionLinkSender');
    expect(sender.connection).toEqual({ canRetry: true, diagnostics });
    const receiver = describeQuickError(
      failedState('incompatible-networks', { role: 'receiver' }),
      {
        shareAvailable: true,
      },
    )!;
    expect(receiver.hint).toBe('errors.connectionLinkReceiver');
    expect(describeQuickError(failedState('incompatible-networks'))!.hint).toBeUndefined();
  });

  it('shows what each side found on request, without addresses', async () => {
    const user = userEvent.setup();
    const view = describeQuickError(failedState('incompatible-networks'))!;
    renderWithProviders(<QuickError view={view} actions={null} />);
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
    expect(screen.getByText('Attempt 1, stopped after 16 s')).toBeVisible();
  });

  it('is described in Macedonian too', () => {
    const view = describeQuickError(failedState('local-network'))!;
    renderWithProviders(<QuickError view={view} actions={null} />, { locale: 'mk' });
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
});

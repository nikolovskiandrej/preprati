import type { MessageKey } from '../../i18n';
import type { ConnectionDiagnostics, FailureCause } from '../../transfer/diagnostics';
import type { TransferErrorCode } from '../../transfer/engine';
import type { QuickErrorCode, QuickState } from '../../transfer/quickSession';

export type Recovery = 'restart' | 'retry-send' | 'home' | 'rejoin';

export interface QuickErrorView {
  title: MessageKey;
  message: MessageKey;
  hint?: MessageKey;
  recovery: Recovery;
  /** Set when a connection attempt failed: "Try again", the share-link fallback and details. */
  connection?: { canRetry: boolean; diagnostics: ConnectionDiagnostics | null };
}

const BY_CODE: Record<QuickErrorCode, Omit<QuickErrorView, 'recovery'>> = {
  unsupported: { title: 'errors.titles.unsupported', message: 'errors.unsupportedWebrtc' },
  'signaling-unavailable': {
    title: 'errors.titles.signaling',
    message: 'errors.signalingUnavailable',
  },
  'session-not-found': { title: 'errors.titles.session', message: 'errors.sessionNotFound' },
  'session-expired': { title: 'errors.titles.expired', message: 'errors.sessionExpired' },
  'session-full': { title: 'errors.titles.session', message: 'errors.sessionFull' },
  'rate-limited': { title: 'errors.titles.session', message: 'errors.rateLimited' },
  'server-busy': { title: 'errors.titles.signaling', message: 'errors.serverBusy' },
  declined: { title: 'errors.titles.declined', message: 'errors.declined' },
  'peer-left': { title: 'errors.titles.disconnected', message: 'errors.peerLeft' },
  'peer-ended': { title: 'errors.titles.disconnected', message: 'errors.peerEnded' },
  'connection-failed': {
    title: 'errors.titles.connection',
    message: 'errors.connectionFailed',
    hint: 'errors.connectionFailedRelay',
  },
  'connection-lost': { title: 'errors.titles.disconnected', message: 'errors.connectionLost' },
  'protocol-error': { title: 'errors.titles.transfer', message: 'errors.protocolError' },
  'file-read-failed': { title: 'errors.titles.transfer', message: 'errors.fileReadFailed' },
  'version-mismatch': { title: 'errors.titles.connection', message: 'errors.versionMismatch' },
  internal: { title: 'errors.titles.transfer', message: 'errors.internal' },
};

/** What went wrong with a failed connection attempt, in plain language. */
const BY_CAUSE: Record<FailureCause, MessageKey> = {
  'same-network-only': 'errors.connectionSameNetwork',
  'no-remote-details': 'errors.connectionNoAnswer',
  'local-network': 'errors.connectionLocalNetwork',
  'remote-network': 'errors.connectionRemoteNetwork',
  'incompatible-networks': 'errors.connectionIncompatible',
};

const BY_TRANSFER: Record<TransferErrorCode, Omit<QuickErrorView, 'recovery'>> = {
  'connection-lost': BY_CODE['connection-lost'],
  'protocol-error': BY_CODE['protocol-error'],
  'file-read-failed': BY_CODE['file-read-failed'],
  'peer-error': { title: 'errors.titles.transfer', message: 'errors.peerError' },
};

/**
 * Describes the current failure (session-level or transfer-level) and how to
 * recover. `shareAvailable`: Share Files works on this server, so a failed
 * direct connection can point to sending the files as a link instead.
 */
export function describeQuickError(
  state: QuickState,
  { shareAvailable = false }: { shareAvailable?: boolean } = {},
): QuickErrorView | null {
  if (
    state.phase === 'expired' ||
    state.phase === 'disconnected' ||
    (state.phase === 'failed' && state.error)
  ) {
    const code: QuickErrorCode =
      state.error ?? (state.transfer?.error === 'connection-lost' ? 'connection-lost' : 'internal');
    const recovery: Recovery = state.isHost
      ? 'restart'
      : code === 'unsupported'
        ? 'home'
        : code === 'session-not-found' || code === 'session-expired' || code === 'session-full'
          ? 'rejoin'
          : 'home';
    if (code === 'connection-failed')
      return describeConnectionFailure(state, shareAvailable, recovery);
    return { ...BY_CODE[code], recovery };
  }
  if (state.phase === 'failed' && state.transfer?.error) {
    // The connection is still up; only this transfer failed.
    return { ...BY_TRANSFER[state.transfer.error], recovery: 'retry-send' };
  }
  return null;
}

function describeConnectionFailure(
  state: QuickState,
  shareAvailable: boolean,
  recovery: Recovery,
): QuickErrorView {
  const failure = state.failure;
  const linkHint: MessageKey | undefined = !shareAvailable
    ? undefined
    : state.role === 'sender'
      ? 'errors.connectionLinkSender'
      : state.role === 'receiver'
        ? 'errors.connectionLinkReceiver'
        : undefined;
  return {
    title: 'errors.titles.connection',
    message: failure ? BY_CAUSE[failure.cause] : 'errors.connectionFailed',
    hint: linkHint ?? (failure ? undefined : 'errors.connectionFailedRelay'),
    recovery,
    connection: { canRetry: state.canRetry, diagnostics: failure?.diagnostics ?? null },
  };
}

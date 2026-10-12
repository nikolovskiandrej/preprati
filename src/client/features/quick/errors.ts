import type { MessageKey } from '../../i18n';
import type { TransferErrorCode } from '../../transfer/engine';
import type { QuickErrorCode, QuickState } from '../../transfer/quickSession';

export type Recovery = 'restart' | 'retry-send' | 'home' | 'rejoin';

export interface QuickErrorView {
  title: MessageKey;
  message: MessageKey;
  hint?: MessageKey;
  recovery: Recovery;
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

const BY_TRANSFER: Record<TransferErrorCode, Omit<QuickErrorView, 'recovery'>> = {
  'connection-lost': BY_CODE['connection-lost'],
  'protocol-error': BY_CODE['protocol-error'],
  'file-read-failed': BY_CODE['file-read-failed'],
  'peer-error': { title: 'errors.titles.transfer', message: 'errors.peerError' },
};

/** Describes the current failure (session-level or transfer-level) and how to recover. */
export function describeQuickError(state: QuickState): QuickErrorView | null {
  if (
    state.phase === 'expired' ||
    state.phase === 'disconnected' ||
    (state.phase === 'failed' && state.error)
  ) {
    const code: QuickErrorCode =
      state.error ?? (state.transfer?.error === 'connection-lost' ? 'connection-lost' : 'internal');
    const view = BY_CODE[code];
    const recovery: Recovery = state.isHost
      ? 'restart'
      : code === 'unsupported'
        ? 'home'
        : code === 'session-not-found' || code === 'session-expired' || code === 'session-full'
          ? 'rejoin'
          : 'home';
    return { ...view, recovery };
  }
  if (state.phase === 'failed' && state.transfer?.error) {
    // The connection is still up; only this transfer failed.
    return { ...BY_TRANSFER[state.transfer.error], recovery: 'retry-send' };
  }
  return null;
}

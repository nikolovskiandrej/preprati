import { useWakeLock } from '../../app/hooks';
import type { QuickState } from '../../transfer/quickSession';

const ENDED = new Set(['idle', 'failed', 'expired', 'disconnected']);

/**
 * Keeps a phone's screen on while its Quick Transfer session is live —
 * pairing, connecting, transferring, or connected and ready for more — and
 * lets it go five minutes after the last visible change (see useWakeLock).
 */
export function useSessionWakeLock(state: QuickState | null): void {
  const phase = state?.phase ?? 'idle';
  const transfer = state?.transfer ?? null;
  const progress =
    transfer && transfer.totalBytes > 0
      ? Math.floor((transfer.transferredBytes / transfer.totalBytes) * 20)
      : 0;
  useWakeLock(
    !ENDED.has(phase) || state?.reconnecting === true,
    `${phase}:${transfer?.id ?? ''}:${transfer?.stage ?? ''}:${progress}`,
  );
}

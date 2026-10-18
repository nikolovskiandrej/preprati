/**
 * Signaling lifecycle events for the server log, so that a connection problem
 * can be followed afterwards: pairing, the recovery steps two devices take
 * when a direct attempt fails (another attempt, relay mode, giving up),
 * departures and expiry. A session appears as a short tag derived from its
 * id — enough to group one session's events, useless for joining it. Codes,
 * device labels, addresses and signal contents are never logged.
 */
import { createHash } from 'node:crypto';
import type { SignalPayload } from '../../shared/signaling';

export type SignalingEvent =
  | 'session-created'
  | 'device-joined'
  | 'join-failed'
  | 'peer-approved'
  | 'peer-declined'
  | 'recovery'
  | 'peer-left'
  | 'session-locked'
  | 'session-reopened'
  | 'session-expired'
  | 'session-closed';

export type SignalingLog = (
  event: SignalingEvent,
  details: Record<string, string | number | boolean>,
) => void;

export function sessionTag(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
}

/**
 * The recovery step a signal stands for, if any (the WebRTC negotiation
 * itself — descriptions, candidates — and relay-mode traffic are not logged).
 */
export function recoveryStep(payload: SignalPayload): Record<string, string | number> | null {
  switch (payload.kind) {
    case 'retry':
    case 'attempt-failed':
    case 'gave-up':
      return { step: payload.kind, attempt: payload.attempt };
    case 'relay-hello':
      return { step: payload.reply ? 'relay-accepted' : 'relay-proposed' };
    default:
      return null;
  }
}

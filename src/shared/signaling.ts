/**
 * Signaling protocol (WebSocket, JSON messages).
 *
 * The signaling server only helps two browsers find each other and exchange
 * WebRTC session descriptions and ICE candidates. File contents never travel
 * over this channel — they flow over the RTCDataChannel (see
 * src/client/transfer/protocol.ts), or, when the devices can't connect
 * directly, through encrypted temporary storage ("relay mode", see
 * src/client/transfer/relay.ts). Relay mode's control messages travel here,
 * end-to-end encrypted: the server only sees opaque ciphertext.
 *
 * Every inbound message is validated with these schemas on the server; the
 * client validates server messages with the same schemas.
 */
import { z } from 'zod';
import { DEVICE_LABEL_MAX_LENGTH, PAIRING_CODE_PATTERN, RANDOM_ID_PATTERN } from './constants';

export const TransferRoleSchema = z.enum(['sender', 'receiver']);
export type TransferRole = z.infer<typeof TransferRoleSchema>;

export const DeviceInfoSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(DEVICE_LABEL_MAX_LENGTH)
    // Control characters have no business in a device label.
    .regex(/^[^\p{Cc}\p{Cf}]+$/u),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const SessionDescriptionSchema = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().min(1).max(64_000),
});

export const IceCandidateSchema = z.object({
  candidate: z.string().max(2_048),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(255).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

/**
 * Connection attempt a payload belongs to (absent = 0, the first). "Try again"
 * renegotiates from scratch as attempt n+1 over the same session, so late
 * messages from an abandoned attempt can be recognised and dropped.
 */
const AttemptSchema = z.number().int().min(0).max(1_000);

/** A raw P-256 public key (65 bytes), base64url without padding. */
const RelayKeySchema = z.string().regex(/^[A-Za-z0-9_-]{87}$/);

/** Ciphertext of one relay control message: base64url of IV ‖ AES-GCM ciphertext ‖ tag. */
export const RELAY_MESSAGE_MAX_CHARS = 48_000;
const RelayDataSchema = z
  .string()
  .min(39)
  .max(RELAY_MESSAGE_MAX_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/);

export const SignalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('description'),
    description: SessionDescriptionSchema,
    attempt: AttemptSchema.optional(),
  }),
  // `candidate: null` signals end-of-candidates.
  z.object({
    kind: z.literal('candidate'),
    candidate: IceCandidateSchema.nullable(),
    attempt: AttemptSchema.optional(),
  }),
  /** The answering device asks the offering device (the host) to start attempt `attempt`. */
  z.object({ kind: z.literal('retry'), attempt: AttemptSchema }),
  /**
   * The receiving device's attempt `attempt` failed (it closed that peer
   * connection) and it now waits for the sending device's next step, which a
   * sender still trying that attempt can take at once.
   */
  z.object({ kind: z.literal('attempt-failed'), attempt: AttemptSchema }),
  /**
   * The sending device found nothing more to try on its own after attempt
   * `attempt` failed (no relay mode, no automatic attempt left) and shows the
   * failure; the receiving device stops waiting for its next step.
   */
  z.object({ kind: z.literal('gave-up'), attempt: AttemptSchema }),
  /**
   * Relay mode: the sending device proposes it with its half of an ECDH key
   * agreement; the receiving device answers with its own half, naming the
   * proposal it answers (`reply`: the sender's key).
   */
  z.object({
    kind: z.literal('relay-hello'),
    key: RelayKeySchema,
    reply: RelayKeySchema.optional(),
  }),
  /** Relay mode: control message number `seq` from one device, encrypted end to end. */
  z.object({
    kind: z.literal('relay-message'),
    seq: z.number().int().min(0).max(1_000_000),
    data: RelayDataSchema,
  }),
]);
export type SignalPayload = z.infer<typeof SignalPayloadSchema>;
/** The payloads of one WebRTC negotiation (what a peer connection sends and consumes). */
export type NegotiationPayload = Extract<SignalPayload, { kind: 'description' | 'candidate' }>;

export const JoinTargetSchema = z.discriminatedUnion('via', [
  z.object({ via: z.literal('link'), sessionId: z.string().regex(RANDOM_ID_PATTERN) }),
  z.object({ via: z.literal('code'), code: z.string().regex(PAIRING_CODE_PATTERN) }),
]);
export type JoinTarget = z.infer<typeof JoinTargetSchema>;

/* -------------------------------------------------------------------------- */
/* Client → server                                                            */
/* -------------------------------------------------------------------------- */

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create-session'),
    role: TransferRoleSchema,
    device: DeviceInfoSchema,
  }),
  z.object({
    type: z.literal('join-session'),
    target: JoinTargetSchema,
    device: DeviceInfoSchema,
  }),
  z.object({ type: z.literal('signal'), payload: SignalPayloadSchema }),
  /** Host approves / declines a peer that joined with the short pairing code. */
  z.object({ type: z.literal('approve-peer') }),
  z.object({ type: z.literal('decline-peer') }),
  /**
   * Host: files have started to move, so this session belongs to the device in
   * it. From now on its departure ends the session instead of letting another
   * device join with the same link or code.
   */
  z.object({ type: z.literal('lock-session') }),
  z.object({ type: z.literal('leave-session') }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/* -------------------------------------------------------------------------- */
/* Server → client                                                            */
/* -------------------------------------------------------------------------- */

export const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServerConfig = z.infer<typeof IceServerSchema>;

export const SignalingErrorCodeSchema = z.enum([
  'invalid-message',
  'rate-limited',
  'session-not-found',
  'session-expired',
  'session-full',
  'already-in-session',
  'not-in-session',
  'not-allowed',
  'server-busy',
  'internal',
]);
export type SignalingErrorCode = z.infer<typeof SignalingErrorCodeSchema>;

export const SessionClosedReasonSchema = z.enum([
  'host-left',
  'lifetime-exceeded',
  'server-shutdown',
]);
export type SessionClosedReason = z.infer<typeof SessionClosedReasonSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session-created'),
    sessionId: z.string(),
    code: z.string(),
    role: TransferRoleSchema,
    expiresAt: z.number(),
    iceServers: z.array(IceServerSchema),
  }),
  z.object({
    type: z.literal('session-joined'),
    sessionId: z.string(),
    role: TransferRoleSchema,
    peer: DeviceInfoSchema,
    /** True when the host still has to approve this device (code joins to a sending host). */
    awaitingApproval: z.boolean(),
    iceServers: z.array(IceServerSchema),
  }),
  z.object({
    type: z.literal('peer-joined'),
    peer: DeviceInfoSchema,
    via: z.enum(['link', 'code']),
    needsApproval: z.boolean(),
  }),
  /** Sent to the guest once the host approved it (only for code joins to a sending host). */
  z.object({ type: z.literal('peer-approved') }),
  z.object({ type: z.literal('peer-declined') }),
  z.object({ type: z.literal('signal'), payload: SignalPayloadSchema }),
  /**
   * The other device is no longer in the session: it `left` on purpose (left the
   * session, closed the page), or it is `gone` silent (stopped checking in, its
   * connection dropped). A direct connection that still works can outlive `gone`.
   */
  z.object({
    type: z.literal('peer-left'),
    reason: z.enum(['left', 'gone']).optional(),
    /**
     * Set when the guest left before any files moved (the session wasn't
     * locked): the session waits for another device, with the same link and
     * code, until this time.
     */
    expiresAt: z.number().optional(),
  }),
  z.object({ type: z.literal('session-expired') }),
  z.object({ type: z.literal('session-closed'), reason: SessionClosedReasonSchema }),
  z.object({
    type: z.literal('error'),
    code: SignalingErrorCodeSchema,
    retryAfterMs: z.number().optional(),
  }),
  z.object({ type: z.literal('pong') }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

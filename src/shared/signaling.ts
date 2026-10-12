/**
 * Signaling protocol (WebSocket, JSON messages).
 *
 * The signaling server only helps two browsers find each other and exchange
 * WebRTC session descriptions and ICE candidates. File contents never travel
 * over this channel — they flow over the RTCDataChannel (see
 * src/client/transfer/protocol.ts).
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

export const SignalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('description'), description: SessionDescriptionSchema }),
  // `candidate: null` signals end-of-candidates.
  z.object({ kind: z.literal('candidate'), candidate: IceCandidateSchema.nullable() }),
]);
export type SignalPayload = z.infer<typeof SignalPayloadSchema>;

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
  z.object({ type: z.literal('peer-left') }),
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

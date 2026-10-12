/**
 * preprati. data-channel protocol, version 1 (see docs/PROTOCOL.md).
 *
 * One reliable, ordered RTCDataChannel carries two kinds of messages:
 *
 * 1. Control messages — UTF-8 JSON text frames, validated on receipt because
 *    the peer is untrusted input.
 * 2. Chunk frames — binary, a fixed 12-byte header followed by file bytes:
 *
 *      offset  size  field
 *      0       1     frame type (0x01 = file chunk)
 *      1       1     reserved (0)
 *      2       2     file index within the transfer (uint16, big-endian)
 *      4       4     transfer tag (uint32, big-endian; random per transfer)
 *      8       4     sequence number within the file (uint32, big-endian)
 *      12      n     payload (1..maxPayload bytes)
 *
 * Flow:  sender ─offer─▶ receiver ─accept|reject─▶ sender
 *        sender ─chunks…, file-end (per file)…, done─▶ receiver
 *        receiver ─progress (periodic)…, complete─▶ sender
 *        either side may send `cancel` at any time.
 */
import { z } from 'zod';
import { PROTOCOL_VERSION } from '../../shared/constants';

export const FRAME_HEADER_BYTES = 12;
export const FRAME_TYPE_CHUNK = 0x01;
/** Max size of one data-channel message we send (header + payload). */
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_FILES_PER_TRANSFER = 1000;
export const MAX_FILE_NAME_LENGTH = 1024;

const TransferId = z.string().regex(/^[A-Za-z0-9_-]{8,32}$/);

export const OfferedFileSchema = z.object({
  index: z
    .number()
    .int()
    .min(0)
    .max(MAX_FILES_PER_TRANSFER - 1),
  name: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  type: z.string().max(255),
  lastModified: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type OfferedFile = z.infer<typeof OfferedFileSchema>;

export const ControlMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    v: z.number().int(),
    /** Largest frame this peer is willing to receive. */
    maxFrame: z
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024),
  }),
  z.object({
    t: z.literal('offer'),
    id: TransferId,
    tag: z.number().int().min(0).max(0xffffffff),
    files: z.array(OfferedFileSchema).min(1).max(MAX_FILES_PER_TRANSFER),
    totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  z.object({ t: z.literal('accept'), id: TransferId }),
  z.object({ t: z.literal('reject'), id: TransferId }),
  z.object({
    t: z.literal('file-end'),
    id: TransferId,
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_FILES_PER_TRANSFER - 1),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  z.object({ t: z.literal('done'), id: TransferId }),
  z.object({
    t: z.literal('progress'),
    id: TransferId,
    bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  z.object({ t: z.literal('complete'), id: TransferId }),
  z.object({ t: z.literal('cancel'), id: TransferId, reason: z.enum(['user', 'error']) }),
  z.object({ t: z.literal('bye') }),
]);
export type ControlMessage = z.infer<typeof ControlMessageSchema>;

export function helloMessage(maxFrame = MAX_FRAME_BYTES): ControlMessage {
  return { t: 'hello', v: PROTOCOL_VERSION, maxFrame };
}

export function encodeControl(message: ControlMessage): string {
  return JSON.stringify(message);
}

/** Parses and validates a text frame. Returns null for anything malformed. */
export function decodeControl(text: string): ControlMessage | null {
  if (text.length > 512 * 1024) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ControlMessageSchema.safeParse(json);
  if (!parsed.success) return null;
  const message = parsed.data;
  if (message.t === 'offer') {
    // Indices must be 0..n-1 in order and the declared total must match.
    const consistent =
      message.files.every((file, i) => file.index === i) &&
      message.files.reduce((sum, file) => sum + file.size, 0) === message.totalBytes;
    if (!consistent) return null;
  }
  return message;
}

export interface ChunkFrame {
  fileIndex: number;
  tag: number;
  sequence: number;
  payload: Uint8Array;
}

export function encodeChunk(
  tag: number,
  fileIndex: number,
  sequence: number,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(new ArrayBuffer(FRAME_HEADER_BYTES + payload.byteLength));
  const view = new DataView(frame.buffer);
  view.setUint8(0, FRAME_TYPE_CHUNK);
  view.setUint8(1, 0);
  view.setUint16(2, fileIndex);
  view.setUint32(4, tag >>> 0);
  view.setUint32(8, sequence >>> 0);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

export function decodeChunk(data: ArrayBuffer): ChunkFrame | null {
  if (data.byteLength <= FRAME_HEADER_BYTES) return null;
  const view = new DataView(data);
  if (view.getUint8(0) !== FRAME_TYPE_CHUNK || view.getUint8(1) !== 0) return null;
  return {
    fileIndex: view.getUint16(2),
    tag: view.getUint32(4),
    sequence: view.getUint32(8),
    payload: new Uint8Array(data, FRAME_HEADER_BYTES),
  };
}

export function randomTransferId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function randomTag(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0]!;
}

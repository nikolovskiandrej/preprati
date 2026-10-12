/**
 * End-to-end encryption for relay mode's control messages (see ./relay.ts).
 *
 * Two devices that can't connect directly still share their signaling
 * session. Relay mode turns it into a private channel:
 *
 *   1. Each device creates an ephemeral ECDH P-256 key pair and sends the
 *      public half over signaling (`relay-hello`).
 *   2. Both derive the same AES-256-GCM key:
 *        HKDF-SHA-256(ECDH secret, salt = "preprati.relay.v1",
 *                     info = "<session id>|<sender key>|<receiver key>")
 *   3. Every control message is sealed with that key. The sending side and the
 *      message number are authenticated (AAD), so a message can't be replayed,
 *      dropped, reordered or reflected back to the device that sent it.
 *
 * The server relays ciphertext only. Like WebRTC itself (whose DTLS
 * fingerprints also travel over signaling), this protects against a passive
 * or curious server, not against one that swaps the keys while they are
 * exchanged.
 */
import { fromBase64Url, toBase64Url } from '../../shared/encoding';

export type RelaySide = 'sender' | 'receiver';

export interface RelayKeyPair {
  privateKey: CryptoKey;
  /** Raw public key (65 bytes), base64url. */
  publicKey: string;
}

/** Wrong key, tampering, replay or an unusable public key. */
export class RelayCryptoError extends Error {
  override name = 'RelayCryptoError';
}

const encoder = new TextEncoder();
const HKDF_SALT = encoder.encode('preprati.relay.v1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

export async function createRelayKeyPair(): Promise<RelayKeyPair> {
  const pair = await crypto.subtle.generateKey(P256, false, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toBase64Url(raw) };
}

/** Derives the message key both devices share; `context` binds it to this session and these keys. */
export async function deriveRelayKey(
  own: RelayKeyPair,
  remotePublicKey: string,
  context: { sessionId: string; senderKey: string; receiverKey: string },
): Promise<CryptoKey> {
  let remote: CryptoKey;
  try {
    const raw = fromBase64Url(remotePublicKey);
    // An uncompressed point: 0x04 ‖ x ‖ y. importKey also checks it lies on the curve.
    if (raw.byteLength !== 65 || raw[0] !== 0x04) throw new Error('not an uncompressed point');
    remote = await crypto.subtle.importKey('raw', copyOf(raw), P256, false, []);
  } catch {
    throw new RelayCryptoError('Unusable public key');
  }
  const secret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: remote },
    own.privateKey,
    256,
  );
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const info = encoder.encode(`${context.sessionId}|${context.senderKey}|${context.receiverKey}`);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const aadFor = (from: RelaySide, seq: number) => encoder.encode(`preprati/relay/v1/${from}/${seq}`);

/** Encrypts message number `seq` sent by `from`; returns base64url(IV ‖ ciphertext ‖ tag). */
export async function sealRelayMessage(
  key: CryptoKey,
  from: RelaySide,
  seq: number,
  message: unknown,
): Promise<string> {
  const iv = new Uint8Array(new ArrayBuffer(IV_BYTES));
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(from, seq), tagLength: TAG_BYTES * 8 },
    key,
    encoder.encode(JSON.stringify(message)),
  );
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return toBase64Url(out);
}

/** Decrypts and parses a message; throws RelayCryptoError unless it is authentic. */
export async function openRelayMessage(
  key: CryptoKey,
  from: RelaySide,
  seq: number,
  data: string,
): Promise<unknown> {
  let plaintext: ArrayBuffer;
  try {
    const sealed = fromBase64Url(data);
    if (sealed.byteLength < IV_BYTES + TAG_BYTES + 1) throw new Error('too short');
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: copyOf(sealed.subarray(0, IV_BYTES)),
        additionalData: aadFor(from, seq),
        tagLength: TAG_BYTES * 8,
      },
      key,
      copyOf(sealed.subarray(IV_BYTES)),
    );
  } catch {
    throw new RelayCryptoError('Message failed authentication');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown;
  } catch {
    throw new RelayCryptoError('Message is not valid JSON');
  }
}

function copyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

/**
 * Client-side encryption for shared packages (Web Crypto only).
 *
 *   secret (32 random bytes, lives only in the URL fragment)
 *     └─ HKDF-SHA-256(salt = "preprati.share.v1")
 *          ├─ info "content"  → AES-256-GCM key for file chunks
 *          └─ info "manifest" → AES-256-GCM key for the manifest
 *
 * Every chunk is sealed independently with a fresh random 96-bit IV and
 * "preprati/v1/chunk/<index>/<count>" as additional authenticated data, so
 * chunks cannot be reordered, dropped, truncated or swapped between packages
 * without failing authentication. Chunk wire format: IV (12) ‖ ciphertext ‖ tag (16).
 */
import {
  SECRET_BYTES,
  SECRET_PATTERN,
  SHARE_CHUNK_IV_BYTES,
  SHARE_CHUNK_OVERHEAD,
} from '../../shared/constants';
import { fromBase64Url, toBase64Url } from '../../shared/encoding';
import { ShareManifestSchema, type ShareManifest } from './manifest';

const encoder = new TextEncoder();
const HKDF_SALT = encoder.encode('preprati.share.v1');
const MANIFEST_AAD = encoder.encode('preprati/v1/manifest');
const MANIFEST_PAD_BLOCK = 512;

export interface ShareKeys {
  content: CryptoKey;
  manifest: CryptoKey;
}

/** Thrown whenever authentication fails: wrong key, tampering or truncation. */
export class DecryptionError extends Error {
  override name = 'DecryptionError';
}

export function generateShareSecret(): Uint8Array<ArrayBuffer> {
  const secret = new Uint8Array(new ArrayBuffer(SECRET_BYTES));
  crypto.getRandomValues(secret);
  return secret;
}

export function encodeShareSecret(secret: Uint8Array): string {
  return toBase64Url(secret);
}

/** Parses the key from a URL fragment; returns null if it is not a well-formed 256-bit key. */
export function decodeShareSecret(fragment: string): Uint8Array<ArrayBuffer> | null {
  const value = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!SECRET_PATTERN.test(value)) return null;
  const bytes = fromBase64Url(value);
  if (bytes.byteLength !== SECRET_BYTES) return null;
  const copy = new Uint8Array(new ArrayBuffer(SECRET_BYTES));
  copy.set(bytes);
  return copy;
}

export async function deriveShareKeys(secret: Uint8Array<ArrayBuffer>): Promise<ShareKeys> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const derive = (info: string) =>
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: encoder.encode(info) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  const [content, manifest] = await Promise.all([derive('content'), derive('manifest')]);
  return { content, manifest };
}

function chunkAad(index: number, chunkCount: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(`preprati/v1/chunk/${index}/${chunkCount}`);
}

async function seal(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
) {
  const iv = new Uint8Array(new ArrayBuffer(SHARE_CHUNK_IV_BYTES));
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    key,
    plaintext,
  );
  const out = new Uint8Array(new ArrayBuffer(SHARE_CHUNK_IV_BYTES + ciphertext.byteLength));
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), SHARE_CHUNK_IV_BYTES);
  return out;
}

async function open(
  key: CryptoKey,
  sealed: Uint8Array,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.byteLength < SHARE_CHUNK_OVERHEAD)
    throw new DecryptionError('Ciphertext is too short');
  const iv = sealed.slice(0, SHARE_CHUNK_IV_BYTES);
  const body = sealed.slice(SHARE_CHUNK_IV_BYTES);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      key,
      body,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new DecryptionError('Authentication failed');
  }
}

export function encryptChunk(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  index: number,
  chunkCount: number,
): Promise<Uint8Array<ArrayBuffer>> {
  return seal(key, plaintext, chunkAad(index, chunkCount));
}

export function decryptChunk(
  key: CryptoKey,
  sealed: Uint8Array,
  index: number,
  chunkCount: number,
): Promise<Uint8Array<ArrayBuffer>> {
  return open(key, sealed, chunkAad(index, chunkCount));
}

/**
 * Encrypts the manifest (file names, types, sizes, layout). The JSON is
 * padded with trailing spaces to a 512-byte boundary so the ciphertext size
 * reveals little about the names inside.
 */
export async function encryptManifest(
  key: CryptoKey,
  manifest: ShareManifest,
): Promise<Uint8Array<ArrayBuffer>> {
  const json = encoder.encode(JSON.stringify(manifest));
  const padded = new Uint8Array(
    new ArrayBuffer(Math.ceil((json.byteLength + 1) / MANIFEST_PAD_BLOCK) * MANIFEST_PAD_BLOCK),
  );
  padded.fill(0x20);
  padded.set(json, 0);
  return seal(key, padded, MANIFEST_AAD);
}

export async function decryptManifest(key: CryptoKey, sealed: Uint8Array): Promise<ShareManifest> {
  const plaintext = await open(key, sealed, MANIFEST_AAD);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    throw new DecryptionError('Manifest is not valid JSON');
  }
  const parsed = ShareManifestSchema.safeParse(json);
  if (!parsed.success) throw new DecryptionError('Manifest has an unexpected structure');
  return parsed.data;
}

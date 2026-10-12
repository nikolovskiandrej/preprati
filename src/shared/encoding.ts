/**
 * Base64url helpers and CSPRNG-backed identifiers that work identically in
 * browsers and in Node (both expose `crypto.getRandomValues`, `btoa`, `atob`).
 */
import { RANDOM_ID_BYTES, SECRET_BYTES } from './constants';

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid base64url string');
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** 128-bit unguessable identifier (22 base64url characters). */
export function randomId(): string {
  return toBase64Url(randomBytes(RANDOM_ID_BYTES));
}

/** 256-bit secret (43 base64url characters). */
export function randomSecret(): string {
  return toBase64Url(randomBytes(SECRET_BYTES));
}

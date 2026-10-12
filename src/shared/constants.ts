/**
 * Constants shared by the browser client and the Node backend.
 *
 * Anything that both sides must agree on (identifier formats, crypto framing
 * overhead, protocol versions) lives here so the two can never drift apart.
 */

/** Version of the signaling + data-channel protocol. Bump on breaking changes. */
export const PROTOCOL_VERSION = 1;

/** Version of the encrypted share package format (see docs/PROTOCOL.md). */
export const SHARE_FORMAT_VERSION = 1;

/** 128-bit random identifiers, base64url encoded (22 characters, no padding). */
export const RANDOM_ID_BYTES = 16;
export const RANDOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** 256-bit secrets (share keys, owner tokens), base64url encoded (43 characters). */
export const SECRET_BYTES = 32;
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Human-typable pairing codes. The alphabet drops characters that are easy to
 * confuse when read aloud or typed on a phone: 0/O, 1/I/L and U.
 * 30^6 ≈ 729 million combinations; codes are short-lived, single-use and
 * join attempts are rate limited per IP on the server.
 */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_PATTERN = new RegExp(
  `^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`,
);

/** Maximum length of the human-readable device label exchanged on join. */
export const DEVICE_LABEL_MAX_LENGTH = 64;

/** Per-chunk overhead of the share format: 12-byte AES-GCM IV + 16-byte tag. */
export const SHARE_CHUNK_IV_BYTES = 12;
export const SHARE_CHUNK_TAG_BYTES = 16;
export const SHARE_CHUNK_OVERHEAD = SHARE_CHUNK_IV_BYTES + SHARE_CHUNK_TAG_BYTES;

/** Upper bound for the encrypted manifest (file list + layout). */
export const SHARE_MANIFEST_MAX_BYTES = 512 * 1024;

/** Allowed range for the plaintext chunk size of share packages. */
export const SHARE_CHUNK_MIN_BYTES = 64 * 1024;
export const SHARE_CHUNK_MAX_BYTES = 16 * 1024 * 1024;

/** Paths used by the HTTP API and the signaling WebSocket. */
export const API_PREFIX = '/api';
export const SIGNALING_PATH = '/ws';

/** Normalizes user input ("k7m-4qx", " K7M 4QX ") into a canonical pairing code. */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s\-–—_.]/g, '');
}

/** Formats a canonical code for display, e.g. "K7M4QX" → "K7M-4QX". */
export function formatPairingCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

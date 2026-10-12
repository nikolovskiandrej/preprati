import { describe, expect, it } from 'vitest';
import { SHARE_CHUNK_OVERHEAD } from '../../src/shared/constants';
import {
  DecryptionError,
  decodeShareSecret,
  decryptChunk,
  decryptManifest,
  deriveShareKeys,
  encodeShareSecret,
  encryptChunk,
  encryptManifest,
  generateShareSecret,
} from '../../src/client/share/crypto';
import { buildManifest } from '../../src/client/share/manifest';

const text = (value: string) => new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;

describe('share crypto', () => {
  it('generates 256-bit secrets that round-trip through the URL fragment format', () => {
    const secret = generateShareSecret();
    expect(secret.byteLength).toBe(32);
    const encoded = encodeShareSecret(secret);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(decodeShareSecret(`#${encoded}`)).toEqual(secret);
    expect(decodeShareSecret('#too-short')).toBeNull();
    expect(decodeShareSecret('#' + '!'.repeat(43))).toBeNull();
    expect(encodeShareSecret(generateShareSecret())).not.toBe(encoded);
  });

  it('encrypts and decrypts chunks with authentication', async () => {
    const keys = await deriveShareKeys(generateShareSecret());
    const plain = text('the quick brown fox jumps over the lazy dog');
    const sealed = await encryptChunk(keys.content, plain, 3, 10);
    expect(sealed.byteLength).toBe(plain.byteLength + SHARE_CHUNK_OVERHEAD);
    expect(Buffer.from(sealed).includes(Buffer.from('quick brown'))).toBe(false);
    expect(await decryptChunk(keys.content, sealed, 3, 10)).toEqual(plain);
  });

  it('uses a fresh IV for every encryption of the same plaintext', async () => {
    const keys = await deriveShareKeys(generateShareSecret());
    const plain = text('same input');
    const a = await encryptChunk(keys.content, plain, 0, 1);
    const b = await encryptChunk(keys.content, plain, 0, 1);
    expect(Buffer.from(a.subarray(0, 12)).equals(Buffer.from(b.subarray(0, 12)))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('rejects tampered ciphertext', async () => {
    const keys = await deriveShareKeys(generateShareSecret());
    const sealed = await encryptChunk(keys.content, text('important data'), 0, 1);
    for (const position of [0, 13, sealed.byteLength - 1]) {
      const copy = sealed.slice();
      copy[position]! ^= 0x01;
      await expect(decryptChunk(keys.content, copy, 0, 1)).rejects.toBeInstanceOf(DecryptionError);
    }
    await expect(decryptChunk(keys.content, sealed.slice(0, 20), 0, 1)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it('binds chunks to their position and the total count (no reordering or truncation)', async () => {
    const keys = await deriveShareKeys(generateShareSecret());
    const sealed = await encryptChunk(keys.content, text('chunk two'), 2, 5);
    await expect(decryptChunk(keys.content, sealed, 1, 5)).rejects.toBeInstanceOf(DecryptionError);
    await expect(decryptChunk(keys.content, sealed, 2, 3)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('cannot decrypt with a different key', async () => {
    const right = await deriveShareKeys(generateShareSecret());
    const wrong = await deriveShareKeys(generateShareSecret());
    const sealed = await encryptChunk(right.content, text('secret'), 0, 1);
    await expect(decryptChunk(wrong.content, sealed, 0, 1)).rejects.toBeInstanceOf(DecryptionError);
    // Content and manifest keys are independent even for the same secret.
    await expect(decryptChunk(right.manifest, sealed, 0, 1)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it('encrypts the manifest so file names, types and sizes are not visible', async () => {
    const keys = await deriveShareKeys(generateShareSecret());
    const files = [
      new File(['x'.repeat(10)], 'tax-return-2026.pdf', { type: 'application/pdf' }),
      new File(['y'], 'holiday.jpg', { type: 'image/jpeg' }),
    ];
    const manifest = buildManifest(files, 64 * 1024, 1_700_000_000_000);
    const sealed = await encryptManifest(keys.manifest, manifest);
    const raw = Buffer.from(sealed);
    for (const secret of ['tax-return', 'holiday', 'application/pdf', 'image/jpeg']) {
      expect(raw.includes(Buffer.from(secret))).toBe(false);
    }
    // Padded to 512-byte blocks so the size reveals little about the names.
    expect((sealed.byteLength - SHARE_CHUNK_OVERHEAD) % 512).toBe(0);
    expect(await decryptManifest(keys.manifest, sealed)).toEqual(manifest);
  });

  it('rejects a manifest decrypted with the wrong key or with inconsistent contents', async () => {
    const keys = await deriveShareKeys(generateShareSecret());
    const other = await deriveShareKeys(generateShareSecret());
    const manifest = buildManifest([new File(['abc'], 'a.txt')], 64 * 1024);
    const sealed = await encryptManifest(keys.manifest, manifest);
    await expect(decryptManifest(other.manifest, sealed)).rejects.toBeInstanceOf(DecryptionError);

    const broken = { ...manifest, totalBytes: manifest.totalBytes + 1 };
    const sealedBroken = await encryptManifest(keys.manifest, broken);
    await expect(decryptManifest(keys.manifest, sealedBroken)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { detectDevice, deviceLabel } from '../../src/client/lib/device';
import {
  fileKind,
  isPreviewableImage,
  sanitizeFileName,
  uniqueNames,
} from '../../src/client/lib/files';
import {
  formatBytes,
  formatCountdown,
  formatDuration,
  formatTtl,
} from '../../src/client/lib/format';
import { HttpError, withRetry } from '../../src/client/lib/http';
import { RateMeter } from '../../src/client/lib/rateMeter';
import {
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
} from '../../src/client/transfer/protocol';
import { derivePhase } from '../../src/client/transfer/quickSession';
import {
  formatPairingCode,
  normalizePairingCode,
  PAIRING_CODE_PATTERN,
} from '../../src/shared/constants';
import { fromBase64Url, randomId, randomSecret, toBase64Url } from '../../src/shared/encoding';

describe('formatting', () => {
  it('formats sizes with decimal units', () => {
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(999, 'en')).toBe('999 B');
    expect(formatBytes(12_400_000, 'en')).toBe('12.4 MB');
    expect(formatBytes(1e9, 'en')).toBe('1 GB');
    expect(formatBytes(-1, 'en')).toBe('—');
  });

  it('formats countdowns, durations and TTLs', () => {
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(-5)).toBe('0:00');
    expect(formatDuration(42, 'en')).toMatch(/42/);
    expect(formatTtl(86_400, 'en')).toBe('24 hours');
    expect(formatTtl(7 * 86_400, 'en')).toBe('7 days');
  });
});

describe('files', () => {
  it('classifies files for icons', () => {
    expect(fileKind('a.jpg', 'image/jpeg')).toBe('image');
    expect(fileKind('a.mov', 'video/quicktime')).toBe('video');
    expect(fileKind('a.zip', '')).toBe('archive');
    expect(fileKind('a.pdf', 'application/pdf')).toBe('document');
    expect(fileKind('a.xyz', '')).toBe('file');
  });

  it('never previews SVG (it can carry script)', () => {
    expect(isPreviewableImage('image/png')).toBe(true);
    expect(isPreviewableImage('image/svg+xml')).toBe(false);
  });

  it('sanitizes dangerous names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFileName('a\u0000b‮c.txt')).toBe('abc.txt');
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFileName('   ')).toBe('file');
    expect(sanitizeFileName('x'.repeat(300) + '.pdf').length).toBeLessThanOrEqual(200);
    expect(sanitizeFileName('x'.repeat(300) + '.pdf').endsWith('.pdf')).toBe(true);
  });

  it('deduplicates names for zip archives', () => {
    expect(uniqueNames(['a.txt', 'A.txt', 'b', 'a.txt'])).toEqual([
      'a.txt',
      'A (2).txt',
      'b',
      'a (3).txt',
    ]);
  });
});

describe('device labels', () => {
  it('derive coarse platform and browser names only', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    expect(deviceLabel(detectDevice(iphone))).toBe('iPhone · Safari');
    const android =
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
    expect(deviceLabel(detectDevice(android))).toBe('Android · Chrome');
    const edge =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0';
    expect(deviceLabel(detectDevice(edge))).toBe('Windows · Edge');
    const ipad =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    expect(deviceLabel(detectDevice(ipad, 5))).toBe('iPad · Safari');
    expect(deviceLabel(detectDevice(ipad, 0))).toBe('Mac · Safari');
  });
});

describe('pairing codes and identifiers', () => {
  it('normalizes typed codes', () => {
    expect(normalizePairingCode(' k7m-4qx ')).toBe('K7M4QX');
    expect(PAIRING_CODE_PATTERN.test('K7M4QX')).toBe(true);
    expect(PAIRING_CODE_PATTERN.test('K7M4Q0')).toBe(false); // 0 is not in the alphabet
    expect(formatPairingCode('K7M4QX')).toBe('K7M-4QX');
  });

  it('generates unguessable base64url identifiers', () => {
    expect(randomId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ids = new Set(Array.from({ length: 1000 }, randomId));
    expect(ids.size).toBe(1000);
    const bytes = new Uint8Array([0, 255, 128, 64, 1]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });
});

describe('data-channel protocol', () => {
  it('round-trips chunk frames', () => {
    const frame = encodeChunk(0xdeadbeef, 3, 42, new Uint8Array([9, 8, 7]));
    const decoded = decodeChunk(frame.buffer);
    expect(decoded?.tag).toBe(0xdeadbeef);
    expect(decoded?.fileIndex).toBe(3);
    expect(decoded?.sequence).toBe(42);
    expect([...decoded!.payload]).toEqual([9, 8, 7]);
    expect(decodeChunk(new ArrayBuffer(12))).toBeNull();
  });

  it('validates control messages from the peer', () => {
    expect(decodeControl(encodeControl({ t: 'accept', id: 'abcdefgh' }))).toEqual({
      t: 'accept',
      id: 'abcdefgh',
    });
    expect(decodeControl('{"t":"accept","id":"x"}')).toBeNull();
    expect(decodeControl('not json')).toBeNull();
    expect(decodeControl('{"t":"launch-missiles"}')).toBeNull();
    const badOffer = {
      t: 'offer',
      id: 'abcdefgh',
      tag: 1,
      files: [{ index: 1, name: 'a', size: 1, type: '', lastModified: 0 }],
      totalBytes: 1,
    };
    expect(decodeControl(JSON.stringify(badOffer))).toBeNull();
  });
});

describe('quick session phases', () => {
  it('refines the connected phase with the transfer status', () => {
    const transfer = (status: string, error: string | null = null) => ({ status, error }) as never;
    expect(derivePhase('waiting-for-peer', null)).toBe('waiting-for-peer');
    expect(derivePhase('connected', null)).toBe('connected');
    expect(derivePhase('connected', transfer('offered'))).toBe('awaiting-acceptance');
    expect(derivePhase('connected', transfer('transferring'))).toBe('transferring');
    expect(derivePhase('connected', transfer('completed'))).toBe('completed');
    expect(derivePhase('connected', transfer('failed', 'connection-lost'))).toBe('disconnected');
    expect(derivePhase('connected', transfer('failed', 'protocol-error'))).toBe('failed');
    expect(derivePhase('expired', transfer('transferring'))).toBe('expired');
  });
});

describe('rate meter', () => {
  it('reports speed and ETA only once there is enough signal', () => {
    let now = 0;
    const meter = new RateMeter(4000, 1500, () => now);
    expect(meter.push(0, 10_000).bytesPerSecond).toBeNull();
    now = 1000;
    expect(meter.push(1000, 10_000).bytesPerSecond).toBeNull();
    now = 2000;
    const estimate = meter.push(2000, 10_000);
    expect(estimate.bytesPerSecond).toBeCloseTo(1000);
    expect(estimate.etaSeconds).toBeCloseTo(8);
  });
});

describe('retries', () => {
  it('retries passing problems, but not a server that asks to come back much later', async () => {
    let calls = 0;
    const flaky = () =>
      ++calls < 3 ? Promise.reject(new HttpError('network', 0, 'offline')) : Promise.resolve('ok');
    expect(await withRetry(flaky, { baseDelayMs: 1 })).toBe('ok');
    expect(calls).toBe(3);

    calls = 0;
    const full = () => {
      calls++;
      return Promise.reject(new HttpError('quota-exceeded', 507, 'full', 900));
    };
    await expect(withRetry(full, { baseDelayMs: 1 })).rejects.toMatchObject({
      code: 'quota-exceeded',
    });
    expect(calls).toBe(1); // no 15-second wait for an answer that won't change
  });
});

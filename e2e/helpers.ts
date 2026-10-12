import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

export const SHORT_BASE = 'http://127.0.0.1:4318';
/** Server that signals over HTTP polling, like the serverless deployment. */
export const HTTP_SIGNALING_BASE = 'http://127.0.0.1:4319';

export function sha256(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Writes a file with random content under test-results and returns its path. */
export function makeFile(name: string, size: number): string {
  const dir = path.resolve('test-results/e2e-files');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${process.pid}-${Date.now()}-${name}`);
  writeFileSync(file, randomBytes(size));
  return file;
}

export function fileHash(file: string): string {
  return sha256(readFileSync(file));
}

/** Decodes a PNG (as produced by Copy/Download QR Code) and returns the encoded text. */
export function decodeQrPng(png: Buffer): string | null {
  const image = PNG.sync.read(png);
  const result = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
  return result?.data ?? null;
}

/** Fails the test on uncaught page errors and console errors (includes CSP violations). */
export function watchConsole(page: Page, label: string): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`[${label}] pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Expected API answers for missing/expired shares are logged by the browser itself.
    if (
      /Failed to load resource: the server responded with a status of (404|410)/.test(
        message.text(),
      )
    )
      return;
    problems.push(`[${label}] console.error: ${message.text()}`);
  });
  return problems;
}

export async function newDevice(
  browser: Browser,
  options: Parameters<Browser['newContext']>[0] = {},
): Promise<{ context: BrowserContext; page: Page; problems: string[] }> {
  const context = await browser.newContext({ acceptDownloads: true, ...options });
  const page = await context.newPage();
  const problems = watchConsole(page, options.viewport ? `${options.viewport.width}px` : 'device');
  return { context, page, problems };
}

/** Reads the pairing code shown on a hosting device. */
export async function pairingCode(page: Page): Promise<string> {
  const code = page.getByTestId('pairing-code');
  await expect(code).toBeVisible();
  return (await code.textContent())!.replace('-', '').trim();
}

/** Saves the first download triggered by `action` and returns its bytes and suggested name. */
export async function captureDownload(page: Page, action: () => Promise<unknown>) {
  const [download] = await Promise.all([page.waitForEvent('download'), action()]);
  const filePath = await download.path();
  return { name: download.suggestedFilename(), bytes: readFileSync(filePath) };
}

/** Reads a stored (uncompressed) .zip produced by "Download all". */
export function readStoredZip(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a zip archive');
  let count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) throw new Error('zip64 not expected in tests');
  while (count-- > 0) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Bad central directory');
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (method !== 0) throw new Error('Expected stored entries');
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, zip.subarray(start, start + size));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Makes the first WebRTC connection attempt in this browser context impossible,
 * like two networks that don't allow a direct path: remote candidates point
 * to an address nobody answers on. Later attempts ("Try again") work normally.
 */
export async function blockFirstConnection(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    let created = 0;
    window.RTCPeerConnection = class extends Native {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        if (created++ > 0) return;
        const add = this.addIceCandidate.bind(this);
        this.addIceCandidate = (candidate?: RTCIceCandidateInit | null) => {
          if (!candidate?.candidate) return add(candidate ?? undefined);
          const parts = candidate.candidate.split(' ');
          parts[4] = '192.0.2.1'; // TEST-NET-1: never answers
          return add({ ...candidate, candidate: parts.join(' ') });
        };
      }
    };
  });
}

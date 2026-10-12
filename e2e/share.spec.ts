import { readdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  captureDownload,
  decodeQrPng,
  fileHash,
  makeFile,
  newDevice,
  readStoredZip,
  sha256,
  SHORT_BASE,
} from './helpers';

const SHORT_STORAGE = 'test-results/e2e-storage/short';

async function createShare(page: Page, files: string[], base = '') {
  await page.goto(`${base}/share`);
  await page.locator('input[type=file]').setInputFiles(files);
  await page.getByRole('button', { name: 'Continue' }).click();
  const dialog = page.getByRole('dialog', { name: 'Store these files temporarily?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Encrypt & create link' }).click();
  await expect(page.getByRole('heading', { name: 'Your share link is ready' })).toBeVisible({
    timeout: 30_000,
  });
  return page.getByTestId('share-link').inputValue();
}

function countFiles(dir: string): number {
  let count = 0;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${current}/${entry.name}`);
      else count++;
    }
  };
  try {
    walk(dir);
  } catch {
    return 0;
  }
  return count;
}

test.describe('Share Files', () => {
  test('a recipient downloads the files later, after the sender has closed the browser', async ({
    browser,
  }) => {
    const sender = await newDevice(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
    const requests: string[] = [];
    sender.page.on('request', (r) =>
      requests.push(`${r.url()} ${JSON.stringify(r.headers())} ${r.postData() ?? ''}`),
    );
    const files = [
      makeFile('квартален-извештај.pdf', 2_600_000),
      makeFile('holiday.jpg', 900_000),
      makeFile('readme.txt', 300),
    ];

    await sender.page.goto('/share');
    await expect(
      sender.page.getByText(/Up to 100 files · 1 GB in total · kept for 24 hours/),
    ).toBeVisible();
    await sender.page.locator('input[type=file]').setInputFiles(files);
    await sender.page.getByRole('button', { name: 'Continue' }).click();
    const dialog = sender.page.getByRole('dialog', { name: 'Store these files temporarily?' });
    await expect(dialog).toContainText('3 files (3.5 MB) will be encrypted in this browser');
    await expect(dialog).toContainText('Anyone who has the complete link can download them');
    // Nothing has been uploaded before the explicit confirmation.
    expect(requests.filter((r) => r.includes('/api/shares'))).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Encrypt & create link' }).click();
    await expect(
      sender.page.getByRole('heading', { name: 'Your share link is ready' }),
    ).toBeVisible({ timeout: 30_000 });

    const link = await sender.page.getByTestId('share-link').inputValue();
    const key = link.split('#')[1]!;
    expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/);
    await expect(sender.page.getByText('3 files · 3.5 MB')).toBeVisible();
    await expect(sender.page.getByTestId('share-expiry')).toContainText(
      /Expires .* \(in 24 hours|tomorrow\)/,
    );
    await expect(sender.page.getByText('Not opened yet')).toBeVisible();

    // Copy QR Code → a PNG on the clipboard that encodes the complete link (key included).
    await sender.page.getByTestId('copy-qr').click();
    await expect(sender.page.getByTestId('copy-qr')).toHaveText(/QR copied/);
    const png = await sender.page.evaluate(async () => {
      const blob = await (await navigator.clipboard.read())[0]!.getType('image/png');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    });
    expect(decodeQrPng(Buffer.from(png, 'base64'))).toBe(link);
    const pngFile = await captureDownload(sender.page, () =>
      sender.page.getByTestId('download-qr').click(),
    );
    expect(pngFile.name).toBe('preprati-share-qr.png');
    expect(decodeQrPng(pngFile.bytes)).toBe(link);
    await sender.page.getByTestId('copy-link').click();
    expect(await sender.page.evaluate(() => navigator.clipboard.readText())).toBe(link);

    // The decryption key never left the sender's browser.
    expect(requests.filter((r) => r.includes(key))).toEqual([]);
    await sender.context.close();

    const recipient = await newDevice(browser, {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const recipientRequests: string[] = [];
    recipient.page.on('request', (r) =>
      recipientRequests.push(`${r.url()} ${JSON.stringify(r.headers())}`),
    );
    await recipient.page.goto(link);
    await expect(
      recipient.page.getByRole('heading', { name: '3 files ready to download' }),
    ).toBeVisible();
    await expect(recipient.page.getByText('Files are decrypted on this device.')).toBeVisible();

    for (const [index, name] of ['квартален-извештај.pdf', 'holiday.jpg', 'readme.txt'].entries()) {
      const download = await captureDownload(recipient.page, () =>
        recipient.page
          .getByRole('button', { name: new RegExp(`^Download .*${name.replace('.', '\\.')}$`) })
          .click(),
      );
      expect(download.name.endsWith(name)).toBe(true);
      expect(sha256(download.bytes)).toBe(fileHash(files[index]!));
    }
    const zip = await captureDownload(recipient.page, () =>
      recipient.page.getByRole('button', { name: 'Download all (.zip)' }).click(),
    );
    const entries = readStoredZip(zip.bytes);
    expect([...entries.values()].map((b) => sha256(b)).sort()).toEqual(files.map(fileHash).sort());

    expect(recipientRequests.filter((r) => r.includes(key))).toEqual([]);
    expect(recipient.problems).toEqual([]);
    await recipient.context.close();
  });

  test('the sender sees when the link was opened, and deleting it stops it working', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const sender = await newDevice(browser);
    const link = await createShare(sender.page, [makeFile('draft.docx', 20_000)]);
    const recipient = await newDevice(browser);
    await recipient.page.goto(link);
    await expect(
      recipient.page.getByRole('heading', { name: '1 file ready to download' }),
    ).toBeVisible();

    // The owner view polls every 15 seconds.
    await expect(sender.page.getByText('Opened 1 time')).toBeVisible({ timeout: 25_000 });

    await sender.page.getByRole('button', { name: 'Delete Share' }).click();
    const confirm = sender.page.getByRole('dialog', { name: 'Delete this share?' });
    await confirm.getByRole('button', { name: 'Delete now' }).click();
    await expect(sender.page.getByRole('heading', { name: 'Share deleted' })).toBeVisible();

    await recipient.page.reload();
    await expect(recipient.page.getByText('The sender deleted this share.')).toBeVisible();
    await sender.context.close();
    await recipient.context.close();
  });

  test('shares expire on the server and their encrypted data is removed', async ({ browser }) => {
    const sender = await newDevice(browser);
    const before = countFiles(SHORT_STORAGE);
    const link = await createShare(sender.page, [makeFile('short-lived.bin', 300_000)], SHORT_BASE);
    expect(countFiles(SHORT_STORAGE)).toBeGreaterThan(before);
    await sender.context.close();

    const recipient = await newDevice(browser);
    await recipient.page.goto(link);
    await expect(
      recipient.page.getByRole('heading', { name: '1 file ready to download' }),
    ).toBeVisible();
    await recipient.page.waitForTimeout(9_000);
    await recipient.page.reload();
    await expect(
      recipient.page.getByText('This share has expired and its files were removed.'),
    ).toBeVisible();
    // Cleanup ran: only small metadata tombstones remain, no ciphertext.
    await expect
      .poll(() => countFiles(SHORT_STORAGE), { timeout: 10_000 })
      .toBeLessThanOrEqual(before + 1);
    await recipient.context.close();
  });

  test('broken links, wrong keys and unknown shares fail safely', async ({ browser }) => {
    const sender = await newDevice(browser);
    const link = await createShare(sender.page, [makeFile('secret.txt', 500)]);
    await sender.context.close();
    const { context, page } = await newDevice(browser);

    const [base, key] = link.split('#') as [string, string];
    const wrongKey = (key[0] === 'A' ? 'B' : 'A') + key.slice(1);
    await page.goto(`${base}#${wrongKey}`);
    await expect(page.getByText(/key doesn’t match these files/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Download/ })).toHaveCount(0);

    await page.goto(`${base}#short`);
    await expect(page.getByText(/link is incomplete or broken/)).toBeVisible();
    await page.goto(base);
    await expect(page.getByText(/link is incomplete or broken/)).toBeVisible();

    await page.goto(`/s/AAAAAAAAAAAAAAAAAAAAAA#${key}`);
    await expect(page.getByText(/There are no files at this link/)).toBeVisible();
    await context.close();
  });

  test('limits are explained before anything is encrypted or uploaded', async ({ page }) => {
    await page.goto(`${SHORT_BASE}/share`);
    await expect(page.getByText(/Up to 3 files · 2 MB in total/)).toBeVisible();
    await page.locator('input[type=file]').setInputFiles(makeFile('too-big.mov', 1_500_000));
    await expect(page.getByText(/Larger than 1 MB/)).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Each file can be up to 1 MB.')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('an empty selection asks for files', async ({ page }) => {
    await page.goto('/share');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Choose at least one file.')).toBeVisible();
  });
});

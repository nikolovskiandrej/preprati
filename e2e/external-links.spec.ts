/**
 * Links that leave preprati.: copied into a chat (Instagram, WhatsApp…),
 * opened on another phone, perhaps in the chat app's built-in browser, which
 * can't save files. The copied link, the shared link and the QR code are the
 * same URL; opening it needs no earlier visit; the built-in browser offers
 * the phone's own browser first without using up the session; a link opened
 * twice connects the second page as soon as the first lets go; and saving
 * never claims more than the browser confirms.
 */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  captureDownload,
  decodeQrPng,
  fileHash,
  HTTP_SIGNALING_BASE,
  makeFile,
  newDevice,
  sha256,
} from './helpers';

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const INSTAGRAM_IOS = {
  ...PHONE,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 339.0.3.12.91 (iPhone14,5; iOS 17_5; en_US; en; scale=3.00; 1170x2532; 618401163; IABMV/1)',
};
const CLIPBOARD = { permissions: ['clipboard-read', 'clipboard-write'] };

const readClipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

/** The live-session link a sending laptop copies with "Copy Link". */
async function copiedSessionLink(laptop: Page): Promise<string> {
  await laptop.getByTestId('copy-link').click();
  await expect(laptop.getByTestId('copy-link')).toHaveText(/Link copied/);
  return readClipboard(laptop);
}

test.describe('Links opened from other apps', () => {
  test('the copied link is the QR code’s URL and opens straight into the session', async ({
    browser,
  }) => {
    const laptop = await newDevice(browser, CLIPBOARD);
    const file = makeFile('Договор за стан.pdf', 400_000);
    await laptop.page.goto('/send');
    await laptop.page.locator('input[type=file]').setInputFiles(file);
    const link = await copiedSessionLink(laptop.page);
    // A public URL of this origin, never a local address; one session id, nothing secret.
    expect(link).toMatch(new RegExp(`^${new URL(laptop.page.url()).origin}/j/[A-Za-z0-9_-]{22}$`));
    await expect(laptop.page.getByText(/works only while this page stays open/)).toBeVisible();
    const png = await captureDownload(laptop.page, () =>
      laptop.page.getByTestId('download-qr').click(),
    );
    expect(decodeQrPng(png.bytes)).toBe(link);

    // A fresh phone (no earlier visit, no storage) opens it from a chat that adds tracking.
    const phone = await newDevice(browser, PHONE);
    await phone.page.goto(`${link}?igsh=MWQ1ZGUxMzBkMA%3D%3D&utm_source=ig_web_copy_link`);
    await expect(phone.page.getByText('Incoming files')).toBeVisible({ timeout: 30_000 });
    await phone.page.getByRole('button', { name: 'Accept' }).click();
    await expect(phone.page.getByText(/1 file received from/)).toBeVisible();
    const saved = await captureDownload(phone.page, () =>
      phone.page.getByRole('button', { name: /^Save: / }).click(),
    );
    expect(saved.name).toBe(path.basename(file)); // Cyrillic and spaces intact
    expect(sha256(saved.bytes)).toBe(fileHash(file));
    // The browser was asked to download; nothing claims the file is on the phone.
    await expect(phone.page.getByRole('button', { name: /^Save again: / })).toBeVisible();

    expect([...laptop.problems, ...phone.problems]).toEqual([]);
    await laptop.context.close();
    await phone.context.close();
  });

  test('Instagram’s built-in browser offers the phone’s browser and leaves the session to it', async ({
    browser,
  }) => {
    const laptop = await newDevice(browser, CLIPBOARD);
    const file = makeFile('scan.pdf', 300_000);
    await laptop.page.goto('/send');
    await laptop.page.locator('input[type=file]').setInputFiles(file);
    const link = await copiedSessionLink(laptop.page);

    const instagram = await newDevice(browser, { ...INSTAGRAM_IOS, ...CLIPBOARD });
    await instagram.page.goto(link);
    await expect(instagram.page.getByText('Open this in your browser')).toBeVisible();
    await expect(
      instagram.page.getByText(/Instagram’s built-in browser can’t save files/),
    ).toBeVisible();
    await expect(instagram.page.getByRole('link', { name: 'Open in browser' })).toBeVisible();
    await instagram.page.getByRole('button', { name: 'Copy link' }).click();
    expect(await readClipboard(instagram.page)).toBe(link);
    // It hasn't joined: the laptop still waits, with its code.
    await instagram.page.waitForTimeout(2_000);
    await expect(laptop.page.getByTestId('pairing-code')).toBeVisible();

    // The same link in the phone's browser gets the session.
    const safari = await newDevice(browser, PHONE);
    await safari.page.goto(link);
    await expect(safari.page.getByText('Incoming files')).toBeVisible({ timeout: 30_000 });
    await safari.page.getByRole('button', { name: 'Accept' }).click();
    await expect(safari.page.getByText(/1 file received from/)).toBeVisible();
    const saved = await captureDownload(safari.page, () =>
      safari.page.getByRole('button', { name: /^Save: / }).click(),
    );
    expect(sha256(saved.bytes)).toBe(fileHash(file));

    expect([...laptop.problems, ...instagram.problems, ...safari.problems]).toEqual([]);
    await Promise.all([laptop, instagram, safari].map((d) => d.context.close()));
  });

  test('a link opened twice connects the second page once the first lets go', async ({
    browser,
  }) => {
    // Like production: HTTP signaling, where a closing page says goodbye with a beacon.
    const laptop = await newDevice(browser, { baseURL: HTTP_SIGNALING_BASE, ...CLIPBOARD });
    const file = makeFile('photo.jpg', 250_000);
    await laptop.page.goto('/send');
    await laptop.page.locator('input[type=file]').setInputFiles(file);
    const link = await copiedSessionLink(laptop.page);

    // First opened inside Instagram (and carried on there), then in the phone's browser.
    const instagram = await newDevice(browser, INSTAGRAM_IOS);
    await instagram.page.goto(link);
    await instagram.page.getByRole('button', { name: 'Continue here anyway' }).click();
    await expect(instagram.page.getByText('Incoming files')).toBeVisible({ timeout: 30_000 });
    const safari = await newDevice(browser, PHONE);
    await safari.page.goto(link);
    await expect(safari.page.getByText('This link is open somewhere else right now')).toBeVisible({
      timeout: 15_000,
    });

    // Closing Instagram's page frees the link (nothing was received there), and the
    // waiting page connects by itself.
    await instagram.context.close();
    await expect(safari.page.getByText('Incoming files')).toBeVisible({ timeout: 30_000 });
    await safari.page.getByRole('button', { name: 'Accept' }).click();
    await expect(safari.page.getByText(/1 file received from/)).toBeVisible();
    const saved = await captureDownload(safari.page, () =>
      safari.page.getByRole('button', { name: /^Save: / }).click(),
    );
    expect(sha256(saved.bytes)).toBe(fileHash(file));

    expect([...laptop.problems, ...safari.problems]).toEqual([]);
    await laptop.context.close();
    await safari.context.close();
  });

  test('a share link opened in Instagram keeps its key through the handoff and downloads', async ({
    browser,
  }) => {
    const sender = await newDevice(browser);
    const file = makeFile('семинарска работа.docx', 700_000);
    await sender.page.goto('/share');
    await sender.page.locator('input[type=file]').setInputFiles(file);
    await sender.page.getByRole('button', { name: 'Continue' }).click();
    await sender.page
      .getByRole('dialog')
      .getByRole('button', { name: 'Encrypt & create link' })
      .click();
    const link = await sender.page.getByTestId('share-link').inputValue();

    const instagram = await newDevice(browser, { ...INSTAGRAM_IOS, ...CLIPBOARD });
    const shareRequests: string[] = [];
    instagram.page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/shares')) shareRequests.push(r.url());
    });
    await instagram.page.goto(link);
    await expect(instagram.page.getByText('Open this in your browser')).toBeVisible();
    expect(shareRequests).toEqual([]); // nothing fetched (or counted as opened) yet
    await instagram.page.getByRole('button', { name: 'Copy link' }).click();
    expect(await readClipboard(instagram.page)).toBe(link); // the key in the fragment included
    // "Open in browser" carries the whole link, key included, to Safari.
    await expect(instagram.page.getByTestId('open-in-browser')).toHaveAttribute(
      'href',
      `x-safari-${link}`,
    );

    // Carrying on here still works in a browser that can download (Chrome in this test).
    await instagram.page.getByRole('button', { name: 'Continue here anyway' }).click();
    await expect(
      instagram.page.getByRole('heading', { name: '1 file ready to download' }),
    ).toBeVisible();
    await expect(instagram.page.getByText(/may not save files/)).toBeVisible();
    const download = await captureDownload(instagram.page, async () => {
      await instagram.page.getByRole('button', { name: /^Download / }).click();
      // Browsers save only right after a tap; a slow decrypt asks for one more.
      const save = instagram.page.getByRole('button', { name: /^Save .*семинарска/ });
      if (await save.isVisible().catch(() => false)) await save.click();
    });
    expect(download.name).toBe(path.basename(file));
    expect(sha256(download.bytes)).toBe(fileHash(file));
    await expect(instagram.page.getByRole('button', { name: /^Save .*семинарска/ })).toHaveText(
      /Save again/,
    );

    expect([...sender.problems, ...instagram.problems]).toEqual([]);
    await sender.context.close();
    await instagram.context.close();
  });
});

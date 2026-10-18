/**
 * When two devices can't connect directly: nobody has to press anything. The
 * sending device switches to relay mode on its own (end to end encrypted,
 * within the same session) or, when its files are too large for that, makes
 * one more direct attempt. Only when nothing works do both devices explain
 * the failure — at the same moment — and offer "Try again" without a new
 * code. A sender whose partner is gone can still switch to a share link
 * without choosing the files again.
 */
import { expect, test } from '@playwright/test';
import {
  blockAllConnections,
  blockFirstConnection,
  blockFirstConnections,
  captureDownload,
  errorsShown,
  fileHash,
  HTTP_SIGNALING_BASE,
  makeFile,
  newDevice,
  pairingCode,
  recordErrors,
  sha256,
  SHORT_BASE,
  storedPackageData,
} from './helpers';

const RECOVERY = { timeout: 60_000 };
const HTTP_STORAGE = 'test-results/e2e-storage/http';
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

test.describe('Connecting across networks', () => {
  test('a failed first attempt is retried on its own when relay mode can’t take the files', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    // The short-limits server takes at most 1 MB per file through preprati., so this
    // 1.5 MB file can only go directly: the sender makes another direct attempt by itself.
    const laptop = await newDevice(browser, { baseURL: SHORT_BASE });
    const phone = await newDevice(browser, { baseURL: SHORT_BASE, ...PHONE });
    for (const device of [laptop, phone]) {
      await blockFirstConnection(device.context);
      await recordErrors(device.context);
    }
    const file = makeFile('video.mp4', 1_500_000);

    await laptop.page.goto('/send');
    await laptop.page.locator('input[type=file]').setInputFiles(file);
    const code = await pairingCode(laptop.page);
    await phone.page.goto(`/j/${code}`);
    await laptop.page.getByRole('button', { name: 'Allow' }).click(); // a code join, a real choice

    await expect(phone.page.getByText('Incoming files')).toBeVisible(RECOVERY);
    await expect(laptop.page.getByText(/Direct connection/)).toBeVisible();
    await phone.page.getByRole('button', { name: 'Accept' }).click();
    await expect(phone.page.getByText(/1 file received from/)).toBeVisible();
    const saved = await captureDownload(phone.page, () =>
      phone.page.getByRole('button', { name: /^Save: / }).click(),
    );
    expect(sha256(saved.bytes)).toBe(fileHash(file));
    expect(await errorsShown(laptop.page)).toEqual([]);
    expect(await errorsShown(phone.page)).toEqual([]);

    expect([...laptop.problems, ...phone.problems]).toEqual([]);
    await laptop.context.close();
    await phone.context.close();
  });

  test('when nothing works, both devices explain it together, and "Try again" reconnects', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const laptop = await newDevice(browser, { baseURL: SHORT_BASE });
    const phone = await newDevice(browser, { baseURL: SHORT_BASE, ...PHONE });
    // The first attempt and the automatic one both fail.
    await blockFirstConnections(laptop.context, 2);
    await blockFirstConnections(phone.context, 2);
    const file = makeFile('video.mp4', 1_500_000); // too large for relay mode here

    await laptop.page.goto('/send');
    await laptop.page.locator('input[type=file]').setInputFiles(file);
    const code = await pairingCode(laptop.page);
    await phone.page.goto(`/j/${code}`);
    await laptop.page.getByRole('button', { name: 'Allow' }).click();

    await expect(laptop.page.getByText('Couldn’t connect the devices')).toBeVisible(RECOVERY);
    // The sender said it had nothing left to try, so the phone explains it right away too.
    await expect(phone.page.getByText('Couldn’t connect the devices')).toBeVisible({
      timeout: 5_000,
    });
    // The e2e servers run without STUN, like a same-network-only deployment.
    await expect(
      laptop.page.getByText(/directly only when they’re on the same network/),
    ).toBeVisible();
    await laptop.page.getByText('Connection details').click();
    await expect(laptop.page.getByText('Not set up on this server')).toBeVisible();
    await expect(laptop.page.getByText(/Attempt 2, stopped after \d+ s/)).toBeVisible();

    await phone.page.getByRole('button', { name: 'Try again' }).click();
    await expect(phone.page.getByText('Incoming files')).toBeVisible({ timeout: 30_000 });
    await expect(laptop.page.getByText(/Direct connection/)).toBeVisible();
    await phone.page.getByRole('button', { name: 'Accept' }).click();
    await expect(phone.page.getByText(/1 file received from/)).toBeVisible();

    expect([...laptop.problems, ...phone.problems]).toEqual([]);
    await laptop.context.close();
    await phone.context.close();
  });

  test('devices on a network that keeps them apart send through preprati. on their own', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    // Like production: HTTP signaling, files stored in between.
    const laptop = await newDevice(browser, { baseURL: HTTP_SIGNALING_BASE });
    const phone = await newDevice(browser, { baseURL: HTTP_SIGNALING_BASE, ...PHONE });
    for (const device of [laptop, phone]) {
      await blockAllConnections(device.context);
      await recordErrors(device.context);
    }
    const file = makeFile('holiday.mov', 2_500_000); // several 1 MiB chunks

    await laptop.page.goto('/send');
    await laptop.page.locator('input[type=file]').setInputFiles(file);
    const code = await pairingCode(laptop.page);
    await phone.page.goto(`/j/${code}`);
    await laptop.page.getByRole('button', { name: 'Allow' }).click();

    // No other button: the failed direct attempt turns into relay mode by itself.
    await expect(phone.page.getByText('Incoming files')).toBeVisible(RECOVERY);
    await phone.page.getByRole('button', { name: 'Accept' }).click();
    await expect(phone.page.getByText(/1 file received from/)).toBeVisible({ timeout: 60_000 });
    await expect(laptop.page.getByText(/Sent! 1 file delivered/)).toBeVisible();
    await expect(laptop.page.getByText('Through preprati.', { exact: true })).toBeVisible();

    const saved = await captureDownload(phone.page, () =>
      phone.page.getByRole('button', { name: /^Save: / }).click(),
    );
    expect(saved.name).toMatch(/holiday\.mov$/);
    expect(sha256(saved.bytes)).toBe(fileHash(file));
    // The package was deleted as soon as the phone had it.
    await expect.poll(() => storedPackageData(HTTP_STORAGE), { timeout: 10_000 }).toEqual([]);
    expect(await errorsShown(laptop.page)).toEqual([]);
    expect(await errorsShown(phone.page)).toEqual([]);

    expect([...laptop.problems, ...phone.problems]).toEqual([]);
    await laptop.context.close();
    await phone.context.close();
  });

  test('a phone that joined to send gets connected through preprati. on its own', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const laptop = await newDevice(browser);
    const phone = await newDevice(browser, PHONE);
    for (const device of [laptop, phone]) {
      await blockAllConnections(device.context);
      await recordErrors(device.context);
    }

    await laptop.page.goto('/receive');
    const code = await pairingCode(laptop.page);
    await phone.page.goto(`/j/${code}`);
    await expect(phone.page.getByText(/Choose the files to send to/)).toBeVisible(RECOVERY);
    await expect(phone.page.getByText('Through preprati.', { exact: true })).toBeVisible();

    const file = makeFile('scan.pdf', 400_000);
    await phone.page.locator('input[type=file]').setInputFiles(file);
    await phone.page.getByRole('button', { name: 'Send 1 file' }).click();
    await laptop.page.getByRole('button', { name: 'Accept' }).click({ timeout: 30_000 });
    await expect(laptop.page.getByText(/1 file received from/)).toBeVisible({ timeout: 60_000 });
    const saved = await captureDownload(laptop.page, () =>
      laptop.page.getByRole('button', { name: /^Save: / }).click(),
    );
    expect(sha256(saved.bytes)).toBe(fileHash(file));
    expect(await errorsShown(laptop.page)).toEqual([]);
    expect(await errorsShown(phone.page)).toEqual([]);

    expect([...laptop.problems, ...phone.problems]).toEqual([]);
    await laptop.context.close();
    await phone.context.close();
  });

  test('a sender whose partner left can still send the same files as a share link', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const laptop = await newDevice(browser);
    const phone = await newDevice(browser);
    await blockAllConnections(laptop.context);
    await blockAllConnections(phone.context);
    const file = makeFile('slides.pdf', 300_000);

    await laptop.page.goto('/send');
    await laptop.page.locator('input[type=file]').setInputFiles(file);
    const code = await pairingCode(laptop.page);
    await phone.page.goto(`/j/${code}`);
    await laptop.page.getByRole('button', { name: 'Allow' }).click();
    await expect(laptop.page.getByText(/Connecting to/)).toBeVisible();

    // The other device leaves before the files got there; a link still works on any network.
    await phone.context.close();
    await laptop.page.getByRole('button', { name: 'Send as a link instead' }).click(RECOVERY);
    await expect(laptop.page).toHaveURL(/\/share$/);
    await expect(laptop.page.getByText(/1 file selected/)).toBeVisible();
    await expect(laptop.page.getByText('slides', { exact: false }).first()).toBeVisible();

    expect(laptop.problems).toEqual([]);
    await laptop.context.close();
  });
});

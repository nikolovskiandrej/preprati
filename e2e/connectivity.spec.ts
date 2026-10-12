/**
 * When two devices can't connect directly: the failure is explained, the
 * same devices can try again without a new code, the sender can send the
 * files through preprati. instead (relay mode: end to end encrypted, within
 * the same session), and a sender whose partner is gone can still switch to
 * a share link without choosing the files again.
 */
import { expect, test } from '@playwright/test';
import {
  blockAllConnections,
  blockFirstConnection,
  captureDownload,
  fileHash,
  HTTP_SIGNALING_BASE,
  makeFile,
  newDevice,
  pairingCode,
  sha256,
  storedPackageData,
} from './helpers';

const FAILURE = { timeout: 45_000 };
const HTTP_STORAGE = 'test-results/e2e-storage/http';
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

test.describe('Connecting across networks', () => {
  test('a failed connection is explained, and "Try again" reconnects the same devices', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const laptop = await newDevice(browser, { baseURL: HTTP_SIGNALING_BASE });
    const phone = await newDevice(browser, { baseURL: HTTP_SIGNALING_BASE, ...PHONE });
    await blockFirstConnection(laptop.context);
    await blockFirstConnection(phone.context);

    await laptop.page.goto('/receive');
    const code = await pairingCode(laptop.page);
    await phone.page.goto(`/j/${code}`);

    for (const device of [laptop, phone]) {
      await expect(device.page.getByText('Couldn’t connect the devices')).toBeVisible(FAILURE);
      // The e2e servers run without STUN, like a same-network-only deployment.
      await expect(
        device.page.getByText(/directly only when they’re on the same network/),
      ).toBeVisible();
    }
    // The phone has the files to send, so it can send them through preprati. instead…
    await expect(phone.page.getByRole('button', { name: 'Send through preprati.' })).toBeDisabled();
    // …and the laptop says where to find that.
    await expect(laptop.page.getByText(/choose “Send through preprati.”/)).toBeVisible();
    await laptop.page.getByText('Connection details').click();
    await expect(laptop.page.getByText('Not set up on this server')).toBeVisible();
    await expect(laptop.page.getByText(/Attempt 1, stopped after \d+ s/)).toBeVisible();

    await phone.page.getByRole('button', { name: 'Try again' }).click();
    await expect(phone.page.getByText(/Choose the files to send to/)).toBeVisible();
    await expect(laptop.page.getByText(/Direct connection/)).toBeVisible();

    const file = makeFile('after-retry.bin', 700_000);
    await phone.page.locator('input[type=file]').setInputFiles(file);
    await phone.page.getByRole('button', { name: 'Send 1 file' }).click();
    await laptop.page.getByRole('button', { name: 'Accept' }).click();
    await expect(laptop.page.getByText(/1 file received from/)).toBeVisible();
    const saved = await captureDownload(laptop.page, () =>
      laptop.page.getByRole('button', { name: /^Save: / }).click(),
    );
    expect(sha256(saved.bytes)).toBe(fileHash(file));

    expect([...laptop.problems, ...phone.problems]).toEqual([]);
    await laptop.context.close();
    await phone.context.close();
  });

  test('devices on a network that keeps them apart send through preprati. instead', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    // Like production: HTTP signaling, files stored in between.
    const laptop = await newDevice(browser, { baseURL: HTTP_SIGNALING_BASE });
    const phone = await newDevice(browser, { baseURL: HTTP_SIGNALING_BASE, ...PHONE });
    await blockAllConnections(laptop.context);
    await blockAllConnections(phone.context);
    const file = makeFile('holiday.mov', 2_500_000); // several 1 MiB chunks

    await laptop.page.goto('/send');
    await laptop.page.locator('input[type=file]').setInputFiles(file);
    const code = await pairingCode(laptop.page);
    await phone.page.goto(`/j/${code}`);
    await laptop.page.getByRole('button', { name: 'Allow' }).click();

    // While the direct attempt drags on (or once it failed), the sender switches over.
    await laptop.page.getByRole('button', { name: /^Send through preprati\./ }).click(FAILURE);
    await expect(phone.page.getByText('Incoming files')).toBeVisible({ timeout: 30_000 });
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

    expect([...laptop.problems, ...phone.problems]).toEqual([]);
    await laptop.context.close();
    await phone.context.close();
  });

  test('a phone that joined to send can send through preprati. after a failed connection', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const laptop = await newDevice(browser);
    const phone = await newDevice(browser, PHONE);
    await blockAllConnections(laptop.context);
    await blockAllConnections(phone.context);

    await laptop.page.goto('/receive');
    const code = await pairingCode(laptop.page);
    await phone.page.goto(`/j/${code}`);
    await expect(phone.page.getByText('Couldn’t connect the devices')).toBeVisible(FAILURE);
    await expect(laptop.page.getByText(/choose “Send through preprati.”/)).toBeVisible(FAILURE);

    const relay = phone.page.getByRole('button', { name: 'Send through preprati.' });
    await expect(relay).toBeDisabled(); // nothing chosen yet
    const file = makeFile('scan.pdf', 400_000);
    await phone.page.locator('input[type=file]').setInputFiles(file);
    await expect(phone.page.getByText(/encrypted on this device first/)).toBeVisible();
    await relay.click();

    await laptop.page.getByRole('button', { name: 'Accept' }).click({ timeout: 30_000 });
    await expect(laptop.page.getByText(/1 file received from/)).toBeVisible({ timeout: 60_000 });
    const saved = await captureDownload(laptop.page, () =>
      laptop.page.getByRole('button', { name: /^Save: / }).click(),
    );
    expect(sha256(saved.bytes)).toBe(fileHash(file));

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
    await expect(laptop.page.getByText('Couldn’t connect the devices')).toBeVisible(FAILURE);

    // Without the other device, relay mode is gone; a link still works on any network.
    await phone.context.close();
    await laptop.page.getByRole('button', { name: 'Send as a link instead' }).click(FAILURE);
    await expect(laptop.page).toHaveURL(/\/share$/);
    await expect(laptop.page.getByText(/1 file selected/)).toBeVisible();
    await expect(laptop.page.getByText('slides', { exact: false }).first()).toBeVisible();

    expect(laptop.problems).toEqual([]);
    await laptop.context.close();
  });
});

/**
 * When two devices can't connect directly: the failure is explained, the
 * same devices can try again without a new code, and a sender can switch to
 * a share link without choosing the files again.
 */
import { expect, test } from '@playwright/test';
import {
  blockFirstConnection,
  captureDownload,
  fileHash,
  HTTP_SIGNALING_BASE,
  makeFile,
  newDevice,
  pairingCode,
  sha256,
} from './helpers';

const FAILURE = { timeout: 45_000 };

test.describe('Connecting across networks', () => {
  test('a failed connection is explained, and "Try again" reconnects the same devices', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const laptop = await newDevice(browser, { baseURL: HTTP_SIGNALING_BASE });
    const phone = await newDevice(browser, {
      baseURL: HTTP_SIGNALING_BASE,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await blockFirstConnection(laptop.context);
    await blockFirstConnection(phone.context);

    await laptop.page.goto('/receive');
    const code = await pairingCode(laptop.page);
    await phone.page.goto(`/j/${code}`);

    for (const device of [laptop, phone]) {
      await expect(device.page.getByText('Couldn’t connect the devices')).toBeVisible(FAILURE);
      // The e2e servers run without STUN, like a same-network-only deployment.
      await expect(
        device.page.getByText(/only connects devices on the same network/),
      ).toBeVisible();
    }
    await expect(phone.page.getByText(/Or send the files as a link/)).toBeVisible();
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

  test('a sender can send the same files as a share link when the devices can’t connect', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const laptop = await newDevice(browser);
    const phone = await newDevice(browser);
    await blockFirstConnection(laptop.context);
    await blockFirstConnection(phone.context);
    const file = makeFile('slides.pdf', 300_000);

    await laptop.page.goto('/send');
    await laptop.page.locator('input[type=file]').setInputFiles(file);
    const code = await pairingCode(laptop.page);
    await phone.page.goto(`/j/${code}`);
    await laptop.page.getByRole('button', { name: 'Allow' }).click();

    await expect(laptop.page.getByText('Couldn’t connect the devices')).toBeVisible(FAILURE);
    await expect(phone.page.getByText(/ask the sender to share the files as a link/)).toBeVisible(
      FAILURE,
    );
    await laptop.page.getByRole('button', { name: 'Send as a link instead' }).click();
    await expect(laptop.page).toHaveURL(/\/share$/);
    await expect(laptop.page.getByText(/1 file selected/)).toBeVisible();
    await expect(laptop.page.getByText('slides', { exact: false }).first()).toBeVisible();

    expect([...laptop.problems, ...phone.problems]).toEqual([]);
    await laptop.context.close();
    await phone.context.close();
  });
});

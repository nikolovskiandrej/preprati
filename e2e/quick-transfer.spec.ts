import { expect, test } from '@playwright/test';
import {
  captureDownload,
  decodeQrPng,
  fileHash,
  makeFile,
  newDevice,
  pairingCode,
  readStoredZip,
  sha256,
  SHORT_BASE,
} from './helpers';

test.describe('Quick Transfer', () => {
  test('phone → laptop: receive by pairing code, accept, and save byte-identical files', async ({
    browser,
  }) => {
    const laptop = await newDevice(browser);
    const phone = await newDevice(browser, {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const files = [makeFile('report.pdf', 2_500_000), makeFile('notes.txt', 1200)];

    await laptop.page.goto('/receive');
    const code = await pairingCode(laptop.page);
    await expect(laptop.page.getByText(/Code expires in \d:\d\d/)).toBeVisible();

    await phone.page.goto(`/j/${code}`);
    await expect(phone.page.getByText(/Choose the files to send to/)).toBeVisible();
    await expect(
      laptop.page.getByText(/Connected to .* Waiting|Waiting for files from/).first(),
    ).toBeVisible();
    await expect(laptop.page.getByText(/Direct connection/)).toBeVisible();

    await phone.page.locator('input[type=file]').setInputFiles(files);
    await phone.page.getByRole('button', { name: 'Send 2 files' }).click();
    await expect(laptop.page.getByText('Incoming files')).toBeVisible();
    await expect(phone.page.getByText(/Waiting for .* to accept/)).toBeVisible();
    await laptop.page.getByRole('button', { name: 'Accept' }).click();

    await expect(laptop.page.getByText(/2 files received from/)).toBeVisible();
    await expect(phone.page.getByText(/Sent! 2 files delivered to/)).toBeVisible();

    const saved = [];
    // Each saved file's button turns into "Save again", so always take the first remaining "Save".
    for (let i = 0; i < files.length; i++) {
      saved.push(
        await captureDownload(laptop.page, () =>
          laptop.page
            .getByRole('button', { name: /^Save: / })
            .first()
            .click(),
        ),
      );
    }
    // The browser was asked to download each file; nothing claims they are saved.
    await expect(laptop.page.getByRole('button', { name: /^Save again: / })).toHaveCount(2);
    expect(saved.map((s) => sha256(s.bytes)).sort()).toEqual(files.map(fileHash).sort());

    const zip = await captureDownload(laptop.page, () =>
      laptop.page.getByRole('button', { name: 'Save all (.zip)' }).click(),
    );
    expect(zip.name).toBe('preprati-files.zip');
    const entries = readStoredZip(zip.bytes);
    expect([...entries.values()].map((b) => sha256(b)).sort()).toEqual(files.map(fileHash).sort());

    expect([...laptop.problems, ...phone.problems]).toEqual([]);
    await laptop.context.close();
    await phone.context.close();
  });

  test('laptop → phone: the copied QR image opens the same live session and files are offered automatically', async ({
    browser,
  }) => {
    const laptop = await newDevice(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
    const phone = await newDevice(browser, {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const file = makeFile('presentation.key', 3_000_000);

    await laptop.page.goto('/send');
    await expect(laptop.page.getByText('Choose files first')).toBeVisible();
    await laptop.page.locator('input[type=file]').setInputFiles(file);
    await expect(laptop.page.getByText(/1 file selected/)).toBeVisible();
    await expect(laptop.page.getByTestId('pairing-code')).toBeVisible();

    // Copy QR Code puts a real PNG image on the clipboard…
    await laptop.page.getByTestId('copy-qr').click();
    await expect(laptop.page.getByTestId('copy-qr')).toHaveText(/QR copied/);
    const pngBase64 = await laptop.page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const blob = await items[0]!.getType('image/png');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    });
    // …which decodes to the link of this very session.
    const url = decodeQrPng(Buffer.from(pngBase64, 'base64'));
    expect(url).toMatch(/\/j\/[A-Za-z0-9_-]{22}$/);
    const copiedLink = await (async () => {
      await laptop.page.getByTestId('copy-link').click();
      return laptop.page.evaluate(() => navigator.clipboard.readText());
    })();
    expect(copiedLink).toBe(url);

    // The downloaded PNG encodes the same link.
    const download = await captureDownload(laptop.page, () =>
      laptop.page.getByTestId('download-qr').click(),
    );
    expect(download.name).toBe('preprati-session-qr.png');
    expect(decodeQrPng(download.bytes)).toBe(url);

    await phone.page.goto(url!);
    await expect(phone.page.getByText('Incoming files')).toBeVisible();
    await phone.page.getByRole('button', { name: 'Accept' }).click();
    await expect(phone.page.getByText(/1 file received from/)).toBeVisible();
    const saved = await captureDownload(phone.page, () =>
      phone.page.getByRole('button', { name: /^Save: / }).click(),
    );
    expect(sha256(saved.bytes)).toBe(fileHash(file));
    await expect(laptop.page.getByText(/Sent! 1 file delivered/)).toBeVisible();

    // "Send more" keeps the connection: a second batch goes through without re-pairing.
    const second = makeFile('second.bin', 50_000);
    await laptop.page.getByRole('button', { name: 'Send more files' }).click();
    await laptop.page.locator('input[type=file]').setInputFiles(second);
    await laptop.page.getByRole('button', { name: 'Send 1 file' }).click();
    await phone.page.getByRole('button', { name: 'Accept' }).click();
    await expect(laptop.page.getByText(/Sent! 1 file delivered/)).toBeVisible();

    expect([...laptop.problems, ...phone.problems]).toEqual([]);
    await laptop.context.close();
    await phone.context.close();
  });

  test('a device joining a sending host by code must be allowed first, and can be declined', async ({
    browser,
  }) => {
    const host = await newDevice(browser);
    const stranger = await newDevice(browser);
    const friend = await newDevice(browser);
    await host.page.goto('/send');
    await host.page.locator('input[type=file]').setInputFiles(makeFile('private.pdf', 1000));
    const code = await pairingCode(host.page);

    await stranger.page.goto(`/j/${code}`);
    await expect(stranger.page.getByText(/Waiting for .* to allow this device/)).toBeVisible();
    await expect(host.page.getByText('Allow this device?')).toBeVisible();
    await host.page.getByRole('button', { name: 'Decline' }).click();
    await expect(
      stranger.page.getByText('The other device didn’t allow this connection.'),
    ).toBeVisible();
    // The stranger never saw any file names.
    await expect(stranger.page.getByText('private.pdf')).toHaveCount(0);

    await friend.page.goto(`/j/${code}`);
    await host.page.getByRole('button', { name: 'Allow' }).click();
    await expect(friend.page.getByText('Incoming files')).toBeVisible();
    await expect(friend.page.getByText('private')).toBeVisible();

    await host.context.close();
    await stranger.context.close();
    await friend.context.close();
  });

  test('declined and cancelled transfers are reported clearly on both sides', async ({
    browser,
  }) => {
    const receiver = await newDevice(browser);
    const sender = await newDevice(browser);
    await receiver.page.goto('/receive');
    const code = await pairingCode(receiver.page);
    await sender.page.goto(`/j/${code}`);
    await sender.page.locator('input[type=file]').setInputFiles(makeFile('unwanted.zip', 4000));
    await sender.page.getByRole('button', { name: 'Send 1 file' }).click();
    await receiver.page.getByRole('button', { name: 'Decline' }).click();
    await expect(sender.page.getByText(/declined the files/)).toBeVisible();
    await expect(receiver.page.getByText('You declined the files.')).toBeVisible();

    // Sending again works over the same connection; then the sender cancels while it waits.
    await sender.page.getByRole('button', { name: 'Send again' }).click();
    await expect(receiver.page.getByText('Incoming files')).toBeVisible();
    await sender.page.getByRole('button', { name: 'Cancel' }).click();
    await expect(sender.page.getByText('You cancelled the transfer.')).toBeVisible();
    await expect(receiver.page.getByText(/cancelled the transfer/)).toBeVisible();

    await receiver.context.close();
    await sender.context.close();
  });

  test('tells the other device when one side leaves', async ({ browser }) => {
    const receiver = await newDevice(browser);
    const sender = await newDevice(browser);
    await receiver.page.goto('/receive');
    const code = await pairingCode(receiver.page);
    await sender.page.goto(`/j/${code}`);
    await expect(sender.page.getByText(/Choose the files to send to/)).toBeVisible();
    // The joining device leaves before anything was sent: the same code keeps working.
    await sender.context.close();
    await expect(receiver.page.getByText(/left before anything was sent/)).toBeVisible();
    expect(await pairingCode(receiver.page)).toBe(code);

    const next = await newDevice(browser);
    await next.page.goto(`/j/${code}`);
    await expect(next.page.getByText(/Choose the files to send to/)).toBeVisible();
    // The device that shared the code leaves: the other one is told the link is over.
    await receiver.context.close();
    await expect(
      next.page.getByText(/other device closed preprati\.|connection was lost/),
    ).toBeVisible();
    await next.context.close();
  });

  test('pairing codes expire on the server, and a new session can be started', async ({
    browser,
  }) => {
    const host = await newDevice(browser);
    await host.page.goto(`${SHORT_BASE}/receive`);
    const code = await pairingCode(host.page);
    await expect(host.page.getByText('Session expired', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(host.page.getByText(/expired before a device joined/)).toBeVisible();

    const late = await newDevice(browser);
    await late.page.goto(`${SHORT_BASE}/j/${code}`);
    await expect(late.page.getByText(/doesn’t lead to an active transfer/)).toBeVisible();

    await host.page.getByRole('button', { name: 'Start a new session' }).click();
    const fresh = await pairingCode(host.page);
    expect(fresh).not.toBe(code);
    await host.context.close();
    await late.context.close();
  });

  test('invalid join links explain what to do', async ({ page }) => {
    await page.goto('/j/not-a-code');
    await expect(page.getByText(/connection link is incomplete/)).toBeVisible();
    await page.getByRole('button', { name: 'Enter a code' }).click();
    await expect(page).toHaveURL(/\/join$/);
    await page.getByLabel('Pairing code').fill('AB');
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText(/Codes have 6 letters or digits/)).toBeVisible();
  });
});

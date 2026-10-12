/**
 * Quick Transfer when signaling runs over HTTP polling (the serverless
 * deployment profile): same flows, real WebRTC between two browser contexts.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  captureDownload,
  fileHash,
  HTTP_SIGNALING_BASE,
  makeFile,
  newDevice,
  pairingCode,
  sha256,
} from './helpers';

test.use({ baseURL: HTTP_SIGNALING_BASE });

/** Records WebSocket attempts and signaling requests made by a page. */
function watchTransport(page: Page) {
  const seen = { websockets: 0, signalRequests: 0 };
  page.on('websocket', () => seen.websockets++);
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/signal/')) seen.signalRequests++;
  });
  return seen;
}

test.describe('Quick Transfer over HTTP signaling', () => {
  test('phone → laptop by pairing code, byte-identical, without WebSockets', async ({
    browser,
  }) => {
    const laptop = await newDevice(browser);
    const phone = await newDevice(browser, {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const laptopTransport = watchTransport(laptop.page);
    const phoneTransport = watchTransport(phone.page);
    const files = [makeFile('scan.pdf', 3_000_000), makeFile('todo.txt', 900)];

    await laptop.page.goto('/receive');
    const code = await pairingCode(laptop.page);
    await phone.page.goto(`/j/${code}`);
    await expect(phone.page.getByText(/Choose the files to send to/)).toBeVisible();
    await expect(laptop.page.getByText(/Direct connection/)).toBeVisible();

    await phone.page.locator('input[type=file]').setInputFiles(files);
    await phone.page.getByRole('button', { name: 'Send 2 files' }).click();
    await laptop.page.getByRole('button', { name: 'Accept' }).click();
    await expect(laptop.page.getByText(/2 files received from/)).toBeVisible();
    await expect(phone.page.getByText(/Sent! 2 files delivered to/)).toBeVisible();

    const saved = [];
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
    expect(saved.map((s) => sha256(s.bytes)).sort()).toEqual(files.map(fileHash).sort());

    expect(laptopTransport.websockets + phoneTransport.websockets).toBe(0);
    expect(laptopTransport.signalRequests).toBeGreaterThan(0);
    expect(phoneTransport.signalRequests).toBeGreaterThan(0);
    expect([...laptop.problems, ...phone.problems]).toEqual([]);
    await laptop.context.close();
    await phone.context.close();
  });

  test('a sending host allows a device that joined by code; files are offered automatically', async ({
    browser,
  }) => {
    const host = await newDevice(browser);
    const guest = await newDevice(browser);
    const file = makeFile('slides.pdf', 1_500_000);
    await host.page.goto('/send');
    await host.page.locator('input[type=file]').setInputFiles(file);
    const code = await pairingCode(host.page);

    await guest.page.goto(`/j/${code}`);
    await expect(guest.page.getByText(/Waiting for .* to allow this device/)).toBeVisible();
    await expect(host.page.getByText('Allow this device?')).toBeVisible();
    await host.page.getByRole('button', { name: 'Allow' }).click();

    await expect(guest.page.getByText('Incoming files')).toBeVisible();
    await guest.page.getByRole('button', { name: 'Accept' }).click();
    await expect(guest.page.getByText(/1 file received from/)).toBeVisible();
    const saved = await captureDownload(guest.page, () =>
      guest.page.getByRole('button', { name: /^Save: / }).click(),
    );
    expect(sha256(saved.bytes)).toBe(fileHash(file));
    await expect(host.page.getByText(/Sent! 1 file delivered/)).toBeVisible();

    expect([...host.problems, ...guest.problems]).toEqual([]);
    await host.context.close();
    await guest.context.close();
  });

  test('tells the waiting device when the other one leaves before connecting', async ({
    browser,
  }) => {
    const host = await newDevice(browser);
    const guest = await newDevice(browser);
    await host.page.goto('/send');
    await host.page.locator('input[type=file]').setInputFiles(makeFile('later.bin', 1000));
    const code = await pairingCode(host.page);
    await guest.page.goto(`/j/${code}`);
    await expect(host.page.getByText('Allow this device?')).toBeVisible();
    await guest.context.close(); // pagehide → disconnect beacon
    await expect(host.page.getByText('Allow this device?')).toBeHidden();
    await expect(host.page.getByTestId('pairing-code')).toBeVisible();
    await host.context.close();
  });
});

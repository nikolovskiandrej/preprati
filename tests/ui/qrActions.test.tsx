// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as QrModule from '../../src/client/lib/qr';

const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
const saved: Array<{ blob: Blob; name: string }> = [];

vi.mock('../../src/client/lib/qr', async (importOriginal) => {
  const actual = await importOriginal<typeof QrModule>();
  // jsdom has no canvas; the real PNG renderer is exercised in the browser E2E tests.
  return { ...actual, renderQrPng: vi.fn(async () => png) };
});
vi.mock('../../src/client/lib/download', () => ({
  saveBlob: (blob: Blob, name: string) => saved.push({ blob, name }),
  canShareFiles: () => false,
}));

const { QrActions } = await import('../../src/client/ui/QrActions');
const { renderWithProviders } = await import('./render');

const URL_WITH_KEY =
  'https://preprati.example/s/5pgLrIf4xQB56QlE8eMTqw#tWTkAHIBK-HXqtWAzP0fOw1RugbDlbZcAWgSq2qVoT0';

function renderActions() {
  return renderWithProviders(
    <QrActions
      url={URL_WITH_KEY}
      fileName="preprati-share-qr.png"
      image={{ url: URL_WITH_KEY, title: 'Scan to download shared files' }}
      shareTitle="preprati."
      shareText="Scan to download shared files"
    />,
  );
}

describe('QR actions', () => {
  beforeEach(() => {
    saved.length = 0;
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('copies the QR code as a PNG image and confirms only after success', async () => {
    const user = userEvent.setup(); // installs its own clipboard; stub ours afterwards
    const write = vi.fn(async () => undefined);
    const items: unknown[] = [];
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(readonly data: Record<string, Blob | Promise<Blob>>) {
          items.push(data);
        }
        static supports = (type: string) => type === 'image/png';
      },
    );
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText: vi.fn() },
      configurable: true,
    });
    renderActions();
    await user.click(screen.getByTestId('copy-qr'));
    await waitFor(() => expect(screen.getByTestId('copy-qr')).toHaveTextContent('QR copied'));
    expect(write).toHaveBeenCalledTimes(1);
    const data = items[0] as Record<string, Promise<Blob>>;
    expect(Object.keys(data)).toEqual(['image/png']);
    expect(await data['image/png']).toBe(png);
    // Nothing was written as text: the link was not silently copied instead.
    expect(
      (navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> }).writeText,
    ).not.toHaveBeenCalled();
  });

  it('explains when image copying is unsupported and offers the PNG download', async () => {
    const user = userEvent.setup(); // installs its own clipboard; stub ours afterwards
    vi.stubGlobal('ClipboardItem', undefined);
    renderActions();
    await user.click(screen.getByTestId('copy-qr'));
    expect(await screen.findByText(/can’t copy images/)).toBeInTheDocument();
    expect(screen.getByTestId('copy-qr')).not.toHaveTextContent('QR copied');
    const toast = screen.getByRole('alert');
    await user.click(within(toast).getByRole('button', { name: 'Download QR Code' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ name: 'preprati-share-qr.png', blob: png });
  });

  it('reports a blocked clipboard instead of claiming success', async () => {
    const user = userEvent.setup(); // installs its own clipboard; stub ours afterwards
    vi.stubGlobal(
      'ClipboardItem',
      class {
        static supports = () => true;
      },
    );
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        write: vi.fn(async () => Promise.reject(new DOMException('denied', 'NotAllowedError'))),
        writeText: vi.fn(),
      },
      configurable: true,
    });
    renderActions();
    await user.click(screen.getByTestId('copy-qr'));
    expect(await screen.findByText(/Copying the image was blocked/)).toBeInTheDocument();
  });

  it('copies the complete link', async () => {
    const user = userEvent.setup(); // installs its own clipboard; stub ours afterwards
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderActions();
    await user.click(screen.getByTestId('copy-link'));
    await waitFor(() => expect(screen.getByTestId('copy-link')).toHaveTextContent('Link copied'));
    expect(writeText).toHaveBeenCalledWith(URL_WITH_KEY);
  });

  it('falls back to copying the link when native sharing is unavailable', async () => {
    const user = userEvent.setup(); // installs its own clipboard; stub ours afterwards
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    renderActions();
    await user.click(screen.getByTestId('share'));
    expect(
      await screen.findByText(/Sharing isn’t available here, so the link was copied instead/),
    ).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(URL_WITH_KEY);
  });

  it('uses the native share sheet with the QR image when files can be shared', async () => {
    const user = userEvent.setup(); // installs its own clipboard; stub ours afterwards
    const share = vi.fn(async (_data: ShareData) => undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    renderActions();
    await user.click(screen.getByTestId('share'));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const data = share.mock.calls[0]![0];
    expect(data.files?.[0]?.name).toBe('preprati-share-qr.png');
    expect(data.text).toContain(URL_WITH_KEY);
  });

  it('downloads the QR code as a PNG', async () => {
    const user = userEvent.setup(); // installs its own clipboard; stub ours afterwards
    renderActions();
    await user.click(screen.getByTestId('download-qr'));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.name).toBe('preprati-share-qr.png');
    expect(screen.getByTestId('download-qr')).toHaveTextContent('QR downloaded');
  });
});

// @vitest-environment jsdom
/**
 * A link tapped in Instagram & co. opens in the app's built-in browser,
 * which can't save files. Receiving pages offer the phone's own browser
 * first and don't join or download until the person decides; saving says no
 * more than the browser confirms, and uses the share sheet where downloads
 * go nowhere.
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReceivedFilesList } from '../../src/client/features/quick/panels';
import { saveFile } from '../../src/client/lib/download';
import JoinScreen from '../../src/client/screens/JoinScreen';
import { QuickSession } from '../../src/client/transfer/quickSession';
import type { ReceivedFile } from '../../src/client/transfer/engine';
import { renderWithProviders } from './render';

const INSTAGRAM_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36 Instagram 343.0.0.33.101 Android';
const INSTAGRAM_IOS_16 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 339.0.3.12.91';
const realUserAgent = navigator.userAgent;
const SESSION = 'AbCdEfGhIjKlMnOpQrStUv';

function setUserAgent(value: string) {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
}

describe('in an app’s built-in browser', () => {
  let join: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    join = vi.spyOn(QuickSession.prototype, 'join').mockResolvedValue(undefined);
  });
  afterEach(() => {
    setUserAgent(realUserAgent);
    vi.restoreAllMocks();
  });

  it('offers the phone’s browser first and doesn’t take the session until asked', async () => {
    setUserAgent(INSTAGRAM_ANDROID);
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    renderWithProviders(<JoinScreen params={{ token: SESSION }} />, { path: `/j/${SESSION}` });

    expect(screen.getByText('Open this in your browser')).toBeInTheDocument();
    expect(screen.getByText(/Instagram’s built-in browser can’t save files/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in browser' })).toBeInTheDocument();
    expect(screen.getByText(/⋮ menu/)).toBeInTheDocument();
    expect(join).not.toHaveBeenCalled(); // the real browser must get the session

    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(await screen.findByText(/Link copied. Paste it/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue here anyway' }));
    await waitFor(() => expect(join).toHaveBeenCalledWith({ via: 'link', sessionId: SESSION }));
  });

  it('explains the menu where no one-tap handoff exists (iOS before 17)', () => {
    setUserAgent(INSTAGRAM_IOS_16);
    renderWithProviders(<JoinScreen params={{ token: SESSION }} />, { path: `/j/${SESSION}` });
    expect(screen.queryByRole('button', { name: 'Open in browser' })).not.toBeInTheDocument();
    expect(screen.getByText(/••• menu/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });

  it('joins right away in a regular browser', async () => {
    renderWithProviders(<JoinScreen params={{ token: SESSION }} />, { path: `/j/${SESSION}` });
    await waitFor(() => expect(join).toHaveBeenCalled());
    expect(screen.queryByText('Open this in your browser')).not.toBeInTheDocument();
  });
});

describe('saving received files', () => {
  const file: ReceivedFile = {
    transferId: 't1',
    index: 0,
    name: 'извештај 2026.pdf',
    size: 4,
    type: 'application/pdf',
    lastModified: 0,
    blob: new Blob(['%PDF']),
  };
  let clicked: string[];

  beforeEach(() => {
    clicked = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
  });

  it('asks the browser to download and doesn’t claim the file was saved', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReceivedFilesList files={[file]} />);
    await user.click(screen.getByRole('button', { name: /^Save: / }));
    expect(clicked).toEqual(['извештај 2026.pdf']); // the original, Unicode name
    expect(await screen.findByRole('button', { name: /^Save again: / })).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(screen.getByText(/look in its downloads/)).toBeInTheDocument();
  });

  it('saves through the share sheet in a built-in browser, when it takes files', async () => {
    const share = vi.fn(async (_data: ShareData) => undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    const user = userEvent.setup();
    renderWithProviders(<ReceivedFilesList files={[file]} inAppBrowser />);
    // The live link is used up once files moved, so the way out is a new transfer.
    expect(
      screen.getByText(/may not save files.*ask the sender to send them again/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Save: / }));
    expect(share).toHaveBeenCalledTimes(1);
    const shared = share.mock.calls[0]![0].files![0]!;
    expect(shared.name).toBe('извештај 2026.pdf');
    expect(shared.type).toBe('application/pdf');
    expect(clicked).toEqual([]); // no download into nothing
    expect(await screen.findByText('Done')).toBeInTheDocument();
  });

  it('treats a closed share sheet as nothing saved yet', async () => {
    const share = vi.fn(async () => {
      throw new DOMException('closed', 'AbortError');
    });
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    await expect(saveFile(file.blob, file.name, { preferShare: true })).resolves.toBe('cancelled');
    expect(clicked).toEqual([]);
  });

  it('falls back to a download when the share sheet refuses', async () => {
    Object.defineProperty(navigator, 'share', {
      value: async () => {
        throw new DOMException('no gesture', 'NotAllowedError');
      },
      configurable: true,
    });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    let outcome: string | undefined;
    await act(async () => {
      outcome = await saveFile(file.blob, file.name, { preferShare: true });
    });
    expect(outcome).toBe('requested');
    expect(clicked).toEqual(['извештај 2026.pdf']);
  });
});

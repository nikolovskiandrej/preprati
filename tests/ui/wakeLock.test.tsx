// @vitest-environment jsdom
/**
 * The screen stays on while a session is live (a phone that locks suspends
 * the page and its connection), comes back after the page was hidden, and
 * is let go when the session ends or nothing happened for a while.
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWakeLock } from '../../src/client/app/hooks';

class FakeWakeLock {
  readonly requests: string[] = [];
  readonly sentinels: Array<{ released: boolean; release: () => Promise<void> }> = [];
  request(type: string) {
    this.requests.push(type);
    const sentinel = {
      released: false,
      release: async () => {
        sentinel.released = true;
      },
    };
    this.sentinels.push(sentinel);
    return Promise.resolve(sentinel);
  }
  get held(): number {
    return this.sentinels.filter((sentinel) => !sentinel.released).length;
  }
}

function Probe({ active, activity }: { active: boolean; activity: unknown }) {
  useWakeLock(active, activity, 60_000);
  return null;
}

describe('useWakeLock', () => {
  let wakeLock: FakeWakeLock;

  beforeEach(() => {
    vi.useFakeTimers();
    wakeLock = new FakeWakeLock();
    Object.defineProperty(navigator, 'wakeLock', { value: wakeLock, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, 'wakeLock');
  });

  const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

  it('keeps the screen on while active, and lets go when the session ends', async () => {
    const view = render(<Probe active activity="connecting" />);
    await flush();
    expect(wakeLock.requests).toEqual(['screen']);
    expect(wakeLock.held).toBe(1);
    view.rerender(<Probe active={false} activity="disconnected" />);
    await flush();
    expect(wakeLock.held).toBe(0);
  });

  it('takes the lock again when the page comes back from the background', async () => {
    render(<Probe active activity="transferring" />);
    await flush();
    // The browser drops the lock while the page is hidden.
    wakeLock.sentinels[0]!.released = true;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(wakeLock.requests).toEqual(['screen', 'screen']);
    expect(wakeLock.held).toBe(1);
  });

  it('tries again at the next tap when the browser wants a user gesture first', async () => {
    let refuse = true;
    const request = wakeLock.request.bind(wakeLock);
    wakeLock.request = (type: string) =>
      refuse
        ? Promise.reject(new DOMException('gesture needed', 'NotAllowedError'))
        : request(type);
    render(<Probe active activity="waiting-for-peer" />);
    await flush();
    expect(wakeLock.held).toBe(0);
    refuse = false;
    document.dispatchEvent(new Event('pointerdown'));
    await flush();
    expect(wakeLock.held).toBe(1);
    document.dispatchEvent(new Event('pointerdown')); // already held: nothing more
    await flush();
    expect(wakeLock.requests).toEqual(['screen']);
  });

  it('lets go after a while without any change, and holds again on the next one', async () => {
    const view = render(<Probe active activity="connected:0" />);
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(59_000));
    expect(wakeLock.held).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(wakeLock.held).toBe(0);
    view.rerender(<Probe active activity="awaiting-acceptance:0" />);
    await flush();
    expect(wakeLock.held).toBe(1);
  });

  it('does nothing where the browser has no wake lock', async () => {
    Reflect.deleteProperty(navigator, 'wakeLock');
    render(<Probe active activity="connecting" />);
    await flush();
    expect(wakeLock.requests).toEqual([]);
  });
});

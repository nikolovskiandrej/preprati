import { useEffect, useState, useSyncExternalStore } from 'react';

interface Store<T> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => T;
  dispose: () => void;
}

/**
 * Owns a disposable store (QuickSession, ShareCreator, ShareRetriever) for
 * the lifetime of a component. The store is created inside an effect, so
 * React StrictMode's dev-only mount/unmount/mount cycle disposes the first
 * instance and keeps a fresh, live one — never a disposed one.
 */
export function useOwnedStore<T, S extends Store<T>>(
  factory: () => S,
  deps: readonly unknown[] = [],
): [S | null, T | null] {
  const [store, setStore] = useState<S | null>(null);

  useEffect(() => {
    const instance = factory();
    // Publishing a resource created by this effect is the point of the hook: it must be
    // created and disposed with the mount (StrictMode-safe), which render-time creation is not.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStore(instance);
    return () => instance.dispose();
    // The factory is intentionally read once per `deps` change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const snapshot = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : nullSnapshot,
    nullSnapshot,
  ) as T | null;
  return [store, snapshot];
}

const noopSubscribe = () => () => undefined;
const nullSnapshot = () => null;

/** Re-renders every `intervalMs` while `enabled` (for countdowns and relative times). */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

const NOT_IDLE = Symbol('not idle');

/**
 * Keeps the screen on while `active` (Screen Wake Lock API): a phone that
 * locks its screen suspends the page, and with it a pairing or a transfer in
 * progress. Browsers drop the lock whenever the page is hidden; it is taken
 * again when the page comes back (or at the next tap, for browsers that only
 * grant it after a user gesture). After `idleMs` without a change of
 * `activity` the lock is let go, so a forgotten page doesn't keep the screen
 * on for good. Without the API (older browsers) this does nothing.
 */
export function useWakeLock(active: boolean, activity: unknown, idleMs = 5 * 60_000): void {
  const [idleSince, setIdleSince] = useState<unknown>(NOT_IDLE);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setIdleSince(activity), idleMs);
    return () => clearTimeout(timer);
  }, [active, activity, idleMs]);
  const enabled = active && !Object.is(idleSince, activity);

  useEffect(() => {
    const wakeLock = typeof navigator !== 'undefined' ? navigator.wakeLock : undefined;
    if (!enabled || !wakeLock) return;
    let sentinel: WakeLockSentinel | null = null;
    let requesting = false;
    let stopped = false;
    const acquire = () => {
      if (stopped || requesting || document.visibilityState !== 'visible') return;
      if (sentinel && !sentinel.released) return;
      requesting = true;
      wakeLock
        .request('screen')
        .then((lock) => {
          if (stopped) void lock.release().catch(() => undefined);
          else sentinel = lock;
        })
        .catch(() => undefined) // not allowed right now (battery saver, hidden page, no gesture)
        .finally(() => {
          requesting = false;
        });
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    document.addEventListener('pointerdown', acquire, { passive: true });
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', acquire);
      document.removeEventListener('pointerdown', acquire);
      void sentinel?.release().catch(() => undefined);
    };
  }, [enabled]);
}

/** Asks the browser to confirm before leaving while `active` (e.g. mid-transfer). */
export function useLeaveWarning(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);
}

/** The current URL fragment, updated on `hashchange` (same-document navigations). */
export function useLocationHash(): string {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('hashchange', onChange);
      return () => window.removeEventListener('hashchange', onChange);
    },
    () => window.location.hash,
    () => '',
  );
}

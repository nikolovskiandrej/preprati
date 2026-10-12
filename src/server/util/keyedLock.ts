/**
 * Per-key readers/writer lock.
 *
 * Share uploads take a shared lock for each chunk write so they can proceed in
 * parallel; finalize, delete and the cleanup job take the exclusive lock so a
 * late chunk write can never resurrect data after a package was purged.
 * Waiters are served in FIFO order, and a queued writer blocks new readers.
 */
interface Waiter {
  mode: 'read' | 'write';
  resume: () => void;
}

interface LockState {
  readers: number;
  writer: boolean;
  queue: Waiter[];
}

export class KeyedRwLock {
  private readonly states = new Map<string, LockState>();

  async read<T>(key: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(key, 'read');
    try {
      return await fn();
    } finally {
      this.release(key, 'read');
    }
  }

  async write<T>(key: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(key, 'write');
    try {
      return await fn();
    } finally {
      this.release(key, 'write');
    }
  }

  /** Number of keys with active holders or waiters (for tests/diagnostics). */
  get activeKeys(): number {
    return this.states.size;
  }

  private acquire(key: string, mode: 'read' | 'write'): Promise<void> {
    let state = this.states.get(key);
    if (!state) {
      state = { readers: 0, writer: false, queue: [] };
      this.states.set(key, state);
    }
    if (state.queue.length === 0 && this.canGrant(state, mode)) {
      this.grant(state, mode);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      state.queue.push({ mode, resume: resolve });
    });
  }

  private release(key: string, mode: 'read' | 'write'): void {
    const state = this.states.get(key);
    if (!state) return;
    if (mode === 'read') state.readers--;
    else state.writer = false;

    while (state.queue.length > 0) {
      const next = state.queue[0]!;
      if (!this.canGrant(state, next.mode)) break;
      state.queue.shift();
      this.grant(state, next.mode);
      next.resume();
      if (next.mode === 'write') break;
    }

    if (state.readers === 0 && !state.writer && state.queue.length === 0) {
      this.states.delete(key);
    }
  }

  private canGrant(state: LockState, mode: 'read' | 'write'): boolean {
    return mode === 'read' ? !state.writer : !state.writer && state.readers === 0;
  }

  private grant(state: LockState, mode: 'read' | 'write'): void {
    if (mode === 'read') state.readers++;
    else state.writer = true;
  }
}

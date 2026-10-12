import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';

// jsdom installs its own `crypto` without SubtleCrypto; tests use Node's Web Crypto
// implementation, which is the same standard API the browser provides.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

// Testing Library only auto-cleans when test globals are enabled; do it explicitly for DOM tests.
if (typeof document !== 'undefined') {
  const { afterEach } = await import('vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => cleanup());
}

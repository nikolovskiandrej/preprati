/**
 * Loads the server's public runtime configuration once per page and shares
 * the result (ConfigProvider, Quick Transfer transport selection).
 */
import type { PublicConfig } from '../../shared/shareApi';
import { apiJson, withRetry } from './http';

let cached: Promise<PublicConfig> | null = null;

export function loadPublicConfig(): Promise<PublicConfig> {
  cached ??= withRetry(() => apiJson<PublicConfig>('/api/config', { timeoutMs: 10_000 }), {
    attempts: 3,
  }).catch((error: unknown) => {
    cached = null; // allow a later retry
    throw error;
  });
  return cached;
}

/** Test helper. */
export function resetPublicConfigCache(): void {
  cached = null;
}

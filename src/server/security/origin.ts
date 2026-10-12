import type { ServerConfig } from '../config';

/**
 * Decides whether a browser origin may call the API or open the signaling
 * socket. Allowed: requests without an Origin header (non-browser clients),
 * same-host requests, PUBLIC_ORIGIN and any ALLOWED_ORIGINS entry.
 */
export function isOriginAllowed(
  origin: string | undefined,
  hostHeader: string | undefined,
  config: Pick<ServerConfig, 'publicOrigin' | 'allowedOrigins'>,
): boolean {
  if (origin === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // includes the opaque "null" origin
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (config.publicOrigin && parsed.origin === config.publicOrigin) return true;
  if (config.allowedOrigins.includes(parsed.origin)) return true;
  return !!hostHeader && parsed.host.toLowerCase() === hostHeader.toLowerCase();
}

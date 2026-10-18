import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from '../config';

/**
 * Security headers applied to every response. HTML documents additionally get
 * a strict Content-Security-Policy: no inline or third-party scripts, no
 * third-party connections, no framing. The share page loads nothing from
 * other origins, and `Referrer-Policy: no-referrer` keeps share/session paths
 * out of Referer headers.
 */
export function applySecurityHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Pick<ServerConfig, 'publicOrigin' | 'allowedOrigins' | 'env'>,
): void {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  reply.header('Origin-Agent-Cluster', '?1');
  reply.header(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  );

  const secure = isSecureRequest(request, config);
  if (secure) reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');

  const contentType = String(reply.getHeader('content-type') ?? '');
  if (contentType.startsWith('text/html')) {
    reply.header('Content-Security-Policy', buildCsp(request, config, secure));
  }
}

export function isSecureRequest(
  request: FastifyRequest,
  config: Pick<ServerConfig, 'publicOrigin'>,
): boolean {
  // request.protocol honours X-Forwarded-Proto only when TRUST_PROXY is set.
  if (request.protocol === 'https') return true;
  return (
    !!config.publicOrigin?.startsWith('https:') &&
    request.hostname === new URL(config.publicOrigin).hostname
  );
}

function buildCsp(
  request: FastifyRequest,
  config: Pick<ServerConfig, 'publicOrigin' | 'allowedOrigins' | 'env'>,
  secure: boolean,
): string {
  // blob: — this page's own object URLs (received files); mobile Chrome checks loading a
  // blob: image against connect-src, so without it previews of received photos stay empty.
  const connect = new Set<string>(["'self'", 'blob:']);
  const host = request.headers.host;
  if (host && /^[A-Za-z0-9.:[\]-]+$/.test(host)) {
    connect.add(`${secure ? 'wss' : 'ws'}://${host}`);
  }
  for (const origin of [config.publicOrigin, ...config.allowedOrigins]) {
    if (!origin) continue;
    connect.add(origin);
    connect.add(origin.replace(/^http/, 'ws'));
  }
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src ${[...connect].join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (secure) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

import { createHash, createHmac } from 'node:crypto';
import type { IceServerConfig } from '../../shared/signaling';

/**
 * ICE (STUN/TURN) configuration — the only place ICE servers are defined.
 * The signaling layer hands the result to both peers of each session, so the
 * browser bundle contains no server list and no credentials.
 *
 * - STUN tells each browser its public address, which is what lets two
 *   devices on different networks connect directly. It never carries file
 *   data, and it cannot connect networks that forbid direct paths.
 * - TURN relays the (still end-to-end encrypted) traffic when no direct path
 *   exists. It is optional and off by default: a relay spends bandwidth on a
 *   server that someone has to run, and hosted relays bill per gigabyte.
 */

/**
 * Free STUN servers from two independent providers, on two different ports
 * (some networks block one of them). Both answer over IPv4 and IPv6.
 * - Cloudflare: "Cloudflare's STUN service at stun.cloudflare.com is free and
 *   unlimited" (developers.cloudflare.com/realtime/turn/faq/).
 * - Google: the public endpoint used throughout WebRTC examples; no account,
 *   no published service level.
 * Two servers also reveal a strict ("symmetric") NAT: it maps one socket to a
 * different public port per destination.
 */
export const DEFAULT_STUN_URLS: readonly string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

/** Browsers slow down candidate gathering with many servers (Chrome warns at five). */
export const MAX_ICE_URLS = 4;

export interface TurnConfig {
  urls: string[];
  /** coturn `static-auth-secret` — enables short-lived HMAC credentials (preferred). */
  secret: string | null;
  /** Static long-term credentials (fallback when no shared secret is used). */
  username: string | null;
  credential: string | null;
  credentialTtlSeconds: number;
}

export interface IceConfig {
  stunUrls: string[];
  turn: TurnConfig | null;
}

const HOST = String.raw`(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)`;
const URL_PATTERNS = {
  // RFC 7064: stun:host[:port] / stuns:host[:port]
  stun: new RegExp(`^stuns?:${HOST}(?::(\\d{1,5}))?$`, 'i'),
  // RFC 7065: turn:host[:port][?transport=udp|tcp]
  turn: new RegExp(`^turns?:${HOST}(?::(\\d{1,5}))?(?:\\?transport=(?:udp|tcp))?$`, 'i'),
};

/**
 * Validates STUN or TURN URLs and removes duplicates. Returns the first
 * problem as a readable message instead of a list, so configuration errors
 * name the offending entry.
 */
export function validateIceUrls(
  urls: string[],
  kind: 'stun' | 'turn',
): { ok: true; urls: string[] } | { ok: false; error: string } {
  const unique = [...new Set(urls)];
  for (const url of unique) {
    const match = URL_PATTERNS[kind].exec(url);
    const port = match?.[1] === undefined ? null : Number(match[1]);
    if (!match || (port !== null && (port < 1 || port > 65535))) {
      const example =
        kind === 'stun' ? 'stun:stun.example.org:3478' : 'turn:turn.example.org:3478?transport=udp';
      return {
        ok: false,
        error: `"${url}" is not a valid ${kind.toUpperCase()} URL (e.g. ${example})`,
      };
    }
  }
  if (unique.length > MAX_ICE_URLS) {
    return {
      ok: false,
      error: `at most ${MAX_ICE_URLS} ${kind.toUpperCase()} URLs are useful; more only slow down connecting`,
    };
  }
  return { ok: true, urls: unique };
}

/** Human-readable notes about the ICE setup, logged once at startup. */
export function iceWarnings(config: IceConfig): string[] {
  if (config.stunUrls.length === 0 && !config.turn) {
    return [
      'STUN_URLS is empty and no TURN relay is configured: Quick Transfer can only connect devices on the same network',
    ];
  }
  return [];
}

/**
 * Builds the ICE server list handed to the two peers of a session.
 *
 * With `TURN_SECRET`, credentials follow the TURN REST API convention used by
 * coturn (`use-auth-secret`): username = "<expiry>:<opaque id>", credential =
 * base64(HMAC-SHA1(secret, username)). They expire on their own, so nothing
 * long-lived is ever delivered to browsers and nothing is embedded in the bundle.
 */
export function iceServersFor(
  config: IceConfig,
  sessionId: string,
  now: number = Date.now(),
): IceServerConfig[] {
  const servers: IceServerConfig[] = [];
  if (config.stunUrls.length > 0) servers.push({ urls: config.stunUrls });

  const turn = config.turn;
  if (turn) {
    if (turn.secret) {
      const expiry = Math.floor(now / 1000) + turn.credentialTtlSeconds;
      // Do not leak the session id to the TURN server's logs; use an opaque digest.
      const opaque = createHash('sha256').update(sessionId).digest('base64url').slice(0, 16);
      const username = `${expiry}:${opaque}`;
      const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
      servers.push({ urls: turn.urls, username, credential });
    } else if (turn.username && turn.credential) {
      servers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
    }
  }
  return servers;
}

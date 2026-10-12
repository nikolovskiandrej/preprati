import { createHash, createHmac } from 'node:crypto';
import type { IceServerConfig } from '../../shared/signaling';
import type { ServerConfig } from '../config';

/**
 * Builds the ICE server list handed to the two peers of a session.
 *
 * With `TURN_SECRET`, credentials follow the TURN REST API convention used by
 * coturn (`use-auth-secret`): username = "<expiry>:<opaque id>", credential =
 * base64(HMAC-SHA1(secret, username)). They expire on their own, so nothing
 * long-lived is ever delivered to browsers and nothing is embedded in the bundle.
 */
export function iceServersFor(
  config: ServerConfig['ice'],
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

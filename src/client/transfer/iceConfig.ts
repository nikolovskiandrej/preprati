/**
 * ICE servers arrive from the signaling server with each session (the server
 * is the only place they are configured; see src/server/signaling/ice.ts).
 * Before they reach RTCPeerConnection they are checked here: one malformed
 * entry would otherwise make the constructor throw and fail the connection
 * for a reason the user can do nothing about.
 */
import type { IceServerConfig } from '../../shared/signaling';

const ICE_URL = /^(stuns?|turns?):[^\s?#]+(?:\?transport=(?:udp|tcp))?$/i;

/** Usable servers only: valid URLs, and TURN entries with credentials. */
export function toRtcIceServers(servers: readonly IceServerConfig[]): RTCIceServer[] {
  const seen = new Set<string>();
  const result: RTCIceServer[] = [];
  for (const server of servers) {
    const hasCredentials = !!server.username && !!server.credential;
    const urls: string[] = [];
    for (const url of Array.isArray(server.urls) ? server.urls : [server.urls]) {
      if (typeof url !== 'string' || !ICE_URL.test(url) || seen.has(url)) continue;
      if (/^turns?:/i.test(url) && !hasCredentials) continue;
      seen.add(url);
      urls.push(url);
    }
    if (urls.length === 0) continue;
    result.push(
      server.username && server.credential
        ? { urls, username: server.username, credential: server.credential }
        : { urls },
    );
  }
  return result;
}

/** How many STUN and TURN URLs a configuration contains (for diagnostics). */
export function countIceServers(servers: readonly RTCIceServer[]): { stun: number; turn: number } {
  let stun = 0;
  let turn = 0;
  for (const server of servers) {
    for (const url of Array.isArray(server.urls) ? server.urls : [server.urls]) {
      if (/^stuns?:/i.test(url)) stun += 1;
      else if (/^turns?:/i.test(url)) turn += 1;
    }
  }
  return { stun, turn };
}

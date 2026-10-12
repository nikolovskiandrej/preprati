/**
 * Connection diagnostics: what each device learned about its network while
 * the two tried to connect, reduced to counts and flags. Addresses and ports
 * are only looked at here and never leave this module, so the result is safe
 * to show in the interface.
 *
 * Candidate types (RFC 8445):
 *   host   an address of the device itself (browsers hide it behind an mDNS
 *          name, so it only works within the same network)
 *   srflx  the device's public address as seen by a STUN server
 *   relay  an address on a TURN relay
 */

export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';

interface ParsedCandidate {
  type: CandidateType;
  protocol: string;
  address: string;
  port: number;
}

export interface CandidateSummary {
  host: number;
  srflx: number;
  relay: number;
  /**
   * One public address showed up with different ports for different STUN
   * servers: a strict ("symmetric") NAT, which picks a new public port per
   * destination. Two such networks, or one and a typical home router, cannot
   * connect directly without a relay.
   */
  strictNat: boolean;
}

export interface ConnectionDiagnostics {
  /** Connection attempt (0 = first, +1 per "Try again"). */
  attempt: number;
  stunServers: number;
  turnServers: number;
  local: CandidateSummary;
  remote: CandidateSummary;
  /** ICE connection states, in milliseconds since the attempt started. */
  iceStates: Array<{ state: RTCIceConnectionState; atMs: number }>;
  /** How long the attempt ran. */
  durationMs: number;
  /** ICE restarts after the connection dropped. */
  restarts: number;
  /**
   * Both devices reported the same public address: they sit behind one router
   * (the same home or office network). A failure then means that network keeps
   * them apart (client isolation, blocked local discovery, a VPN), not that two
   * different networks are incompatible.
   */
  sameNetwork: boolean;
}

/** Why a connection attempt failed, in terms the interface can explain. */
export type FailureCause =
  /** No STUN or TURN server is configured: only devices on one network can connect. */
  | 'same-network-only'
  /** Nothing arrived from the other device. */
  | 'no-remote-details'
  /** Both devices are on one network, but it doesn't let them reach each other. */
  | 'same-network-blocked'
  /** This device found no public route (its network or a privacy setting blocks it). */
  | 'local-network'
  /** The other device found no public route. */
  | 'remote-network'
  /** Both devices found public routes, but their networks don't let them meet. */
  | 'incompatible-networks';

/** Parses an SDP candidate attribute: "candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> …". */
export function parseCandidate(line: string): ParsedCandidate | null {
  const parts = line.replace(/^a=/, '').trim().split(/\s+/);
  if (parts.length < 8 || !parts[0]!.startsWith('candidate:') || parts[6] !== 'typ') return null;
  const type = parts[7] as CandidateType;
  if (type !== 'host' && type !== 'srflx' && type !== 'prflx' && type !== 'relay') return null;
  const port = Number(parts[5]);
  if (!Number.isInteger(port)) return null;
  return { type, protocol: parts[2]!.toLowerCase(), address: parts[4]!, port };
}

/** Collects the candidates of one side and summarizes them. */
export class CandidateLog {
  private readonly candidates: ParsedCandidate[] = [];

  add(line: string): void {
    const parsed = parseCandidate(line);
    if (parsed) this.candidates.push(parsed);
  }

  get size(): number {
    return this.candidates.length;
  }

  /**
   * The public networks this side showed up from: each IPv4 address seen by a
   * STUN server, and the /64 prefix of each public IPv6 address (devices on
   * one IPv6 network share it while their own addresses differ).
   */
  publicNetworks(): Set<string> {
    const networks = new Set<string>();
    for (const candidate of this.candidates) {
      if (candidate.type !== 'srflx') continue;
      const network = networkOf(candidate.address);
      if (network) networks.add(network);
    }
    return networks;
  }

  summary(): CandidateSummary {
    const count = (type: CandidateType) => this.candidates.filter((c) => c.type === type).length;
    const udp = this.candidates.filter((c) => c.protocol === 'udp');
    const localSockets = udp.filter((c) => c.type === 'host').length;
    const reflexive = udp.filter((c) => c.type === 'srflx');
    const portsByAddress = new Map<string, Set<number>>();
    for (const candidate of reflexive) {
      const ports = portsByAddress.get(candidate.address) ?? new Set<number>();
      ports.add(candidate.port);
      portsByAddress.set(candidate.address, ports);
    }
    // Several sockets behind one NAT legitimately get several ports; only more public
    // mappings than local sockets point to per-destination port allocation.
    const strictNat =
      reflexive.length > localSockets && [...portsByAddress.values()].some((p) => p.size > 1);
    return { host: count('host'), srflx: count('srflx'), relay: count('relay'), strictNat };
  }
}

export function emptySummary(): CandidateSummary {
  return { host: 0, srflx: 0, relay: 0, strictNat: false };
}

/** True when both sides showed up from a common public network (see `publicNetworks`). */
export function onSameNetwork(local: CandidateLog, remote: CandidateLog): boolean {
  const theirs = remote.publicNetworks();
  for (const network of local.publicNetworks()) if (theirs.has(network)) return true;
  return false;
}

/** "203.0.113.7" → itself; "2001:db8:a:b:1:2:3:4" → "2001:db8:a:b::/64"; anything else → null. */
function networkOf(address: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return address;
  if (!address.includes(':')) return null;
  const bare = address
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
  const [head = '', tail, ...rest] = bare.split('::');
  if (rest.length > 0) return null;
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** Explains a failed attempt from what both sides gathered. */
export function classifyFailure(diagnostics: ConnectionDiagnostics): FailureCause {
  const { local, remote } = diagnostics;
  if (diagnostics.stunServers === 0 && diagnostics.turnServers === 0) return 'same-network-only';
  if (remote.host + remote.srflx + remote.relay === 0) return 'no-remote-details';
  if (diagnostics.sameNetwork) return 'same-network-blocked';
  if (local.srflx + local.relay === 0) return 'local-network';
  if (remote.srflx + remote.relay === 0) return 'remote-network';
  return 'incompatible-networks';
}

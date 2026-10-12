import { describe, expect, it } from 'vitest';
import {
  CandidateLog,
  classifyFailure,
  emptySummary,
  onSameNetwork,
  parseCandidate,
  type ConnectionDiagnostics,
} from '../../src/client/transfer/diagnostics';
import { countIceServers, toRtcIceServers } from '../../src/client/transfer/iceConfig';

const host = (port: number, protocol = 'udp') =>
  `candidate:1 1 ${protocol} 2113937151 0b0e4c3f-6d2a.local ${port} typ host generation 0`;
const srflx = (address: string, port: number) =>
  `candidate:2 1 udp 1677729535 ${address} ${port} typ srflx raddr 0.0.0.0 rport 0 generation 0`;

function logOf(lines: string[]) {
  const log = new CandidateLog();
  for (const line of lines) log.add(line);
  return log;
}

const summarize = (lines: string[]) => logOf(lines).summary();

describe('candidate parsing', () => {
  it('reads type, transport and address from SDP candidate attributes', () => {
    expect(parseCandidate(srflx('203.0.113.4', 61000))).toEqual({
      type: 'srflx',
      protocol: 'udp',
      address: '203.0.113.4',
      port: 61000,
    });
    expect(parseCandidate(`a=${host(5000, 'TCP')} tcptype passive`)).toMatchObject({
      type: 'host',
      protocol: 'tcp',
    });
    expect(parseCandidate('')).toBeNull();
    expect(parseCandidate('candidate:1 1 udp 1 1.2.3.4 99 typ bogus')).toBeNull();
    expect(parseCandidate('not a candidate at all')).toBeNull();
  });
});

describe('candidate summary', () => {
  it('counts candidates per type', () => {
    expect(summarize([host(5000), srflx('203.0.113.4', 61000)])).toEqual({
      host: 1,
      srflx: 1,
      relay: 0,
      strictNat: false,
    });
    expect(summarize([])).toEqual(emptySummary());
  });

  it('recognises a strict NAT: one socket, a new public port per STUN server', () => {
    expect(
      summarize([host(5000), srflx('198.51.100.7', 61000), srflx('198.51.100.7', 61004)]).strictNat,
    ).toBe(true);
  });

  it('does not mistake two network interfaces behind one router for a strict NAT', () => {
    // Wi-Fi + Ethernet: two sockets, each with its own (stable) public port.
    expect(
      summarize([
        host(5000),
        host(5002),
        srflx('198.51.100.7', 61000),
        srflx('198.51.100.7', 61002),
        host(5004, 'tcp'),
      ]).strictNat,
    ).toBe(false);
  });
});

describe('same network', () => {
  it('recognises two devices behind one router by their shared public address', () => {
    // A laptop and a phone on one home Wi-Fi behind a strict NAT: same address, other ports.
    const laptop = logOf([host(5000), srflx('198.51.100.7', 5924), srflx('198.51.100.7', 5925)]);
    const phone = logOf([host(6000), srflx('198.51.100.7', 7311)]);
    expect(onSameNetwork(laptop, phone)).toBe(true);
    expect(onSameNetwork(laptop, logOf([host(6000), srflx('203.0.113.9', 7311)]))).toBe(false);
  });

  it('compares IPv6 addresses by their /64 network, however they are written', () => {
    const a = logOf([srflx('2001:db8:aa:1:2c4e:11ff:fe22:3344', 50000)]);
    const b = logOf([srflx('2001:0db8:00aa:0001::7', 50002)]);
    const elsewhere = logOf([srflx('2001:db8:aa:2::7', 50002)]);
    expect(onSameNetwork(a, b)).toBe(true);
    expect(onSameNetwork(a, elsewhere)).toBe(false);
  });

  it('ignores local and relay addresses, and needs public details from both sides', () => {
    const relayOnly = logOf([
      'candidate:3 1 udp 41885439 192.0.2.10 3478 typ relay raddr 0.0.0.0 rport 0 generation 0',
    ]);
    expect(onSameNetwork(relayOnly, relayOnly)).toBe(false);
    expect(onSameNetwork(logOf([host(5000)]), logOf([host(5000)]))).toBe(false);
    expect(onSameNetwork(logOf([srflx('198.51.100.7', 5924)]), new CandidateLog())).toBe(false);
  });
});

describe('failure causes', () => {
  const base: ConnectionDiagnostics = {
    attempt: 0,
    stunServers: 2,
    turnServers: 0,
    local: { host: 1, srflx: 1, relay: 0, strictNat: false },
    remote: { host: 1, srflx: 1, relay: 0, strictNat: false },
    iceStates: [],
    durationMs: 15_000,
    restarts: 0,
    sameNetwork: false,
  };

  it('says so when both devices are on one network that keeps them apart', () => {
    expect(classifyFailure({ ...base, sameNetwork: true })).toBe('same-network-blocked');
    // Without STUN there is no public address to compare, and silence stays silence.
    expect(classifyFailure({ ...base, sameNetwork: true, stunServers: 0 })).toBe(
      'same-network-only',
    );
    expect(classifyFailure({ ...base, sameNetwork: true, remote: emptySummary() })).toBe(
      'no-remote-details',
    );
  });

  it('blames the configuration, the signaling, one network or their combination', () => {
    expect(classifyFailure(base)).toBe('incompatible-networks');
    expect(classifyFailure({ ...base, stunServers: 0 })).toBe('same-network-only');
    expect(classifyFailure({ ...base, remote: emptySummary() })).toBe('no-remote-details');
    expect(classifyFailure({ ...base, local: { ...base.local, srflx: 0 } })).toBe('local-network');
    expect(classifyFailure({ ...base, remote: { ...base.remote, srflx: 0 } })).toBe(
      'remote-network',
    );
    // A relay candidate counts as a way out of the network.
    expect(
      classifyFailure({ ...base, turnServers: 1, local: { ...base.local, srflx: 0, relay: 1 } }),
    ).toBe('incompatible-networks');
  });
});

describe('ICE servers from the server', () => {
  it('keeps usable entries only and removes duplicates', () => {
    const servers = toRtcIceServers([
      { urls: ['stun:a.example:3478', 'stun:a.example:3478', 'stun:b.example:19302'] },
      { urls: 'turn:relay.example:3478?transport=udp', username: 'u', credential: 'c' },
      { urls: 'turn:relay.example:3478' }, // no credentials
      { urls: ['ftp://wrong.example', 'stun:has space'] },
    ]);
    expect(servers).toEqual([
      { urls: ['stun:a.example:3478', 'stun:b.example:19302'] },
      { urls: ['turn:relay.example:3478?transport=udp'], username: 'u', credential: 'c' },
    ]);
    expect(countIceServers(servers)).toEqual({ stun: 2, turn: 1 });
    expect(toRtcIceServers([])).toEqual([]);
  });
});

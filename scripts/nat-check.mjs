// Checks whether the network this computer is on allows direct WebRTC
// connections across networks: from ONE UDP socket it asks two independent
// STUN servers which public address and port they see, and tries IPv6.
//
//   npm run nat-check
//
// Same public port for both → endpoint-independent mapping: STUN hole punching
// works with most other networks. Different ports → a strict ("symmetric")
// NAT: direct connections only work with fairly open networks. No IP address
// is printed in full.
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';

const SERVERS = [
  ['stun.l.google.com', 19302],
  ['stun.cloudflare.com', 3478],
];
const COOKIE = 0x2112a442;

function bindingRequest() {
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001, 0);
  request.writeUInt32BE(COOKIE, 4);
  randomBytes(12).copy(request, 8);
  return request;
}

/** XOR-MAPPED-ADDRESS (IPv4 or IPv6) from a Binding Success response. */
function mappedAddress(message) {
  for (let offset = 20; offset + 4 <= message.length;) {
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    if (type === 0x0020) {
      const family = message[offset + 5];
      const port = message.readUInt16BE(offset + 6) ^ (COOKIE >>> 16);
      const mask = Buffer.concat([Buffer.alloc(4), message.subarray(8, 20)]);
      mask.writeUInt32BE(COOKIE, 0);
      const raw = message.subarray(offset + 8, offset + 8 + (family === 1 ? 4 : 16));
      const bytes = [...raw].map((byte, index) => byte ^ mask[index]);
      const ip =
        family === 1
          ? bytes.join('.')
          : Array.from({ length: 8 }, (_, i) =>
              ((bytes[2 * i] << 8) | bytes[2 * i + 1]).toString(16),
            ).join(':');
      return { ip, port };
    }
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return null;
}

/** Sends a Binding Request from `socket` and resolves with what the server saw (or null). */
function ask(socket, address, port) {
  const request = bindingRequest();
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (!message.subarray(8, 20).equals(request.subarray(8, 20))) return;
      finish(mappedAddress(message));
    };
    const retry = setInterval(() => socket.send(request, port, address), 500);
    const timeout = setTimeout(() => finish(null), 3000);
    function finish(result) {
      clearInterval(retry);
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(result);
    }
    socket.on('message', onMessage);
    socket.send(request, port, address);
  });
}

const masked = (ip) =>
  ip.includes('.') ? ip.replace(/^\d+\.\d+\.\d+/, 'x.x.x') : `${ip.split(':')[0]}:…`;

const v4 = dgram.createSocket('udp4');
await new Promise((resolve) => v4.bind(0, resolve));
const seen = [];
for (const [host, port] of SERVERS) {
  const { address } = await lookup(host, { family: 4 });
  const result = await ask(v4, address, port);
  seen.push(result);
  console.log(
    `${host.padEnd(20)} sees ${result ? `${masked(result.ip)}:${result.port}` : 'nothing (no answer)'}`,
  );
}
v4.close();

let ipv6 = false;
try {
  const v6 = dgram.createSocket('udp6');
  await new Promise((resolve, reject) => {
    v6.once('error', reject);
    v6.bind(0, resolve);
  });
  const { address } = await lookup(SERVERS[0][0], { family: 6 });
  ipv6 = (await ask(v6, address, SERVERS[0][1])) !== null;
  v6.close();
} catch {
  ipv6 = false;
}

console.log();
if (seen.some((result) => result === null)) {
  console.log(
    'UDP to STUN is blocked or filtered here: only same-network connections can work directly.',
  );
} else if (seen[0].port === seen[1].port) {
  console.log('Endpoint-independent mapping: direct connections to most other networks can work.');
} else {
  console.log('Strict ("symmetric") NAT: this network picks a new public port per destination.');
  console.log(
    'Direct connections only work with fairly open networks; see docs/CONNECTIVITY.md §4.',
  );
}
console.log(
  ipv6
    ? 'IPv6 works here: devices that both have IPv6 can connect without NAT.'
    : 'No working IPv6 here.',
);

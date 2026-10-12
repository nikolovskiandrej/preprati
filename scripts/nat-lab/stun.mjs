// Minimal RFC 5389 STUN binding server for the NAT lab: answers Binding
// Requests with XOR-MAPPED-ADDRESS (and MAPPED-ADDRESS for old clients), so
// browsers behind the lab's NATs learn their public address. IPv4 only.
//
//   node stun.mjs [port]
import dgram from 'node:dgram';

const port = Number(process.argv[2] ?? 3478);
const COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;

function addressAttribute(type, address, port, xor) {
  const attribute = Buffer.alloc(12);
  attribute.writeUInt16BE(type, 0);
  attribute.writeUInt16BE(8, 2);
  attribute.writeUInt8(0x01, 5); // IPv4
  const octets = address.split('.').map(Number);
  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  attribute.writeUInt16BE(xor ? port ^ (COOKIE >>> 16) : port, 6);
  attribute.writeUInt32BE(xor ? (value ^ COOKIE) >>> 0 : value, 8);
  return attribute;
}

const socket = dgram.createSocket('udp4');
socket.on('message', (message, remote) => {
  if (message.length < 20) return;
  if (message.readUInt16BE(0) !== BINDING_REQUEST || message.readUInt32BE(4) !== COOKIE) return;
  const header = Buffer.alloc(20);
  header.writeUInt16BE(BINDING_SUCCESS, 0);
  header.writeUInt16BE(24, 2);
  header.writeUInt32BE(COOKIE, 4);
  message.copy(header, 8, 8, 20); // transaction id
  socket.send(
    Buffer.concat([
      header,
      addressAttribute(0x0020, remote.address, remote.port, true),
      addressAttribute(0x0001, remote.address, remote.port, false),
    ]),
    remote.port,
    remote.address,
  );
});
socket.bind(port, '0.0.0.0', () => console.log(`STUN listening on udp/${port}`));

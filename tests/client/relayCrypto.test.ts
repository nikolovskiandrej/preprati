/**
 * Relay mode's end-to-end encryption: both devices derive one key from the
 * public halves they exchange over signaling, and every control message is
 * bound to its sender and its number.
 */
import { describe, expect, it } from 'vitest';
import {
  createRelayKeyPair,
  deriveRelayKey,
  openRelayMessage,
  RelayCryptoError,
  sealRelayMessage,
} from '../../src/client/transfer/relayCrypto';
import { toBase64Url } from '../../src/shared/encoding';
import { SignalPayloadSchema } from '../../src/shared/signaling';

async function agree(sessionId = 'session-1') {
  const sender = await createRelayKeyPair();
  const receiver = await createRelayKeyPair();
  const context = { sessionId, senderKey: sender.publicKey, receiverKey: receiver.publicKey };
  return {
    sender,
    receiver,
    context,
    senderKey: await deriveRelayKey(sender, receiver.publicKey, context),
    receiverKey: await deriveRelayKey(receiver, sender.publicKey, context),
  };
}

describe('relay mode encryption', () => {
  it('lets both devices derive the same key from the public halves they exchange', async () => {
    const { sender, senderKey, receiverKey } = await agree();
    expect(sender.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(SignalPayloadSchema.parse({ kind: 'relay-hello', key: sender.publicKey })).toBeTruthy();

    const message = { t: 'offer', name: 'квартален-извештај.pdf', secret: 'package-key' };
    const data = await sealRelayMessage(senderKey, 'sender', 0, message);
    expect(await openRelayMessage(receiverKey, 'sender', 0, data)).toEqual(message);
    // What the server relays is opaque.
    expect(SignalPayloadSchema.parse({ kind: 'relay-message', seq: 0, data })).toBeTruthy();
    expect(data).not.toMatch(/извештај|package-key|offer/);
  });

  it('rejects tampered, renumbered and reflected messages', async () => {
    const { senderKey, receiverKey } = await agree();
    const data = await sealRelayMessage(senderKey, 'sender', 3, { t: 'complete' });
    const fails = (promise: Promise<unknown>) =>
      expect(promise).rejects.toBeInstanceOf(RelayCryptoError);
    await fails(openRelayMessage(receiverKey, 'sender', 4, data)); // replayed as another number
    await fails(openRelayMessage(receiverKey, 'receiver', 3, data)); // reflected to its sender
    const flipped = `${data.slice(0, 30)}${data[30] === 'A' ? 'B' : 'A'}${data.slice(31)}`;
    await fails(openRelayMessage(receiverKey, 'sender', 3, flipped));
    await fails(openRelayMessage(receiverKey, 'sender', 3, data.slice(0, 30)));
    await fails(openRelayMessage(receiverKey, 'sender', 3, 'not base64url!'));
  });

  it('binds the key to the session and to both public keys', async () => {
    const { sender, receiver, context, senderKey } = await agree('session-1');
    const data = await sealRelayMessage(senderKey, 'sender', 0, { t: 'accept' });

    const otherSession = await deriveRelayKey(receiver, sender.publicKey, {
      ...context,
      sessionId: 'session-2',
    });
    await expect(openRelayMessage(otherSession, 'sender', 0, data)).rejects.toBeInstanceOf(
      RelayCryptoError,
    );
    // A server that swaps in its own key gets a different secret than the sender's.
    const intruder = await createRelayKeyPair();
    const swapped = await deriveRelayKey(receiver, intruder.publicKey, {
      ...context,
      senderKey: intruder.publicKey,
    });
    await expect(openRelayMessage(swapped, 'sender', 0, data)).rejects.toBeInstanceOf(
      RelayCryptoError,
    );
  });

  it('refuses public keys that are not points on the curve', async () => {
    const own = await createRelayKeyPair();
    const context = { sessionId: 's', senderKey: 'a', receiverKey: 'b' };
    const offCurve = new Uint8Array(65).fill(1);
    offCurve[0] = 0x04;
    for (const key of [toBase64Url(new Uint8Array(65)), toBase64Url(offCurve), 'short', '***']) {
      await expect(deriveRelayKey(own, key, context)).rejects.toBeInstanceOf(RelayCryptoError);
    }
  });
});

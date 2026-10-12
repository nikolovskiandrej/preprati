import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ClientMessageSchema } from '../../shared/signaling';
import { sendApiError } from '../http/apiError';
import type { InboxBatch, PollingConnection, PollingSignaling } from './pollingSignaling';

/**
 * HTTP transport for signaling (serverless deployments):
 *
 *   POST /api/signal/connect     → { connectionId, token }
 *   POST /api/signal/send        body: ClientMessage      → { messages, firstSeq }
 *   GET  /api/signal/poll                                  → { messages, firstSeq }
 *   POST /api/signal/disconnect  body: { connectionId, token }  (sendBeacon-friendly)
 *
 * `send` and `poll` authenticate with `Authorization: Bearer <token>` and
 * `X-Signal-Connection: <connectionId>`. `send` also takes `X-Signal-Seq`, a
 * per-connection message number, so a retried request is handled only once.
 * Both take `X-Signal-Ack`, the number of the last inbox message the client
 * has processed: messages stay queued until acknowledged, and message `i` of
 * a response has number `firstSeq + i`. Without the header (older clients),
 * returned messages are removed right away. Message shapes are identical to
 * the WebSocket transport.
 */
export function registerHttpSignalingRoutes(
  app: FastifyInstance,
  signaling: PollingSignaling,
): void {
  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<PollingConnection | null> => {
    const header = request.headers.authorization;
    const token = header && /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const connectionId = request.headers['x-signal-connection'];
    const record =
      token && typeof connectionId === 'string'
        ? await signaling.authenticate(connectionId, token)
        : null;
    if (!record) {
      await sendApiError(reply, 401, 'unauthorized', 'Unknown or expired signaling connection');
      return null;
    }
    return record;
  };

  const respond = (reply: FastifyReply, batch: InboxBatch) =>
    reply.header('Cache-Control', 'no-store').send(batch);

  const ackOf = (request: FastifyRequest): number | null => {
    const value = request.headers['x-signal-ack'];
    return typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : null;
  };

  app.post('/api/signal/connect', async (request, reply) => {
    const credentials = await signaling.connect(request.ip);
    return reply.code(201).header('Cache-Control', 'no-store').send(credentials);
  });

  app.post('/api/signal/send', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const connection = await authenticate(request, reply);
    if (!connection) return reply;
    const parsed = ClientMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      await signaling.reportError(connection.id, 'invalid-message');
      return respond(reply, await signaling.read(connection.id, ackOf(request)));
    }
    const seq = request.headers['x-signal-seq'];
    const isRetry =
      typeof seq === 'string' &&
      /^\d{1,12}$/.test(seq) &&
      !(await signaling.claimSequence(connection.id, Number(seq)));
    if (!isRetry) await signaling.handle(connection, parsed.data);
    // Replies are already queued; expiry checks run on the regular polls.
    return respond(reply, await signaling.read(connection.id, ackOf(request)));
  });

  app.get('/api/signal/poll', async (request, reply) => {
    const connection = await authenticate(request, reply);
    if (!connection) return reply;
    return respond(reply, await signaling.poll(connection, ackOf(request)));
  });

  // navigator.sendBeacon cannot set headers; credentials travel in the body (text/plain or JSON).
  app.post('/api/signal/disconnect', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    let body: unknown = request.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    }
    const { connectionId, token } = (body ?? {}) as { connectionId?: unknown; token?: unknown };
    if (typeof connectionId === 'string' && typeof token === 'string') {
      const connection = await signaling.authenticate(connectionId, token);
      if (connection) await signaling.disconnect(connection);
    }
    return reply.code(204).send();
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SHARE_CHUNK_OVERHEAD, SHARE_MANIFEST_MAX_BYTES } from '../../shared/constants';
import type { ServerConfig } from '../config';
import { ApiError, sendApiError } from '../http/apiError';
import type { RateLimiter } from '../security/rateLimiter';
import { ShareServiceError, type ShareService } from './shareService';

export interface ShareRouteDeps {
  config: ServerConfig;
  /** Returns the service when hosted sharing is available, otherwise an error to report. */
  getService: () => ShareService | ApiError;
  createLimiter: RateLimiter;
}

type IdParams = { id: string };
type ChunkParams = { id: string; index: string };

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

function parseIndex(raw: string): number {
  if (!/^\d{1,9}$/.test(raw))
    throw new ShareServiceError('invalid-request', 400, 'Invalid chunk index');
  return Number(raw);
}

function asBytes(body: unknown): Uint8Array {
  // Realm-independent check (Buffer from Fastify's parser, or any typed array view).
  if (Buffer.isBuffer(body)) return body;
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new ShareServiceError('invalid-request', 400, 'Expected an application/octet-stream body');
}

/**
 * Registers `/api/shares/*`. Every handler either returns a JSON body, an
 * empty 204, or streams ciphertext. Errors are mapped by `handleShareError`.
 */
export function registerShareRoutes(app: FastifyInstance, deps: ShareRouteDeps): void {
  const { config, getService, createLimiter } = deps;
  const maxChunkBody = config.share.chunkBytes + SHARE_CHUNK_OVERHEAD;

  const withService =
    <P>(
      handler: (
        service: ShareService,
        request: FastifyRequest<{ Params: P }>,
        reply: FastifyReply,
      ) => Promise<unknown>,
    ) =>
    async (request: FastifyRequest<{ Params: P }>, reply: FastifyReply) => {
      const service = getService();
      if (service instanceof ApiError) {
        return sendApiError(
          reply,
          service.status,
          service.code,
          service.message,
          service.retryAfterSeconds,
        );
      }
      try {
        return await handler(service, request, reply);
      } catch (error) {
        return handleShareError(reply, error, request);
      }
    };

  app.post(
    '/api/shares',
    withService(async (service, request, reply) => {
      const limit = createLimiter.consume(request.ip);
      if (!limit.allowed) {
        throw new ShareServiceError(
          'rate-limited',
          429,
          'Too many shares created recently',
          limit.retryAfterMs / 1000,
        );
      }
      const created = await service.create(request.body);
      return reply.code(201).header('Cache-Control', 'no-store').send(created);
    }),
  );

  app.put<{ Params: IdParams }>(
    '/api/shares/:id/manifest',
    { bodyLimit: SHARE_MANIFEST_MAX_BYTES },
    withService<IdParams>(async (service, request, reply) => {
      await service.putManifest(request.params.id, bearer(request), asBytes(request.body));
      return reply.code(204).send();
    }),
  );

  app.put<{ Params: ChunkParams }>(
    '/api/shares/:id/chunks/:index',
    { bodyLimit: maxChunkBody },
    withService<ChunkParams>(async (service, request, reply) => {
      const index = parseIndex(request.params.index);
      await service.putChunk(request.params.id, bearer(request), index, asBytes(request.body));
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: IdParams }>(
    '/api/shares/:id/finalize',
    withService<IdParams>(async (service, request, reply) => {
      const result = await service.finalize(request.params.id, bearer(request));
      return reply.header('Cache-Control', 'no-store').send(result);
    }),
  );

  app.get<{ Params: IdParams }>(
    '/api/shares/:id',
    withService<IdParams>(async (service, request, reply) => {
      const info = await service.getInfo(request.params.id);
      return reply.header('Cache-Control', 'no-store').send(info);
    }),
  );

  app.get<{ Params: IdParams }>(
    '/api/shares/:id/owner',
    withService<IdParams>(async (service, request, reply) => {
      const status = await service.ownerStatus(request.params.id, bearer(request));
      return reply.header('Cache-Control', 'no-store').send(status);
    }),
  );

  app.get<{ Params: IdParams }>(
    '/api/shares/:id/manifest',
    withService<IdParams>(async (service, request, reply) => {
      const { stream, size } = await service.openManifest(request.params.id);
      return sendBinary(reply, stream, size);
    }),
  );

  app.get<{ Params: ChunkParams }>(
    '/api/shares/:id/chunks/:index',
    withService<ChunkParams>(async (service, request, reply) => {
      const index = parseIndex(request.params.index);
      const { stream, size } = await service.openChunk(request.params.id, index);
      return sendBinary(reply, stream, size);
    }),
  );

  app.delete<{ Params: IdParams }>(
    '/api/shares/:id',
    withService<IdParams>(async (service, request, reply) => {
      await service.delete(request.params.id, bearer(request));
      return reply.code(204).header('Cache-Control', 'no-store').send();
    }),
  );
}

function sendBinary(reply: FastifyReply, stream: NodeJS.ReadableStream, size: number) {
  return reply
    .header('Content-Type', 'application/octet-stream')
    .header('Content-Length', String(size))
    .header('Cache-Control', 'no-store')
    .send(stream);
}

function handleShareError(reply: FastifyReply, error: unknown, request: FastifyRequest) {
  if (error instanceof ShareServiceError || error instanceof ApiError) {
    return sendApiError(reply, error.status, error.code, error.message, error.retryAfterSeconds);
  }
  request.log.error({ err: error }, 'unexpected share API error');
  return sendApiError(reply, 500, 'internal', 'Unexpected server error');
}

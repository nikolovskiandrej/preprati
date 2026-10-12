import type { FastifyReply } from 'fastify';
import type { ApiErrorBody, ShareErrorCode } from '../../shared/shareApi';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly code: ShareErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function sendApiError(
  reply: FastifyReply,
  status: number,
  code: ShareErrorCode,
  message: string,
  retryAfterSeconds?: number,
): FastifyReply {
  const body: ApiErrorBody = { error: { code, message } };
  if (retryAfterSeconds !== undefined) {
    body.error.retryAfterSeconds = retryAfterSeconds;
    void reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  }
  return reply.code(status).header('Cache-Control', 'no-store').send(body);
}

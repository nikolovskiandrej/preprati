/**
 * Thin fetch/XHR helpers with typed API errors, timeouts and retries.
 */
import type { ApiErrorBody, ShareErrorCode } from '../../shared/shareApi';
import { apiBaseUrl } from './env';

export type HttpErrorCode = ShareErrorCode | 'network' | 'timeout' | 'aborted';

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly code: HttpErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }

  /** Whether repeating the same request may succeed. */
  get retryable(): boolean {
    return (
      this.code === 'network' ||
      this.code === 'timeout' ||
      this.code === 'storage-unavailable' ||
      this.code === 'rate-limited' ||
      this.status >= 500
    );
  }
}

async function toHttpError(response: Response): Promise<HttpError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  const code = body?.error?.code ?? (response.status >= 500 ? 'internal' : 'invalid-request');
  return new HttpError(
    code,
    response.status,
    body?.error?.message ?? response.statusText,
    body?.error?.retryAfterSeconds,
  );
}

export interface RequestOptions {
  method?: string;
  body?: BodyInit | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Issues a request against the API and returns the raw Response (throws HttpError on failure). */
export async function apiRequest(path: string, options: RequestOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), options.timeoutMs ?? 30_000);
  const onAbort = () => controller.abort('aborted');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(apiBaseUrl() + path, {
      method: options.method ?? 'GET',
      body: options.body ?? null,
      headers: options.headers,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw await toHttpError(response);
    return response;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (options.signal?.aborted) throw new HttpError('aborted', 0, 'Request aborted');
    if (controller.signal.aborted) throw new HttpError('timeout', 0, 'Request timed out');
    throw new HttpError('network', 0, 'Network request failed');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function apiJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await apiRequest(path, options);
  return (await response.json()) as T;
}

/**
 * Uploads binary data with XMLHttpRequest so we can report real upload
 * progress (fetch has no upload progress events).
 */
export function apiUpload(
  path: string,
  data: Uint8Array,
  options: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    onProgress?: (sentBytes: number) => void;
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new HttpError('aborted', 0, 'Request aborted'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(options.method ?? 'PUT', apiBaseUrl() + path);
    xhr.timeout = options.timeoutMs ?? 120_000;
    for (const [name, value] of Object.entries(options.headers ?? {}))
      xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => options.onProgress?.(event.loaded);
    const onAbort = () => xhr.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => options.signal?.removeEventListener('abort', onAbort);
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      let body: Partial<ApiErrorBody> | null = null;
      try {
        body = JSON.parse(xhr.responseText) as ApiErrorBody;
      } catch {
        body = null;
      }
      reject(
        new HttpError(
          body?.error?.code ?? (xhr.status >= 500 ? 'internal' : 'invalid-request'),
          xhr.status,
          body?.error?.message ?? 'Upload failed',
          body?.error?.retryAfterSeconds,
        ),
      );
    };
    xhr.onerror = () => {
      done();
      reject(new HttpError('network', 0, 'Network request failed'));
    };
    xhr.ontimeout = () => {
      done();
      reject(new HttpError('timeout', 0, 'Upload timed out'));
    };
    xhr.onabort = () => {
      done();
      reject(new HttpError('aborted', 0, 'Request aborted'));
    };
    // Encrypted chunks are always ArrayBuffer-backed views, which XHR sends as-is.
    xhr.send(data as Uint8Array<ArrayBuffer>);
  });
}

const MAX_RETRY_DELAY_MS = 15_000;

/**
 * Retries `operation` with exponential backoff while the error is retryable.
 * A server that asks to come back later than the longest delay (storage
 * full, monthly allowance used up) gets no retry: the error is final now.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: { attempts?: number; signal?: AbortSignal; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!(error instanceof HttpError) || !error.retryable || attempt === attempts - 1)
        throw error;
      const retryAfterMs = (error.retryAfterSeconds ?? 0) * 1000;
      if (retryAfterMs > MAX_RETRY_DELAY_MS) throw error;
      if (options.signal?.aborted) throw new HttpError('aborted', 0, 'Request aborted');
      const backoff = (options.baseDelayMs ?? 600) * 2 ** attempt + Math.random() * 250;
      await sleep(Math.min(Math.max(backoff, retryAfterMs), MAX_RETRY_DELAY_MS), options.signal);
    }
  }
  throw lastError;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HttpError('aborted', 0, 'Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new HttpError('aborted', 0, 'Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

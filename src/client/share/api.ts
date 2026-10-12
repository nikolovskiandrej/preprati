/**
 * Share API calls. The decryption key is never part of any request: only the
 * share id (path) and, for owner actions, the owner token (Authorization
 * header) are sent.
 */
import type {
  CreateShareRequest,
  CreateShareResponse,
  FinalizeShareResponse,
  ShareInfo,
  ShareOwnerStatus,
} from '../../shared/shareApi';
import { apiJson, apiRequest, apiUpload, HttpError } from '../lib/http';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const enc = encodeURIComponent;

export function createShare(
  request: CreateShareRequest,
  signal?: AbortSignal,
): Promise<CreateShareResponse> {
  return apiJson('/api/shares', {
    method: 'POST',
    body: JSON.stringify(request),
    headers: { 'Content-Type': 'application/json' },
    signal,
  });
}

export function uploadManifest(id: string, token: string, data: Uint8Array, signal?: AbortSignal) {
  return apiUpload(`/api/shares/${enc(id)}/manifest`, data, {
    headers: { ...auth(token), 'Content-Type': 'application/octet-stream' },
    signal,
  });
}

export function uploadChunk(
  id: string,
  token: string,
  index: number,
  data: Uint8Array,
  options: { signal?: AbortSignal; onProgress?: (sent: number) => void; timeoutMs?: number },
) {
  return apiUpload(`/api/shares/${enc(id)}/chunks/${index}`, data, {
    headers: { ...auth(token), 'Content-Type': 'application/octet-stream' },
    ...options,
  });
}

export function finalizeShare(
  id: string,
  token: string,
  signal?: AbortSignal,
): Promise<FinalizeShareResponse> {
  return apiJson(`/api/shares/${enc(id)}/finalize`, {
    method: 'POST',
    headers: auth(token),
    signal,
  });
}

export async function deleteShare(id: string, token: string): Promise<void> {
  await apiRequest(`/api/shares/${enc(id)}`, { method: 'DELETE', headers: auth(token) });
}

export function ownerStatus(
  id: string,
  token: string,
  signal?: AbortSignal,
): Promise<ShareOwnerStatus> {
  return apiJson(`/api/shares/${enc(id)}/owner`, { headers: auth(token), signal });
}

export function getShareInfo(id: string, signal?: AbortSignal): Promise<ShareInfo> {
  return apiJson(`/api/shares/${enc(id)}`, { signal });
}

export async function getManifest(id: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await apiRequest(`/api/shares/${enc(id)}/manifest`, { signal });
  return new Uint8Array(await response.arrayBuffer());
}

/** Downloads one encrypted chunk, reporting received bytes as they stream in. */
export async function getChunk(
  id: string,
  index: number,
  options: { signal?: AbortSignal; onProgress?: (received: number) => void } = {},
): Promise<Uint8Array> {
  const response = await apiRequest(`/api/shares/${enc(id)}/chunks/${index}`, {
    signal: options.signal,
    timeoutMs: 120_000,
  });
  if (!response.body || !options.onProgress) return new Uint8Array(await response.arrayBuffer());
  const expected = Number(response.headers.get('Content-Length') ?? 0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.byteLength;
      options.onProgress(received);
    }
  } catch {
    throw new HttpError(options.signal?.aborted ? 'aborted' : 'network', 0, 'Download interrupted');
  }
  if (expected && received !== expected) throw new HttpError('network', 0, 'Download incomplete');
  const out = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Relay mode's storage: ordinary encrypted share packages (see
 * src/client/share). Relay transfers therefore inherit everything Share
 * Files guarantees — encryption in the browser, the server's size limits,
 * quotas, monthly budget and expiry — and the server can't tell the two apart.
 */
import { HttpError } from '../lib/http';
import { deleteShare } from '../share/api';
import { toCreatorError } from '../share/creator';
import { encodeShareSecret } from '../share/crypto';
import { retrieverErrorOf, ShareRetriever, type RetrieverErrorCode } from '../share/retriever';
import { uploadPackage } from '../share/upload';
import { RelayStorageError, type RelayStorage } from './relay';

export function shareRelayStorage(chunkBytes: number): RelayStorage {
  return {
    async upload(files, { signal, onProgress }) {
      try {
        const uploaded = await uploadPackage(files, chunkBytes, {
          signal,
          onProgress: (bytes) => onProgress(bytes),
        });
        return {
          id: uploaded.id,
          ownerToken: uploaded.ownerToken,
          secret: encodeShareSecret(uploaded.secret),
        };
      } catch (error) {
        if (signal.aborted || (error instanceof HttpError && error.code === 'aborted'))
          throw new RelayStorageError('aborted');
        throw new RelayStorageError(uploadErrorCode(error));
      }
    },

    async download(pkg, { signal, onProgress }) {
      const retriever = new ShareRetriever(pkg.id, pkg.secret);
      const stop = () => retriever.dispose();
      signal.addEventListener('abort', stop, { once: true });
      try {
        await retriever.open();
        const state = retriever.getSnapshot();
        if (state.phase !== 'ready-to-download')
          throw new RelayStorageError(downloadErrorCode(state.error ?? 'internal'));
        return await retriever.fetchFiles(onProgress);
      } catch (error) {
        if (signal.aborted) throw new RelayStorageError('aborted');
        if (error instanceof RelayStorageError) throw error;
        throw new RelayStorageError(downloadErrorCode(retrieverErrorOf(error)));
      } finally {
        signal.removeEventListener('abort', stop);
        retriever.dispose();
      }
    },

    async remove(pkg) {
      await deleteShare(pkg.id, pkg.ownerToken);
    },
  };
}

function uploadErrorCode(error: unknown): RelayStorageError['code'] {
  switch (toCreatorError(error)) {
    case 'file-too-large':
    case 'package-too-large':
    case 'too-many-files':
      return 'too-large';
    case 'file-read-failed':
      return 'file-read-failed';
    case 'network':
    case 'internal':
      return 'network';
    default:
      // Full, busy, out of monthly budget, switched off, or the upload took too long.
      return 'unavailable';
  }
}

function downloadErrorCode(code: RetrieverErrorCode): RelayStorageError['code'] {
  switch (code) {
    case 'invalid-key':
    case 'corrupted':
    case 'invalid-link':
      return 'corrupted';
    case 'storage-unavailable':
    case 'unsupported':
      return 'unavailable';
    default:
      return 'network';
  }
}

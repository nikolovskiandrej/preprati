import type { MessageValues } from '../../i18n/format';
import type { MessageKey } from '../../i18n';
import type { CreatorErrorCode, ShareLimits } from '../../share/creator';
import type { RetrieverErrorCode } from '../../share/retriever';
import { formatBytes } from '../../lib/format';

export function creatorErrorMessage(
  code: CreatorErrorCode,
  limits: ShareLimits,
  locale: string,
): { key: MessageKey; values?: MessageValues } {
  switch (code) {
    case 'unsupported':
      return { key: 'errors.unsupportedSecure' };
    case 'share-disabled':
      return { key: 'errors.shareDisabled' };
    case 'empty':
      return { key: 'errors.shareEmpty' };
    case 'too-many-files':
      return { key: 'errors.shareTooManyFiles', values: { count: limits.maxFiles } };
    case 'file-too-large':
      return {
        key: 'errors.shareFileTooLarge',
        values: { size: formatBytes(limits.maxFileBytes, locale) },
      };
    case 'package-too-large':
      return {
        key: 'errors.sharePackageTooLarge',
        values: { size: formatBytes(limits.maxPackageBytes, locale) },
      };
    case 'quota-exceeded':
      return { key: 'errors.shareQuota' };
    case 'too-many-shares':
      return { key: 'errors.shareTooMany' };
    case 'rate-limited':
      return { key: 'errors.shareRateLimited' };
    case 'storage-unavailable':
      return { key: 'errors.shareStorage' };
    case 'network':
      return { key: 'errors.shareNetwork' };
    case 'file-read-failed':
      return { key: 'errors.fileReadFailed' };
    case 'upload-expired':
      return { key: 'errors.shareUploadExpired' };
    case 'delete-failed':
      return { key: 'errors.shareDeleteFailed' };
    case 'internal':
      return { key: 'errors.internal' };
  }
}

export const RETRIEVER_MESSAGES: Record<RetrieverErrorCode, MessageKey> = {
  'invalid-link': 'errors.invalidLink',
  unsupported: 'errors.unsupportedSecure',
  'not-found': 'errors.notFound',
  expired: 'errors.expired',
  deleted: 'errors.deleted',
  'invalid-key': 'errors.invalidKey',
  corrupted: 'errors.corrupted',
  'storage-unavailable': 'errors.storageUnavailable',
  network: 'errors.network',
  internal: 'errors.internal',
};

/** Errors where simply trying again can help. */
export function isRetryable(code: RetrieverErrorCode): boolean {
  return (
    code === 'network' ||
    code === 'storage-unavailable' ||
    code === 'corrupted' ||
    code === 'internal'
  );
}

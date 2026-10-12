/**
 * Shared package page (/s/<id>#<key>). Fetches the encrypted package,
 * decrypts the file list in the browser and saves verified files.
 */
import { Link } from 'wouter';
import { useLocationHash, useNow, useOwnedStore } from '../app/hooks';
import { isRetryable, RETRIEVER_MESSAGES } from '../features/share/messages';
import { useI18n } from '../i18n';
import { CheckIcon, DownloadIcon, ErrorIcon, LockIcon, RetryIcon } from '../icons';
import { formatBytes, formatDateTime, formatPercent, formatRelative } from '../lib/format';
import { ShareRetriever, type RetrieverState } from '../share/retriever';
import { Button } from '../ui/Button';
import { FileListFrame, FileRow } from '../ui/FileRow';
import { Notice } from '../ui/Notice';
import { ProgressBar } from '../ui/ProgressBar';
import { Spinner } from '../ui/Spinner';
import styles from './RecipientScreen.module.css';

export default function RecipientScreen({ params }: { params: { id: string } }) {
  const { t, locale } = useI18n();
  // The key lives in the fragment; editing it in an open tab re-opens the package.
  const hash = useLocationHash();
  const [retriever, state] = useOwnedStore<RetrieverState, ShareRetriever>(() => {
    const instance = new ShareRetriever(params.id, hash);
    void instance.open();
    return instance;
  }, [params.id, hash]);
  const now = useNow(60_000);

  const phase = state?.phase ?? 'opening-share';

  if (
    !retriever ||
    !state ||
    phase === 'opening-share' ||
    phase === 'fetching-package' ||
    phase === 'decrypting'
  ) {
    return (
      <div className={styles.page}>
        <section className={styles.sheet} aria-busy="true">
          <p className={styles.eyebrow}>
            <LockIcon size={18} />
            <span>{t('recipient.eyebrow')}</span>
          </p>
          <h1 className={styles.title}>{t('recipient.titleLoading')}</h1>
          <p className={styles.status} role="status">
            <Spinner size={20} />
            <span>
              {phase === 'decrypting' ? t('recipient.decrypting') : t('recipient.fetching')}
            </span>
          </p>
        </section>
      </div>
    );
  }

  if (phase === 'failed' && state.error) {
    const code = state.error;
    return (
      <div className={styles.page}>
        <section className={styles.sheet}>
          <p className={styles.eyebrow}>
            <ErrorIcon size={18} />
            <span>{t('recipient.eyebrow')}</span>
          </p>
          <h1 className={styles.title}>{t('errors.titles.shareLink')}</h1>
          <p className={styles.errorText} role="alert">
            {t(RETRIEVER_MESSAGES[code])}
          </p>
          <div className={styles.actions}>
            {isRetryable(code) ? (
              <Button variant="dark" icon={RetryIcon} onClick={() => void retriever.open()}>
                {t('common.retry')}
              </Button>
            ) : null}
          </div>
        </section>
        <Cta />
      </div>
    );
  }

  const files = state.files;
  const zip = state.zip;
  return (
    <div className={styles.page}>
      <section className={styles.sheet}>
        <p className={styles.eyebrow}>
          <LockIcon size={18} />
          <span>{t('recipient.eyebrow')}</span>
        </p>
        <h1 className={styles.title}>{t('recipient.title', { count: files.length })}</h1>
        <p className={styles.meta}>
          <span>{formatBytes(state.totalBytes, locale)}</span>
          {state.expiresAt ? (
            <span>
              {t('common.expiresAt', { date: formatDateTime(state.expiresAt, locale) })} (
              {formatRelative(state.expiresAt, now, locale)})
            </span>
          ) : null}
        </p>

        <div className={styles.list}>
          <FileListFrame label={t('recipient.title', { count: files.length })}>
            {files.map((file) => {
              const downloading = file.status === 'downloading';
              return (
                <FileRow
                  key={file.index}
                  name={file.name}
                  type={file.type}
                  meta={
                    file.status === 'failed' && file.error ? (
                      <span className={styles.fileError}>{t(RETRIEVER_MESSAGES[file.error])}</span>
                    ) : downloading ? (
                      `${formatBytes(file.size, locale)} · ${t('recipient.downloading')} ${formatPercent(file.progress, locale)}`
                    ) : (
                      formatBytes(file.size, locale)
                    )
                  }
                  progress={
                    downloading ? (
                      <ProgressBar
                        value={file.progress}
                        label={t('recipient.downloadName', { name: file.name })}
                        size="sm"
                      />
                    ) : undefined
                  }
                  action={
                    <Button
                      variant={file.status === 'saved' ? 'ghost' : 'primary'}
                      size="sm"
                      icon={
                        file.status === 'saved'
                          ? CheckIcon
                          : file.status === 'failed'
                            ? RetryIcon
                            : DownloadIcon
                      }
                      loading={downloading}
                      onClick={() => void retriever.downloadFile(file.index)}
                      aria-label={t('recipient.downloadName', { name: file.name })}
                    >
                      {file.status === 'saved'
                        ? t('recipient.saved')
                        : file.status === 'failed'
                          ? t('common.retry')
                          : t('recipient.download')}
                    </Button>
                  }
                />
              );
            })}
          </FileListFrame>
        </div>

        {files.length > 1 ? (
          <div className={styles.all}>
            <Button
              variant="dark"
              size="lg"
              icon={zip.status === 'saved' ? CheckIcon : DownloadIcon}
              loading={zip.status === 'preparing'}
              onClick={() => void retriever.downloadAll()}
              fullWidth
            >
              {zip.status === 'preparing'
                ? t('recipient.preparingAll', { percent: formatPercent(zip.progress, locale) })
                : zip.status === 'saved'
                  ? t('recipient.allSaved')
                  : t('recipient.downloadAll')}
            </Button>
            {zip.status === 'preparing' ? (
              <ProgressBar value={zip.progress} label={t('recipient.downloadAll')} size="sm" />
            ) : null}
            {zip.status === 'failed' && zip.error ? (
              <Notice tone="danger" role="alert">
                <p>{t(RETRIEVER_MESSAGES[zip.error])}</p>
              </Notice>
            ) : null}
          </div>
        ) : null}

        <p className={styles.privacy}>
          <LockIcon size={16} />
          <span>{t('recipient.privacy')}</span>
        </p>
      </section>
      <Cta />
    </div>
  );
}

function Cta() {
  const { t } = useI18n();
  return (
    <p className={styles.cta}>
      {t('recipient.cta')}{' '}
      <Link href="/" className={styles.ctaLink}>
        {t('recipient.ctaLink')}
      </Link>
    </p>
  );
}

/**
 * Shared package page (/s/<id>#<key>). Fetches the encrypted package,
 * decrypts the file list in the browser and saves verified files.
 *
 * Opened in an app's built-in browser (a link tapped in Instagram, say),
 * it first offers to continue in the phone's own browser, which can save
 * files; nothing is fetched until the person decides.
 */
import { Link } from 'wouter';
import { useLocationHash, useNow, useOwnedStore } from '../app/hooks';
import { InAppBrowserGate, useInAppBrowserGate } from '../features/common/InAppBrowserGate';
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
  const { t } = useI18n();
  const gate = useInAppBrowserGate();
  if (gate.browser && gate.open) {
    return (
      <div className={styles.page}>
        <section className={styles.sheet}>
          <p className={styles.eyebrow}>
            <LockIcon size={18} />
            <span>{t('recipient.eyebrow')}</span>
          </p>
          <InAppBrowserGate browser={gate.browser} onStay={gate.stay} tone="light" />
        </section>
      </div>
    );
  }
  return <SharedFiles id={params.id} inAppBrowser={!!gate.browser} />;
}

/** `inAppBrowser`: saving falls back to the share sheet, and says it may not work. */
function SharedFiles({ id, inAppBrowser }: { id: string; inAppBrowser: boolean }) {
  const { t, locale } = useI18n();
  // The key lives in the fragment; editing it in an open tab re-opens the package.
  const hash = useLocationHash();
  const [retriever, state] = useOwnedStore<RetrieverState, ShareRetriever>(() => {
    const instance = new ShareRetriever(id, hash);
    void instance.open();
    return instance;
  }, [id, hash]);
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
  const save = { preferShare: inAppBrowser };
  const anyReady = zip.status === 'ready' || files.some((file) => file.status === 'ready');
  const anyRequested =
    zip.status === 'requested' || files.some((file) => file.status === 'requested');
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
                      variant={
                        file.status === 'requested' || file.status === 'shared'
                          ? 'ghost'
                          : 'primary'
                      }
                      size="sm"
                      icon={
                        file.status === 'shared'
                          ? CheckIcon
                          : file.status === 'failed'
                            ? RetryIcon
                            : DownloadIcon
                      }
                      loading={downloading}
                      onClick={() => void retriever.downloadFile(file.index, save)}
                      aria-label={
                        file.status === 'idle' || file.status === 'downloading'
                          ? t('recipient.downloadName', { name: file.name })
                          : t('recipient.saveName', { name: file.name })
                      }
                    >
                      {file.status === 'ready'
                        ? t('recipient.save')
                        : file.status === 'requested'
                          ? t('recipient.saveAgain')
                          : file.status === 'shared'
                            ? t('recipient.shared')
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
              variant={zip.status === 'requested' || zip.status === 'shared' ? 'ghost' : 'dark'}
              size="lg"
              icon={zip.status === 'shared' ? CheckIcon : DownloadIcon}
              loading={zip.status === 'preparing'}
              onClick={() => void retriever.downloadAll(save)}
              fullWidth
            >
              {zip.status === 'preparing'
                ? t('recipient.preparingAll', { percent: formatPercent(zip.progress, locale) })
                : zip.status === 'ready'
                  ? t('recipient.saveAll')
                  : zip.status === 'requested'
                    ? t('recipient.saveAllAgain')
                    : zip.status === 'shared'
                      ? t('recipient.shared')
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

        {anyReady || anyRequested || inAppBrowser ? (
          <div className={styles.hints} role="status">
            {anyReady ? <p>{t('recipient.readyHint')}</p> : null}
            {anyRequested ? <p>{t('recipient.requestedHint')}</p> : null}
            {inAppBrowser ? <p>{t('inApp.saveHint')}</p> : null}
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

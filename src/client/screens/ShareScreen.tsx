/**
 * Share Files — create an encrypted, temporary package and a QR code / link
 * that someone can open later, even after this page is closed.
 */
import { useEffect, useState } from 'react';
import { useConfig } from '../app/config';
import { useLeaveWarning, useNow, useOwnedStore } from '../app/hooks';
import { FlowHeader } from '../features/common/FlowHeader';
import { SelectedFilesPane } from '../features/common/SelectedFilesPane';
import { creatorErrorMessage } from '../features/share/messages';
import { useI18n } from '../i18n';
import { CheckCircleIcon, ClockIcon, LinkIcon, LockIcon, SendIcon, TrashIcon } from '../icons';
import { isSecureContextAvailable } from '../lib/env';
import { clearHandedOffFiles, handedOffFiles } from '../lib/handoff';
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  formatSpeed,
  formatTtl,
} from '../lib/format';
import { deleteShare as deleteShareRequest } from '../share/api';
import { ShareCreator, type CreatorState, type ShareLimits } from '../share/creator';
import { forgetOwnedShare, listOwnedShares, type OwnedShare } from '../share/ownedShares';
import { Button, ButtonLink } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Notice } from '../ui/Notice';
import { ProgressBar } from '../ui/ProgressBar';
import { QrActions } from '../ui/QrActions';
import { QrCode } from '../ui/QrCode';
import { Spinner } from '../ui/Spinner';
import { useToast } from '../ui/Toast';
import styles from './ShareScreen.module.css';

export default function ShareScreen() {
  const { t } = useI18n();
  const { config, status, reload } = useConfig();

  if (!config) {
    return (
      <div>
        <FlowHeader title={t('share.title')} lead={t('share.lead')} mode="share" />
        {status === 'error' ? (
          <Notice tone="danger" title={t('errors.titles.signaling')} role="alert">
            <p>{t('errors.signalingUnavailable')}</p>
            <Button variant="dark" size="sm" onClick={reload} className={styles.inlineButton}>
              {t('common.retry')}
            </Button>
          </Notice>
        ) : (
          <div className={styles.loading} role="status">
            <Spinner /> <span>{t('common.working')}</span>
          </div>
        )}
      </div>
    );
  }

  if (!config.share.enabled) {
    const reason =
      config.share.reason === 'not-configured'
        ? t('share.unavailableNotConfigured')
        : config.share.reason === 'disabled'
          ? t('share.unavailableDisabled')
          : t('share.unavailableStorage');
    return (
      <div>
        <FlowHeader title={t('share.title')} mode="share" />
        <div className={styles.unavailable}>
          <Notice tone="warning" title={t('share.unavailableTitle')} role="status">
            <p>{reason}</p>
            {config.share.reason !== 'storage-unavailable' ? (
              <p className={styles.adminHint}>{t('share.adminHint')}</p>
            ) : null}
          </Notice>
          <ButtonLink href="/send" variant="primary" icon={SendIcon}>
            {t('share.useQuick')}
          </ButtonLink>
        </div>
      </div>
    );
  }

  return <ShareCreatorView limits={config.share} />;
}

function ShareCreatorView({ limits }: { limits: ShareLimits }) {
  const { t, locale } = useI18n();
  const [creator, state] = useOwnedStore<CreatorState, ShareCreator>(() => {
    const store = new ShareCreator(limits);
    // Files from a Quick Transfer that couldn't connect ("Send as a link instead").
    const handedOff = handedOffFiles();
    if (handedOff.length > 0) store.addFiles(handedOff);
    return store;
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const now = useNow(30_000);

  useEffect(() => {
    creator?.setLimits(limits);
  }, [creator, limits]);

  useEffect(() => {
    if (creator) clearHandedOffFiles();
  }, [creator]);

  const phase = state?.phase ?? 'selecting-files';
  const uploading = phase === 'encrypting' || phase === 'uploading' || phase === 'finalizing';
  useLeaveWarning(uploading);

  if (!creator || !state) return null;

  const ttl = formatTtl(limits.ttlSeconds, locale);
  const editable =
    phase === 'selecting-files' || phase === 'awaiting-confirmation' || phase === 'failed';

  /* ------------------------------ Ready & after ------------------------------ */
  if (
    state.result &&
    (phase === 'ready-to-share' ||
      phase === 'accessed' ||
      phase === 'expired' ||
      phase === 'deleting' ||
      phase === 'deleted')
  ) {
    const result = state.result;
    if (phase === 'deleted' || phase === 'expired') {
      return (
        <div>
          <FlowHeader
            title={phase === 'deleted' ? t('share.deletedTitle') : t('share.expiredTitle')}
            mode="share"
          />
          <div className={styles.endState}>
            <Notice tone={phase === 'deleted' ? 'success' : 'info'} role="status">
              <p>{phase === 'deleted' ? t('share.deletedBody') : t('share.expiredBody')}</p>
            </Notice>
            <Button variant="dark" icon={LinkIcon} onClick={() => creator.reset()}>
              {t('share.shareMore')}
            </Button>
          </div>
        </div>
      );
    }
    const opened = state.accessCount > 0;
    return (
      <div>
        <FlowHeader title={t('share.readyTitle')} lead={t('share.readyLead')} mode="share" />
        <section className={styles.ready} aria-label={t('share.readyTitle')}>
          <div className={styles.ticketColumn}>
            <div className={styles.ticket}>
              <QrCode value={result.url} label={t('qr.alt', { purpose: t('qr.purposeShare') })} />
            </div>
          </div>
          <div className={styles.infoColumn}>
            <p
              className={opened ? `${styles.pill} ${styles.pillOpened}` : styles.pill}
              role="status"
            >
              {opened ? <CheckCircleIcon size={16} /> : <ClockIcon size={16} />}
              <span>
                {opened ? t('share.opened', { count: state.accessCount }) : t('share.notOpened')}
              </span>
            </p>
            <ul className={styles.facts}>
              <li>
                {t('common.files', { count: result.fileCount })} ·{' '}
                {formatBytes(result.totalBytes, locale)}
              </li>
              <li data-testid="share-expiry">
                {t('share.expires', {
                  date: formatDateTime(result.expiresAt, locale),
                  relative: formatRelative(result.expiresAt, now, locale),
                })}
              </li>
            </ul>
            <QrActions
              url={result.url}
              fileName="preprati-share-qr.png"
              image={{
                url: result.url,
                title: t('qr.shareImageTitle'),
                subtitle: t('qr.shareImageNote', {
                  date: formatDateTime(result.expiresAt, locale),
                  count: result.fileCount,
                }),
              }}
              shareTitle="preprati."
              shareText={t('qr.shareImageTitle')}
            />
            <div className={styles.linkField}>
              <label htmlFor="share-link" className={styles.linkLabel}>
                {t('qr.linkLabel')}
              </label>
              <input
                id="share-link"
                className={styles.linkInput}
                value={result.url}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
                data-testid="share-link"
              />
            </div>
            <Notice tone="secure" icon={LockIcon}>
              <p>{t('share.bearerWarning')}</p>
            </Notice>
            <div className={styles.readyActions}>
              <Button
                variant="danger"
                icon={TrashIcon}
                onClick={() => setConfirmDelete(true)}
                loading={phase === 'deleting'}
              >
                {phase === 'deleting' ? t('share.deleting') : t('share.deleteShare')}
              </Button>
              <Button variant="ghost" icon={LinkIcon} onClick={() => creator.reset()}>
                {t('share.shareMore')}
              </Button>
            </div>
            {state.error === 'delete-failed' ? (
              <Notice tone="danger" role="alert">
                <p>{t('errors.shareDeleteFailed')}</p>
              </Notice>
            ) : null}
          </div>
        </section>
        <Dialog
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title={t('share.deleteConfirmTitle')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger-solid"
                icon={TrashIcon}
                data-autofocus
                onClick={() => {
                  setConfirmDelete(false);
                  void creator.deleteShare();
                }}
              >
                {t('share.deleteConfirmAction')}
              </Button>
            </>
          }
        >
          <p>{t('share.deleteConfirmBody')}</p>
        </Dialog>
      </div>
    );
  }

  /* --------------------------------- Upload ---------------------------------- */
  if (uploading) {
    const progress = state.progress;
    const fraction =
      progress && progress.totalBytes > 0
        ? progress.uploadedBytes / progress.totalBytes
        : phase === 'finalizing'
          ? 1
          : 0;
    const title =
      phase === 'encrypting'
        ? t('share.encrypting')
        : phase === 'finalizing'
          ? t('share.finalizing')
          : t('share.uploading');
    return (
      <div>
        <FlowHeader title={t('share.title')} mode="share" />
        <section className={styles.uploadPanel} aria-live="polite">
          <div className={styles.uploadHead}>
            <p className={styles.uploadTitle}>
              <LockIcon size={20} />
              <span>{title}</span>
            </p>
            <p className={styles.uploadPercent} aria-hidden="true">
              {formatPercent(fraction, locale)}
            </p>
          </div>
          <ProgressBar
            value={fraction}
            label={title}
            valueText={formatPercent(fraction, locale)}
            showPlane
          />
          <p className={styles.uploadMetrics}>
            <span>
              {t('share.uploadProgress', {
                done: formatBytes(progress?.uploadedBytes ?? 0, locale),
                total: formatBytes(progress?.totalBytes ?? state.totalBytes, locale),
              })}
            </span>
            {progress?.bytesPerSecond && progress.etaSeconds !== null ? (
              <span>
                {t('quick.speed', {
                  speed: formatSpeed(progress.bytesPerSecond, locale),
                  eta: formatDuration(progress.etaSeconds, locale),
                })}
              </span>
            ) : null}
          </p>
          <div>
            <Button
              variant="ghost"
              onClick={() => creator.cancelUpload()}
              disabled={phase === 'finalizing'}
            >
              {t('share.cancelUpload')}
            </Button>
          </div>
        </section>
      </div>
    );
  }

  /* -------------------------------- Selecting -------------------------------- */
  const errorMessage = state.error ? creatorErrorMessage(state.error, limits, locale) : null;
  const expiryPreview = formatDateTime(now + limits.ttlSeconds * 1000, locale);
  const secure = isSecureContextAvailable();

  return (
    <div>
      <FlowHeader title={t('share.title')} lead={t('share.lead')} mode="share" />
      <div className={styles.workspace}>
        <SelectedFilesPane
          title={t('quick.yourFiles')}
          files={state.files}
          onAdd={(files) => creator.addFiles(files)}
          onRemove={(id) => creator.removeFile(id)}
          locked={!editable}
          maxFileBytes={limits.maxFileBytes}
        >
          <p className={styles.limits}>
            {t('share.limits', {
              files: t('common.files', { count: limits.maxFiles }),
              size: formatBytes(limits.maxPackageBytes, locale),
              ttl,
            })}
          </p>
        </SelectedFilesPane>

        <section className={styles.laterPanel}>
          <div className={styles.laterHead}>
            <span className={styles.laterIcon} aria-hidden="true">
              <LockIcon size={22} />
            </span>
            <h2 className={styles.laterTitle}>{t('share.noticeTitle')}</h2>
          </div>
          <p className={styles.laterBody}>{t('share.noticeBody')}</p>
          {!secure ? (
            <Notice tone="warning" role="alert">
              <p>{t('errors.unsupportedSecure')}</p>
            </Notice>
          ) : null}
          {errorMessage ? (
            <Notice
              tone="danger"
              title={phase === 'failed' ? t('errors.titles.share') : undefined}
              role="alert"
            >
              <p>{t(errorMessage.key, errorMessage.values)}</p>
            </Notice>
          ) : null}
          <Button
            variant="dark"
            size="lg"
            icon={LinkIcon}
            onClick={() => creator.requestConfirmation()}
            disabled={!secure}
            fullWidth
          >
            {phase === 'failed' ? t('common.retry') : t('share.continue')}
          </Button>
        </section>
      </div>

      <OwnedSharesList />

      <Dialog
        open={phase === 'awaiting-confirmation'}
        onClose={() => creator.cancelConfirmation()}
        title={t('share.confirmTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => creator.cancelConfirmation()}>
              {t('common.back')}
            </Button>
            <Button
              variant="primary"
              icon={LockIcon}
              onClick={() => void creator.confirm()}
              data-autofocus
            >
              {t('share.confirmAction')}
            </Button>
          </>
        }
      >
        <p>
          <strong>
            {t('share.confirmBody', {
              count: state.files.length,
              size: formatBytes(state.totalBytes, locale),
              date: expiryPreview,
              ttl,
            })}
          </strong>
        </p>
        <p>{t('share.confirmBearer')}</p>
        <p>{t('share.confirmServer')}</p>
      </Dialog>
    </div>
  );
}

/** Earlier shares created in this browser, so their owner can still delete them. */
function OwnedSharesList() {
  const { t, locale } = useI18n();
  const { notify } = useToast();
  const [shares, setShares] = useState<OwnedShare[]>(() => listOwnedShares());
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow(60_000);
  if (shares.length === 0) return null;

  const remove = async (share: OwnedShare) => {
    setBusy(share.id);
    try {
      await deleteShareRequest(share.id, share.ownerToken);
      forgetOwnedShare(share.id);
      setShares(listOwnedShares());
    } catch {
      notify({ tone: 'error', message: t('errors.shareDeleteFailed') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={styles.owned} aria-labelledby="owned-title">
      <h2 id="owned-title" className={styles.ownedTitle}>
        {t('share.previousTitle')}
      </h2>
      <ul className={styles.ownedList}>
        {shares.map((share) => (
          <li key={share.id}>
            <span>
              {t('share.previousItem', {
                count: share.fileCount,
                size: formatBytes(share.totalBytes, locale),
                relative: formatRelative(share.expiresAt, now, locale),
              })}
            </span>
            <Button
              variant="quiet"
              size="sm"
              icon={TrashIcon}
              loading={busy === share.id}
              onClick={() => void remove(share)}
              aria-label={t('share.previousDelete', {
                date: formatDateTime(share.createdAt, locale),
              })}
            >
              {t('share.deleteShare')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

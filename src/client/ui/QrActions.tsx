/**
 * Copy QR Code · Share · Copy Link · Download QR Code.
 *
 * Feedback is always truthful: "QR copied" only appears after the PNG was
 * written to the clipboard. If image copying is unsupported or blocked, the
 * user is told so and offered the PNG download instead — we never copy the
 * text link while claiming the image was copied.
 */
import { AnimatePresence, m } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import {
  CheckIcon,
  CopyIcon,
  CopyQrIcon,
  DownloadQrIcon,
  ShareIcon,
  type IconProps,
} from '../icons';
import { useI18n } from '../i18n';
import { canCopyImage, copyImage, copyText } from '../lib/clipboard';
import { saveBlob } from '../lib/download';
import { renderQrPng, type QrImageOptions } from '../lib/qr';
import { useToast } from './Toast';
import styles from './QrActions.module.css';

type Feedback = 'idle' | 'done';

function useFeedback(): [Feedback, () => void] {
  const [state, setState] = useState<Feedback>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const flash = useCallback(() => {
    setState('done');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2200);
  }, []);
  return [state, flash];
}

function ActionButton({
  icon: Icon,
  label,
  doneLabel,
  feedback,
  onClick,
  primary,
  testId,
}: {
  icon: ComponentType<IconProps>;
  label: string;
  doneLabel?: string;
  feedback?: Feedback;
  onClick: () => void;
  primary?: boolean;
  testId: string;
}) {
  const done = feedback === 'done';
  return (
    <button
      type="button"
      className={`${styles.action} ${primary ? styles.primary : ''} ${done ? styles.done : ''}`}
      onClick={onClick}
      data-testid={testId}
      data-state={feedback ?? 'idle'}
    >
      <span className={styles.iconSlot} aria-hidden="true">
        <AnimatePresence initial={false} mode="wait">
          <m.span
            key={done ? 'done' : 'idle'}
            className={styles.iconInner}
            initial={{ scale: 0.5, opacity: 0, rotate: done ? -30 : 0 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 600, damping: 30 }}
          >
            {done ? <CheckIcon size={19} /> : <Icon size={19} />}
          </m.span>
        </AnimatePresence>
      </span>
      <span className={styles.label}>{done && doneLabel ? doneLabel : label}</span>
    </button>
  );
}

export function QrActions({
  url,
  image,
  fileName,
  shareTitle,
  shareText,
}: {
  url: string;
  image: QrImageOptions;
  fileName: string;
  shareTitle: string;
  shareText: string;
}) {
  const { t } = useI18n();
  const { notify } = useToast();
  const [copyQrState, flashCopyQr] = useFeedback();
  const [downloadState, flashDownload] = useFeedback();
  const [copyLinkState, flashCopyLink] = useFeedback();
  const pngRef = useRef<{ key: string; promise: Promise<Blob> } | null>(null);
  const imageKey = `${url}|${image.title}|${image.subtitle ?? ''}`;

  /** Pre-renders the PNG so clipboard/share calls happen inside the user gesture. */
  const getPng = useCallback((): Promise<Blob> => {
    if (!pngRef.current || pngRef.current.key !== imageKey) {
      const promise = renderQrPng(image);
      promise.catch(() => undefined);
      pngRef.current = { key: imageKey, promise };
    }
    return pngRef.current.promise;
    // `image` is captured through imageKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKey]);

  useEffect(() => {
    void getPng();
  }, [getPng]);

  const downloadPng = useCallback(async () => {
    try {
      saveBlob(await getPng(), fileName);
      flashDownload();
    } catch {
      notify({ tone: 'error', message: t('errors.internal') });
    }
  }, [fileName, flashDownload, getPng, notify, t]);

  const onCopyQr = () => {
    if (!canCopyImage()) {
      notify({
        tone: 'error',
        message: t('qr.copyQrUnsupported'),
        action: { label: t('qr.downloadQr'), onClick: () => void downloadPng() },
      });
      return;
    }
    // Called synchronously from the click handler (Safari requires this).
    void copyImage(getPng()).then((result) => {
      if (result.ok) {
        flashCopyQr();
        return;
      }
      notify({
        tone: 'error',
        message: result.reason === 'denied' ? t('qr.copyQrDenied') : t('qr.copyQrUnsupported'),
        action: { label: t('qr.downloadQr'), onClick: () => void downloadPng() },
      });
    });
  };

  const onCopyLink = async () => {
    const result = await copyText(url);
    if (result.ok) flashCopyLink();
    else notify({ tone: 'error', message: t('qr.copyLinkFailed') });
  };

  const onShare = async () => {
    if (typeof navigator.share === 'function') {
      try {
        let data: ShareData = { title: shareTitle, text: shareText, url };
        try {
          const blob = await getPng();
          const file = new File([blob], fileName, { type: 'image/png' });
          if (navigator.canShare?.({ files: [file] })) {
            data = { title: shareTitle, text: `${shareText}\n${url}`, files: [file] };
          }
        } catch {
          // Share the link only.
        }
        await navigator.share(data);
        return;
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') return; // the user closed the share sheet
        notify({ tone: 'error', message: t('qr.shareFailed') });
        return;
      }
    }
    const result = await copyText(url);
    if (result.ok) notify({ tone: 'info', message: t('qr.shareFallback') });
    else notify({ tone: 'error', message: t('qr.copyLinkFailed') });
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.grid}>
        <ActionButton
          icon={CopyQrIcon}
          label={t('qr.copyQr')}
          doneLabel={t('qr.copyQrDone')}
          feedback={copyQrState}
          onClick={onCopyQr}
          primary
          testId="copy-qr"
        />
        <ActionButton
          icon={ShareIcon}
          label={t('qr.share')}
          onClick={() => void onShare()}
          testId="share"
        />
        <ActionButton
          icon={CopyIcon}
          label={t('qr.copyLink')}
          doneLabel={t('qr.copyLinkDone')}
          feedback={copyLinkState}
          onClick={() => void onCopyLink()}
          testId="copy-link"
        />
        <ActionButton
          icon={DownloadQrIcon}
          label={t('qr.downloadQr')}
          doneLabel={t('qr.downloadQrDone')}
          feedback={downloadState}
          onClick={() => void downloadPng()}
          testId="download-qr"
        />
        <span className="visually-hidden" role="status">
          {copyQrState === 'done' ? t('qr.copyQrDone') : ''}
          {copyLinkState === 'done' ? t('qr.copyLinkDone') : ''}
          {downloadState === 'done' ? t('qr.downloadQrDone') : ''}
        </span>
      </div>
    </div>
  );
}

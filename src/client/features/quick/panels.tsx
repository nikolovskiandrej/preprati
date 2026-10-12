/**
 * Building blocks for the Quick Transfer screens. They render on the
 * charcoal "live" surface that marks this mode throughout the app.
 */
import { downloadZip } from 'client-zip';
import { AnimatePresence, m } from 'motion/react';
import { useMemo, useState, type ReactNode } from 'react';
import { formatPairingCode } from '../../../shared/constants';
import type { TransferRole } from '../../../shared/signaling';
import { useNow } from '../../app/hooks';
import { useI18n } from '../../i18n';
import {
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  ConnectionIcon,
  DownloadIcon,
  ErrorIcon,
  QrIcon,
  RelayIcon,
} from '../../icons';
import { saveBlob } from '../../lib/download';
import { isPreviewableImage, uniqueNames } from '../../lib/files';
import {
  formatBytes,
  formatCountdown,
  formatDuration,
  formatPercent,
  formatSpeed,
} from '../../lib/format';
import type { RateEstimate } from '../../lib/rateMeter';
import type { CandidateSummary, ConnectionDiagnostics } from '../../transfer/diagnostics';
import type { ReceivedFile, TransferSnapshot } from '../../transfer/engine';
import type { ConnectionRoute } from '../../transfer/peerLink';
import type { QuickSessionInfo } from '../../transfer/quickSession';
import { Button } from '../../ui/Button';
import { FileListFrame, FileRow } from '../../ui/FileRow';
import { ProgressBar } from '../../ui/ProgressBar';
import { QrActions } from '../../ui/QrActions';
import { QrCode } from '../../ui/QrCode';
import { Spinner } from '../../ui/Spinner';
import type { QuickErrorView } from './errors';
import styles from './panels.module.css';

const ease = [0.16, 1, 0.3, 1] as const;

/** Charcoal container for everything "live". Children cross-fade when `stateKey` changes. */
export function LivePanel({
  stateKey,
  children,
  className,
}: {
  stateKey: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className ? `${styles.live} ${className}` : styles.live}>
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={stateKey}
          className={styles.liveInner}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
          transition={{ duration: 0.24, ease }}
        >
          {children}
        </m.div>
      </AnimatePresence>
    </section>
  );
}

export function StatusBlock({
  busy = false,
  icon,
  title,
  detail,
  children,
}: {
  busy?: boolean;
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={styles.status}>
      <div className={styles.statusHead} role="status">
        <span className={styles.statusIcon} aria-hidden="true">
          {busy ? <Spinner size={22} /> : icon}
        </span>
        <div>
          <p className={styles.statusTitle}>{title}</p>
          {detail ? <p className={styles.statusDetail}>{detail}</p> : null}
        </div>
      </div>
      {children}
    </div>
  );
}

/** Dashed outline where the QR code will appear once a session exists. */
export function GhostTicket() {
  return (
    <div className={styles.ghost} aria-hidden="true">
      <QrIcon size={40} />
    </div>
  );
}

export function PairingTicket({
  session,
  hostRole,
}: {
  session: QuickSessionInfo;
  hostRole: TransferRole;
}) {
  const { t } = useI18n();
  const now = useNow(1000);
  const remaining = session.expiresAt - now;
  const host = typeof window !== 'undefined' ? window.location.host : '';
  const code = formatPairingCode(session.code);

  return (
    <div className={styles.pairing}>
      <div className={styles.ticket}>
        <QrCode value={session.link} label={t('qr.alt', { purpose: t('qr.purposeSession') })} />
      </div>
      <div className={styles.codeBlock}>
        <p className={styles.codeLabel}>{t('quick.codeLabel')}</p>
        <p
          className={styles.code}
          data-testid="pairing-code"
          aria-label={session.code.split('').join(' ')}
        >
          {code}
        </p>
        <p className={styles.countdown} role="timer" aria-live="off">
          <ClockIcon size={16} />
          <span>{t('quick.expiresIn', { time: formatCountdown(remaining) })}</span>
        </p>
      </div>
      <p className={styles.help}>{t('quick.codeHelp', { host })}</p>
      <QrActions
        url={session.link}
        fileName="preprati-session-qr.png"
        image={{
          url: session.link,
          title:
            hostRole === 'receiver' ? t('qr.sessionImageTitleSend') : t('qr.sessionImageTitle'),
          subtitle: t('qr.sessionImageNote'),
        }}
        shareTitle="preprati."
        shareText={
          hostRole === 'receiver' ? t('qr.sessionImageTitleSend') : t('qr.sessionImageTitle')
        }
      />
      <p className={styles.note}>{t('quick.keepOpen')}</p>
    </div>
  );
}

export function ApprovalPrompt({
  device,
  onAllow,
  onDecline,
}: {
  device: string;
  onAllow: () => void;
  onDecline: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.status}>
      <div className={styles.statusHead}>
        <span className={styles.statusIcon} aria-hidden="true">
          <ConnectionIcon size={22} />
        </span>
        <div role="alert">
          <p className={styles.statusTitle}>{t('quick.approvalTitle')}</p>
          <p className={styles.statusDetail}>{t('quick.approvalBody', { device })}</p>
        </div>
      </div>
      <p className={styles.note}>{t('quick.approvalHint')}</p>
      <div className={styles.buttons}>
        <Button variant="primary" size="lg" onClick={onAllow} data-autofocus>
          {t('quick.allow')}
        </Button>
        <Button variant="ghost" size="lg" onClick={onDecline}>
          {t('quick.decline')}
        </Button>
      </div>
    </div>
  );
}

/** "Connecting…", turning into a patience note when it takes a while (other networks, retries). */
export function ConnectingStatus({ device }: { device: string }) {
  const { t } = useI18n();
  const [since] = useState(() => Date.now());
  const now = useNow(1000);
  return (
    <StatusBlock
      busy
      title={t('quick.connecting', { device })}
      detail={now - since > 8_000 ? t('quick.connectingSlow') : t('quick.connectingHint')}
    />
  );
}

/** Shown while a dropped connection is being repaired; the transfer resumes on its own. */
export function ReconnectingNotice() {
  const { t } = useI18n();
  return (
    <div className={styles.reconnecting} role="status">
      <Spinner size={18} />
      <div>
        <p className={styles.reconnectingTitle}>{t('quick.reconnecting')}</p>
        <p className={styles.note}>{t('quick.reconnectingHint')}</p>
      </div>
    </div>
  );
}

/** What each side found while connecting, for people who want to know why (no addresses). */
export function ConnectionDetails({ diagnostics }: { diagnostics: ConnectionDiagnostics }) {
  const { t } = useI18n();
  const describe = (summary: CandidateSummary, received: boolean) => {
    if (!received) return t('quick.details.nothingReceived');
    if (summary.srflx + summary.relay === 0) return t('quick.details.publicMissing');
    return summary.strictNat
      ? t('quick.details.publicFoundStrict')
      : t('quick.details.publicFound');
  };
  const { local, remote } = diagnostics;
  const rows: Array<[string, string]> = [
    [t('quick.details.thisDevice'), describe(local, true)],
    [
      t('quick.details.otherDevice'),
      describe(remote, remote.host + remote.srflx + remote.relay > 0),
    ],
    [
      t('quick.details.relay'),
      diagnostics.turnServers > 0
        ? t('quick.details.relayAvailable')
        : t('quick.details.relayNone'),
    ],
  ];
  return (
    <details className={styles.details}>
      <summary>
        <ChevronDownIcon size={16} className={styles.detailsChevron} />
        {t('quick.details.title')}
      </summary>
      <dl className={styles.detailsList}>
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.note}>
        {t('quick.details.attempt', {
          number: diagnostics.attempt + 1,
          seconds: Math.round(diagnostics.durationMs / 1000),
        })}
      </p>
    </details>
  );
}

export function ConnectionBadge({ route }: { route: ConnectionRoute | null }) {
  const { t } = useI18n();
  if (!route || route === 'unknown') return null;
  const relay = route === 'relay';
  return (
    <p
      className={styles.badge}
      title={relay ? t('quick.routeRelayHint') : t('quick.routeDirectHint')}
    >
      {relay ? <RelayIcon size={16} /> : <ConnectionIcon size={16} />}
      <span>{relay ? t('quick.routeRelay') : t('quick.routeDirect')}</span>
      <span className="visually-hidden">
        . {relay ? t('quick.routeRelayHint') : t('quick.routeDirectHint')}
      </span>
    </p>
  );
}

export function TransferProgress({
  transfer,
  rate,
  device,
  onCancel,
}: {
  transfer: TransferSnapshot;
  rate: RateEstimate | null;
  device: string;
  onCancel: () => void;
}) {
  const { t, locale } = useI18n();
  const fraction = transfer.totalBytes === 0 ? 1 : transfer.transferredBytes / transfer.totalBytes;
  const done = formatBytes(transfer.transferredBytes, locale);
  const total = formatBytes(transfer.totalBytes, locale);
  const percent = formatPercent(fraction, locale);
  const outgoing = transfer.direction === 'outgoing';

  return (
    <div className={styles.transfer}>
      <div className={styles.transferHead}>
        <p className={styles.statusTitle}>
          {outgoing ? t('quick.sending', { device }) : t('quick.receiving', { device })}
        </p>
        <p className={styles.percent} aria-hidden="true">
          {percent}
        </p>
      </div>
      <ProgressBar
        value={fraction}
        label={t('quick.transferring')}
        valueText={`${percent} — ${t('quick.progress', { done, total })}`}
        tone="inverse"
        showPlane
      />
      <p className={styles.metrics}>
        <span>{t('quick.progress', { done, total })}</span>
        {rate?.bytesPerSecond && rate.etaSeconds !== null ? (
          <span>
            {t('quick.speed', {
              speed: formatSpeed(rate.bytesPerSecond, locale),
              eta: formatDuration(rate.etaSeconds, locale),
            })}
          </span>
        ) : null}
      </p>
      {transfer.files.length > 1 ? (
        <FileListFrame label={t('files.selected', { count: transfer.files.length })}>
          {transfer.files.map((file) => (
            <FileRow
              key={file.index}
              tone="dark"
              name={file.name}
              type={file.type}
              meta={`${formatBytes(file.size, locale)} · ${formatPercent(file.size ? file.transferredBytes / file.size : file.done ? 1 : 0, locale)}`}
              action={
                file.done ? (
                  <CheckIcon size={20} className={styles.check} title={t('common.done')} />
                ) : null
              }
            />
          ))}
        </FileListFrame>
      ) : null}
      <div className={styles.buttons}>
        <Button variant="ghost" onClick={onCancel}>
          {t('quick.cancelTransfer')}
        </Button>
      </div>
    </div>
  );
}

export function IncomingOffer({
  transfer,
  device,
  onAccept,
  onReject,
}: {
  transfer: TransferSnapshot;
  device: string;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div className={styles.status}>
      <div className={styles.statusHead}>
        <span className={styles.statusIcon} aria-hidden="true">
          <DownloadIcon size={22} />
        </span>
        <div role="alert">
          <p className={styles.statusTitle}>{t('quick.incomingTitle')}</p>
          <p className={styles.statusDetail}>
            {t('quick.incomingBody', {
              device,
              count: transfer.files.length,
              size: formatBytes(transfer.totalBytes, locale),
            })}
          </p>
        </div>
      </div>
      <div className={styles.scrollList}>
        <FileListFrame label={t('quick.incomingTitle')}>
          {transfer.files.map((file) => (
            <FileRow
              key={file.index}
              tone="dark"
              name={file.name}
              type={file.type}
              meta={formatBytes(file.size, locale)}
            />
          ))}
        </FileListFrame>
      </div>
      <div className={styles.buttons}>
        <Button variant="primary" size="lg" icon={DownloadIcon} onClick={onAccept} data-autofocus>
          {t('quick.accept')}
        </Button>
        <Button variant="ghost" size="lg" onClick={onReject}>
          {t('quick.reject')}
        </Button>
      </div>
    </div>
  );
}

export function TransferDone({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={styles.status}>
      <div className={styles.statusHead} role="status">
        <m.span
          className={`${styles.statusIcon} ${styles.success}`}
          aria-hidden="true"
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 380, damping: 18 }}
        >
          <CheckCircleIcon size={24} />
        </m.span>
        <p className={styles.statusTitle}>{title}</p>
      </div>
      {children}
    </div>
  );
}

export function QuickError({ view, actions }: { view: QuickErrorView; actions: ReactNode }) {
  const { t } = useI18n();
  const diagnostics = view.connection?.diagnostics;
  return (
    <div className={styles.status}>
      <div className={styles.statusHead} role="alert">
        <span className={`${styles.statusIcon} ${styles.danger}`} aria-hidden="true">
          <ErrorIcon size={22} />
        </span>
        <div>
          <p className={styles.statusTitle}>{t(view.title)}</p>
          <p className={styles.statusDetail}>{t(view.message)}</p>
          {view.hint ? <p className={styles.statusDetail}>{t(view.hint)}</p> : null}
        </div>
      </div>
      <div className={styles.buttons}>{actions}</div>
      {diagnostics ? <ConnectionDetails diagnostics={diagnostics} /> : null}
    </div>
  );
}

/** Files received in this session, each savable on its own or all together as .zip. */
export function ReceivedFilesList({
  files,
  tone = 'light',
}: {
  files: ReceivedFile[];
  tone?: 'light' | 'dark';
}) {
  const { t, locale } = useI18n();
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const [zipping, setZipping] = useState(false);
  const names = useMemo(() => uniqueNames(files.map((file) => file.name)), [files]);

  const keyOf = (file: ReceivedFile) => `${file.transferId}:${file.index}`;
  const save = (file: ReceivedFile, name: string) => {
    saveBlob(file.blob, name);
    setSaved((current) => new Set(current).add(keyOf(file)));
  };
  const saveAll = async () => {
    setZipping(true);
    try {
      const zip = await downloadZip(
        files.map((file, i) => ({
          name: names[i]!,
          input: file.blob,
          lastModified: new Date(file.lastModified || Date.now()),
        })),
      ).blob();
      saveBlob(zip, 'preprati-files.zip');
      setSaved(new Set(files.map(keyOf)));
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className={styles.received}>
      <div className={styles.receivedHead}>
        <h2 className={styles.receivedTitle}>{t('quick.receivedFiles')}</h2>
        {files.length > 1 ? (
          <Button
            variant={tone === 'dark' ? 'inverse' : 'dark'}
            size="sm"
            icon={DownloadIcon}
            loading={zipping}
            onClick={() => void saveAll()}
          >
            {zipping ? t('quick.preparingZip') : t('quick.saveAll')}
          </Button>
        ) : null}
      </div>
      <FileListFrame label={t('quick.receivedFiles')}>
        {files.map((file, i) => {
          const isSaved = saved.has(keyOf(file));
          return (
            <FileRow
              key={keyOf(file)}
              tone={tone}
              name={file.name}
              type={file.type}
              meta={formatBytes(file.size, locale)}
              action={
                <>
                  {isPreviewableImage(file.type) ? (
                    <Thumbnail blob={file.blob} type={file.type} />
                  ) : null}
                  <Button
                    variant={isSaved ? 'ghost' : 'primary'}
                    size="sm"
                    icon={isSaved ? CheckIcon : DownloadIcon}
                    onClick={() => save(file, names[i]!)}
                    aria-label={`${isSaved ? t('quick.saved') : t('quick.save')}: ${file.name}`}
                  >
                    {isSaved ? t('quick.saved') : t('quick.save')}
                  </Button>
                </>
              }
            />
          );
        })}
      </FileListFrame>
    </div>
  );
}

/** Small preview for raster images; the object URL lives exactly as long as the <img>. */
function Thumbnail({ blob, type }: { blob: Blob; type: string }) {
  if (blob.size > 25 * 1024 * 1024) return null;
  return (
    <img
      alt=""
      className={styles.thumb}
      width={40}
      height={40}
      ref={(element) => {
        if (!element) return;
        const objectUrl = URL.createObjectURL(blob.slice(0, blob.size, type));
        element.src = objectUrl;
        return () => URL.revokeObjectURL(objectUrl);
      }}
    />
  );
}

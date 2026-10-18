/**
 * Building blocks for the Quick Transfer screens. They render on the
 * charcoal "live" surface that marks this mode throughout the app.
 */
import { downloadZip } from 'client-zip';
import { AnimatePresence, m } from 'motion/react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
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
  LockIcon,
  QrIcon,
  RelayIcon,
} from '../../icons';
import { hasUserActivation, saveFile, type SaveOutcome } from '../../lib/download';
import { isPreviewableImage, uniqueNames } from '../../lib/files';
import {
  formatBytes,
  formatCountdown,
  formatDuration,
  formatPercent,
  formatSpeed,
  formatTtl,
} from '../../lib/format';
import type { RateEstimate } from '../../lib/rateMeter';
import type { CandidateSummary, ConnectionDiagnostics } from '../../transfer/diagnostics';
import type { ReceivedFile, TransferSnapshot } from '../../transfer/engine';
import type { ConnectionRoute } from '../../transfer/peerLink';
import type { QuickSessionInfo, QuickState } from '../../transfer/quickSession';
import { relayLimitProblem } from '../../transfer/relay';
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
  reopened = false,
  later,
}: {
  session: QuickSessionInfo;
  hostRole: TransferRole;
  /** The device that joined left before anything was sent; the link still works. */
  reopened?: boolean;
  /** Below the ticket: a way to send the files as a link that works later. */
  later?: ReactNode;
}) {
  const { t } = useI18n();
  const now = useNow(1000);
  const remaining = session.expiresAt - now;
  const host = typeof window !== 'undefined' ? window.location.host : '';
  const code = formatPairingCode(session.code);

  return (
    <div className={styles.pairing}>
      {reopened ? (
        <p className={`${styles.note} ${styles.reopened}`} role="status">
          {t('quick.reopened')}
        </p>
      ) : null}
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
        linkNote={t('quick.linkNote')}
      />
      <p className={styles.note}>{t('quick.keepOpen')}</p>
      {later}
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

/**
 * "Connecting…", turning into a patience note when it takes a while (other
 * networks, retries) — and offering `slowAction` then, if given. `viaServer`:
 * relay mode is being set up instead of a direct connection. `recovering`: a
 * direct attempt failed and the app is connecting another way on its own.
 * `autoFallback`: if the direct attempt fails, that will happen by itself.
 */
export function ConnectingStatus({
  device,
  viaServer = false,
  recovering = false,
  autoFallback = false,
  slowAction,
}: {
  device: string;
  viaServer?: boolean;
  recovering?: boolean;
  autoFallback?: boolean;
  slowAction?: ReactNode;
}) {
  const { t } = useI18n();
  const [since] = useState(() => Date.now());
  const now = useNow(1000);
  const slow = now - since > 8_000;
  if (viaServer)
    return (
      <StatusBlock
        busy
        title={t('quick.connectingServer', { device })}
        detail={
          recovering ? t('quick.connectingServerRecovering') : t('quick.connectingServerHint')
        }
      />
    );
  const detail = recovering
    ? t('quick.connectingRecovering')
    : !slow
      ? t('quick.connectingHint')
      : autoFallback
        ? t('quick.connectingSlowAuto')
        : t('quick.connectingSlow');
  return (
    <StatusBlock busy title={t('quick.connecting', { device })} detail={detail}>
      {slow && !recovering && slowAction ? (
        <div className={styles.buttons}>{slowAction}</div>
      ) : null}
    </StatusBlock>
  );
}

/**
 * Under "Send through preprati.": what happens to the files (or, when the
 * selection is over the limits, why the option is missing).
 */
export function RelayNote({
  device,
  relay,
  files,
}: {
  device: string;
  relay: NonNullable<QuickState['relay']>;
  files: readonly File[];
}) {
  const { t, locale } = useI18n();
  const tooLarge = relayLimitProblem(files, relay.limits) !== null;
  return (
    <p className={`${styles.note} ${styles.relayNote}`}>
      <LockIcon size={16} />
      <span>
        {tooLarge
          ? t('quick.relayTooLarge', { size: formatBytes(relay.limits.maxPackageBytes, locale) })
          : t('quick.relayNote', { device, time: formatTtl(relay.ttlSeconds, locale) })}
      </span>
    </p>
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
      t('quick.details.network'),
      diagnostics.sameNetwork
        ? t('quick.details.networkSame')
        : local.srflx > 0 && remote.srflx > 0
          ? t('quick.details.networkDifferent')
          : t('quick.details.networkUnknown'),
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
  const [Icon, label, hint] =
    route === 'server'
      ? [LockIcon, t('quick.routeServer'), t('quick.routeServerHint')]
      : route === 'relay'
        ? [RelayIcon, t('quick.routeRelay'), t('quick.routeRelayHint')]
        : [ConnectionIcon, t('quick.routeDirect'), t('quick.routeDirectHint')];
  return (
    <p className={styles.badge} title={hint}>
      <Icon size={16} />
      <span>{label}</span>
      <span className="visually-hidden">. {hint}</span>
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
  // Relay mode moves the files in two legs: the sender uploads, then the receiver downloads.
  const title =
    transfer.stage === 'upload'
      ? outgoing
        ? t('quick.relayUploading', { device })
        : t('quick.relayPeerUploading', { device })
      : transfer.stage === 'download'
        ? outgoing
          ? t('quick.relayPeerDownloading', { device })
          : t('quick.relayDownloading', { device })
        : outgoing
          ? t('quick.sending', { device })
          : t('quick.receiving', { device });

  return (
    <div className={styles.transfer}>
      <div className={styles.transferHead}>
        <p className={styles.statusTitle}>{title}</p>
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

export function QuickError({
  view,
  device,
  actions,
  note,
}: {
  view: QuickErrorView;
  /** The other device's name, for messages that mention it. */
  device: string;
  actions: ReactNode;
  /** Shown under the buttons (e.g. what "Send through preprati." does). */
  note?: ReactNode;
}) {
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
          <p className={styles.statusDetail}>{t(view.message, { device })}</p>
          {view.hint ? <p className={styles.statusDetail}>{t(view.hint, { device })}</p> : null}
        </div>
      </div>
      <div className={styles.buttons}>{actions}</div>
      {note}
      {diagnostics ? <ConnectionDetails diagnostics={diagnostics} /> : null}
    </div>
  );
}

type Saved = Exclude<SaveOutcome, 'cancelled'>;

/**
 * Files received in this session, each savable on its own or all together
 * as .zip. Saving happens on a tap (browsers allow nothing else) and claims
 * no more than the browser confirms: "Save again" after a download request,
 * "Done" only after the share sheet. `inAppBrowser`: saves through the share
 * sheet where downloads don't work, and says that saving may fail here.
 */
export function ReceivedFilesList({
  files,
  tone = 'light',
  inAppBrowser = false,
}: {
  files: ReceivedFile[];
  tone?: 'light' | 'dark';
  inAppBrowser?: boolean;
}) {
  const { t, locale } = useI18n();
  const [saved, setSaved] = useState<Map<string, Saved>>(() => new Map());
  const [zip, setZip] = useState<{ blob: Blob | null; preparing: boolean }>({
    blob: null,
    preparing: false,
  });
  const names = useMemo(() => uniqueNames(files.map((file) => file.name)), [files]);

  const keyOf = (file: ReceivedFile) => `${file.transferId}:${file.index}`;
  const mark = (keys: string[], outcome: SaveOutcome) => {
    if (outcome === 'cancelled') return;
    setSaved((current) => {
      const next = new Map(current);
      for (const key of keys) next.set(key, outcome);
      return next;
    });
  };
  const save = (file: ReceivedFile, name: string) => {
    // Straight from the click: the download or share sheet needs the gesture.
    void saveFile(file.blob, name, { type: file.type, preferShare: inAppBrowser }).then((outcome) =>
      mark([keyOf(file)], outcome),
    );
  };
  const saveZip = (blob: Blob) =>
    void saveFile(blob, 'preprati-files.zip', {
      type: 'application/zip',
      preferShare: inAppBrowser,
    }).then((outcome) => mark(files.map(keyOf), outcome));
  const saveAll = async () => {
    if (zip.blob) {
      saveZip(zip.blob);
      return;
    }
    setZip({ blob: null, preparing: true });
    try {
      const blob = await downloadZip(
        files.map((file, i) => ({
          name: names[i]!,
          input: file.blob,
          lastModified: new Date(file.lastModified || Date.now()),
        })),
      ).blob();
      setZip({ blob, preparing: false });
      // Still within the tap: save now. Otherwise "Save .zip" asks for one more.
      if (hasUserActivation()) saveZip(blob);
    } catch {
      setZip({ blob: null, preparing: false });
    }
  };
  const zipReady = !!zip.blob && !files.every((file) => saved.has(keyOf(file)));
  const anySaved = [...saved.values()].includes('requested');

  return (
    <div className={styles.received}>
      <div className={styles.receivedHead}>
        <h2 className={styles.receivedTitle}>{t('quick.receivedFiles')}</h2>
        {files.length > 1 ? (
          <Button
            variant={tone === 'dark' ? 'inverse' : 'dark'}
            size="sm"
            icon={DownloadIcon}
            loading={zip.preparing}
            onClick={() => void saveAll()}
          >
            {zip.preparing
              ? t('quick.preparingZip')
              : zipReady
                ? t('quick.saveAllReady')
                : t('quick.saveAll')}
          </Button>
        ) : null}
      </div>
      <FileListFrame label={t('quick.receivedFiles')}>
        {files.map((file, i) => {
          const outcome = saved.get(keyOf(file));
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
                    variant={outcome ? 'ghost' : 'primary'}
                    size="sm"
                    icon={outcome === 'shared' ? CheckIcon : DownloadIcon}
                    onClick={() => save(file, names[i]!)}
                    aria-label={`${outcome === 'requested' ? t('quick.saveAgain') : t('quick.save')}: ${file.name}`}
                  >
                    {outcome === 'shared'
                      ? t('quick.saveDone')
                      : outcome === 'requested'
                        ? t('quick.saveAgain')
                        : t('quick.save')}
                  </Button>
                </>
              }
            />
          );
        })}
      </FileListFrame>
      {zipReady || anySaved || inAppBrowser ? (
        <div className={styles.receivedHints} role="status">
          {zipReady ? <p>{t('quick.zipReadyHint')}</p> : null}
          {anySaved ? <p>{t('quick.savedHint')}</p> : null}
          {inAppBrowser ? <p>{t('inApp.saveHintLive')}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Small preview for raster images; the object URL lives exactly as long as the
 * <img> (a stable ref, so re-renders don't load the image again).
 */
function Thumbnail({ blob, type }: { blob: Blob; type: string }) {
  const attach = useCallback(
    (element: HTMLImageElement | null) => {
      if (!element) return;
      const objectUrl = URL.createObjectURL(blob.slice(0, blob.size, type));
      element.src = objectUrl;
      return () => URL.revokeObjectURL(objectUrl);
    },
    [blob, type],
  );
  if (blob.size > 25 * 1024 * 1024) return null;
  return <img alt="" className={styles.thumb} width={40} height={40} ref={attach} />;
}

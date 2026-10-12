/**
 * Quick Transfer — Send. Pick files, a live session starts, the other device
 * scans the code (or types the pairing code), accepts, and the files move
 * over the WebRTC data channel.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useConfig } from '../app/config';
import { useLeaveWarning, useOwnedStore } from '../app/hooks';
import { FlowHeader } from '../features/common/FlowHeader';
import { SelectedFilesPane } from '../features/common/SelectedFilesPane';
import { describeQuickError } from '../features/quick/errors';
import {
  ApprovalPrompt,
  ConnectingStatus,
  ConnectionBadge,
  GhostTicket,
  LivePanel,
  PairingTicket,
  QuickError,
  ReconnectingNotice,
  RelayNote,
  StatusBlock,
  TransferDone,
  TransferProgress,
} from '../features/quick/panels';
import { useSessionWakeLock } from '../features/quick/wakeLock';
import { useI18n } from '../i18n';
import { LinkIcon, LockIcon, RetryIcon, SendIcon } from '../icons';
import { localFileId, type SelectedFile } from '../lib/files';
import { handOffFiles } from '../lib/handoff';
import { QuickSession, type QuickState } from '../transfer/quickSession';
import { relayLimitProblem } from '../transfer/relay';
import { Button } from '../ui/Button';
import styles from './QuickScreens.module.css';

export default function SendScreen() {
  const { t } = useI18n();
  const [, navigate] = useLocation();
  const [session, state] = useOwnedStore<QuickState, QuickSession>(
    () => new QuickSession({ autoOffer: true }),
  );
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [composing, setComposing] = useState(false);
  const { config } = useConfig();
  const shareAvailable = config?.share.enabled === true;

  const phase = state?.phase ?? 'idle';
  const locked = phase === 'awaiting-acceptance' || phase === 'transferring';
  useLeaveWarning(locked);
  useSessionWakeLock(state);

  // A session starts as soon as there is something to send.
  useEffect(() => {
    if (session && phase === 'idle' && files.length > 0) void session.host('sender');
  }, [session, phase, files.length]);

  // Keep the selection that will be offered in sync (ignored while a transfer is in flight).
  useEffect(() => {
    session?.setFiles(files.map((entry) => entry.file));
  }, [session, files]);

  const addFiles = (added: File[]) => {
    setFiles((current) => [...current, ...added.map((file) => ({ id: localFileId(), file }))]);
  };
  const removeFile = (id: string) =>
    setFiles((current) => current.filter((entry) => entry.id !== id));

  const sendNow = () => {
    if (!session) return;
    session.setFiles(files.map((entry) => entry.file));
    if (session.send()) setComposing(false);
  };
  const sendMore = () => {
    setFiles([]);
    setComposing(true);
  };
  const end = () => navigate('/');
  /** The devices can't connect directly: upload the same files as an encrypted share link. */
  const sendAsLink = () => {
    handOffFiles(files.map((entry) => entry.file));
    navigate('/share');
  };

  const device = state?.peer?.label ?? t('common.unknownDevice');
  const live = renderLive();

  function renderLive(): { key: string; node: ReactNode } {
    if (!state || !session || phase === 'idle') {
      return {
        key: 'pick',
        node: (
          <StatusBlock
            icon={<SendIcon size={22} />}
            title={t('quick.connect')}
            detail={t('quick.pickFirst')}
          >
            <GhostTicket />
          </StatusBlock>
        ),
      };
    }
    const selected = files.map((entry) => entry.file);
    // "Send through preprati." needs a selection within the storage limits.
    const relayFits =
      !!state.relay &&
      selected.length > 0 &&
      relayLimitProblem(selected, state.relay.limits) === null;
    const relayButton = (
      variant: 'primary' | 'inverse',
      label: 'relaySend' | 'relaySendInstead',
    ) => (
      <Button variant={variant} icon={LockIcon} onClick={() => session.useRelay()}>
        {t(`quick.${label}`)}
      </Button>
    );
    const error = describeQuickError(state, { shareAvailable });
    if (error) {
      const retry = error.connection?.canRetry === true;
      const canRelay = error.connection?.canRelay === true;
      const offerRelay = canRelay && relayFits;
      // Without relay mode (no signaling left), a share link still gets the files there.
      const offerLink = !!error.connection && !canRelay && shareAvailable && files.length > 0;
      const actions =
        error.recovery === 'retry-send' ? (
          <Button variant="primary" onClick={sendNow} disabled={files.length === 0}>
            {t('quick.sendAgain')}
          </Button>
        ) : (
          <>
            {offerRelay ? relayButton('primary', 'relaySend') : null}
            {retry ? (
              <Button
                variant={offerRelay ? 'inverse' : 'primary'}
                icon={RetryIcon}
                onClick={() => session.retryConnection()}
              >
                {t('quick.tryAgain')}
              </Button>
            ) : null}
            {offerLink ? (
              <Button variant={retry ? 'inverse' : 'primary'} icon={LinkIcon} onClick={sendAsLink}>
                {t('quick.sendAsLink')}
              </Button>
            ) : null}
            {error.recovery === 'restart' ? (
              <Button
                variant={retry || offerLink || offerRelay ? 'ghost' : 'primary'}
                onClick={() => void session.host('sender')}
              >
                {t('quick.newSession')}
              </Button>
            ) : (
              <Button variant="inverse" onClick={end}>
                {t('common.goHome')}
              </Button>
            )}
          </>
        );
      const note =
        canRelay && state.relay ? (
          <RelayNote device={device} relay={state.relay} files={selected} />
        ) : null;
      return {
        key: `error-${error.message}-${retry}-${offerRelay}`,
        node: <QuickError view={error} device={device} actions={actions} note={note} />,
      };
    }
    if (
      composing &&
      (phase === 'completed' ||
        phase === 'rejected' ||
        phase === 'cancelled' ||
        phase === 'connected')
    ) {
      return {
        key: 'compose',
        node: (
          <StatusBlock
            icon={<SendIcon size={22} />}
            title={t('quick.connectedTo', { device })}
            detail={t('quick.chooseToSend', { device })}
          >
            <ConnectionBadge route={state.route} />
            <div className={styles.liveButtons}>
              <Button
                variant="primary"
                size="lg"
                icon={SendIcon}
                onClick={sendNow}
                disabled={files.length === 0}
              >
                {t('quick.sendNow', { count: files.length })}
              </Button>
              <Button variant="ghost" size="lg" onClick={end}>
                {t('quick.endSession')}
              </Button>
            </div>
          </StatusBlock>
        ),
      };
    }
    switch (phase) {
      case 'creating-session':
        return { key: 'creating', node: <StatusBlock busy title={t('quick.creating')} /> };
      case 'waiting-for-peer':
        return state.session
          ? { key: 'pairing', node: <PairingTicket session={state.session} hostRole="sender" /> }
          : { key: 'creating', node: <StatusBlock busy title={t('quick.creating')} /> };
      case 'approval-required':
        return {
          key: 'approval',
          node: (
            <ApprovalPrompt
              device={device}
              onAllow={() => session.approvePeer()}
              onDecline={() => session.declinePeer()}
            />
          ),
        };
      case 'peer-connected':
      case 'connecting':
        return {
          key: state.route === 'server' ? 'connecting-server' : 'connecting',
          node: (
            <ConnectingStatus
              device={device}
              viaServer={state.route === 'server'}
              slowAction={
                state.canRelay && relayFits ? relayButton('inverse', 'relaySendInstead') : null
              }
            />
          ),
        };
      case 'connected':
        return {
          key: 'connected',
          node: (
            <StatusBlock
              icon={<SendIcon size={22} />}
              title={t('quick.connectedTo', { device })}
              detail={t('quick.chooseToSend', { device })}
            >
              <ConnectionBadge route={state.route} />
            </StatusBlock>
          ),
        };
      case 'awaiting-acceptance':
        return {
          key: 'awaiting',
          node: (
            <StatusBlock busy title={t('quick.awaitingAcceptance', { device })}>
              <ConnectionBadge route={state.route} />
              <div className={styles.liveButtons}>
                <Button variant="ghost" onClick={() => session.cancelTransfer()}>
                  {t('common.cancel')}
                </Button>
              </div>
            </StatusBlock>
          ),
        };
      case 'transferring':
        return {
          key: 'transferring',
          node: state.transfer ? (
            <>
              <TransferProgress
                transfer={state.transfer}
                rate={state.rate}
                device={device}
                onCancel={() => session.cancelTransfer()}
              />
              <ConnectionBadge route={state.route} />
            </>
          ) : null,
        };
      case 'completed':
        return {
          key: 'completed',
          node: (
            <TransferDone
              title={t('quick.completedSent', { count: state.transfer?.files.length ?? 0, device })}
            >
              <ConnectionBadge route={state.route} />
              <div className={styles.liveButtons}>
                <Button variant="primary" size="lg" icon={SendIcon} onClick={sendMore}>
                  {t('quick.sendMore')}
                </Button>
                <Button variant="ghost" size="lg" onClick={end}>
                  {t('quick.endSession')}
                </Button>
              </div>
            </TransferDone>
          ),
        };
      case 'rejected':
      case 'cancelled': {
        const message =
          phase === 'rejected'
            ? t('quick.rejected', { device })
            : state.transfer?.endedBy === 'remote'
              ? t('quick.cancelledByPeer', { device })
              : t('quick.cancelledByYou');
        return {
          key: phase,
          node: (
            <StatusBlock icon={<SendIcon size={22} />} title={message}>
              <div className={styles.liveButtons}>
                <Button
                  variant="primary"
                  size="lg"
                  icon={SendIcon}
                  onClick={sendNow}
                  disabled={files.length === 0}
                >
                  {t('quick.sendAgain')}
                </Button>
                <Button variant="ghost" size="lg" onClick={end}>
                  {t('quick.endSession')}
                </Button>
              </div>
            </StatusBlock>
          ),
        };
      }
      default:
        return { key: 'creating', node: <StatusBlock busy title={t('quick.creating')} /> };
    }
  }

  return (
    <div>
      <FlowHeader title={t('quick.sendTitle')} lead={t('quick.sendLead')} mode="quick" />
      <div className={styles.workspace}>
        <SelectedFilesPane
          title={t('quick.yourFiles')}
          files={files}
          onAdd={addFiles}
          onRemove={removeFile}
          locked={locked}
        />
        <LivePanel stateKey={live.key}>
          {state?.reconnecting ? <ReconnectingNotice /> : null}
          {live.node}
        </LivePanel>
      </div>
    </div>
  );
}

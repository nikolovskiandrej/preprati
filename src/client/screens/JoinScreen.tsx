/**
 * Quick Transfer — joining device. Reached by scanning a session QR code
 * (/j/<session id>) or by typing a pairing code (/j/<code>). The role is
 * decided by the host: if it receives, we send; if it sends, we receive.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import {
  normalizePairingCode,
  PAIRING_CODE_PATTERN,
  RANDOM_ID_PATTERN,
} from '../../shared/constants';
import type { JoinTarget } from '../../shared/signaling';
import { useConfig } from '../app/config';
import { useLeaveWarning, useOwnedStore } from '../app/hooks';
import { FlowHeader } from '../features/common/FlowHeader';
import { describeQuickError } from '../features/quick/errors';
import {
  ConnectingStatus,
  ConnectionBadge,
  IncomingOffer,
  LivePanel,
  QuickError,
  ReceivedFilesList,
  ReconnectingNotice,
  RelayNote,
  StatusBlock,
  TransferDone,
  TransferProgress,
} from '../features/quick/panels';
import { useSessionWakeLock } from '../features/quick/wakeLock';
import { SelectedFilesPane } from '../features/common/SelectedFilesPane';
import { useI18n } from '../i18n';
import { DownloadIcon, ErrorIcon, LinkIcon, LockIcon, RetryIcon, SendIcon } from '../icons';
import { localFileId, type SelectedFile } from '../lib/files';
import { handOffFiles } from '../lib/handoff';
import { QuickSession, type QuickState } from '../transfer/quickSession';
import { relayLimitProblem } from '../transfer/relay';
import { Button } from '../ui/Button';
import styles from './QuickScreens.module.css';

export function parseJoinToken(token: string): JoinTarget | null {
  if (RANDOM_ID_PATTERN.test(token)) return { via: 'link', sessionId: token };
  const code = normalizePairingCode(token);
  return PAIRING_CODE_PATTERN.test(code) ? { via: 'code', code } : null;
}

export default function JoinScreen({ params }: { params: { token: string } }) {
  const { t } = useI18n();
  const [, navigate] = useLocation();
  const target = useMemo(() => parseJoinToken(params.token), [params.token]);
  const [session, state] = useOwnedStore<QuickState, QuickSession>(
    () => new QuickSession(),
    [params.token],
  );
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [composing, setComposing] = useState(false);
  const { config } = useConfig();
  const shareAvailable = config?.share.enabled === true;

  const phase = state?.phase ?? 'idle';
  const role = state?.role ?? null;
  const device = state?.peer?.label ?? t('common.unknownDevice');
  useLeaveWarning(
    phase === 'transferring' ||
      phase === 'awaiting-acceptance' ||
      (state?.received.length ?? 0) > 0,
  );
  useSessionWakeLock(state);

  useEffect(() => {
    if (session && target && phase === 'idle') void session.join(target);
  }, [session, target, phase]);

  const sendNow = () => {
    if (!session) return;
    session.setFiles(files.map((entry) => entry.file));
    if (session.send()) setComposing(false);
  };
  /** The devices can't connect directly: send the chosen files through preprati. instead. */
  const sendThroughServer = () => {
    if (!session) return;
    session.setFiles(files.map((entry) => entry.file));
    session.useRelay();
  };

  if (!target) {
    return (
      <div className={styles.single}>
        <FlowHeader title={t('quick.joinTitle')} mode="quick" />
        <LivePanel stateKey="invalid">
          <StatusBlock
            icon={<ErrorIcon size={22} />}
            title={t('errors.titles.session')}
            detail={t('quick.invalidLink')}
          >
            <div className={styles.liveButtons}>
              <Button variant="primary" onClick={() => navigate('/join')}>
                {t('quick.enterCode')}
              </Button>
            </div>
          </StatusBlock>
        </LivePanel>
      </div>
    );
  }

  const live = renderLive();

  function renderLive(): { key: string; node: ReactNode } {
    if (!state || !session || phase === 'idle' || phase === 'joining') {
      return { key: 'joining', node: <StatusBlock busy title={t('join.joining')} /> };
    }
    const selected = files.map((entry) => entry.file);
    const relayFits =
      !!state.relay &&
      selected.length > 0 &&
      relayLimitProblem(selected, state.relay.limits) === null;
    const error = describeQuickError(state, { shareAvailable });
    if (error) {
      const retry = error.connection?.canRetry === true;
      const canRelay = error.connection?.canRelay === true;
      // A sender who hasn't chosen files yet sees the button disabled until they do.
      const offerRelay = canRelay && (relayFits || selected.length === 0);
      const offerLink =
        !!error.connection && !canRelay && shareAvailable && role === 'sender' && files.length > 0;
      const actions =
        error.recovery === 'retry-send' ? (
          <Button variant="primary" onClick={sendNow} disabled={files.length === 0}>
            {t('quick.sendAgain')}
          </Button>
        ) : (
          <>
            {offerRelay ? (
              <Button
                variant="primary"
                icon={LockIcon}
                onClick={sendThroughServer}
                disabled={!relayFits}
              >
                {t('quick.relaySend')}
              </Button>
            ) : null}
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
              <Button
                variant={retry ? 'inverse' : 'primary'}
                icon={LinkIcon}
                onClick={() => {
                  handOffFiles(files.map((entry) => entry.file));
                  navigate('/share');
                }}
              >
                {t('quick.sendAsLink')}
              </Button>
            ) : null}
            {error.recovery === 'rejoin' ? (
              <Button variant="primary" onClick={() => navigate('/join')}>
                {t('quick.enterCode')}
              </Button>
            ) : (
              <Button
                variant={retry || offerLink || offerRelay ? 'ghost' : 'inverse'}
                onClick={() => navigate('/')}
              >
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

    const endButton = (
      <Button variant="ghost" size="lg" onClick={() => navigate('/')}>
        {t('quick.endSession')}
      </Button>
    );
    const sendPanel = (
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
        </div>
      </StatusBlock>
    );

    if (
      role === 'sender' &&
      composing &&
      ['completed', 'rejected', 'cancelled', 'connected'].includes(phase)
    ) {
      return { key: 'compose', node: sendPanel };
    }

    switch (phase) {
      case 'awaiting-approval':
        return {
          key: 'approval',
          node: <StatusBlock busy title={t('quick.awaitingApproval', { device })} />,
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
                role === 'sender' && state.canRelay && relayFits ? (
                  <Button variant="inverse" icon={LockIcon} onClick={sendThroughServer}>
                    {t('quick.relaySendInstead')}
                  </Button>
                ) : null
              }
            />
          ),
        };
      case 'connected':
        return role === 'sender'
          ? { key: 'compose', node: sendPanel }
          : {
              key: 'connected',
              node: (
                <StatusBlock
                  busy
                  title={t('quick.connectedTo', { device })}
                  detail={t('quick.waitingForFiles', { device })}
                >
                  <ConnectionBadge route={state.route} />
                </StatusBlock>
              ),
            };
      case 'awaiting-acceptance':
        if (role === 'receiver' && state.transfer) {
          return {
            key: `offer-${state.transfer.id}`,
            node: (
              <IncomingOffer
                transfer={state.transfer}
                device={device}
                onAccept={() => session.accept()}
                onReject={() => session.reject()}
              />
            ),
          };
        }
        return {
          key: 'awaiting',
          node: (
            <StatusBlock busy title={t('quick.awaitingAcceptance', { device })}>
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
        return role === 'sender'
          ? {
              key: 'completed',
              node: (
                <TransferDone
                  title={t('quick.completedSent', {
                    count: state.transfer?.files.length ?? 0,
                    device,
                  })}
                >
                  <div className={styles.liveButtons}>
                    <Button
                      variant="primary"
                      size="lg"
                      icon={SendIcon}
                      onClick={() => {
                        setFiles([]);
                        setComposing(true);
                      }}
                    >
                      {t('quick.sendMore')}
                    </Button>
                    {endButton}
                  </div>
                </TransferDone>
              ),
            }
          : {
              key: `completed-${state.transfer?.id}`,
              node: (
                <TransferDone
                  title={t('quick.completedReceived', {
                    count: state.transfer?.files.length ?? 0,
                    device,
                  })}
                >
                  <p className={styles.liveNote}>{t('quick.waitingForMore')}</p>
                  <div className={styles.liveButtons}>{endButton}</div>
                </TransferDone>
              ),
            };
      case 'rejected':
      case 'cancelled': {
        const title =
          phase === 'rejected'
            ? role === 'sender'
              ? t('quick.rejected', { device })
              : t('quick.youDeclined')
            : state.transfer?.endedBy === 'remote'
              ? t('quick.cancelledByPeer', { device })
              : t('quick.cancelledByYou');
        return {
          key: phase,
          node: (
            <StatusBlock
              icon={role === 'sender' ? <SendIcon size={22} /> : <DownloadIcon size={22} />}
              title={title}
            >
              <div className={styles.liveButtons}>
                {role === 'sender' ? (
                  <Button
                    variant="primary"
                    size="lg"
                    icon={SendIcon}
                    onClick={sendNow}
                    disabled={files.length === 0}
                  >
                    {t('quick.sendAgain')}
                  </Button>
                ) : null}
                {endButton}
              </div>
            </StatusBlock>
          ),
        };
      }
      default:
        return { key: 'joining', node: <StatusBlock busy title={t('join.joining')} /> };
    }
  }

  const showPicker =
    role === 'sender' &&
    (phase === 'connected' ||
      composing ||
      ['rejected', 'cancelled'].includes(phase) ||
      phase === 'failed');
  const locked = phase === 'awaiting-acceptance' || phase === 'transferring';

  return (
    <div className={styles.single}>
      <FlowHeader title={t('quick.joinTitle')} mode="quick" />
      <LivePanel stateKey={live.key}>
        {state?.reconnecting ? <ReconnectingNotice /> : null}
        {live.node}
      </LivePanel>
      {showPicker || (role === 'sender' && files.length > 0) ? (
        <div className={styles.below}>
          <SelectedFilesPane
            title={t('quick.yourFiles')}
            files={files}
            onAdd={(added) =>
              setFiles((current) => [
                ...current,
                ...added.map((file) => ({ id: localFileId(), file })),
              ])
            }
            onRemove={(id) => setFiles((current) => current.filter((entry) => entry.id !== id))}
            locked={locked}
          />
        </div>
      ) : null}
      {state && state.received.length > 0 ? (
        <div className={styles.below}>
          <ReceivedFilesList files={state.received} />
        </div>
      ) : null}
    </div>
  );
}

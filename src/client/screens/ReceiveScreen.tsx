/**
 * Quick Transfer — Receive. This device shows a live QR code / pairing code;
 * the device with the files joins, offers them, and we accept or decline.
 */
import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useConfig } from '../app/config';
import { useLeaveWarning, useOwnedStore } from '../app/hooks';
import { FlowHeader } from '../features/common/FlowHeader';
import { describeQuickError } from '../features/quick/errors';
import {
  ConnectingStatus,
  ConnectionBadge,
  IncomingOffer,
  LivePanel,
  PairingTicket,
  QuickError,
  ReconnectingNotice,
  ReceivedFilesList,
  StatusBlock,
  TransferDone,
  TransferProgress,
} from '../features/quick/panels';
import { useI18n } from '../i18n';
import { DownloadIcon, RetryIcon } from '../icons';
import { QuickSession, type QuickState } from '../transfer/quickSession';
import { Button } from '../ui/Button';
import styles from './QuickScreens.module.css';

export default function ReceiveScreen() {
  const { t } = useI18n();
  const [, navigate] = useLocation();
  const [session, state] = useOwnedStore<QuickState, QuickSession>(() => new QuickSession());
  const { config } = useConfig();
  const phase = state?.phase ?? 'idle';
  useLeaveWarning(phase === 'transferring' || (state?.received.length ?? 0) > 0);

  useEffect(() => {
    if (session && phase === 'idle') void session.host('receiver');
  }, [session, phase]);

  const device = state?.peer?.label ?? t('common.unknownDevice');
  const host = typeof window !== 'undefined' ? window.location.host : '';
  const live = renderLive();

  function renderLive(): { key: string; node: ReactNode } {
    if (!state || !session || phase === 'idle' || phase === 'creating-session') {
      return { key: 'creating', node: <StatusBlock busy title={t('quick.creating')} /> };
    }
    const error = describeQuickError(state, { shareAvailable: config?.share.enabled === true });
    if (error) {
      const retry = error.connection?.canRetry === true;
      return {
        key: `error-${error.message}-${retry}`,
        node: (
          <QuickError
            view={error}
            actions={
              <>
                {retry ? (
                  <Button
                    variant="primary"
                    icon={RetryIcon}
                    onClick={() => session.retryConnection()}
                  >
                    {t('quick.tryAgain')}
                  </Button>
                ) : null}
                {error.recovery === 'home' ? (
                  <Button variant="inverse" onClick={() => navigate('/')}>
                    {t('common.goHome')}
                  </Button>
                ) : (
                  <Button
                    variant={retry ? 'ghost' : 'primary'}
                    onClick={() => void session.host('receiver')}
                  >
                    {t('quick.newSession')}
                  </Button>
                )}
              </>
            }
          />
        ),
      };
    }
    const endButton = (
      <Button variant="ghost" size="lg" onClick={() => navigate('/')}>
        {t('quick.endSession')}
      </Button>
    );
    switch (phase) {
      case 'waiting-for-peer':
        return state.session
          ? { key: 'pairing', node: <PairingTicket session={state.session} hostRole="receiver" /> }
          : { key: 'creating', node: <StatusBlock busy title={t('quick.creating')} /> };
      case 'peer-connected':
      case 'connecting':
        return { key: 'connecting', node: <ConnectingStatus device={device} /> };
      case 'connected':
        return {
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
        return state.transfer
          ? {
              key: `offer-${state.transfer.id}`,
              node: (
                <IncomingOffer
                  transfer={state.transfer}
                  device={device}
                  onAccept={() => session.accept()}
                  onReject={() => session.reject()}
                />
              ),
            }
          : {
              key: 'connected',
              node: <StatusBlock busy title={t('quick.waitingForFiles', { device })} />,
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
      case 'cancelled':
        return {
          key: phase,
          node: (
            <StatusBlock
              icon={<DownloadIcon size={22} />}
              title={
                phase === 'rejected'
                  ? t('quick.youDeclined')
                  : state.transfer?.endedBy === 'remote'
                    ? t('quick.cancelledByPeer', { device })
                    : t('quick.cancelledByYou')
              }
              detail={t('quick.waitingForFiles', { device })}
            >
              <div className={styles.liveButtons}>{endButton}</div>
            </StatusBlock>
          ),
        };
      default:
        return { key: 'creating', node: <StatusBlock busy title={t('quick.creating')} /> };
    }
  }

  return (
    <div>
      <FlowHeader title={t('quick.receiveTitle')} lead={t('quick.receiveLead')} mode="quick" />
      <div className={styles.receive}>
        <LivePanel stateKey={live.key}>
          {state?.reconnecting ? <ReconnectingNotice /> : null}
          {live.node}
        </LivePanel>
        <aside className={styles.side}>
          {state && state.received.length > 0 ? (
            <ReceivedFilesList files={state.received} />
          ) : (
            <>
              <h2 className={styles.sideTitle}>{t('quick.stepsTitle')}</h2>
              <ol className={styles.steps}>
                <li>
                  <span>{t('quick.receiveStep1', { host })}</span>
                </li>
                <li>
                  <span>{t('quick.receiveStep2')}</span>
                </li>
                <li>
                  <span>{t('quick.receiveStep3')}</span>
                </li>
              </ol>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

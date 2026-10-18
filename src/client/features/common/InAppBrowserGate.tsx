/**
 * Shown before a page receives files inside an app's built-in browser
 * (Instagram, Facebook, TikTok…), which can't save files: one tap opens the
 * same page — fragment and all — in the phone's own browser where the
 * platform allows it, the app's menu does it everywhere, and "Copy link"
 * covers the rest. Nothing has joined or downloaded yet, so the real browser
 * gets the transfer to itself. People can still carry on here.
 */
import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { CopyIcon, GlobeIcon, InfoIcon } from '../../icons';
import { copyText } from '../../lib/clipboard';
import { detectInAppBrowser, externalBrowserUrl, type InAppBrowser } from '../../lib/inAppBrowser';
import { Button, buttonClass } from '../../ui/Button';
import { useToast } from '../../ui/Toast';
import styles from './InAppBrowserGate.module.css';

/** The in-app browser this page runs in (if any), and whether the person chose to stay. */
export function useInAppBrowserGate(): {
  browser: InAppBrowser | null;
  open: boolean;
  stay: () => void;
} {
  const browser = useMemo(() => detectInAppBrowser(), []);
  const [stayed, setStayed] = useState(false);
  return { browser, open: !!browser && !stayed, stay: () => setStayed(true) };
}

export function InAppBrowserGate({
  browser,
  onStay,
  tone,
}: {
  browser: InAppBrowser;
  onStay: () => void;
  /** `dark` on the charcoal Quick Transfer panel, `light` on the share page. */
  tone: 'dark' | 'light';
}) {
  const { t } = useI18n();
  const { notify } = useToast();
  // The whole URL: a share link's key lives in the fragment.
  const url = typeof window === 'undefined' ? '' : window.location.href;
  const external = externalBrowserUrl(url, browser);
  const copy = async () => {
    const result = await copyText(url);
    notify(
      result.ok
        ? { tone: 'success', message: t('inApp.copied') }
        : { tone: 'error', message: t('qr.copyLinkFailed') },
    );
  };

  return (
    <div className={`${styles.gate} ${tone === 'dark' ? styles.dark : styles.light}`}>
      <div className={styles.head} role="alert">
        <span className={styles.icon} aria-hidden="true">
          <InfoIcon size={22} />
        </span>
        <div>
          <p className={styles.title}>{t('inApp.title')}</p>
          <p className={styles.body}>
            {browser.app ? t('inApp.bodyNamed', { app: browser.app }) : t('inApp.bodyUnnamed')}
          </p>
        </div>
      </div>
      <div className={styles.buttons}>
        {external ? (
          // A plain link: the app's browser hands intent:/x-safari- links to the system.
          <a
            href={external}
            className={buttonClass({ variant: 'primary', size: 'lg' })}
            data-testid="open-in-browser"
          >
            <GlobeIcon size={20} />
            <span>{t('inApp.open')}</span>
          </a>
        ) : null}
        <Button
          variant={external ? (tone === 'dark' ? 'inverse' : 'ghost') : 'primary'}
          size="lg"
          icon={CopyIcon}
          onClick={() => void copy()}
        >
          {t('inApp.copy')}
        </Button>
      </div>
      <p className={styles.steps}>
        {browser.os === 'ios'
          ? t('inApp.stepsIos')
          : browser.os === 'android'
            ? t('inApp.stepsAndroid')
            : t('inApp.stepsOther')}
      </p>
      <div className={styles.stay}>
        <Button variant="quiet" onClick={onStay}>
          {t('inApp.stay')}
        </Button>
        <p className={styles.note}>{t('inApp.stayNote')}</p>
      </div>
    </div>
  );
}

import { useId, useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { normalizePairingCode, PAIRING_CODE_PATTERN } from '../../shared/constants';
import { useConfig } from '../app/config';
import { HeroMark } from '../brand/HeroMark';
import { useI18n } from '../i18n';
import {
  ConnectionIcon,
  DevicesIcon,
  LinkIcon,
  LockIcon,
  QrIcon,
  ReceiveIcon,
  SendIcon,
  ShieldIcon,
} from '../icons';
import { formatTtl } from '../lib/format';
import { Button, ButtonLink } from '../ui/Button';
import styles from './HomeScreen.module.css';

export function HomeScreen({ introActive = false }: { introActive?: boolean }) {
  const { t, locale } = useI18n();
  const { config } = useConfig();
  const [, navigate] = useLocation();
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState(false);
  const codeId = useId();
  const codeErrorId = useId();

  const ttl = config ? formatTtl(config.share.ttlSeconds, locale) : null;

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizePairingCode(code);
    if (!PAIRING_CODE_PATTERN.test(normalized)) {
      setCodeError(true);
      return;
    }
    navigate(`/j/${normalized}`);
  };

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.title}>
          {t('home.title')}
          <span className={styles.period}>.</span>
        </h1>
        <p className={styles.lead}>{t('home.lead')}</p>
        {/* Wait for the intro to hand over before drawing the plane. */}
        {introActive ? (
          <span className={styles.markSpace} aria-hidden="true" />
        ) : (
          <HeroMark className={styles.mark} />
        )}
      </section>

      <section
        className={styles.modes}
        aria-label={`${t('home.quick.title')} / ${t('home.share.title')}`}
      >
        <div className={styles.quick}>
          <div className={styles.modeHead}>
            <span className={styles.modeIcon} aria-hidden="true">
              <DevicesIcon size={22} />
            </span>
            <div>
              <h2 className={styles.modeTitle}>{t('home.quick.title')}</h2>
              <p className={styles.modeTag}>{t('home.quick.tag')}</p>
            </div>
          </div>
          <p className={styles.modeBody}>{t('home.quick.body')}</p>
          <div className={styles.actions}>
            <ButtonLink href="/send" variant="primary" size="lg" icon={SendIcon}>
              {t('home.quick.send')}
            </ButtonLink>
            <ButtonLink href="/receive" variant="inverse" size="lg" icon={ReceiveIcon}>
              {t('home.quick.receive')}
            </ButtonLink>
          </div>
          <form className={styles.codeForm} onSubmit={submitCode} noValidate>
            <label htmlFor={codeId} className={styles.codeLabel}>
              {t('home.quick.haveCode')}
            </label>
            <div className={styles.codeRow}>
              <input
                id={codeId}
                className={styles.codeInput}
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  setCodeError(false);
                }}
                placeholder={t('home.quick.codePlaceholder')}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
                maxLength={12}
                aria-invalid={codeError || undefined}
                aria-describedby={codeError ? codeErrorId : undefined}
              />
              <Button type="submit" variant="ghost" className={styles.codeButton}>
                {t('home.quick.join')}
              </Button>
            </div>
            {codeError ? (
              <p id={codeErrorId} className={styles.codeError} role="alert">
                {t('home.quick.codeInvalid')}
              </p>
            ) : null}
          </form>
        </div>

        <div className={styles.share}>
          <div className={styles.modeHead}>
            <span className={styles.modeIcon} aria-hidden="true">
              <QrIcon size={22} />
            </span>
            <div>
              <h2 className={styles.modeTitle}>{t('home.share.title')}</h2>
              <p className={styles.modeTag}>{t('home.share.tag')}</p>
            </div>
          </div>
          <p className={styles.modeBody}>
            {ttl ? t('home.share.body', { ttl }) : t('home.share.bodyNoTtl')}
          </p>
          <div className={styles.actions}>
            <ButtonLink href="/share" variant="dark" size="lg" icon={LinkIcon}>
              {t('home.share.cta')}
            </ButtonLink>
          </div>
        </div>
      </section>

      <section className={styles.privacy} aria-labelledby="privacy-title">
        <h2 id="privacy-title" className={styles.privacyTitle}>
          {t('home.privacy.title')}
        </h2>
        <ul className={styles.points}>
          <li>
            <ConnectionIcon size={22} />
            <div>
              <h3>{t('home.privacy.directTitle')}</h3>
              <p>{t('home.privacy.directBody')}</p>
            </div>
          </li>
          <li>
            <LockIcon size={22} />
            <div>
              <h3>{t('home.privacy.encryptedTitle')}</h3>
              <p>{t('home.privacy.encryptedBody')}</p>
            </div>
          </li>
          <li>
            <ShieldIcon size={22} />
            <div>
              <h3>{t('home.privacy.accountsTitle')}</h3>
              <p>{t('home.privacy.accountsBody')}</p>
            </div>
          </li>
        </ul>
      </section>
    </div>
  );
}

export default HomeScreen;

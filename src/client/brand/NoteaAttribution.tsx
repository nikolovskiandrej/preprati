/**
 * Discreet "Made by Notea" attribution with the Notea mark. The link target
 * is configurable (NOTEA_URL); without it the attribution is plain text. The
 * mark is transparent on both appearances: Notea's dark green on light, and
 * Notea's own mint mark on dark, where the dark green would disappear.
 */
import noteaLogoOnDark from '../assets/notea-logo-on-dark.png';
import noteaLogo from '../assets/notea-logo.png';
import { useI18n } from '../i18n';
import styles from './NoteaAttribution.module.css';

/** Pixel size of both logo files. CSS sets only the height, so the width keeps this ratio. */
const NOTEA_LOGO_SIZE = { width: 130, height: 96 } as const;

export function NoteaAttribution({ url, theme }: { url: string | null; theme: 'light' | 'dark' }) {
  const { t } = useI18n();
  const content = (
    <>
      <span>{t('common.madeBy')}</span>
      <img
        src={theme === 'dark' ? noteaLogoOnDark : noteaLogo}
        alt=""
        width={NOTEA_LOGO_SIZE.width}
        height={NOTEA_LOGO_SIZE.height}
        className={styles.logo}
      />
      <span className={styles.name}>{t('common.notea')}</span>
    </>
  );
  if (url) {
    return (
      <a className={styles.attribution} href={url} target="_blank" rel="noopener noreferrer">
        {content}
      </a>
    );
  }
  return <span className={styles.attribution}>{content}</span>;
}

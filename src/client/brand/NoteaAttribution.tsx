/**
 * Discreet "Made by Notea" attribution with the original Notea logo. The
 * link target is configurable (NOTEA_URL); without it the attribution is
 * plain text. In dark mode the logo sits on a small cream chip so its
 * original green stays legible.
 */
import noteaLogo from '../assets/notea-logo.png';
import { useI18n } from '../i18n';
import styles from './NoteaAttribution.module.css';

export function NoteaAttribution({ url }: { url: string | null }) {
  const { t } = useI18n();
  const content = (
    <>
      <span>{t('common.madeBy')}</span>
      <span className={styles.chip}>
        <img src={noteaLogo} alt="" width={26} height={19} className={styles.logo} />
      </span>
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

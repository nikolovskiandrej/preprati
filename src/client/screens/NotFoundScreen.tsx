import { useI18n } from '../i18n';
import { ArrowLeftIcon } from '../icons';
import { ButtonLink } from '../ui/Button';
import styles from './NotFoundScreen.module.css';

export default function NotFoundScreen() {
  const { t } = useI18n();
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('notFound.title')}</h1>
      <p className={styles.body}>{t('notFound.body')}</p>
      <ButtonLink href="/" variant="dark" icon={ArrowLeftIcon}>
        {t('common.goHome')}
      </ButtonLink>
    </div>
  );
}

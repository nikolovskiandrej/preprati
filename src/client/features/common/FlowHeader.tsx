import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { ArrowLeftIcon } from '../../icons';
import { useI18n } from '../../i18n';
import styles from './FlowHeader.module.css';

export function FlowHeader({
  title,
  lead,
  mode,
}: {
  title: string;
  lead?: ReactNode;
  mode?: 'quick' | 'share';
}) {
  const { t } = useI18n();
  return (
    <div className={styles.header}>
      <Link href="/" className={styles.back}>
        <ArrowLeftIcon size={18} />
        <span>{t('common.home')}</span>
      </Link>
      <h1 className={styles.title} data-mode={mode}>
        {title}
      </h1>
      {lead ? <p className={styles.lead}>{lead}</p> : null}
    </div>
  );
}

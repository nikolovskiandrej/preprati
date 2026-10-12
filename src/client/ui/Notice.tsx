import type { ComponentType, ReactNode } from 'react';
import { CheckCircleIcon, ErrorIcon, InfoIcon, LockIcon, type IconProps } from '../icons';
import styles from './Notice.module.css';

type Tone = 'info' | 'secure' | 'warning' | 'danger' | 'success';

const ICONS: Record<Tone, ComponentType<IconProps>> = {
  info: InfoIcon,
  secure: LockIcon,
  warning: ErrorIcon,
  danger: ErrorIcon,
  success: CheckCircleIcon,
};

/** Inline callout. Tone is always reinforced by an icon and wording, never color alone. */
export function Notice({
  tone = 'info',
  title,
  children,
  icon,
  role,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ComponentType<IconProps>;
  role?: 'status' | 'alert';
}) {
  const Icon = icon ?? ICONS[tone];
  return (
    <div className={`${styles.notice} ${styles[tone]}`} role={role}>
      <Icon size={20} className={styles.icon} />
      <div className={styles.content}>
        {title ? <p className={styles.title}>{title}</p> : null}
        {children ? <div className={styles.body}>{children}</div> : null}
      </div>
    </div>
  );
}

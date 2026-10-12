/**
 * Buttons. Variants map to intent, not decoration:
 * - primary: the one main action of a view (tangerine, charcoal label — AA contrast)
 * - dark:    strong secondary action on light surfaces
 * - inverse: strong action on dark (Quick Transfer) surfaces
 * - ghost:   outlined secondary action
 * - quiet:   low-emphasis text action
 * - danger:  destructive action (always paired with a confirmation)
 */
import { m, useReducedMotion } from 'motion/react';
import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from 'react';
import { Link } from 'wouter';
import type { IconProps } from '../icons';
import { Spinner } from './Spinner';
import styles from './Button.module.css';

export type ButtonVariant =
  'primary' | 'dark' | 'inverse' | 'ghost' | 'quiet' | 'danger' | 'danger-solid';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ComponentType<IconProps>;
  iconEnd?: ComponentType<IconProps>;
  fullWidth?: boolean;
  children: ReactNode;
}

export interface ButtonProps
  extends CommonProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  loading?: boolean;
}

export function buttonClass({
  variant = 'primary',
  size = 'md',
  fullWidth,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}): string {
  return [
    styles.button,
    styles[variant],
    styles[size],
    fullWidth ? styles.full : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

const iconSize: Record<ButtonSize, number> = { sm: 16, md: 19, lg: 20 };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant,
    size = 'md',
    icon: Icon,
    iconEnd: IconEnd,
    fullWidth,
    loading,
    disabled,
    className,
    children,
    type,
    ...rest
  },
  ref,
) {
  const reduce = useReducedMotion();
  const {
    onAnimationStart: _onAnimationStart,
    onDrag: _onDrag,
    onDragStart: _onDragStart,
    onDragEnd: _onDragEnd,
    ...buttonProps
  } = rest;
  return (
    <m.button
      ref={ref}
      type={type ?? 'button'}
      className={buttonClass({ variant, size, fullWidth, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      whileTap={reduce || disabled || loading ? undefined : { scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 520, damping: 32 }}
      {...buttonProps}
    >
      {loading ? <Spinner size={iconSize[size]} /> : Icon ? <Icon size={iconSize[size]} /> : null}
      <span className={styles.label}>{children}</span>
      {IconEnd && !loading ? <IconEnd size={iconSize[size]} /> : null}
    </m.button>
  );
});

/** A link styled as a button (client-side navigation). */
export function ButtonLink({
  href,
  variant,
  size = 'md',
  icon: Icon,
  iconEnd: IconEnd,
  fullWidth,
  className,
  children,
}: CommonProps & { href: string; className?: string }) {
  return (
    <Link href={href} className={buttonClass({ variant, size, fullWidth, className })}>
      {Icon ? <Icon size={iconSize[size]} /> : null}
      <span className={styles.label}>{children}</span>
      {IconEnd ? <IconEnd size={iconSize[size]} /> : null}
    </Link>
  );
}

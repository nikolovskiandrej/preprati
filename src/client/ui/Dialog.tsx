/**
 * Accessible modal dialog. Centered card on larger screens, bottom sheet on
 * phones. Traps focus, closes on Escape / backdrop, restores focus, and locks
 * page scroll while open.
 */
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '../icons';
import { useI18n } from '../i18n';
import { useMediaQuery } from './useMediaQuery';
import styles from './Dialog.module.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  dismissible?: boolean;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const sheet = useMediaQuery('(max-width: 640px)');
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      const first =
        panel?.querySelector<HTMLElement>('[data-autofocus]') ??
        panel?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel)?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissible) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, [open, dismissible, onClose]);

  const panelMotion = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : sheet
      ? { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' } }
      : {
          initial: { opacity: 0, scale: 0.96, y: 8 },
          animate: { opacity: 1, scale: 1, y: 0 },
          exit: { opacity: 0, scale: 0.97, y: 4 },
        };

  return createPortal(
    <AnimatePresence>
      {open ? (
        <m.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && dismissible) onClose();
          }}
        >
          <m.div
            ref={panelRef}
            className={sheet ? `${styles.panel} ${styles.sheet}` : styles.panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            tabIndex={-1}
            {...panelMotion}
            transition={
              sheet
                ? { type: 'spring', stiffness: 380, damping: 38 }
                : { duration: 0.2, ease: [0.16, 1, 0.3, 1] }
            }
          >
            <div className={styles.header}>
              <h2 id={titleId} className={styles.title}>
                {title}
              </h2>
              {dismissible ? (
                <button
                  type="button"
                  className={styles.close}
                  onClick={onClose}
                  aria-label={t('common.close')}
                >
                  <CloseIcon size={20} />
                </button>
              ) : null}
            </div>
            <div id={bodyId} className={styles.body}>
              {children}
            </div>
            {footer ? <div className={styles.footer}>{footer}</div> : null}
          </m.div>
        </m.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

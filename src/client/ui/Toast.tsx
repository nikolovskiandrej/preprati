/**
 * Lightweight toasts for transient feedback (copy results, fallbacks).
 * Announced politely to screen readers; errors use an assertive region.
 */
import { AnimatePresence, m } from 'motion/react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircleIcon, CloseIcon, ErrorIcon, InfoIcon } from '../icons';
import { useI18n } from '../i18n';
import styles from './Toast.module.css';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastInput {
  message: string;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<{ notify: (toast: ToastInput) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback(
    (id: number) => setItems((current) => current.filter((item) => item.id !== id)),
    [],
  );

  const notify = useCallback(
    (toast: ToastInput) => {
      counter.current += 1;
      const id = counter.current;
      setItems((current) => [...current.slice(-2), { ...toast, id }]);
      const duration = toast.durationMs ?? (toast.tone === 'error' || toast.action ? 7000 : 4000);
      setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ notify }), [notify]);
  const polite = items.filter((item) => item.tone !== 'error');
  const assertive = items.filter((item) => item.tone === 'error');

  const render = (list: ToastItem[]) => (
    <AnimatePresence initial={false}>
      {list.map((item) => {
        const Icon =
          item.tone === 'success' ? CheckCircleIcon : item.tone === 'error' ? ErrorIcon : InfoIcon;
        return (
          <m.div
            key={item.id}
            className={`${styles.toast} ${styles[item.tone ?? 'info']}`}
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <Icon size={20} />
            <span className={styles.message}>{item.message}</span>
            {item.action ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  item.action!.onClick();
                  dismiss(item.id);
                }}
              >
                {item.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.close}
              onClick={() => dismiss(item.id)}
              aria-label={t('common.close')}
            >
              <CloseIcon size={16} />
            </button>
          </m.div>
        );
      })}
    </AnimatePresence>
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.region}>
        <div role="status" aria-live="polite" className={styles.stack}>
          {render(polite)}
        </div>
        <div role="alert" aria-live="assertive" className={styles.stack}>
          {render(assertive)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside <ToastProvider>');
  return value;
}

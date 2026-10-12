/**
 * Startup introduction (~1.2 s): the plane outline draws itself, the fill
 * lands with a small spring, the loop trail draws, the wordmark wipes in, and
 * the whole lockup then flies into its place in the header (shared layout
 * animation via `layoutId`). Shown once per browser session, never on deep
 * links (join/share pages) and never when the user prefers reduced motion.
 */
import { m } from 'motion/react';
import { useEffect } from 'react';
import { useI18n } from '../i18n';
import {
  COMPACT_PLANE,
  COMPACT_PLANE_ROUNDING,
  COMPACT_STROKE,
  COMPACT_TRAIL,
  COMPACT_VIEWBOX,
} from './geometry';
import { Wordmark } from './Logo';
import styles from './IntroSplash.module.css';

const ease = [0.16, 1, 0.3, 1] as const;
const SESSION_KEY = 'preprati.introSeen';

export function shouldPlayIntro(location: Pick<Location, 'pathname' | 'search'>): boolean {
  if (typeof window === 'undefined') return false;
  if (location.pathname !== '/') return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  // `/?intro` forces the intro (used by tests); automation otherwise skips it for determinism.
  const forced = new URLSearchParams(location.search).has('intro');
  if (!forced && navigator.webdriver) return false;
  try {
    if (!forced && sessionStorage.getItem(SESSION_KEY)) return false;
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    // Storage unavailable: still fine to play once for this page view.
  }
  return true;
}

export function IntroSplash({ onComplete }: { onComplete: () => void }) {
  const { t } = useI18n();

  useEffect(() => {
    // Safety net: never hold the interface hostage if an animation event is missed.
    const timer = setTimeout(onComplete, 2200);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <m.div
      className={styles.overlay}
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.32, ease } }}
      role="presentation"
    >
      <span className="visually-hidden">{t('intro.label')}</span>
      <m.span
        className={styles.lockup}
        layoutId="brand-lockup"
        transition={{ type: 'spring', stiffness: 240, damping: 30 }}
      >
        <m.svg
          viewBox={COMPACT_VIEWBOX}
          className={styles.mark}
          aria-hidden="true"
          initial={{ scale: 0.86, rotate: -10 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 210, damping: 15, delay: 0.38 }}
        >
          <m.path
            d={COMPACT_PLANE}
            fill="none"
            stroke="var(--tangerine)"
            strokeWidth={COMPACT_PLANE_ROUNDING}
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.42, ease }}
          />
          <m.path
            d={COMPACT_PLANE}
            fill="var(--tangerine)"
            stroke="var(--tangerine)"
            strokeWidth={COMPACT_PLANE_ROUNDING}
            strokeLinejoin="round"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2, delay: 0.36 }}
          />
          <m.path
            d={COMPACT_TRAIL}
            fill="none"
            stroke="var(--tangerine)"
            strokeWidth={COMPACT_STROKE}
            strokeLinecap="round"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{
              pathLength: { duration: 0.5, ease, delay: 0.22 },
              opacity: { duration: 0.1, delay: 0.22 },
            }}
          />
        </m.svg>
        <m.span
          className={styles.word}
          initial={{ opacity: 0, x: -10, clipPath: 'inset(0 100% 0 0)' }}
          animate={{ opacity: 1, x: 0, clipPath: 'inset(0 0% 0 0)' }}
          transition={{ duration: 0.42, ease, delay: 0.58 }}
          onAnimationComplete={() => setTimeout(onComplete, 220)}
        >
          <Wordmark height={52} className={styles.wordmark} />
        </m.span>
      </m.span>
    </m.div>
  );
}

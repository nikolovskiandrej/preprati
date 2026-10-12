import { m, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { useEffect } from 'react';
import styles from './ProgressBar.module.css';

/**
 * Determinate progress. The fill is spring-smoothed (progress arrives in
 * bursts); `showPlane` adds a small paper plane riding the leading edge.
 */
export function ProgressBar({
  value,
  label,
  valueText,
  showPlane = false,
  tone = 'accent',
  size = 'md',
}: {
  value: number;
  label: string;
  valueText?: string;
  showPlane?: boolean;
  tone?: 'accent' | 'success' | 'neutral' | 'inverse';
  size?: 'sm' | 'md';
}) {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const reduce = useReducedMotion();
  const spring = useSpring(clamped, { stiffness: 140, damping: 28, mass: 0.6 });
  useEffect(() => {
    if (reduce) spring.jump(clamped);
    else spring.set(clamped);
  }, [clamped, reduce, spring]);
  const left = useTransform(spring, (v) => `${v * 100}%`);

  return (
    <div
      className={[styles.root, styles[tone], styles[size], showPlane ? styles.withPlane : ''].join(
        ' ',
      )}
    >
      <div className={styles.inner}>
        <div
          className={styles.track}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(clamped * 100)}
          aria-valuetext={valueText}
        >
          <m.div className={styles.fill} style={{ scaleX: spring }} />
        </div>
        {showPlane ? (
          <m.span className={styles.plane} style={{ left }} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path
                d="M21.6 2.6 2.4 11.3l4.9 1.6 9.3-6.1-7.2 7.3 3.4 7.3Z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </m.span>
        ) : null}
      </div>
    </div>
  );
}

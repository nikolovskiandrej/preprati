/**
 * preprati. logo components. All artwork is vector (see ./geometry.ts):
 * - CompactMark: plane + short loop, for icons and small sizes.
 * - Wordmark: "preprati." outlined; letters follow the text color, the
 *   period is always tangerine.
 * - Logo: the horizontal lockup used in the header and the intro.
 */
import { m } from 'motion/react';
import type { CSSProperties } from 'react';
import {
  COMPACT_PLANE,
  COMPACT_PLANE_ROUNDING,
  COMPACT_STROKE,
  COMPACT_TRAIL,
  COMPACT_VIEWBOX,
  WORDMARK_DOT,
  WORDMARK_HEIGHT,
  WORDMARK_LETTERS,
  WORDMARK_SOFTEN,
  WORDMARK_WIDTH,
} from './geometry';
import styles from './Logo.module.css';

export function CompactMark({
  size = 32,
  className,
  style,
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox={COMPACT_VIEWBOX}
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={COMPACT_PLANE}
        fill="var(--tangerine)"
        stroke="var(--tangerine)"
        strokeWidth={COMPACT_PLANE_ROUNDING}
        strokeLinejoin="round"
      />
      <path
        d={COMPACT_TRAIL}
        fill="none"
        stroke="var(--tangerine)"
        strokeWidth={COMPACT_STROKE}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Wordmark({ height = 24, className }: { height?: number; className?: string }) {
  const width = (WORDMARK_WIDTH / WORDMARK_HEIGHT) * height;
  return (
    <svg
      viewBox={`0 0 ${WORDMARK_WIDTH} ${WORDMARK_HEIGHT}`}
      width={width}
      height={height}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={WORDMARK_LETTERS}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={WORDMARK_SOFTEN}
        strokeLinejoin="round"
      />
      <path d={WORDMARK_DOT} fill="var(--tangerine)" />
    </svg>
  );
}

/** Horizontal lockup. The accessible name lives on the surrounding link/heading. */
export function Logo({ height = 26, layoutId }: { height?: number; layoutId?: string }) {
  return (
    <m.span className={styles.lockup} layoutId={layoutId} style={{ gap: height * 0.28 }}>
      <CompactMark size={height * 1.45} className={styles.mark} />
      <Wordmark height={height} />
    </m.span>
  );
}

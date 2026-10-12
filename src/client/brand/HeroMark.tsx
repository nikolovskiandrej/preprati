/**
 * The large paper plane with its hand-drawn looping trail, used once on the
 * home page. On first view the trail draws itself and the plane settles —
 * the page's single orchestrated moment. Static when motion is reduced.
 */
import { m, useReducedMotion } from 'motion/react';
import {
  MARK_PLANE,
  MARK_PLANE_ROUNDING,
  MARK_SPARKS,
  MARK_STROKE,
  MARK_TRAIL,
  MARK_VIEWBOX,
} from './geometry';

const ease = [0.16, 1, 0.3, 1] as const;

export function HeroMark({ className, animate = true }: { className?: string; animate?: boolean }) {
  const reduce = useReducedMotion();
  const play = animate && !reduce;

  return (
    <svg viewBox={MARK_VIEWBOX} className={className} aria-hidden="true" focusable="false">
      <m.path
        d={MARK_TRAIL}
        fill="none"
        stroke="var(--tangerine)"
        strokeWidth={MARK_STROKE}
        strokeLinecap="round"
        initial={play ? { pathLength: 0, opacity: 0 } : false}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{
          pathLength: { duration: 1.1, ease, delay: 0.15 },
          opacity: { duration: 0.2, delay: 0.15 },
        }}
        style={{ pathOffset: 0 }}
      />
      <m.path
        d={MARK_PLANE}
        fill="var(--tangerine)"
        stroke="var(--tangerine)"
        strokeWidth={MARK_PLANE_ROUNDING}
        strokeLinejoin="round"
        initial={play ? { opacity: 0, x: -18, y: 14, rotate: -6 } : false}
        animate={{ opacity: 1, x: 0, y: 0, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 170, damping: 18, delay: 0.75 }}
        style={{ transformOrigin: '187px 110px' }}
      />
      {MARK_SPARKS.map((d, index) => (
        <m.path
          key={d}
          d={d}
          fill="none"
          stroke="var(--tangerine)"
          strokeWidth={MARK_STROKE}
          strokeLinecap="round"
          initial={play ? { pathLength: 0, opacity: 0 } : false}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.25, ease, delay: 1.05 + index * 0.06 }}
        />
      ))}
    </svg>
  );
}

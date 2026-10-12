import { useMemo } from 'react';
import { createQrModel, finderPath } from '../lib/qr';
import styles from './QrCode.module.css';

/**
 * The on-screen QR code: always charcoal on white with a full quiet zone,
 * in light and dark mode alike, so phone cameras read it reliably.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const model = useMemo(() => createQrModel(value), [value]);
  return (
    <svg
      viewBox={`0 0 ${model.extent} ${model.extent}`}
      className={styles.qr}
      role="img"
      aria-label={label}
      data-testid="qr-code"
      data-qr-value-length={value.length}
    >
      <rect width={model.extent} height={model.extent} fill="#ffffff" />
      <path d={model.modulesPath} fill="#252525" shapeRendering="crispEdges" />
      {model.finders.map((finder) => (
        <path
          key={`${finder.x}-${finder.y}`}
          d={finderPath(finder.x, finder.y)}
          fill="#252525"
          fillRule="evenodd"
        />
      ))}
    </svg>
  );
}

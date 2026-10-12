/**
 * Locale-aware formatting for sizes, speeds and times. All user-visible
 * numbers go through here so English and Macedonian stay consistent.
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Decimal units (1 MB = 1,000,000 bytes), matching how OSes show file sizes on most platforms. */
export function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number, locale: string): string {
  return `${formatBytes(bytesPerSecond, locale)}/s`;
}

export function formatPercent(fraction: number, locale: string): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    clamped,
  );
}

/** "4:05" style countdown for short pairing windows. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Compact duration for ETAs: "45 s", "3 min", "1 h 20 min". */
export function formatDuration(seconds: number, locale: string): string {
  const s = Math.max(0, Math.round(seconds));
  const unit = (value: number, u: 'second' | 'minute' | 'hour') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'narrow' }).format(value);
  if (s < 60) return unit(s, 'second');
  const minutes = Math.round(s / 60);
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? unit(hours, 'hour') : `${unit(hours, 'hour')} ${unit(rest, 'minute')}`;
}

/** Absolute date-time, e.g. "Oct 12, 14:30". */
export function formatDateTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

/** Relative time until a moment in the future: "in 23 hours", "in 5 minutes". */
export function formatRelative(timestamp: number, now: number, locale: string): string {
  const diff = timestamp - now;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

/** Human duration for configured windows: 86400 → "24 hours". */
export function formatTtl(seconds: number, locale: string): string {
  const fmt = (value: number, unit: 'day' | 'hour' | 'minute') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
  if (seconds % 86_400 === 0 && seconds >= 172_800) return fmt(seconds / 86_400, 'day');
  if (seconds % 3_600 === 0) return fmt(seconds / 3_600, 'hour');
  return fmt(Math.round(seconds / 60), 'minute');
}

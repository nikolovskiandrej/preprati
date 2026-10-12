/**
 * Builds a short, human-readable device label such as "iPhone · Safari" that
 * is shown to the other side of a Quick Transfer session. Only coarse
 * platform/browser names are derived — no versions, models or identifiers.
 */
export interface DeviceLabelParts {
  platform: 'iphone' | 'ipad' | 'android' | 'mac' | 'windows' | 'chromeos' | 'linux' | 'unknown';
  browser: 'Safari' | 'Chrome' | 'Firefox' | 'Edge' | 'Samsung Internet' | 'Opera' | 'Browser';
}

export function detectDevice(userAgent: string, maxTouchPoints = 0): DeviceLabelParts {
  const ua = userAgent;
  let platform: DeviceLabelParts['platform'] = 'unknown';
  if (/iPhone|iPod/.test(ua)) platform = 'iphone';
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) platform = 'ipad';
  else if (/Android/.test(ua)) platform = 'android';
  else if (/CrOS/.test(ua)) platform = 'chromeos';
  else if (/Macintosh|Mac OS X/.test(ua)) platform = 'mac';
  else if (/Windows/.test(ua)) platform = 'windows';
  else if (/Linux|X11/.test(ua)) platform = 'linux';

  let browser: DeviceLabelParts['browser'] = 'Browser';
  if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox|FxiOS/.test(ua)) browser = 'Firefox';
  else if (/Chrome|CriOS|Chromium/.test(ua)) browser = 'Chrome';
  else if (/Safari/.test(ua)) browser = 'Safari';

  return { platform, browser };
}

export function currentDevice(): DeviceLabelParts {
  if (typeof navigator === 'undefined') return { platform: 'unknown', browser: 'Browser' };
  return detectDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

const PLATFORM_NAMES: Record<DeviceLabelParts['platform'], string | null> = {
  iphone: 'iPhone',
  ipad: 'iPad',
  android: 'Android',
  mac: 'Mac',
  windows: 'Windows',
  chromeos: 'Chromebook',
  linux: 'Linux',
  unknown: null,
};

/** "iPhone · Safari" — proper nouns only, so it reads the same in every locale. */
export function deviceLabel(parts: DeviceLabelParts = currentDevice()): string {
  const platform = PLATFORM_NAMES[parts.platform];
  return platform ? `${platform} · ${parts.browser}` : parts.browser;
}

export function isMobileDevice(parts: DeviceLabelParts = currentDevice()): boolean {
  return parts.platform === 'iphone' || parts.platform === 'android' || parts.platform === 'ipad';
}

/**
 * Built-in ("in-app") browsers of apps such as Instagram, Facebook or
 * TikTok. They open links inside the app with a stripped-down web view that
 * can run preprati. but can't save files: a download either does nothing or
 * is handed to the app, which can't fetch the browser-local file. Pages that
 * receive files therefore suggest opening them in the phone's own browser
 * first (see InAppBrowserGate).
 *
 * Detection reads the user agent: apps name themselves in it, an Android
 * WebView marks itself with "; wv)", and an embedded iOS web view lacks the
 * "Safari/" token that Safari and every real iOS browser carry. Real
 * browsers opened from apps (Chrome Custom Tabs, SFSafariViewController) look
 * like the browsers they are and are not flagged.
 */

export type MobileOs = 'android' | 'ios' | 'other';

export interface InAppBrowser {
  /** The app, when its user agent names it (null for an unnamed web view). */
  app: string | null;
  os: MobileOs;
  /** iOS major version (0 elsewhere or when unknown). */
  iosVersion: number;
}

const APPS: Array<[RegExp, string]> = [
  [/\bInstagram\b/, 'Instagram'],
  [/\bBarcelona\b/, 'Threads'],
  [/FBAN\/(Messenger|MessengerForiOS)|FB_IAB\/(MESSENGER|Orca)|\bOrca-Android/, 'Messenger'],
  [/\bFBAN\/|\bFBAV\/|\bFB_IAB\/|\bFBIOS\b|\bFB4A\b/, 'Facebook'],
  [/musical_ly|BytedanceWebview|\bTikTok\b|\btrill_/, 'TikTok'],
  [/\bSnapchat\b/, 'Snapchat'],
  [/\bLinkedInApp\b/, 'LinkedIn'],
  [/\bLine\/\d/, 'LINE'],
  [/MicroMessenger/, 'WeChat'],
  [/\bPinterest\b/, 'Pinterest'],
];

/** Web-view-based browsers that do save files (not to be sent elsewhere). */
const CAPABLE_WEBVIEWS = /DuckDuckGo\//;

export function detectInAppBrowser(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): InAppBrowser | null {
  const os: MobileOs = /Android/.test(userAgent)
    ? 'android'
    : /iPhone|iPad|iPod/.test(userAgent)
      ? 'ios'
      : 'other';
  const iosVersion = Number(/OS (\d+)[_.]\d+.* like Mac OS X/.exec(userAgent)?.[1] ?? 0);
  const named = APPS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  if (named) return { app: named, os, iosVersion };
  if (CAPABLE_WEBVIEWS.test(userAgent)) return null;
  const webView =
    (os === 'android' && /; wv\)/.test(userAgent)) || (os === 'ios' && !/Safari\//.test(userAgent));
  return webView ? { app: null, os, iosVersion } : null;
}

/**
 * A link that asks the phone to open `url` in its regular browser, or null
 * when the platform has none: an Android intent (the app hands it to the
 * default browser), or Safari's own scheme on iOS 17 and later. Neither can
 * be followed without a tap, so they are buttons, never redirects. The URL's
 * fragment (a share link's key) survives: Android parses the intent from the
 * last "#", and Safari opens the URL as given.
 */
export function externalBrowserUrl(url: string, browser: InAppBrowser): string | null {
  const target = new URL(url);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  if (browser.os === 'android') {
    const scheme = target.protocol.slice(0, -1);
    const rest = `${target.host}${target.pathname}${target.search}${target.hash}`;
    return `intent://${rest}#Intent;scheme=${scheme};action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end`;
  }
  if (browser.os === 'ios' && browser.iosVersion >= 17) return `x-safari-${target.href}`;
  return null;
}

/**
 * Telling an app's built-in browser (which can't save files) from a real
 * browser, and building the link that opens the page in the real one.
 */
import { describe, expect, it } from 'vitest';
import { detectInAppBrowser, externalBrowserUrl } from '../../src/client/lib/inAppBrowser';

const UA = {
  instagramIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 339.0.3.12.91 (iPhone14,5; iOS 17_5; en_US; en; scale=3.00; 1170x2532; 618401163; IABMV/1)',
  instagramAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36 Instagram 343.0.0.33.101 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 7; panther; panther; en_US; 627400398)',
  facebookIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBDV/iPhone13,2;FBMD/iPhone;FBSN/iOS;FBSV/16.6;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]',
  messengerAndroid:
    'Mozilla/5.0 (Linux; Android 13; SM-A536B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.193 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/440.0.0.31.110;]',
  threadsIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Barcelona 330.0.0.13.105 (iPhone15,2; iOS 17_4; en_US)',
  tiktokAndroid:
    'Mozilla/5.0 (Linux; Android 12; M2101K6G Build/SKQ1.210908.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.193 Mobile Safari/537.36 trill_320504 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/32.5.4 ByteLocale/en',
  snapchatIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/12.65.0.36 (like Safari/8617.2.4.10.8, panda)',
  unnamedAndroidWebView:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.230803.041; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.88 Mobile Safari/537.36',
  unnamedIosWebView:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/127.0.6533.107 Mobile/15E148 Safari/604.1',
  firefoxIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/129.0 Mobile/15E148 Safari/605.1.15',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  samsungInternet:
    'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  duckduckgoAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.0.0 Mobile DuckDuckGo/5 Safari/537.36',
  chromeDesktop:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
};

describe('in-app browser detection', () => {
  it.each([
    ['instagramIos', 'Instagram', 'ios'],
    ['instagramAndroid', 'Instagram', 'android'],
    ['facebookIos', 'Facebook', 'ios'],
    ['messengerAndroid', 'Messenger', 'android'],
    ['threadsIos', 'Threads', 'ios'],
    ['tiktokAndroid', 'TikTok', 'android'],
    ['snapchatIos', 'Snapchat', 'ios'],
    ['unnamedAndroidWebView', null, 'android'],
    ['unnamedIosWebView', null, 'ios'],
  ] as const)('recognises %s', (name, app, os) => {
    expect(detectInAppBrowser(UA[name])).toMatchObject({ app, os });
  });

  it.each([
    'safariIos',
    'chromeIos',
    'firefoxIos',
    'chromeAndroid',
    'samsungInternet',
    'duckduckgoAndroid',
    'chromeDesktop',
  ] as const)('leaves the real browser %s alone', (name) => {
    expect(detectInAppBrowser(UA[name])).toBeNull();
  });

  it('reads the iOS version', () => {
    expect(detectInAppBrowser(UA.instagramIos)?.iosVersion).toBe(17);
    expect(detectInAppBrowser(UA.facebookIos)?.iosVersion).toBe(16);
  });
});

describe('opening the page in the real browser', () => {
  const share = 'https://preprati.vercel.app/s/AbCdEfGhIjKlMnOpQrStUv#k3y_with-fragment';

  it('hands an Android app an intent that keeps the fragment (a share link’s key)', () => {
    const url = externalBrowserUrl(share, detectInAppBrowser(UA.instagramAndroid)!);
    expect(url).toBe(
      'intent://preprati.vercel.app/s/AbCdEfGhIjKlMnOpQrStUv#k3y_with-fragment#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end',
    );
    // Android takes the intent from the last "#": what is before it is the page, key included.
    const data = url!.slice(0, url!.lastIndexOf('#')).replace(/^intent:/, 'https:');
    expect(data).toBe(share);
  });

  it('uses Safari’s scheme on iOS 17 and later, and nothing before', () => {
    expect(externalBrowserUrl(share, detectInAppBrowser(UA.instagramIos)!)).toBe(
      `x-safari-${share}`,
    );
    expect(externalBrowserUrl(share, detectInAppBrowser(UA.facebookIos)!)).toBeNull();
  });

  it('keeps live-session links as they are', () => {
    const live = 'https://preprati.vercel.app/j/AbCdEfGhIjKlMnOpQrStUv?igsh=xyz';
    expect(externalBrowserUrl(live, detectInAppBrowser(UA.threadsIos)!)).toBe(`x-safari-${live}`);
  });
});

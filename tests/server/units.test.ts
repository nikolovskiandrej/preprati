import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseBytes, parseDuration } from '../../src/server/config';
import { isOriginAllowed } from '../../src/server/security/origin';
import { RateLimiter } from '../../src/server/security/rateLimiter';
import { iceServersFor } from '../../src/server/signaling/ice';
import { KeyedRwLock } from '../../src/server/util/keyedLock';

describe('config', () => {
  it('parses sizes and durations', () => {
    expect(parseBytes('512MiB')).toBe(512 * 1024 * 1024);
    expect(parseBytes('1 GB')).toBe(1e9);
    expect(parseBytes('1.5kb')).toBe(1500);
    expect(parseBytes('12parsecs')).toBeNull();
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('600')).toBe(600_000);
    expect(parseDuration('soon')).toBeNull();
  });

  it('has safe defaults for development', () => {
    const config = loadConfig({});
    expect(config.env).toBe('development');
    expect(config.host).toBe('127.0.0.1');
    expect(config.share.enabled).toBe(true);
    expect(config.share.driver).toBe('local');
    expect(config.sessions.pairingTtlMs).toBe(600_000);
    expect(config.share.ttlMs).toBe(86_400_000);
  });

  it('requires an explicit storage choice in production before enabling hosted sharing', () => {
    const config = loadConfig({ NODE_ENV: 'production' });
    expect(config.share.enabled).toBe(false);
    expect(config.share.unavailableReason).toBe('not-configured');
    expect(loadConfig({ NODE_ENV: 'production', STORAGE_DRIVER: 'local' }).share.enabled).toBe(
      true,
    );
    expect(loadConfig({ SHARE_ENABLED: 'false' }).share.unavailableReason).toBe('disabled');
  });

  it('rejects invalid or unsafe settings with a clear error', () => {
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(ConfigError);
    expect(() => loadConfig({ STORAGE_DRIVER: 'ftp' })).toThrow(ConfigError);
    expect(() => loadConfig({ STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    expect(() => loadConfig({ TURN_URLS: 'turn:turn.example.com' })).toThrow(/TURN_SECRET/);
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'not a url' })).toThrow(ConfigError);
    expect(() => loadConfig({ SHARE_STORAGE_QUOTA: '1MB', SHARE_MAX_PACKAGE_SIZE: '1GB' })).toThrow(
      /QUOTA/,
    );
  });
});

describe('rate limiter', () => {
  it('allows up to the limit per window and reports when to retry', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000, now: () => now });
    expect([1, 2, 3].map(() => limiter.consume('ip').allowed)).toEqual([true, true, true]);
    const blocked = limiter.consume('ip');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
    expect(limiter.consume('other-ip').allowed).toBe(true);
    now = 1001;
    expect(limiter.consume('ip').allowed).toBe(true);
  });

  it('bounds memory under a flood of distinct keys', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) limiter.consume(`ip-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });
});

describe('keyed readers/writer lock', () => {
  it('runs readers concurrently and writers exclusively', async () => {
    const lock = new KeyedRwLock();
    const log: string[] = [];
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await Promise.all([
      lock.read('k', async () => {
        log.push('r1-start');
        await delay(20);
        log.push('r1-end');
      }),
      lock.read('k', async () => {
        log.push('r2-start');
        await delay(20);
        log.push('r2-end');
      }),
      lock.write('k', async () => {
        log.push('w-start');
        await delay(5);
        log.push('w-end');
      }),
      lock.read('k', async () => {
        log.push('r3');
      }),
    ]);
    expect(log.slice(0, 2)).toEqual(['r1-start', 'r2-start']);
    expect(log.indexOf('w-start')).toBeGreaterThan(log.indexOf('r2-end'));
    expect(log.indexOf('r3')).toBeGreaterThan(log.indexOf('w-end')); // queued reader waits for the writer
    expect(lock.activeKeys).toBe(0);
  });

  it('releases the lock when the critical section throws', async () => {
    const lock = new KeyedRwLock();
    await expect(lock.write('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(lock.write('k', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('origin policy', () => {
  const config = {
    publicOrigin: 'https://preprati.example',
    allowedOrigins: ['https://cdn.example'],
  };
  it('allows same-host, configured and non-browser requests only', () => {
    expect(isOriginAllowed(undefined, 'x', config)).toBe(true);
    expect(isOriginAllowed('https://preprati.example', 'internal:8787', config)).toBe(true);
    expect(isOriginAllowed('https://cdn.example', 'x', config)).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', 'localhost:5173', config)).toBe(true);
    expect(isOriginAllowed('https://evil.example', 'preprati.example', config)).toBe(false);
    expect(isOriginAllowed('null', 'preprati.example', config)).toBe(false);
    expect(isOriginAllowed('chrome-extension://abc', 'abc', config)).toBe(false);
  });
});

describe('ICE configuration', () => {
  const base = loadConfig({ STUN_URLS: 'stun:stun.example.com:3478' }).ice;

  it('uses two free STUN providers by default, and no relay', () => {
    const config = loadConfig({});
    expect(config.ice.stunUrls).toEqual([
      'stun:stun.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ]);
    expect(config.ice.turn).toBeNull();
    expect(config.warnings).toEqual([]);
    expect(iceServersFor(config.ice, 'session')).toEqual([{ urls: config.ice.stunUrls }]);
  });

  it('can turn STUN off on purpose, and says what that means', () => {
    const config = loadConfig({ STUN_URLS: '' });
    expect(config.ice.stunUrls).toEqual([]);
    expect(iceServersFor(config.ice, 'session')).toEqual([]);
    expect(config.warnings).toEqual([expect.stringContaining('same network')]);
  });

  it('validates STUN and TURN URLs and removes duplicates', () => {
    expect(
      loadConfig({
        STUN_URLS: 'stun:a.example:3478, stun:a.example:3478 ,stuns:[2001:db8::1]:5349',
      }).ice.stunUrls,
    ).toEqual(['stun:a.example:3478', 'stuns:[2001:db8::1]:5349']);
    for (const bad of [
      'stun.l.google.com:19302',
      'http://stun.example',
      'stun:bad host',
      'stun:a.example:0',
      'stun:a.example:70000',
      'turn:t.example:3478',
      'stun:a.example?transport=udp',
      'stun:user@a.example',
    ]) {
      expect(() => loadConfig({ STUN_URLS: bad }), bad).toThrow(/STUN_URLS/);
    }
    expect(() => loadConfig({ STUN_URLS: 'stun:a:1,stun:b:1,stun:c:1,stun:d:1,stun:e:1' })).toThrow(
      /at most 4/,
    );
    expect(() =>
      loadConfig({ TURN_URLS: 'turn:t.example:3478?transport=sctp', TURN_SECRET: 'x' }),
    ).toThrow(/TURN_URLS/);
    expect(
      loadConfig({ TURN_URLS: 'turns:t.example:443?transport=tcp', TURN_SECRET: 'x' }).ice.turn
        ?.urls,
    ).toEqual(['turns:t.example:443?transport=tcp']);
  });

  it('offers STUN only when no relay is configured', () => {
    expect(iceServersFor(base, 'session')).toEqual([{ urls: ['stun:stun.example.com:3478'] }]);
  });

  it('issues short-lived TURN credentials derived from the shared secret', () => {
    const ice = loadConfig({
      TURN_URLS: 'turn:turn.example.com:3478',
      TURN_SECRET: 's3cret',
      TURN_CREDENTIAL_TTL: '1h',
    }).ice;
    const servers = iceServersFor(ice, 'abc', 1_000_000);
    const turn = servers.find((server) => String(server.urls).includes('turn:'))!;
    const [expiry, opaque] = turn.username!.split(':');
    expect(Number(expiry)).toBe(1000 + 3600);
    expect(opaque).not.toContain('abc'); // the session id is not exposed to the relay
    expect(turn.credential).toBe(
      createHmac('sha1', 's3cret').update(turn.username!).digest('base64'),
    );
    expect(JSON.stringify(servers)).not.toContain('s3cret');
  });
});

describe('Vercel function URL restoring', async () => {
  const { restoreUrl } = await import('../../src/server/vercel');
  it('recovers the original API path from a rewrite', () => {
    expect(restoreUrl('/api/index?__path=shares/abc/chunks/3')).toBe('/api/shares/abc/chunks/3');
    expect(restoreUrl('/api/index?__path=signal/poll&x=1')).toBe('/api/signal/poll?x=1');
    expect(restoreUrl('/api/index?__path=config')).toBe('/api/config');
  });
  it('keeps an original URL and only drops the helper parameter', () => {
    expect(restoreUrl('/api/shares/abc?__path=shares/abc')).toBe('/api/shares/abc');
    expect(restoreUrl('/api/health')).toBe('/api/health');
  });
  it('ignores path tricks', () => {
    expect(restoreUrl('/api/index?__path=../../etc/passwd')).toBe('/api/index');
    expect(restoreUrl('/api/index?__path=a%0d%0ab')).toBe('/api/index');
  });
});

import { rmSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the production build served by the real Node
 * backend (strict CSP, static serving, signaling, storage). Three servers run
 * side by side: one with production-like defaults, one with very short
 * expiry windows and small limits for expiry/limit scenarios, and one that
 * signals over HTTP polling like the serverless (Vercel) deployment.
 *
 *   npm run test:e2e        (builds first)
 */
export const MAIN_PORT = 4317;
export const SHORT_PORT = 4318;
export const HTTP_SIGNALING_PORT = 4319;
export const MAIN_STORAGE = path.resolve('test-results/e2e-storage/main');
export const SHORT_STORAGE = path.resolve('test-results/e2e-storage/short');
export const HTTP_SIGNALING_STORAGE = path.resolve('test-results/e2e-storage/http');

// Start every run from empty storage (runs before the web servers start).
rmSync(path.resolve('test-results/e2e-storage'), { recursive: true, force: true });

const common = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  SERVE_STATIC: 'true',
  STORAGE_DRIVER: 'local',
  LOG_LEVEL: 'warn',
  // Loopback connections need no STUN; avoids depending on the internet in CI.
  STUN_URLS: '',
  SHARE_CHUNK_SIZE: '1MiB',
  RATE_LIMIT_API: '100000',
  RATE_LIMIT_SHARE_CREATE: '1000',
  RATE_LIMIT_WS_CONNECT: '1000',
  RATE_LIMIT_JOIN_FAILURES: '1000',
  SESSION_MAX_PER_IP: '1000',
  WS_MAX_CONNECTIONS_PER_IP: '1000',
};

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 3,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${MAIN_PORT}`,
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: [
    {
      command: 'node dist/server/index.js',
      url: `http://127.0.0.1:${MAIN_PORT}/api/health`,
      reuseExistingServer: false,
      env: { ...common, PORT: String(MAIN_PORT), STORAGE_DIR: MAIN_STORAGE },
    },
    {
      command: 'node dist/server/index.js',
      url: `http://127.0.0.1:${SHORT_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        ...common,
        PORT: String(SHORT_PORT),
        STORAGE_DIR: SHORT_STORAGE,
        SHARE_TTL: '8s',
        SESSION_PAIRING_TTL: '4s',
        CLEANUP_INTERVAL: '1s',
        SHARE_MAX_FILE_SIZE: '1MB',
        SHARE_MAX_PACKAGE_SIZE: '2MB',
        SHARE_MAX_FILES: '3',
      },
    },
    {
      command: 'node dist/server/index.js',
      url: `http://127.0.0.1:${HTTP_SIGNALING_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        ...common,
        PORT: String(HTTP_SIGNALING_PORT),
        STORAGE_DIR: HTTP_SIGNALING_STORAGE,
        SIGNALING_TRANSPORT: 'http',
        KV_DRIVER: 'memory',
      },
    },
  ],
});

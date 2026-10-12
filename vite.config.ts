import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Frontend build + dev server.
 *
 * - `npm run dev` serves the SPA on :5173 and proxies `/api` + `/ws` to the
 *   Node backend on :8787 (see src/server).
 * - `npm run dev:lan` additionally serves over HTTPS with a self-signed
 *   certificate on all interfaces, so phones on the same network can test
 *   features that require a secure context (Web Crypto, Clipboard).
 */
export default defineConfig(({ mode }) => {
  const lan = mode === 'lan';
  const backend = process.env.PREPRATI_DEV_BACKEND ?? 'http://localhost:8787';

  return {
    plugins: [react(), ...(lan ? [basicSsl()] : [])],
    server: {
      port: 5173,
      strictPort: true,
      host: lan ? true : 'localhost',
      proxy: {
        '/api': { target: backend, changeOrigin: false },
        '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
      },
    },
    preview: {
      port: 4173,
    },
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
      sourcemap: false,
      assetsInlineLimit: 2048,
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.{ts,tsx}'],
      setupFiles: ['tests/setup.ts'],
      restoreMocks: true,
      testTimeout: 20_000,
    },
  };
});

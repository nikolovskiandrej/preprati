import { render } from '@testing-library/react';
import { LazyMotion, MotionConfig, domMax } from 'motion/react';
import type { ReactNode } from 'react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ConfigProvider } from '../../src/client/app/config';
import { ThemeProvider } from '../../src/client/app/theme';
import { I18nProvider, type Locale } from '../../src/client/i18n';
import type { PublicConfig } from '../../src/shared/shareApi';
import { ToastProvider } from '../../src/client/ui/Toast';

export const testConfig: PublicConfig = {
  version: 'test',
  quickTransfer: { pairingTtlSeconds: 600, relayConfigured: false, signaling: 'websocket' },
  share: {
    enabled: true,
    ttlSeconds: 86_400,
    maxFileBytes: 1e9,
    maxPackageBytes: 1e9,
    maxFiles: 100,
    chunkBytes: 4 * 1024 * 1024,
  },
  attribution: { url: null },
};

export function renderWithProviders(
  ui: ReactNode,
  { path = '/', locale }: { path?: string; locale?: Locale } = {},
) {
  const location = memoryLocation({ path, record: true });
  const result = render(
    <LazyMotion features={domMax}>
      <MotionConfig reducedMotion="always">
        <I18nProvider locale={locale}>
          <ThemeProvider>
            <ConfigProvider initial={testConfig}>
              <ToastProvider>
                <Router hook={location.hook}>{ui}</Router>
              </ToastProvider>
            </ConfigProvider>
          </ThemeProvider>
        </I18nProvider>
      </MotionConfig>
    </LazyMotion>,
  );
  return { ...result, location };
}

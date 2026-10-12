import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { newDevice } from './helpers';

const VIEWPORTS = [
  { name: 'phone-small', width: 360, height: 640, mobile: true },
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'phone-landscape', width: 844, height: 390, mobile: true },
  { name: 'tablet', width: 768, height: 1024, mobile: true },
  { name: 'tablet-landscape', width: 1024, height: 768, mobile: true },
  { name: 'laptop', width: 1280, height: 800, mobile: false },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
];

const PAGES = [
  { path: '/', ready: (page: Page) => page.getByRole('heading', { level: 1 }) },
  { path: '/receive', ready: (page: Page) => page.getByTestId('pairing-code') },
  { path: '/send', ready: (page: Page) => page.getByRole('button', { name: 'Choose files' }) },
  { path: '/share', ready: (page: Page) => page.getByRole('button', { name: 'Choose files' }) },
  { path: '/join', ready: (page: Page) => page.getByRole('button', { name: 'Connect' }) },
  {
    path: '/s/AAAAAAAAAAAAAAAAAAAAAA#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ready: (page: Page) => page.getByRole('heading', { level: 1 }),
  },
];

for (const viewport of VIEWPORTS) {
  test(`layout holds at ${viewport.name} (${viewport.width}×${viewport.height})`, async ({
    browser,
  }) => {
    const device = await newDevice(browser, {
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.mobile,
      hasTouch: viewport.mobile,
    });
    for (const { path, ready } of PAGES) {
      await device.page.goto(path);
      await expect(ready(device.page)).toBeVisible();
      const metrics = await device.page.evaluate(() => {
        const offenders = [...document.querySelectorAll('body *')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && (rect.right > window.innerWidth + 0.5 || rect.left < -0.5);
          })
          .filter((el) => !el.closest('.visually-hidden'))
          .slice(0, 5)
          .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`);
        const qr = document.querySelector('[data-testid="qr-code"]')?.getBoundingClientRect();
        const buttons = [...document.querySelectorAll('button, a[href]')]
          .map((el) => el.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0);
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          offenders,
          qrSize: qr ? Math.round(qr.width) : null,
          smallestTarget: Math.min(...buttons.map((rect) => Math.min(rect.width, rect.height))),
        };
      });
      expect(metrics.overflow, `${path} horizontal overflow`).toBeLessThanOrEqual(0);
      expect(metrics.offenders, `${path} elements outside the viewport`).toEqual([]);
      if (metrics.qrSize !== null)
        expect(metrics.qrSize, `${path} QR size`).toBeGreaterThanOrEqual(180);
      if (viewport.mobile)
        expect(metrics.smallestTarget, `${path} touch target`).toBeGreaterThanOrEqual(38);
      await device.page.screenshot({
        path: `test-results/screens/${viewport.name}${path.replace(/[^a-z]+/gi, '-')}.png`,
        fullPage: true,
      });
    }
    expect(device.problems).toEqual([]);
    await device.context.close();
  });
}

test.describe('accessibility', () => {
  for (const path of ['/', '/send', '/receive', '/share', '/join']) {
    test(`${path} has no serious accessibility violations`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (path === '/receive') await expect(page.getByTestId('pairing-code')).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const serious = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(
        serious.map(
          (v) =>
            `${v.id}: ${v.nodes
              .map((n) => n.target.join(' '))
              .slice(0, 3)
              .join(', ')}`,
        ),
      ).toEqual([]);
    });
  }

  test('dark mode keeps contrast', async ({ browser }) => {
    const { page, context } = await newDevice(browser, { colorScheme: 'dark' });
    for (const path of ['/', '/share']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze();
      expect(
        results.violations.filter((v) => v.id === 'color-contrast').map((v) => v.nodes.length),
      ).toEqual([]);
    }
    await context.close();
  });

  test('the main flows work with the keyboard alone', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.getByRole('link', { name: 'Receive files' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('pairing-code')).toBeVisible();
    await page.getByTestId('copy-link').focus();
    await expect(page.getByTestId('copy-link')).toBeFocused();
  });
});

test('the startup animation resolves into the interface quickly', async ({ page }) => {
  await page.goto('/?intro');
  const overlay = page.locator('[role="presentation"]').filter({ hasText: 'preprati. is loading' });
  await expect(overlay).toBeAttached();
  await expect(overlay).toHaveCount(0, { timeout: 2500 });
  await expect(page.getByRole('link', { name: 'preprati. — Home' })).toBeVisible();
});

test('reduced motion skips the startup animation', async ({ browser }) => {
  const { page, context } = await newDevice(browser, { reducedMotion: 'reduce' });
  await page.goto('/?intro');
  await expect(
    page.locator('[role="presentation"]').filter({ hasText: 'preprati. is loading' }),
  ).toHaveCount(0);
  await context.close();
});

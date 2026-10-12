// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../../src/client/app/AppShell';
import { shouldPlayIntro } from '../../src/client/brand/IntroSplash';
import { HomeScreen } from '../../src/client/screens/HomeScreen';
import { renderWithProviders } from './render';

describe('Home', () => {
  it('shows the brand, the headline and both transfer modes', () => {
    renderWithProviders(
      <AppShell introActive={false}>
        <HomeScreen />
      </AppShell>,
    );
    // The logo links home and is named with the exact wordmark.
    expect(screen.getByRole('link', { name: 'preprati. — Home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('From here to there.');
    expect(
      screen.getByText(/No accounts\. No installations\. Just transfer\./),
    ).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Quick Transfer' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Share Files' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Send files' })).toHaveAttribute('href', '/send');
    expect(screen.getByRole('link', { name: 'Receive files' })).toHaveAttribute('href', '/receive');
    expect(screen.getByRole('link', { name: 'Create a share link' })).toHaveAttribute(
      'href',
      '/share',
    );
    expect(screen.getByText(/kept for 24 hours/)).toBeInTheDocument();
    expect(screen.getByText('Made by')).toBeInTheDocument();
  });

  it('validates pairing codes and navigates to the join page', async () => {
    const user = userEvent.setup();
    const { location } = renderWithProviders(<HomeScreen />);
    const input = screen.getByLabelText('Have a pairing code?');
    await user.type(input, 'nope');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(screen.getByText(/Codes have 6 letters or digits/)).toHaveAttribute('role', 'alert');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    await user.clear(input);
    await user.type(input, 'k7m-4qx');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(location.history?.at(-1)).toBe('/j/K7M4QX');
  });

  it('switches the whole interface to Macedonian, keeping the Latin wordmark', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AppShell introActive={false}>
        <HomeScreen />
      </AppShell>,
    );
    await user.click(screen.getByRole('button', { name: /Македонски/ }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Од тука до таму.');
    expect(screen.getByRole('link', { name: 'Испрати датотеки' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'preprati. — Почетна' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('mk');
    const languages = screen.getByRole('group', { name: 'Јазик' });
    expect(within(languages).getByRole('button', { name: /Македонски/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('startup intro', () => {
  it('plays only on the home page and not for deep links', () => {
    expect(shouldPlayIntro({ pathname: '/s/abc', search: '' })).toBe(false);
    expect(shouldPlayIntro({ pathname: '/j/abc', search: '' })).toBe(false);
    expect(shouldPlayIntro({ pathname: '/', search: '?intro' })).toBe(true);
  });
});

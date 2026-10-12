import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Logo } from '../brand/Logo';
import { NoteaAttribution } from '../brand/NoteaAttribution';
import { MoonIcon, SunIcon } from '../icons';
import { LOCALES, useI18n } from '../i18n';
import { useConfig } from './config';
import { useTheme } from './theme';
import styles from './AppShell.module.css';

export function AppShell({ children, introActive }: { children: ReactNode; introActive: boolean }) {
  const { t, locale, setLocale } = useI18n();
  const { theme, toggle } = useTheme();
  const { config } = useConfig();

  return (
    <div className={styles.app}>
      <a href="#main" className={styles.skip}>
        {t('common.skipToContent')}
      </a>
      <header className={styles.header}>
        <Link
          href="/"
          className={styles.home}
          aria-label={`${t('common.brand')} — ${t('common.home')}`}
        >
          {introActive ? (
            <span className={styles.logoPlaceholder} aria-hidden="true">
              <Logo />
            </span>
          ) : (
            <Logo layoutId="brand-lockup" />
          )}
        </Link>
        <div className={styles.controls}>
          <div className={styles.locales} role="group" aria-label={t('common.language')}>
            {LOCALES.map((option) => (
              <button
                key={option.id}
                type="button"
                className={styles.locale}
                aria-pressed={locale === option.id}
                lang={option.id}
                title={option.name}
                onClick={() => setLocale(option.id)}
              >
                <span aria-hidden="true">{option.label}</span>
                <span className="visually-hidden">{option.name}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className={styles.theme}
            onClick={toggle}
            aria-label={theme === 'dark' ? t('common.themeLight') : t('common.themeDark')}
          >
            {theme === 'dark' ? <SunIcon size={20} /> : <MoonIcon size={20} />}
          </button>
        </div>
      </header>
      <main id="main" className={styles.main} tabIndex={-1}>
        {children}
      </main>
      <footer className={styles.footer}>
        <NoteaAttribution url={config?.attribution.url ?? null} />
      </footer>
    </div>
  );
}

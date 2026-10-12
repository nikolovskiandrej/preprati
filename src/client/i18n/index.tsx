/**
 * Localization: English (default) and Macedonian. The chosen locale is
 * remembered per browser; translation keys are type-checked.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en, type Messages } from './en';
import { formatMessage, type MessageValues } from './format';
import { mk } from './mk';

export type Locale = 'en' | 'mk';
export const LOCALES: Array<{ id: Locale; label: string; name: string }> = [
  { id: 'en', label: 'EN', name: 'English' },
  { id: 'mk', label: 'MK', name: 'Македонски' },
];

const CATALOGS: Record<Locale, Messages> = { en, mk };
const STORAGE_KEY = 'preprati.locale';

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<Messages>;

export type Translate = (key: MessageKey, values?: MessageValues) => string;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function lookup(catalog: Messages, key: string): string {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  return typeof node === 'string' ? node : key;
}

/** The saved choice, else the browser's first supported language, else English. */
export function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'mk') return stored;
  } catch {
    // ignore unavailable storage
  }
  const preferred =
    typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  for (const tag of preferred) {
    const language = tag?.toLowerCase().split('-')[0];
    if (language === 'mk' || language === 'en') return language;
  }
  return 'en';
}

export function createTranslator(locale: Locale): Translate {
  const catalog = CATALOGS[locale];
  return (key, values) => formatMessage(lookup(catalog, key), values, locale);
}

export function I18nProvider({
  children,
  locale: forced,
}: {
  children: ReactNode;
  locale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => forced ?? initialLocale());

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore unavailable storage
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = lookup(CATALOGS[locale], 'meta.title');
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', lookup(CATALOGS[locale], 'meta.description'));
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: createTranslator(locale) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { en } from '../../src/client/i18n/en';
import { formatMessage } from '../../src/client/i18n/format';
import { mk } from '../../src/client/i18n/mk';

function leaves(node: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of leaves(value, path)) out.set(k, v);
  }
  return out;
}

const placeholders = (message: string) =>
  [...new Set([...message.matchAll(/\{(\w+)(?=\}|,\s*plural)/g)].map((match) => match[1]))].sort();

describe('localization', () => {
  const english = leaves(en);
  const macedonian = leaves(mk);

  it('has a Macedonian string for every English key and nothing extra', () => {
    expect([...macedonian.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it('uses the same placeholders in both languages', () => {
    for (const [key, value] of english) {
      expect(placeholders(macedonian.get(key)!), key).toEqual(placeholders(value));
    }
  });

  it('never translates or recases the wordmark', () => {
    for (const value of [...english.values(), ...macedonian.values()]) {
      expect(value).not.toMatch(/Preprati|PREPRATI|Препрати/);
    }
    expect(mk.common.brand).toBe('preprati.');
  });

  it('formats plurals with locale rules (Macedonian 21 → singular form)', () => {
    expect(formatMessage(en.common.files, { count: 1 }, 'en')).toBe('1 file');
    expect(formatMessage(en.common.files, { count: 3 }, 'en')).toBe('3 files');
    expect(formatMessage(mk.common.files, { count: 1 }, 'mk')).toBe('1 датотека');
    expect(formatMessage(mk.common.files, { count: 5 }, 'mk')).toBe('5 датотеки');
    expect(formatMessage(mk.common.files, { count: 21 }, 'mk')).toBe('21 датотека');
  });

  it('substitutes placeholders inside plural branches', () => {
    const result = formatMessage(
      mk.share.confirmBody,
      { count: 1, size: '2 MB', date: '12 окт.', ttl: '24 часа' },
      'mk',
    );
    expect(result).toBe(
      '1 датотека (2 MB) ќе се шифрира во овој прелистувач и ќе се чува до 12 окт. (24 часа).',
    );
    expect(formatMessage('Hello {name}', { name: 'Ana' })).toBe('Hello Ana');
    expect(formatMessage('Keep {missing}', {})).toBe('Keep {missing}');
  });
});

describe('initial language', () => {
  const setLanguages = (languages: string[]) =>
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);

  it('follows the browser when nothing is saved', async () => {
    const { initialLocale } = await import('../../src/client/i18n');
    setLanguages(['mk-MK', 'en-US']);
    expect(initialLocale()).toBe('mk');
    setLanguages(['de-DE', 'en-GB', 'mk']);
    expect(initialLocale()).toBe('en');
    setLanguages(['fr-FR']);
    expect(initialLocale()).toBe('en');
  });

  it('prefers the saved choice', async () => {
    const { initialLocale } = await import('../../src/client/i18n');
    setLanguages(['mk-MK']);
    localStorage.setItem('preprati.locale', 'en');
    try {
      expect(initialLocale()).toBe('en');
    } finally {
      localStorage.removeItem('preprati.locale');
    }
  });
});

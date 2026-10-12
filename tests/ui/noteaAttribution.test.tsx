// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoteaAttribution } from '../../src/client/brand/NoteaAttribution';
import { renderWithProviders } from './render';

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(path.resolve('src/client/assets', file));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('Notea attribution', () => {
  it.each([
    ['light', 'notea-logo.png'],
    ['dark', 'notea-logo-on-dark.png'],
  ] as const)('on %s shows %s at its own pixel size', (theme, file) => {
    const { container } = renderWithProviders(<NoteaAttribution url={null} theme={theme} />);
    const logo = container.querySelector('img');
    expect(logo?.getAttribute('src')).toMatch(new RegExp(`/${file.replace('.', '\\.')}$`));
    const { width, height } = pngSize(file);
    expect(logo).toHaveAttribute('width', String(width));
    expect(logo).toHaveAttribute('height', String(height));
    expect(logo).toHaveAttribute('alt', '');
  });

  it('keeps both marks at the original Notea proportions', () => {
    const light = pngSize('notea-logo.png');
    expect(pngSize('notea-logo-on-dark.png')).toEqual(light);
    expect(light.width / light.height).toBeCloseTo(1.354, 2);
  });
});

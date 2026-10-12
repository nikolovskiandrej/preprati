import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { createQrModel, finderPath, QR_QUIET_ZONE } from '../../src/client/lib/qr';

/** Rasterizes the QR model exactly as the app draws it (finder patterns as solid rings). */
function rasterize(text: string, scale = 8) {
  const model = createQrModel(text);
  const size = model.extent * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  const setDark = (row: number, col: number) => {
    for (let y = row * scale; y < (row + 1) * scale; y++) {
      for (let x = col * scale; x < (col + 1) * scale; x++) {
        const i = (y * size + x) * 4;
        pixels[i] = 0x25;
        pixels[i + 1] = 0x25;
        pixels[i + 2] = 0x25;
      }
    }
  };
  for (let row = 0; row < model.size; row++) {
    for (let col = 0; col < model.size; col++) {
      if (model.isDark(row, col)) setDark(row + QR_QUIET_ZONE, col + QR_QUIET_ZONE);
    }
  }
  return { model, size, pixels };
}

describe('QR codes', () => {
  it('encode full share links (with key fragment) that decode back exactly', () => {
    const url =
      'https://preprati.example/s/5pgLrIf4xQB56QlE8eMTqw#tWTkAHIBK-HXqtWAzP0fOw1RugbDlbZcAWgSq2qVoT0';
    const { size, pixels, model } = rasterize(url);
    const decoded = jsQR(pixels, size, size);
    expect(decoded?.data).toBe(url);
    // Medium error correction keeps the symbol small enough to scan from a screen.
    expect(model.size).toBeLessThanOrEqual(53);
  });

  it('encode session links', () => {
    const url = 'http://192.168.1.20:5173/j/xgUOc56aPb68hBFB5Ea5DA';
    const { size, pixels } = rasterize(url);
    expect(jsQR(pixels, size, size)?.data).toBe(url);
  });

  it('keeps a 4-module quiet zone and excludes finder patterns from the module path', () => {
    const model = createQrModel('https://example.com');
    expect(model.extent).toBe(model.size + 2 * QR_QUIET_ZONE);
    expect(model.finders).toHaveLength(3);
    expect(model.finders[0]).toEqual({ x: QR_QUIET_ZONE, y: QR_QUIET_ZONE });
    expect(finderPath(4, 4)).toMatch(/^M/);
  });
});

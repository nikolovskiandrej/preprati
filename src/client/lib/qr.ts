/**
 * QR codes for session links and share links.
 *
 * Rendering keeps scannability first: dark charcoal modules on pure white,
 * a 4-module quiet zone, medium error correction, and only the three finder
 * patterns get softly rounded corners. The same geometry is used for the
 * on-screen SVG and for the exported PNG.
 */
import qrcode from 'qrcode-generator';
import {
  COMPACT_PLANE,
  COMPACT_PLANE_ROUNDING,
  COMPACT_STROKE,
  COMPACT_TRAIL,
  WORDMARK_DOT,
  WORDMARK_HEIGHT,
  WORDMARK_LETTERS,
  WORDMARK_SOFTEN,
  WORDMARK_WIDTH,
} from '../brand/geometry';

export const QR_QUIET_ZONE = 4;
const FINDER = 7;

export interface QrModel {
  /** Number of modules per side (without quiet zone). */
  size: number;
  /** Side length including the quiet zone on both sides. */
  extent: number;
  /** Data modules (finder patterns excluded) as one SVG path, offset by the quiet zone. */
  modulesPath: string;
  /** Top-left corners of the three finder patterns, offset by the quiet zone. */
  finders: Array<{ x: number; y: number }>;
  isDark(row: number, col: number): boolean;
}

export function createQrModel(text: string, errorCorrection: 'L' | 'M' | 'Q' | 'H' = 'M'): QrModel {
  const qr = qrcode(0, errorCorrection);
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const isFinder = (row: number, col: number) =>
    (row < FINDER && col < FINDER) ||
    (row < FINDER && col >= size - FINDER) ||
    (row >= size - FINDER && col < FINDER);

  let path = '';
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (qr.isDark(row, col) && !isFinder(row, col)) {
        const start = col;
        while (col < size && qr.isDark(row, col) && !isFinder(row, col)) col++;
        path += `M${start + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h${col - start}v1h-${col - start}z`;
      } else {
        col++;
      }
    }
  }
  return {
    size,
    extent: size + QR_QUIET_ZONE * 2,
    modulesPath: path,
    finders: [
      { x: QR_QUIET_ZONE, y: QR_QUIET_ZONE },
      { x: QR_QUIET_ZONE + size - FINDER, y: QR_QUIET_ZONE },
      { x: QR_QUIET_ZONE, y: QR_QUIET_ZONE + size - FINDER },
    ],
    isDark: (row, col) => qr.isDark(row, col),
  };
}

/** SVG path for one finder pattern (outer ring + center) using even-odd fill. */
export function finderPath(x: number, y: number): string {
  const ring = roundedRectPath(x, y, 7, 7, 1.9) + roundedRectPath(x + 1, y + 1, 5, 5, 1.15);
  const eye = roundedRectPath(x + 2, y + 2, 3, 3, 0.85);
  return ring + eye;
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}` +
    `h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`
  );
}

/* -------------------------------------------------------------------------- */
/* PNG export                                                                 */
/* -------------------------------------------------------------------------- */

export interface QrImageOptions {
  url: string;
  /** Main caption under the logo, e.g. "Scan to download shared files". */
  title: string;
  /** Secondary line, e.g. "Expires Oct 12, 14:30 · 3 files". */
  subtitle?: string;
}

const CREAM = '#FFF7ED';
const CHARCOAL = '#252525';
const TANGERINE = '#F97316';
const MUTED = '#6E655E';
const FONT_FAMILY =
  '"Manrope Variable", "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * Renders a branded, high-resolution PNG (1080px wide) suitable for pasting
 * into messaging apps. The QR sits on white with a full quiet zone; branding
 * and captions are placed outside it so they never interfere with scanning.
 */
export async function renderQrPng(options: QrImageOptions): Promise<Blob> {
  const model = createQrModel(options.url);
  const width = 1080;
  const pad = 72;
  const card = width - pad * 2;
  const module = Math.floor(card / model.extent);
  const qrPixels = module * model.extent;
  const qrOffset = pad + Math.floor((card - qrPixels) / 2);
  const height = pad + card + 64 + 76 + 36 + 52 + (options.subtitle ? 44 : 0) + pad;

  await ensureFontsLoaded();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');

  // Background and white QR card.
  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#FFFFFF';
  fillRoundRect(ctx, pad, pad, card, card, 44);

  // QR modules.
  ctx.save();
  ctx.translate(qrOffset, qrOffset);
  ctx.scale(module, module);
  ctx.fillStyle = CHARCOAL;
  ctx.fill(new Path2D(model.modulesPath));
  for (const finder of model.finders)
    ctx.fill(new Path2D(finderPath(finder.x, finder.y)), 'evenodd');
  ctx.restore();

  // Brand lockup: compact mark + wordmark, centered.
  let y = pad + card + 64;
  const wordHeight = 64;
  const wordScale = wordHeight / WORDMARK_HEIGHT;
  const wordWidth = WORDMARK_WIDTH * wordScale;
  const markSize = 84;
  const gap = 14;
  const lockupWidth = markSize + gap + wordWidth;
  let x = (width - lockupWidth) / 2;

  ctx.save();
  ctx.translate(x, y - 14);
  ctx.scale(markSize / 128, markSize / 128);
  ctx.fillStyle = TANGERINE;
  ctx.strokeStyle = TANGERINE;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const plane = new Path2D(COMPACT_PLANE);
  ctx.lineWidth = COMPACT_PLANE_ROUNDING;
  ctx.fill(plane);
  ctx.stroke(plane);
  ctx.lineWidth = COMPACT_STROKE;
  ctx.stroke(new Path2D(COMPACT_TRAIL));
  ctx.restore();

  x += markSize + gap;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(wordScale, wordScale);
  ctx.fillStyle = CHARCOAL;
  ctx.strokeStyle = CHARCOAL;
  ctx.lineJoin = 'round';
  ctx.lineWidth = WORDMARK_SOFTEN;
  const letters = new Path2D(WORDMARK_LETTERS);
  ctx.fill(letters);
  ctx.stroke(letters);
  ctx.fillStyle = TANGERINE;
  ctx.fill(new Path2D(WORDMARK_DOT));
  ctx.restore();

  // Captions.
  y += wordHeight + 36 + 40;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = CHARCOAL;
  ctx.font = `700 40px ${FONT_FAMILY}`;
  ctx.fillText(fitText(ctx, options.title, card), width / 2, y);
  if (options.subtitle) {
    y += 52;
    ctx.fillStyle = MUTED;
    ctx.font = `500 32px ${FONT_FAMILY}`;
    ctx.fillText(fitText(ctx, options.subtitle, card), width / 2, y);
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))),
      'image/png',
    );
  });
}

async function ensureFontsLoaded(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load(`700 40px ${FONT_FAMILY}`),
      document.fonts.load(`500 32px ${FONT_FAMILY}`),
    ]);
  } catch {
    // Fall back to system fonts; the QR itself does not depend on them.
  }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth)
    trimmed = trimmed.slice(0, -1);
  return `${trimmed}…`;
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  ctx.fill();
}

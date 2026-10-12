/**
 * File helpers shared by Quick Transfer and Share Files: classification for
 * icons, safe file names for downloads/zips, and dangerous-type handling.
 */
export type FileKind = 'image' | 'video' | 'audio' | 'archive' | 'document' | 'file';

const ARCHIVE_EXT = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|iso|dmg)$/i;
const DOCUMENT_EXT =
  /\.(pdf|docx?|odt|rtf|txt|md|pages|xlsx?|ods|csv|pptx?|odp|key|numbers|epub)$/i;

export function fileKind(name: string, type: string): FileKind {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (ARCHIVE_EXT.test(name) || /zip|compressed|x-tar|x-7z/.test(type)) return 'archive';
  if (DOCUMENT_EXT.test(name) || type.startsWith('text/') || type === 'application/pdf')
    return 'document';
  return 'file';
}

/** Raster images that are safe to preview inline (never SVG, which can carry script). */
export function isPreviewableImage(type: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(type);
}

/**
 * Turns an untrusted name (from a peer or a decrypted manifest) into a safe
 * download / zip entry name: no path separators or traversal, no control
 * characters, no reserved device names, bounded length.
 */
export function sanitizeFileName(raw: string, fallback = 'file'): string {
  let name = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = `_${name}`;
  if (name.length === 0) name = fallback;
  if (name.length > 200) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

/** Makes names unique within a list ("a.txt", "a (2).txt") for zip archives. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const key = name.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = `${base} (${count + 1})${ext}`;
    while (seen.has(candidate.toLowerCase())) candidate = `${base} (${count + 2})${ext}`;
    seen.set(candidate.toLowerCase(), 1);
    return candidate;
  });
}

/** Sum of file sizes. */
export function totalSize(files: ReadonlyArray<{ size: number }>): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

/** A file chosen in the UI, with a stable id for keys and removal. */
export interface SelectedFile {
  id: string;
  file: File;
}

let counter = 0;
/** Stable client-side identifier for a selected File (for React keys and removal). */
export function localFileId(): string {
  counter += 1;
  return `f${Date.now().toString(36)}${counter.toString(36)}`;
}

/**
 * Clipboard helpers that report what actually happened. Copying an image is
 * attempted with the async Clipboard API; when it is unavailable or denied the
 * caller receives `{ ok: false }` and must offer the PNG download instead —
 * we never silently copy a URL while claiming an image was copied.
 */
export type CopyResult = { ok: true } | { ok: false; reason: 'unsupported' | 'denied' | 'failed' };

export function canCopyImage(): boolean {
  if (typeof window === 'undefined' || !window.isSecureContext) return false;
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
  const supports = (ClipboardItem as unknown as { supports?: (type: string) => boolean }).supports;
  return typeof supports === 'function' ? supports.call(ClipboardItem, 'image/png') : true;
}

/**
 * Copies a PNG to the clipboard. `png` may be a promise: Safari requires the
 * ClipboardItem to be created synchronously inside the user gesture, with the
 * data provided asynchronously.
 */
export async function copyImage(png: Blob | Promise<Blob>): Promise<CopyResult> {
  if (!canCopyImage()) return { ok: false, reason: 'unsupported' };
  try {
    const item = new ClipboardItem({ 'image/png': png });
    await navigator.clipboard.write([item]);
    return { ok: true };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    return { ok: false, reason: name === 'NotAllowedError' ? 'denied' : 'failed' };
  }
}

export async function copyText(text: string): Promise<CopyResult> {
  if (typeof window !== 'undefined' && window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === 'NotAllowedError')
        return legacyCopy(text) ? { ok: true } : { ok: false, reason: 'denied' };
    }
  }
  return legacyCopy(text) ? { ok: true } : { ok: false, reason: 'unsupported' };
}

/** Fallback for insecure contexts (e.g. testing over plain HTTP on a LAN). */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

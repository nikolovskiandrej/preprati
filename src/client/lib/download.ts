/**
 * Saving blobs to the user's device. Object URLs are revoked once the browser
 * has had time to start the download, so nothing leaks.
 *
 * Downloads always use a generic binary type: a peer-supplied or decrypted
 * MIME type (e.g. text/html) must never turn a same-origin blob URL into a
 * page that the browser renders.
 */
export function saveBlob(blob: Blob, fileName: string): void {
  const safe =
    blob.type === 'application/octet-stream'
      ? blob
      : blob.slice(0, blob.size, 'application/octet-stream');
  const url = URL.createObjectURL(safe);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * What saving a file is known to have done: `requested` — the browser was
 * asked to download it (browsers don't say whether that worked, so the
 * interface must not claim the file was saved); `shared` — the person
 * finished the system share sheet ("Save to Files", "Save image"…);
 * `cancelled` — they closed it.
 */
export type SaveOutcome = 'requested' | 'shared' | 'cancelled';

/**
 * Saves a received file. Call it straight from a click: downloads and the
 * share sheet both need the user's gesture. With `preferShare` (an app's
 * built-in browser, where downloads go nowhere) it uses the system share
 * sheet when that can take files, and a regular download otherwise.
 */
export async function saveFile(
  blob: Blob,
  name: string,
  { type = '', preferShare = false }: { type?: string; preferShare?: boolean } = {},
): Promise<SaveOutcome> {
  if (preferShare) {
    const file = new File([blob], name, { type: type || 'application/octet-stream' });
    if (canShareFiles([file])) {
      try {
        await navigator.share({ files: [file] });
        return 'shared';
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') return 'cancelled';
        // The share sheet refused (e.g. the gesture expired): try a download instead.
      }
    }
  }
  saveBlob(blob, name);
  return 'requested';
}

/**
 * Whether the page may still act on the user's latest tap (open a share sheet,
 * start a download). Unknown (older browsers) counts as no, so callers show
 * an explicit "Save" button rather than save silently into nothing.
 */
export function hasUserActivation(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
    .userActivation;
  return activation?.isActive === true;
}

/** Whether the Web Share API can share files (mobile Safari/Chrome, some desktops). */
export function canShareFiles(files: File[]): boolean {
  try {
    return (
      typeof navigator !== 'undefined' && !!navigator.canShare && navigator.canShare({ files })
    );
  } catch {
    return false;
  }
}

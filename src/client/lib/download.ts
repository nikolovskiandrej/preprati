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

/**
 * Remembers shares created in this browser so their owner can delete them
 * later, even after closing the tab. Only the share id, owner token and
 * non-sensitive numbers are stored — never the decryption key or file names.
 * localStorage may be unavailable (private mode); every access is guarded.
 */
const STORAGE_KEY = 'preprati.ownedShares.v1';

export interface OwnedShare {
  id: string;
  ownerToken: string;
  createdAt: number;
  expiresAt: number;
  fileCount: number;
  totalBytes: number;
}

function read(): OwnedShare[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is OwnedShare =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as OwnedShare).id === 'string' &&
        typeof (entry as OwnedShare).ownerToken === 'string' &&
        typeof (entry as OwnedShare).expiresAt === 'number',
    );
  } catch {
    return [];
  }
}

function write(entries: OwnedShare[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable: deletion will only be possible while this page stays open.
  }
}

/** Active (unexpired) shares, newest first. Expired entries are pruned. */
export function listOwnedShares(now = Date.now()): OwnedShare[] {
  const all = read();
  const active = all.filter((entry) => entry.expiresAt > now);
  if (active.length !== all.length) write(active);
  return active.sort((a, b) => b.createdAt - a.createdAt);
}

export function rememberOwnedShare(share: OwnedShare): void {
  write([share, ...read().filter((entry) => entry.id !== share.id)].slice(0, 50));
}

export function forgetOwnedShare(id: string): void {
  write(read().filter((entry) => entry.id !== id));
}

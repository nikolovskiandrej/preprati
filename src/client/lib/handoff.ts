/**
 * Carries a file selection from a Quick Transfer that couldn't connect to
 * Share Files ("Send as a link instead"), so the files don't have to be
 * chosen again. In memory only: it survives the in-app navigation, not a
 * reload.
 */
let handedOff: File[] = [];

export function handOffFiles(files: File[]): void {
  handedOff = [...files];
}

/** The files handed off, if any; they stay until `clearHandedOffFiles` is called. */
export function handedOffFiles(): File[] {
  return handedOff;
}

export function clearHandedOffFiles(): void {
  handedOff = [];
}

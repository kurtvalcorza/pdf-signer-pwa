/**
 * Trigger a client-side download of raw bytes. No network (Principle I).
 *
 * Keep the download on `HTMLAnchorElement.prototype.click()`: dist/ is shared by every
 * distribution, and the Android shell (android/app/src/main/assets/shell/shell.js) intercepts
 * blob: downloads only through that method. A dispatched MouseEvent, or a link the user clicks,
 * would bypass it, and the save would silently do nothing on Android.
 */
export function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.click();
  } finally {
    // Revoke on a later tick (not synchronously): revoking right after click can
    // cancel the download before the browser has read the blob, notably on
    // mobile/Firefox. The `finally` still guarantees revocation if click() throws.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** Trigger a client-side download of PDF bytes. */
export function downloadPdf(bytes: Uint8Array, filename: string): void {
  downloadBytes(bytes, filename.endsWith('.pdf') ? filename : `${filename}.pdf`, 'application/pdf');
}

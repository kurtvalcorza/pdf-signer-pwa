// Bridge to the desktop shell's persistence availability (electron/preload.js exposes it). On the
// web this is undefined and persistence is available (the app's own storage-failure handling applies).
// On desktop read-only media the shell sets persistenceEnabled=false, and the app MUST NOT write the
// opt-in certificate/signature — FR-011b: memory-only is enforced by not writing.
interface DesktopShell {
  persistenceEnabled: boolean;
  mode: string | null;
}

declare global {
  interface Window {
    desktopShell?: DesktopShell;
  }
}

/** True unless the desktop shell reports persistence is unavailable (read-only media). */
export function persistenceAvailable(): boolean {
  return window.desktopShell?.persistenceEnabled !== false;
}

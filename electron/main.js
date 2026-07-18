// Desktop shell entry — the offline Electron wrapper around the unchanged web build (FR-009/FR-019).
// Order matters: scheme registration and userData relocation MUST happen before app.whenReady().

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerAppScheme, handleAppProtocol, appURL } = require('./protocol');
const { installNetworkLocks, lockWindow } = require('./network');
const { resolvePortableData } = require('./paths');

const DIST = path.join(__dirname, '..', 'dist'); // repo dist/ in dev; app.asar/dist when packaged

// Layer 5 (network-policy.md): we NEVER call crashReporter.start() — a dump could contain in-memory
// key material (FR-012) or phone home. Its absence is the guarantee; there is no flag to misconfigure.

// --- Runs synchronously at load, before `ready` ---
registerAppScheme();

const dataLocation = resolvePortableData();
if (dataLocation.userData) {
  app.setPath('userData', dataLocation.userData); // relocate BEFORE whenReady so IndexedDB follows
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 900,
    show: !process.env.PDFSIGNER_HEADLESS,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox off so the preload can require the shell's buildmeta module (US3 surfaces). The
      // renderer stays isolated (contextIsolation) with no Node integration; the preload injects only
      // vanilla DOM chrome and never exposes Node to the page.
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
      // Hand the resolved data location to the preload's about surface (FR-013 disclosure).
      additionalArguments: [
        '--pdfsigner-data=' +
          JSON.stringify({ mode: dataLocation.mode, path: dataLocation.userData }),
      ],
    },
  });
  lockWindow(win);
  win.loadURL(appURL('index.html'));
  return win;
}

app.whenReady().then(() => {
  handleAppProtocol(DIST);
  installNetworkLocks(session.defaultSession);

  // Production keeps Electron's default download handling (the OS save dialog — R10, no code change).
  // A TEST-ONLY hook auto-saves to a directory so the desktop E2E can capture the signed PDF without
  // driving a native dialog. Off unless the env var is set; never active in a shipped build.
  const testDir = process.env.PDFSIGNER_E2E_DOWNLOAD_DIR;
  if (testDir) {
    session.defaultSession.on('will-download', (_e, item) => {
      const out = path.join(testDir, item.getFilename());
      item.setSavePath(out);
      item.once('done', (_ev, state) => {
        if (state === 'completed') fs.writeFileSync(out + '.done', 'ok');
      });
    });
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Ephemeral (read-only media): remove the throwaway userData on quit — leftovers are a bug (FR-011b).
app.on('will-quit', () => {
  if (dataLocation.mode === 'ephemeral' && dataLocation.userData) {
    try {
      fs.rmSync(dataLocation.userData, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

app.on('window-all-closed', () => app.quit());

module.exports = { dataLocation };

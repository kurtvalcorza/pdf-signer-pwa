// Desktop shell entry — the offline Electron wrapper around the unchanged web build (FR-009/FR-019).
// Order matters: scheme registration and userData relocation MUST happen before app.whenReady().

const { app, BrowserWindow, Menu, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerAppScheme, handleAppProtocol, appURL } = require('./protocol');
const { installNetworkLocks, lockWindow } = require('./network');
const { resolvePortableData, acquireDirLock } = require('./paths');

const DIST = path.join(__dirname, '..', 'dist'); // repo dist/ in dev; app.asar/dist when packaged

// Layer 5 (network-policy.md): no phone-home. Two parts, both before `ready`:
//  1. We NEVER call crashReporter.start() — a dump could contain in-memory key material (FR-012).
//  2. Disable Chromium's background networking / metrics / component + domain-reliability services
//     via command-line switches (these would otherwise initialise their own network paths that
//     `webRequest` does not govern). Layer 6 (the monitored gate) is the proof; these are the switches
//     the contract requires be SET, not merely relied upon by absence. *(Codex, PR #13.)*
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-breakpad'); // no crash-dump uploader armed at all

// --- Runs synchronously at load, before `ready` ---
registerAppScheme();

// Remove Electron's DEFAULT application menu: its Help item calls shell.openExternal('electronjs.org'),
// which would bypass the exact-REPO_URL carve-out (network-policy.md § Carve-out). No menu is needed.
Menu.setApplicationMenu(null);

const dataLocation = resolvePortableData();
if (dataLocation.userData) {
  app.setPath('userData', dataLocation.userData); // relocate BEFORE whenReady so IndexedDB follows
}

// Data-directory-scoped single-instance lock: a second copy launched from the SAME folder defers to
// the running one (spec § Edge Cases); different folders run independently.
const instanceLock = acquireDirLock(dataLocation.mode === 'adjacent' ? dataLocation.userData : null);

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
      // Hand the resolved data location + persistence flag to the preload (FR-013 disclosure, and
      // FR-011b: the renderer must DISABLE opt-in persistence when it is unavailable).
      additionalArguments: [
        '--pdfsigner-data=' +
          JSON.stringify({
            mode: dataLocation.mode,
            path: dataLocation.userData,
            persistenceEnabled: dataLocation.persistenceEnabled,
          }),
      ],
    },
  });
  lockWindow(win);
  win.loadURL(appURL('index.html'));
  return win;
}

app.whenReady().then(() => {
  // Another live instance owns this data folder — defer to it (spec § Edge Cases).
  if (!instanceLock.ok) {
    app.quit();
    return;
  }

  handleAppProtocol(DIST);
  installNetworkLocks(session.defaultSession);

  // Production keeps Electron's DEFAULT download handling (the OS save dialog — R10). A test-only hook
  // auto-saves the signed PDF so the E2E can capture it (Playwright cannot intercept Electron's blob
  // download). It is DOUBLY gated so a shipped build cannot be tricked into redirecting a user's
  // documents by an inherited env var: it needs `!app.isPackaged` OR an explicit `PDFSIGNER_ALLOW_TEST_
  // CAPTURE=1` marker — a normal user environment has neither. *(Codex, PR #13.)*
  const testDir = process.env.PDFSIGNER_E2E_DOWNLOAD_DIR;
  const testAllowed = !app.isPackaged || process.env.PDFSIGNER_ALLOW_TEST_CAPTURE === '1';
  if (testDir && testAllowed) {
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

app.on('will-quit', () => {
  // Release the single-instance lock so a graceful quit doesn't leave a lockfile with our (now
  // exited) PID — a coincidental PID reuse could otherwise make the next launch think a live
  // instance still owns the folder. (The stale-reclaim path is the backstop, not a substitute.)
  instanceLock.release();
  // Ephemeral (read-only media): remove the throwaway userData on quit — leftovers are a bug (FR-011b).
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

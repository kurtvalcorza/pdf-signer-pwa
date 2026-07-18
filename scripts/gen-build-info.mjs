// T011 — inject BuildMetadata at build time into electron/build-info.json (read by the shell at
// runtime; never fetched — FR-015a). MUST fail on a placeholder so the staleness nudge can't ship
// silently inoperative. The BUILD may use the network/clock; the packaged APP never does.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

const pkg = read('package.json');
const electronVersion = read('node_modules/electron/package.json').version; // e.g. 43.1.1

// engineDate = the ACTUAL publish date of the resolved Electron version, read from the npm registry
// at BUILD time (the build may use the network; the app never does). This is accurate and
// self-updating — no hand-maintained map to go stale and falsely mark a fresh engine as ageing.
// A hardcoded fallback (kept current) covers an offline build.
const ELECTRON_MAJOR_FALLBACK = {
  43: '2026-05-13', // Electron 43.0.0 (Chromium 150), ~mid-2026
};
let engineDate;
try {
  // `time --json` gives the whole publish-time map; index by the exact version. (A `time.<version>`
  // field query mis-parses the version's dots as nested keys and returns nothing.)
  const json = execFileSync('npm', ['view', `electron@${electronVersion}`, 'time', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32', // npm is npm.cmd on Windows
  });
  const iso = JSON.parse(json)[electronVersion];
  if (iso && !Number.isNaN(Date.parse(iso))) engineDate = new Date(iso).toISOString();
} catch {
  /* offline — fall through to the map */
}
if (!engineDate) {
  const major = Number(electronVersion.split('.')[0]);
  engineDate = ELECTRON_MAJOR_FALLBACK[major];
  if (!engineDate) {
    console.error(
      `gen-build-info: could not resolve engineDate for Electron ${electronVersion} (npm view failed ` +
        `and no offline fallback for major ${major}). Add it to ELECTRON_MAJOR_FALLBACK — do not guess.`,
    );
    process.exit(1);
  }
}

let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout — leave 'unknown'; validation below rejects it */
}

const info = {
  version: pkg.version,
  buildDate: new Date().toISOString(),
  engineVersion: electronVersion,
  engineDate,
  commit,
  selfUpdates: false,
};

// Reject placeholders — shipping "unknown" would make the disclosure silently inoperative (Principle IV).
for (const [k, v] of Object.entries(info)) {
  if (v === 'unknown' || v === '' || v == null) {
    console.error(`gen-build-info: refusing to write placeholder ${k}=${JSON.stringify(v)}.`);
    process.exit(1);
  }
}

const out = resolve(ROOT, 'electron/build-info.json');
writeFileSync(out, JSON.stringify(info, null, 2) + '\n');
console.log(`gen-build-info: wrote ${out}`);
console.log(info);

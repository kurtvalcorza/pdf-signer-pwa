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

// engineDate = the bundled Chromium/Electron's release date. Derived from the resolved Electron
// MAJOR — the staleness nudge only needs approximate age. Add new majors here as they are adopted;
// an unknown major FAILS the build rather than guessing (a wrong date mutes or fakes the warning).
const ELECTRON_MAJOR_RELEASE = {
  43: '2025-05-27', // Electron 43.0.0 (Chromium 136)
};
const major = Number(electronVersion.split('.')[0]);
const engineDate = ELECTRON_MAJOR_RELEASE[major];
if (!engineDate) {
  console.error(
    `gen-build-info: no engineDate for Electron major ${major} (${electronVersion}). ` +
      `Add it to ELECTRON_MAJOR_RELEASE in scripts/gen-build-info.mjs — do not guess.`,
  );
  process.exit(1);
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

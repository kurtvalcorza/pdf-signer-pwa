// Reads the injected BuildMetadata (electron/build-info.json) and derives staleness — a LOCAL clock
// comparison only, never a network call (FR-015a/FR-006). Data model: data-model.md § BuildMetadata.

const { readFileSync } = require('node:fs');
const path = require('node:path');

const STALENESS_THRESHOLD_DAYS = 180; // R6

// distribution isn't baked into build-info (the same file is packed for both platforms); the shell
// knows its own platform at runtime.
function distribution() {
  return process.platform === 'win32' ? 'windows-portable' : 'linux-appimage';
}

/**
 * Load BuildMetadata. Returns null if absent (dev run without a generated build-info) so the shell
 * simply shows no staleness/about disclosure rather than crashing — the packaged build always has it
 * (gen-build-info runs in build:desktop and fails on a placeholder).
 */
function loadBuildMetadata() {
  // Test override: point at a fixture to exercise the stale path (T026a) without rebuilding.
  const file = process.env.PDFSIGNER_BUILD_INFO || path.join(__dirname, 'build-info.json');
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const engineAgeInDays = daysSince(raw.engineDate);
  return {
    ...raw,
    distribution: distribution(),
    engineAgeInDays,
    buildAgeInDays: daysSince(raw.buildDate), // displayed only — MUST NOT drive isStale
    isStale: engineAgeInDays !== null && engineAgeInDays > STALENESS_THRESHOLD_DAYS,
  };
}

// Whole days between an ISO date and now, per the DEVICE clock (untrusted, accepted — R6). null if
// the input is unparseable.
function daysSince(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

module.exports = { loadBuildMetadata, STALENESS_THRESHOLD_DAYS };

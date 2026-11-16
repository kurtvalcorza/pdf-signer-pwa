// Fuse-state gate (issue #33, RFC 23-2 decision B3 (b)). Reads the fuse wire BURNED into a packaged
// Electron binary with @electron/fuses and fails unless it matches the expected set exactly. The
// config (electron-builder*.yml) is what we asked for; only the binary is what ships.
//
//   node scripts/check-fuses.mjs --release <exe> --probe <exe>   (both required; exit 2 = usage)
//
// --release: every fuse must hold its hardened value (HARDENED below), the inspector included.
// --probe:   the gate-only probe build (electron-builder.probe.yml). Identical to HARDENED except
//            EnableNodeCliInspectArguments, which is on so Playwright can drive it.
// With both flags it also proves the probe is the release plus one fuse, not merely the same commit:
//   1. resources/app.asar is byte-identical (same SHA-256) in both builds, and
//   2. every file in the two app folders is byte-identical, except the main binary, which has the
//      same length and differs in exactly ONE byte. Step 1's fuse tables already show the inspector
//      fuse differs, so that byte is the inspector fuse and nothing else changed.
//
// verify-packaged.mjs imports assertFuses() to check the binary it is about to drive.
import fuses from '@electron/fuses';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { FuseV1Options, getCurrentFuseWire } = fuses;
const DISABLED = 48; // the fuse wire stores ASCII '0' and '1'
const ENABLED = 49;

// The release set. Every fuse @electron/fuses knows is listed, so a new one cannot slip in unlisted
// (the loop below fails on a fuse this table does not name). All are hardened except
// EnableCookieEncryption, kept at Electron's default (off) as on main: turning it on is a separate
// follow-up (on Linux it may create a desktop-keyring entry; unverified). Asar integrity validation
// is burned on, but Electron enforces it on Windows (and macOS) only, not on Linux.
export const HARDENED = {
  RunAsNode: DISABLED, // ELECTRON_RUN_AS_NODE would turn the binary into a plain Node runtime
  EnableCookieEncryption: DISABLED, // Electron default; the app sets no cookies (follow-up to harden)
  EnableNodeOptionsEnvironmentVariable: DISABLED, // NODE_OPTIONS could --require arbitrary code
  EnableNodeCliInspectArguments: DISABLED, // --inspect would attach a debugger to the main process
  EnableEmbeddedAsarIntegrityValidation: ENABLED, // Windows checks app.asar against its embedded hash
  OnlyLoadAppFromAsar: ENABLED, // no loose app/ folder next to the archive gets loaded instead
  LoadBrowserProcessSpecificV8Snapshot: DISABLED, // one V8 snapshot for every process
  GrantFileProtocolExtraPrivileges: DISABLED, // file: gets no privileges beyond a normal scheme
};
export const PROBE = { ...HARDENED, EnableNodeCliInspectArguments: ENABLED };

const show = (v) => (v === ENABLED ? 'on' : v === DISABLED ? 'off' : `raw ${v}`);

/** Throws unless the binary at `exe` has exactly `expected` burned in. Returns the observed table. */
export async function assertFuses(exe, expected, label) {
  if (!existsSync(exe)) throw new Error(`[fuses] ${label}: no binary at ${exe}`);
  const wire = await getCurrentFuseWire(exe);
  const names = Object.keys(FuseV1Options).filter((k) => Number.isNaN(Number(k)));
  const unknown = names.filter((n) => !(n in expected));
  if (unknown.length)
    throw new Error(`[fuses] ${label}: no expected value for ${unknown.join(', ')}`);
  const table = {};
  const wrong = [];
  for (const [name, want] of Object.entries(expected)) {
    const got = wire[FuseV1Options[name]];
    table[name] = show(got);
    if (got !== want) wrong.push(`${name} is ${show(got)}, expected ${show(want)}`);
  }
  console.log(`[fuses] ${label} (${exe}):`);
  for (const [name, state] of Object.entries(table)) console.log(`  ${name.padEnd(38)} ${state}`);
  if (wrong.length) throw new Error(`[fuses] ${label}: ${wrong.join('; ')}`);
  console.log(`[fuses] ${label}: all ${names.length} fuses as expected.`);
  return table;
}

const asarOf = (exe) => join(dirname(exe), 'resources', 'app.asar');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Throws unless both builds packed byte-identical app.asar archives. Returns the hash. */
export function assertSameAsar(releaseExe, probeExe) {
  const [a, b] = [asarOf(releaseExe), asarOf(probeExe)];
  for (const f of [a, b]) if (!existsSync(f)) throw new Error(`[fuses] no app.asar at ${f}`);
  const [ha, hb] = [sha256(a), sha256(b)];
  console.log(`[fuses] app.asar sha256 release ${ha}\n[fuses] app.asar sha256 probe   ${hb}`);
  if (ha !== hb)
    throw new Error("[fuses] the probe build does not carry the release build's app.asar");
  console.log('[fuses] probe and release pack the same app.asar.');
  return ha;
}

const listFiles = (root, dir = root) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listFiles(root, join(dir, d.name)) : [relative(root, join(dir, d.name))],
  );

/** Throws unless the two app folders differ only by one byte of the main binary. */
export function assertOnlyFuseByteDiffers(releaseExe, probeExe) {
  const [ra, rb] = [dirname(releaseExe), dirname(probeExe)];
  // The release's Windows portable target adds electron-builder's UAC helper next to the app; the
  // probe builds only the unpacked folder. It is the one file allowed on the release side alone.
  const releaseOnly = new Set([join('resources', 'elevate.exe')]);
  const all = listFiles(ra).sort();
  const extra = all.filter((f) => releaseOnly.has(f));
  if (extra.length) console.log(`[fuses] release-only, allowed by name: ${extra.join(', ')}`);
  const [fa, fb] = [all.filter((f) => !releaseOnly.has(f)), listFiles(rb).sort()];
  if (JSON.stringify(fa) !== JSON.stringify(fb)) {
    const only = (x, y) => x.filter((f) => !y.includes(f));
    throw new Error(
      `[fuses] the two builds hold different files: release-only [${only(fa, fb)}], probe-only [${only(fb, fa)}]`,
    );
  }
  const exeRel = relative(ra, releaseExe);
  for (const f of fa) {
    const [a, b] = [readFileSync(join(ra, f)), readFileSync(join(rb, f))];
    if (f !== exeRel) {
      if (!a.equals(b)) throw new Error(`[fuses] ${f} differs between release and probe`);
      continue;
    }
    if (a.length !== b.length)
      throw new Error(`[fuses] ${f} differs in length between release and probe`);
    let diffs = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diffs > 1) break;
    if (diffs !== 1)
      throw new Error(
        `[fuses] ${f}: expected exactly 1 differing byte (the fuse), found ${diffs > 1 ? 'more' : diffs}`,
      );
  }
  console.log(
    `[fuses] ${fa.length} files compared: identical except one byte of ${exeRel} (the inspector fuse).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Strict: exactly --release <exe> --probe <exe>, each with a non-empty value naming an existing
  // file. Anything else is a usage error (exit 2), so an empty CI matrix value cannot pass by
  // silently checking less.
  const usage = (why) => {
    console.error(`[fuses] usage error: ${why}`);
    console.error('usage: node scripts/check-fuses.mjs --release <exe> --probe <exe>');
    process.exit(2);
  };
  const args = process.argv.slice(2);
  const paths = {};
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (flag !== '--release' && flag !== '--probe')
      usage(`unknown argument ${JSON.stringify(flag)}`);
    if (flag in paths) usage(`${flag} given twice`);
    if (value === undefined || value.trim() === '' || value.startsWith('--'))
      usage(`${flag} needs a non-empty path`);
    paths[flag] = resolve(value);
  }
  for (const flag of ['--release', '--probe']) {
    if (!paths[flag]) usage(`${flag} is required`);
    if (!existsSync(paths[flag])) usage(`${flag} ${paths[flag]} does not exist`);
  }
  const { '--release': release, '--probe': probe } = paths;
  try {
    await assertFuses(release, HARDENED, 'release');
    await assertFuses(probe, PROBE, 'probe');
    assertSameAsar(release, probe);
    assertOnlyFuseByteDiffers(release, probe);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

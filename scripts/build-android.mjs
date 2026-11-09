#!/usr/bin/env node
/**
 * Runs the Android shell's Gradle wrapper in android/ (feature 003, T009).
 *
 *   node scripts/build-android.mjs assembleRelease [moreTasks...]
 *
 * Expects dist/ to exist (`npm run build`); the Gradle build copies it into the APK and fails
 * with a clear message if dist/index.html is missing.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ANDROID = resolve('android');
const args = process.argv.slice(2);
if (args.length === 0) args.push('assembleRelease');

// Only Gradle task names and plain flags: on Windows the .bat wrapper has to go through cmd.exe,
// so nothing that cmd would interpret is allowed through.
for (const a of args) {
  if (!/^[A-Za-z0-9:_.=-]+$/.test(a)) {
    console.error(`✗ refusing argument ${JSON.stringify(a)}`);
    process.exit(2);
  }
}

// shell:false + discrete argv so the repository path (which may contain spaces) is passed intact.
// `.\` is explicit because cmd skips the current directory when NoDefaultCurrentDirectoryInExePath
// is set.
const r =
  process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '.\\gradlew.bat', ...args], {
        cwd: ANDROID,
        stdio: 'inherit',
        shell: false,
      })
    : spawnSync('./gradlew', args, { cwd: ANDROID, stdio: 'inherit', shell: false });

if (r.error) {
  console.error(`✗ could not run the Gradle wrapper: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);

#!/usr/bin/env node
/**
 * Android release gate (feature 003, research R13, contracts/apk-checks.md C10–C11).
 *
 * Drives the SIGNED RELEASE APK on a running emulator through the accessibility tree
 * (`uiautomator dump` + `input`), which works under FLAG_SECURE and across apps (the system
 * picker and save dialog). No test APK, no debug build, no WebView DevTools.
 *
 *   node scripts/android-gate.mjs <apk> [--adb <path>] [--large] [--skip-negative]
 *
 * Cases:
 *   sign            open sample.pdf, place signature.png, sign with e2e-cert.p12, save
 *   counter-sign    open the result, place the image on page 2, sign again, save
 *   validate (C10)  scripts/validate_pdf.py on both files: integrity + modification policy
 *   wrong password  US1 AS4: the shared app's error, and no save dialog opens
 *   cancel          US1 AS5: backing out of the save dialog saves nothing
 *   certified (C11) US1 AS3: a certified "no changes" PDF is refused for certificate signing
 *   --large         R7: a ~95 MiB PDF signs, saves with a matching byte count, and validates
 *
 * Driver rules from the spike (S9): dump twice after a launch, and tap only from a fresh dump,
 * by resource id where one exists (android:id/button1 = SAVE).
 *
 * Exits non-zero on the first failure, printing what it saw.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PKG = 'io.github.kurtvalcorza.pdfsigner';
const ACTIVITY = `${PKG}/.MainActivity`;
const DOCSUI = 'com.google.android.documentsui';
const DEVICE_DIR = '/sdcard/Download';
const PASSWORD = 'e2e-pass';
const PY = process.env.PYTHON || 'python';
const VALIDATOR = resolve('scripts/validate_pdf.py');
const FIXTURES = resolve('tests/e2e/fixtures');
const POLICY = resolve('tests/signing/fixtures/policy');

// ---------------------------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const option = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const LARGE_MB_OPT = option('--large-mb');
const LARGE = flag('--large') || LARGE_MB_OPT !== null;
const LARGE_MB = Number(LARGE_MB_OPT ?? 95);
const SKIP_NEGATIVE = flag('--skip-negative');
const ADB = option('--adb') || process.env.ADB || 'adb';
const APK = argv[0] && resolve(argv[0]);
if (!APK || !existsSync(APK)) {
  console.error(
    'usage: node scripts/android-gate.mjs <signed-release.apk> [--adb <path>] [--large] [--skip-negative]',
  );
  process.exit(2);
}
const WORK = mkdtempSync(join(tmpdir(), 'android-gate-'));

// ---------------------------------------------------------------------------------- adb helpers
function adb(...args) {
  return execFileSync(ADB, args, {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const shell = (cmd) => adb('shell', cmd);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GateError extends Error {}
function fail(msg) {
  throw new GateError(msg);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, _all, dec, hex, name) =>
    dec
      ? String.fromCodePoint(Number(dec))
      : hex
        ? String.fromCodePoint(parseInt(hex, 16))
        : (ENTITIES[name] ?? m),
  );

/** One fresh accessibility dump. */
function dump() {
  let xml = '';
  for (let attempt = 0; attempt < 3 && !xml.includes('<node'); attempt++) {
    try {
      shell('uiautomator dump /sdcard/gate-ui.xml >/dev/null 2>&1');
      xml = adb('exec-out', 'cat', '/sdcard/gate-ui.xml');
    } catch {
      xml = '';
    }
  }
  const nodes = [];
  for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const at = Object.fromEntries(
      [...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], decode(x[2])]),
    );
    const b = at.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    nodes.push({
      text: at.text || '',
      desc: at['content-desc'] || '',
      id: at['resource-id'] || '',
      pkg: at.package || '',
      cls: (at.class || '').split('.').pop(),
      click: at.clickable === 'true',
      enabled: at.enabled !== 'false',
      x: (x1 + x2) >> 1,
      y: (y1 + y2) >> 1,
    });
  }
  return nodes;
}

const label = (n) => [n.text, n.desc, n.id].filter(Boolean).join(' | ');
const matches = (n, re) => re.test(n.text) || re.test(n.desc) || re.test(n.id);

/** Polls fresh dumps until `pick(nodes)` returns something truthy. */
async function waitFor(what, pick, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let nodes = [];
  while (Date.now() < end) {
    nodes = dump();
    const hit = pick(nodes);
    if (hit) return hit;
    await sleep(700);
  }
  const seen = nodes.map(label).filter(Boolean).slice(0, 40).join('\n    ');
  fail(`timed out waiting for ${what}. Last screen:\n    ${seen}`);
}

const find = (re) => (nodes) => nodes.find((n) => matches(n, re));

/** Waits for a node, then taps it from a fresh dump (S9 rule b). */
async function tap(what, re, timeoutMs) {
  await waitFor(what, find(re), timeoutMs);
  const n = find(re)(dump());
  if (!n) fail(`${what} disappeared before it could be tapped`);
  shell(`input tap ${n.x} ${n.y}`);
  console.log(`    tap ${what}`);
  await sleep(600);
}

function keyboardShown() {
  return /mInputShown=true/.test(shell('dumpsys input_method'));
}

async function hideKeyboard() {
  if (keyboardShown()) {
    shell('input keyevent KEYCODE_BACK');
    await sleep(700);
  }
}

// ---------------------------------------------------------------------------------- logcat
function clearLog() {
  adb('logcat', '-c');
}
function shellLog() {
  return adb('logcat', '-d', '-s', 'PdfSignerShell:*');
}
async function waitLog(what, re, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const log = shellLog();
    const m = log.match(re);
    if (m) return m;
    await sleep(1000);
  }
  fail(`timed out waiting for log ${what}. Shell log:\n${shellLog()}`);
}

// ---------------------------------------------------------------------------------- app steps
function deviceFiles() {
  return shell(`ls -1 ${DEVICE_DIR}`)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function push(local, name = local.split(/[\\/]/).pop()) {
  adb('push', local, `${DEVICE_DIR}/${name}`);
  // Make the new file visible to DocumentsUI's MediaStore-backed listing.
  shell(
    `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${DEVICE_DIR}/${name} >/dev/null`,
  );
  return name;
}

async function launchFresh() {
  shell(`am start -S -W -n ${ACTIVITY} >/dev/null`);
  dump(); // S9 rule a: the first dump after launch can show the WebView with no children.
  await waitFor('the app start screen', find(/^Open (different )?PDF$/), 30000);
}

/** In DocumentsUI: tap the file whose title (list) or description (image grid) is `name`. */
async function pickFile(name) {
  const isFile = (n) => n.pkg === DOCSUI && (n.text === name || n.desc.startsWith(`${name},`));
  await waitFor('the system picker', (ns) => ns.some((n) => n.pkg === DOCSUI), 20000);
  let hit = await waitFor(`${name} in the picker`, (ns) => ns.find(isFile), 6000).catch(() => null);
  if (!hit) {
    // Not in the current folder: go to Downloads through the roots drawer.
    await tap('Show roots', /^Show roots$/);
    await tap('Downloads root', /^Downloads$/);
    hit = await waitFor(`${name} in Downloads`, (ns) => ns.find(isFile), 15000);
  }
  const n = dump().find(isFile);
  if (!n) fail(`${name} disappeared from the picker`);
  shell(`input tap ${n.x} ${n.y}`);
  console.log(`    pick ${name}`);
  await sleep(800);
}

async function openPdf(name) {
  await tap('Open PDF', /^Open (different )?PDF$/);
  await pickFile(name);
  await waitFor(
    `${name} rendered`,
    find(new RegExp(`^Page 1 of \\d+ of ${name.replace(/[.()]/g, '\\$&')}$`)),
    60000,
  );
}

async function placeSignature({ page2 }) {
  if (page2) {
    await tap('Next page', /^Next ›$/);
    await waitFor('page 2', find(/^Page 2 of \d+ of /), 20000);
  }
  await tap('Add signature', /^Add signature$/);
  await pickFile('signature.png');
  await waitFor('the placed signature', find(/^Remove signature$/), 20000);
}

async function fillCertificate(password) {
  await tap('Sign with a digital certificate', /^Sign with a digital certificate/);
  const chosen = (ns) => ns.find((n) => n.cls === 'Button' && /e2e-cert\.p12/.test(n.text));
  if (!chosen(dump())) {
    await tap('Choose certificate', /^Choose certificate/);
    await pickFile('e2e-cert.p12');
    await waitFor('the chosen certificate', chosen, 20000);
  }
  const field = await waitFor('the password field', (ns) => ns.find((n) => n.cls === 'EditText'));
  shell(`input tap ${field.x} ${field.y}`);
  await sleep(500);
  // Clear whatever is there, then type.
  shell('input keycombination KEYCODE_CTRL_LEFT KEYCODE_A');
  shell('input keyevent KEYCODE_DEL');
  shell(`input text ${password}`);
  await sleep(400);
  await hideKeyboard();
}

/** Signs `input` and saves it. Returns the pulled local path and the device file name. */
async function signAndSave(input, { page2 = false } = {}) {
  await launchFresh();
  await openPdf(input);
  await placeSignature({ page2 });
  await fillCertificate(PASSWORD);
  clearLog();
  await tap('Sign & Download', /^Sign & Download$/);
  await waitLog(
    'save request received',
    /SAVE received id=\d+ bytes=(\d+)/,
    LARGE ? 240000 : 60000,
  );
  const expected = `${input.replace(/\.pdf$/i, '')}-signed.pdf`;
  await waitFor('the save dialog', find(/^android:id\/button1$/), 30000);
  const name = dump().find((n) => n.id === 'android:id/title' && n.cls === 'EditText')?.text;
  if (name !== expected) fail(`save dialog proposes ${JSON.stringify(name)}, expected ${expected}`);
  await tap('SAVE', /^android:id\/button1$/);
  const m = await waitLog('saved', /SAVE saved id=\d+ bytes=(\d+)/, LARGE ? 240000 : 60000);
  const local = join(WORK, expected);
  adb('pull', `${DEVICE_DIR}/${expected}`, local);
  const size = statSync(local).size;
  if (String(size) !== m[1]) fail(`pulled ${size} bytes, shell wrote ${m[1]}`);
  console.log(`    saved ${expected} (${size} bytes)`);
  return { local, name: expected };
}

function validate(files) {
  console.log(`  › validate_pdf.py ${files.map((f) => f.split(/[\\/]/).pop()).join(' ')}`);
  const r = spawnSync(PY, [VALIDATOR, ...files], { stdio: 'inherit', shell: false });
  if ((r.status ?? 1) !== 0) fail('validator rejected the output');
}

// ---------------------------------------------------------------------------------- cases
async function caseSignAndCounterSign() {
  console.log('▶ sign + counter-sign (C10)');
  const first = await signAndSave('sample.pdf');
  const second = await signAndSave(first.name, { page2: true });
  validate([first.local, second.local]);
}

async function caseWrongPassword() {
  console.log('▶ wrong password (US1 AS4)');
  await launchFresh();
  await openPdf('sample.pdf');
  await placeSignature({ page2: false });
  await fillCertificate('not-the-password');
  clearLog();
  await tap('Sign & Download', /^Sign & Download$/);
  await waitFor('the incorrect-password message', find(/Incorrect certificate password/), 30000);
  await sleep(2000);
  if (/SAVE (begin|received)/.test(shellLog()))
    fail('a save request was sent after a wrong password');
  if (dump().some((n) => n.pkg === DOCSUI)) fail('a save dialog opened after a wrong password');
  console.log('    refused with the shared message; no save dialog');
}

async function caseCancel() {
  console.log('▶ cancel the save dialog (US1 AS5)');
  const before = deviceFiles();
  await launchFresh();
  await openPdf('sample.pdf');
  await placeSignature({ page2: false });
  await fillCertificate(PASSWORD);
  clearLog();
  await tap('Sign & Download', /^Sign & Download$/);
  await waitFor('the save dialog', find(/^android:id\/button1$/), 60000);
  shell('input keyevent KEYCODE_BACK');
  await sleep(700);
  if (dump().some((n) => n.pkg === DOCSUI)) shell('input keyevent KEYCODE_BACK');
  await waitLog('cancelled', /SAVE cancelled id=\d+/, 20000);
  await sleep(1000);
  if (/SAVE saved/.test(shellLog())) fail('the shell reported a save after cancel');
  if (/Saved /.test(dump().map(label).join('\n'))) fail('"Saved" shown after cancel');
  const after = deviceFiles();
  const added = after.filter((f) => !before.includes(f));
  if (added.length) fail(`cancel left new files in Download/: ${added.join(', ')}`);
  console.log('    cancelled; nothing saved, no new file');
}

async function caseCertified() {
  console.log('▶ certified PDF refused (US1 AS3, C11)');
  const name = push(join(POLICY, 'certified-p1.pdf'), 'gate-certified-p1.pdf');
  await launchFresh();
  await tap('Open PDF', /^Open (different )?PDF$/);
  await pickFile(name);
  await waitFor('the certified refusal', find(/cannot be signed here/), 60000);
  const sign = dump().find((n) => /^Sign with a digital certificate/.test(n.text));
  if (sign && sign.enabled) {
    // The message alone is not enough: certificate signing must not be offered.
    clearLog();
    shell(`input tap ${sign.x} ${sign.y}`);
    await sleep(1500);
    const offered = dump().some((n) => /^Sign & Download$/.test(n.text) && n.enabled);
    if (offered) fail('certificate signing is still offered for a certified PDF');
  }
  console.log('    refused with the shared message; certificate signing not offered');
}

async function caseLarge() {
  console.log('▶ large PDF (R7, --large)');
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++)
    doc
      .addPage([595, 842])
      .drawText(`Large gate fixture, page ${i}`, { x: 50, y: 780, size: 18, font });
  // Incompressible padding sets the file size; the default 95 MiB stays under LIMITS.pdfBytes (100 MiB).
  if (!(LARGE_MB > 0 && LARGE_MB < 100))
    fail(`--large-mb must be between 0 and 100, got ${LARGE_MB}`);
  const pad = new Uint8Array(Math.round(LARGE_MB * 1024 * 1024));
  for (let i = 0; i < pad.length; i += 65536) crypto.getRandomValues(pad.subarray(i, i + 65536));
  await doc.attach(pad, 'padding.bin', { mimeType: 'application/octet-stream' });
  const bytes = await doc.save({ useObjectStreams: false });
  const local = join(WORK, 'gate-large.pdf');
  writeFileSync(local, bytes);
  console.log(`    generated ${bytes.length} bytes`);
  push(local);
  let out;
  try {
    out = await signAndSave('gate-large.pdf');
  } catch (e) {
    // Tell "ran out of memory, said so" apart from a crash or a hang (spec edge case).
    const screen = dump().map(label).join('\n');
    const log = adb('logcat', '-d', '-s', 'PdfSignerShell:*', 'chromium:*', 'AndroidRuntime:*');
    if (/ran out of memory/.test(screen) && /RENDERER gone/.test(log)) {
      fail(
        `${LARGE_MB} MiB: the WebView renderer ran out of memory; the app showed its message and did not crash`,
      );
    }
    if (/FATAL EXCEPTION|crash wasn't handled/.test(log)) fail(`${LARGE_MB} MiB: the app crashed`);
    throw e;
  }
  if (statSync(out.local).size <= bytes.length)
    fail('signed large file is not larger than its input');
  validate([out.local]);
}

// ---------------------------------------------------------------------------------- main
async function main() {
  console.log(`Android gate: ${APK}`);
  const devices = adb('devices')
    .split(/\r?\n/)
    .filter((l) => /\tdevice$/.test(l));
  if (devices.length !== 1) fail(`need exactly one device, found ${devices.length}`);
  console.log(
    `  device ${devices[0].split('\t')[0]}, WebView ${shell('dumpsys package com.google.android.webview | grep -m1 versionName').trim()}`,
  );

  // Airplane mode before first launch (Q3): the app must never have seen a network.
  shell('cmd connectivity airplane-mode enable');
  if (shell('settings get global airplane_mode_on').trim() !== '1')
    fail('airplane mode did not turn on');
  spawnSync(ADB, ['uninstall', PKG], { stdio: 'ignore' });
  adb('install', APK);
  console.log('  installed with airplane mode on');

  for (const f of ['sample.pdf', 'signature.png', 'e2e-cert.p12']) push(join(FIXTURES, f));
  for (const f of deviceFiles())
    if (/-signed(\s*\(\d+\))?\.pdf$|^gate-/.test(f)) shell(`rm -f '${DEVICE_DIR}/${f}'`);

  await caseSignAndCounterSign();
  if (!SKIP_NEGATIVE) {
    await caseWrongPassword();
    await caseCancel();
    await caseCertified();
  }
  if (LARGE) await caseLarge();
}

main()
  .then(() => {
    console.log('✓ Android gate passed');
    rmSync(WORK, { recursive: true, force: true });
  })
  .catch((e) => {
    console.error(`✗ Android gate failed: ${e instanceof GateError ? e.message : e.stack}`);
    console.error(`  outputs kept in ${WORK}`);
    process.exit(1);
  });

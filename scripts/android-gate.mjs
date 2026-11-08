#!/usr/bin/env node
/**
 * Android release gate (feature 003, research R13, contracts/apk-checks.md C10–C11).
 *
 * Drives the SIGNED RELEASE APK on a running emulator through the accessibility tree
 * (`uiautomator dump` + `input`), which works under FLAG_SECURE and across apps (the system
 * picker and save dialog). No test APK, no debug build, no WebView DevTools.
 *
 *   node scripts/android-gate.mjs <apk> [--adb <path>] [--network-on] [--large | --large-mb <n>]
 *                                 [--skip-negative]
 *
 * Cases:
 *   sign            open sample.pdf, place signature.png, sign with e2e-cert.p12, save
 *   counter-sign    open the result, place the image on page 2, sign again, save
 *   validate (C10)  scripts/validate_pdf.py on both files: integrity + modification policy
 *   content hidden  C8: with a document open, screencap is black (FLAG_SECURE)
 *   --network-on    C12: with airplane mode off, sign again; netstats shows no traffic for the UID
 *   wrong password  US1 AS4: the shared app's error, and no save dialog opens
 *   cancel          US1 AS5: backing out of the save dialog saves nothing
 *   certified (C11) US1 AS3: a certified "no changes" PDF is refused for certificate signing
 *   --large         R7: a 25 MiB PDF (--large-mb <n> to change) signs, saves with a matching
 *                   byte count, and validates. 25, not ~100: research.md G2
 *
 * Driver rules from the spike (S9): dump twice after a launch, and tap only from a fresh dump,
 * by resource id where one exists (android:id/button1 = SAVE).
 *
 * Exits non-zero on the first failure, printing what it saw.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
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
// 25 MiB until the shared engine's peak memory is reduced (research.md G2, owner decision 2026-11-08).
const LARGE_MB = Number(LARGE_MB_OPT ?? 25);
const SKIP_NEGATIVE = flag('--skip-negative');
const NETWORK_ON = flag('--network-on');
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

/** Minimal PNG decoder for `screencap -p` output: 8-bit RGB/RGBA, non-interlaced. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) fail('screencap did not return a PNG');
  let p = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const color = data[9];
      if (depth !== 8 || data[12] !== 0 || (color !== 2 && color !== 6)) {
        fail(`unsupported PNG (depth ${depth}, color ${color}, interlace ${data[12]})`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= channels ? up[i - channels] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v & 0xff;
    }
  }
  return { width, height, channels, px };
}

async function caseContentHidden() {
  console.log('▶ content hidden (C8, FR-023)');
  await launchFresh();
  await openPdf('sample.pdf');
  const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 });
  const img = decodePng(png);
  // Spike S8 method: a 40 px grid over the app window, skipping the status and navigation bars.
  const top = Math.round(img.height * 0.045);
  const bottom = img.height - Math.round(img.height * 0.07);
  let sampled = 0;
  let lit = 0;
  for (let y = top; y < bottom; y += 40) {
    for (let x = 0; x < img.width; x += 40) {
      const o = (y * img.width + x) * img.channels;
      sampled++;
      if (img.px[o] > 8 || img.px[o + 1] > 8 || img.px[o + 2] > 8) lit++;
    }
  }
  console.log(
    `    ${img.width}x${img.height}, ${sampled} samples in y ${top}..${bottom}, ${lit} non-black`,
  );
  if (lit) {
    writeFileSync(join(WORK, 'screencap.png'), png);
    fail(`screencap shows content: ${lit} of ${sampled} samples are not black`);
  }
}

function appUid() {
  const m = shell(`cmd package list packages -U ${PKG}`).match(
    new RegExp(`package:${PKG.replace(/\./g, '\\.')} uid:(\\d+)`),
  );
  if (!m) fail('could not read the app UID');
  return m[1];
}

/** Every netstats record for `uid` with bytes in either direction (C12). */
function trafficFor(uid) {
  try {
    shell('dumpsys netstats --poll >/dev/null');
  } catch {
    // older builds lack --poll; the detail dump still reflects the last poll
  }
  const out = shell('dumpsys netstats detail');
  const hits = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    const key = line.match(/\buid=(-?\d+) set=(\w+) tag=(0x[0-9a-f]+)/i);
    if (key) {
      current = key[1] === uid ? line.trim() : null;
      continue;
    }
    const b = current && line.match(/\brb=(\d+).*\btb=(\d+)/);
    if (b && (Number(b[1]) > 0 || Number(b[2]) > 0)) hits.push(`${current} :: ${line.trim()}`);
  }
  return hits;
}

async function caseNetworkOn() {
  console.log('▶ no traffic with the network on (C12, SC-003)');
  shell('cmd connectivity airplane-mode disable');
  try {
    await sleep(5000);
    const uid = appUid();
    for (const f of deviceFiles())
      if (/^sample-signed/.test(f)) shell(`rm -f '${DEVICE_DIR}/${f}'`);
    const out = await signAndSave('sample.pdf');
    validate([out.local]);
    await sleep(3000);
    const hits = trafficFor(uid);
    console.log(`    app uid ${uid}: ${hits.length} traffic record(s)`);
    for (const h of hits) console.log(`      ${h}`);
    if (hits.length) fail(`the app UID has network traffic`);
  } finally {
    shell('cmd connectivity airplane-mode enable');
  }
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
  // Incompressible padding sets the file size; it must stay under LIMITS.pdfBytes (100 MiB).
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
  await caseContentHidden();
  if (NETWORK_ON) await caseNetworkOn();
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

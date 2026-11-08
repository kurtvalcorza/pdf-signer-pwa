#!/usr/bin/env node
/**
 * Android release gate (feature 003, research R13, contracts/apk-checks.md C10–C11).
 *
 * Drives the SIGNED RELEASE APK on a running emulator through the accessibility tree
 * (`uiautomator dump` + `input`), which works under FLAG_SECURE and across apps (the system
 * picker and save dialog). No test APK, no debug build, no WebView DevTools.
 *
 *   node scripts/android-gate.mjs <apk> [--adb <path>] [--network-on] [--large | --large-mb <n>]
 *                                 [--skip-negative] [--backup] [--camera]
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
 *   --backup        US3: a remembered certificate is refused by backup (bmgr, local transport,
 *                   with a positive control), Forget removes it, and uninstall leaves nothing
 *   --camera        US4: photo → clean up → sign → validate, the photo is in the PDF; backing out
 *                   leaves the picker working with no prompt; a 48 MP image is refused
 *
 * Driver rules from the spike (S9): dump twice after a launch, and tap only from a fresh dump,
 * by resource id where one exists (android:id/button1 = SAVE).
 *
 * Exits non-zero on the first failure, printing what it saw.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync, inflateSync } from 'node:zlib';
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
const BACKUP = flag('--backup');
const CAMERA = flag('--camera');
const ADB = option('--adb') || process.env.ADB || 'adb';
const APK = argv[0] && resolve(argv[0]);
if (!APK || !existsSync(APK)) {
  console.error(
    'usage: node scripts/android-gate.mjs <signed-release.apk> [--adb <path>] [--network-on] [--large | --large-mb <n>] [--skip-negative] [--backup] [--camera]',
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

const REMEMBER = /^Remember this certificate on this device/;

/**
 * Ticks "Remember this certificate". The WebView's accessibility tree reports every checkbox as
 * checked="false" (WebView 133, 2026-11-08), so the tick is proved by its effect instead: callers
 * check that the certificate is remembered on a fresh launch. Only a freshly chosen certificate
 * is ticked; a remembered one (Forget shown) is already ticked and a tap would clear it.
 */
async function tickRemember() {
  const ns = dump();
  if (ns.some((n) => /^Forget/.test(n.text))) fail('tickRemember: a certificate is already remembered');
  const n = await waitFor('the Remember checkbox', (all) =>
    all.find((x) => x.cls === 'CheckBox' && REMEMBER.test(x.text)),
  );
  shell(`input tap ${n.x} ${n.y}`);
  await sleep(600);
  console.log('    tick Remember this certificate');
}

/**
 * Opens the certificate sheet on a fresh launch WITHOUT choosing a certificate, and reports
 * whether the shared app shows one as remembered (its label plus a Forget button).
 */
async function rememberedOnFreshLaunch() {
  await launchFresh();
  await openPdf('sample.pdf');
  await placeSignature({ page2: false });
  await tap('Sign with a digital certificate', /^Sign with a digital certificate/);
  await waitFor('the certificate sheet', find(/^Certificate password$|^Choose certificate|e2e-cert\.p12/));
  // The stored record is read asynchronously: give it time before calling it absent.
  const hit = await waitFor(
    'a remembered certificate',
    (ns) => ns.some((n) => /^Forget/.test(n.text)) && ns.some((n) => /e2e-cert\.p12/.test(n.text)),
    8000,
  ).catch(() => false);
  return !!hit;
}

/** Signs `input` and saves it. Returns the pulled local path and the device file name. */
async function signAndSave(input, { page2 = false, remember = false } = {}) {
  await launchFresh();
  await openPdf(input);
  await placeSignature({ page2 });
  await fillCertificate(PASSWORD);
  if (remember) await tickRemember();
  return signAndSaveOpen(input);
}

/** With `input` open, a signature placed and the certificate filled: sign, save, pull. */
async function signAndSaveOpen(input) {
  // An earlier case may have left a file with the same name; the save dialog would then write
  // "<name> (1).pdf" and the pull below would fetch the stale file (caught by the size check).
  shell(`rm -f '${DEVICE_DIR}/${input.replace(/\.pdf$/i, '')}-signed.pdf'`);
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
// Counts image XObjects reachable from page 1 (through form XObjects such as a signature
// appearance), with pyHanko's reader, which the validator already needs.
const IMAGES_PY = String.raw`
import sys
from pyhanko.pdf_utils.reader import PdfFileReader
def walk(res, seen, out):
    xo = res.get('/XObject') if res is not None else None
    if xo is None:
        return
    xo = xo.get_object()
    for k in xo:
        o = xo.raw_get(k)
        ref = getattr(o, 'idnum', None)
        if ref in seen:
            continue
        seen.add(ref)
        o = o.get_object()
        if o.get('/Subtype') == '/Image':
            out.append((int(o['/Width']), int(o['/Height'])))
        elif o.get('/Subtype') == '/Form':
            walk(o.get('/Resources'), seen, out)
with open(sys.argv[1], 'rb') as f:
    r = PdfFileReader(f, strict=False)
    page = r.root['/Pages']['/Kids'][0].get_object()
    out = []
    walk(page.get('/Resources'), set(), out)
    annots = page.get('/Annots') or []
    for a in annots:
        ap = a.get_object().get('/AP')
        if ap is not None and '/N' in ap:
            n = ap['/N'].get_object()
            walk(n.get('/Resources'), set(), out)
    print(len(out), ' '.join(f'{w}x{h}' for w, h in out))
`;

function pageOneImages(file) {
  const r = spawnSync(PY, ['-c', IMAGES_PY, file], { encoding: 'utf8' });
  if (r.status !== 0) fail(`image count failed for ${file}:\n${r.stderr}`);
  const [count, ...dims] = r.stdout.trim().split(/\s+/);
  return { count: Number(count), dims };
}

/** A tiny PNG whose header claims w x h: the shared app checks the header before decoding. */
function oversizedPng(path, w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.alloc(0))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** Fails if Android ever asks the user to grant this app a permission. */
const askedForPermission = (ns) =>
  ns.some((n) => /permissioncontroller|packageinstaller/.test(n.pkg) && /PDF Signer/.test(n.text));

/**
 * Taps "Take photo" and drives the emulator's camera app (com.android.camera2): shutter + Done
 * to keep the photo, or Back to back out. Fails if a permission prompt for this app appears.
 */
async function takePhoto({ keep }) {
  await tap('Take photo', /Take photo$/);
  const shutter = await waitFor(
    'the camera app',
    (ns) => {
      if (askedForPermission(ns)) fail('Android asked to grant PDF Signer a permission');
      return ns.find((n) => n.id === 'com.android.camera2:id/shutter_button');
    },
    30000,
  );
  if (!keep) {
    shell('input keyevent KEYCODE_BACK');
    console.log('    back out of the camera');
    return;
  }
  await sleep(1500); // let the preview settle
  shell(`input tap ${shutter.x} ${shutter.y}`);
  console.log('    tap Shutter');
  await tap('Done', /^com\.android\.camera2:id\/done_button$/, 20000);
}

async function caseCamera() {
  console.log('▶ camera capture (US4, FR-011)');
  // AS1: capture → clean up → sign → validate, and the photo is in the signed PDF.
  await launchFresh();
  await openPdf('sample.pdf');
  clearLog();
  await takePhoto({ keep: true });
  const got = await waitLog('the capture handed to WebView', /CHOOSER capture bytes=(\d+)/, 20000);
  await waitFor('the placed photo', find(/^Remove signature$/), 30000);
  console.log(`    capture ${got[1]} bytes placed as the signature`);
  await tap('Clean up background', /^Clean up background$/);
  await tap('Use cleaned', /^Use cleaned$/, 30000);
  await fillCertificate(PASSWORD);
  const out = await signAndSaveOpen('sample.pdf');
  validate([out.local]);
  const before = pageOneImages(join(FIXTURES, 'sample.pdf'));
  const after = pageOneImages(out.local);
  if (after.count <= before.count)
    fail(`no image added to page 1: ${before.count} before, ${after.count} after`);
  console.log(`    page 1 images: ${before.count} before, ${after.count} after (${after.dims.join(', ')})`);
  shell(`rm -f '${DEVICE_DIR}/${out.name}'`);

  // AS2: back out → nothing placed, the image picker still works, and nothing is asked again.
  await launchFresh();
  await openPdf('sample.pdf');
  clearLog();
  await takePhoto({ keep: false });
  await waitLog('the capture cancelled', /CHOOSER capture cancelled/, 20000);
  await waitFor('back in the app', find(/^Add signature$/), 20000);
  if (dump().some((n) => /^Remove signature$/.test(n.text))) fail('a signature was placed after backing out');
  await placeSignature({ page2: false });
  console.log('    backed out: nothing placed; the image picker still works');
  clearLog();
  await takePhoto({ keep: false });
  await waitLog('the second capture cancelled', /CHOOSER capture cancelled/, 20000);
  console.log('    the camera opens again with no prompt');

  // AS3: an image over LIMITS.imagePixels is refused with the shared app's message. The emulator's
  // camera can't exceed 40 MP, so a pushed PNG goes through the same readImageFile path.
  const big = join(WORK, 'gate-oversized.png');
  oversizedPng(big, 8000, 6000);
  push(big);
  await launchFresh();
  await openPdf('sample.pdf');
  await tap('Add signature', /^Add signature$/);
  await pickFile('gate-oversized.png');
  await waitFor(
    'the too-large message',
    find(/This image is too large\. The limit is 40 megapixels\./),
    20000,
  );
  if (dump().some((n) => /^Remove signature$/.test(n.text))) fail('the oversized image was placed');
  console.log('    48 MP image refused with the shared message');
}

function bmgr(args) {
  return shell('bmgr ' + args).trim();
}

async function caseBackup() {
  console.log('▶ remembered certificate: backup, Forget, uninstall (US3, Q8)');
  const first = await signAndSave('sample.pdf', { remember: true });
  shell("rm -f '" + DEVICE_DIR + '/' + first.name + "'");
  // Positive control for the rest: the certificate really is remembered.
  if (!(await rememberedOnFreshLaunch()))
    fail('the certificate was not remembered after opting in, so the checks below prove nothing');
  console.log('    remembered across a fresh launch');

  // AS1 (cloud half): the package contributes no backup data.
  const wasEnabled = !/disabled/.test(bmgr('enabled'));
  const wasTransport = bmgr('list transports')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('*'))
    ?.replace('*', '')
    .trim();
  try {
    bmgr('enable true');
    const sel = bmgr('transport com.android.localtransport/.LocalTransport');
    if (!/LocalTransport/.test(sel)) fail('could not select the local transport: ' + sel);
    const control = bmgr('backupnow com.android.providers.settings');
    if (!/Package com\.android\.providers\.settings with result: Success/.test(control))
      fail('positive control failed, the transport backs up nothing:\n' + control);
    const out = bmgr('backupnow ' + PKG);
    const line = out.split(/\r?\n/).find((l) => l.includes('Package ' + PKG + ' with result:'));
    if (!line) fail('bmgr did not report on ' + PKG + ':\n' + out);
    if (/result: Success/.test(line)) fail('the package contributed backup data: ' + line);
    console.log('    ' + line.trim() + ' (control: the settings provider backed up)');
  } finally {
    if (wasTransport) bmgr('transport ' + wasTransport);
    if (!wasEnabled) bmgr('enable false');
  }

  // AS2: Forget removes it, and a fresh launch shows nothing remembered.
  await tap('Forget', /^Forget$/);
  await waitFor('the certificate gone from the sheet', find(/^Choose certificate/), 15000);
  if (await rememberedOnFreshLaunch()) fail('the certificate is still remembered after Forget');
  console.log('    Forget: nothing remembered on a fresh launch');

  // AS3: remember again, uninstall, reinstall: nothing remains.
  const again = await signAndSave('sample.pdf', { remember: true });
  shell("rm -f '" + DEVICE_DIR + '/' + again.name + "'");
  if (!(await rememberedOnFreshLaunch())) fail('the certificate was not remembered the second time');
  adb('uninstall', PKG);
  adb('install', APK);
  if (await rememberedOnFreshLaunch()) fail('a remembered certificate survived uninstall');
  console.log('    uninstall + reinstall: nothing remembered');
}

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
  if (CAMERA) await caseCamera();
  if (BACKUP) await caseBackup();
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

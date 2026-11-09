#!/usr/bin/env node
/**
 * Static release checks on the Android APK (feature 003, contracts/apk-checks.md C1, C3–C7, C9).
 *
 *   node scripts/android-check-apk.mjs <apk> [--dist dist] [--fingerprint android/SIGNING_FINGERPRINT]
 *                                      [--base <git-ref>] [--sdk <android-sdk>] [--skip-c3]
 *
 * Run it on the SIGNED RELEASE APK that is published (Principle V). C3 needs a signed APK; pass
 * --skip-c3 only for an unsigned local build. C2 (dependency allow-list) runs inside the Gradle
 * build (verifyDependencyAllowlist); C8 and C10–C12 run on an emulator (android-gate.mjs).
 *
 * Each check prints the evidence it judged. Nothing here reads or prints a secret: C3 reads the
 * public certificate only. Exits non-zero if any check fails.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const PKG = 'io.github.kurtvalcorza.pdfsigner';
const ALLOWED_PERMISSION = `${PKG}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`;
const PROTECTION_SIGNATURE = 0x2;
const LAUNCHER = `${PKG}.MainActivity`;
const DOMAINS = [
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
];
const SHARED_PATHS = ['src/', 'index.html', 'vite.config.ts'];
const SHELL_PATTERN = /pdfSignerShell|appassets|androidplatform|android/i;

// ---------------------------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const takeFlag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const takeOption = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const DIST = resolve(takeOption('--dist') || 'dist');
const FINGERPRINT_FILE = takeOption('--fingerprint');
const BASE = takeOption('--base');
const SDK_OPT = takeOption('--sdk');
const SKIP_C3 = takeFlag('--skip-c3');
const APK = argv[0] && resolve(argv[0]);
if (!APK || !existsSync(APK)) {
  console.error(
    'usage: node scripts/android-check-apk.mjs <apk> [--dist dist] [--fingerprint file] [--base ref] [--sdk dir] [--skip-c3]',
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------------- tools
function sdkRoot() {
  const candidates = [
    SDK_OPT,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    process.env.HOME && join(process.env.HOME, 'Android', 'Sdk'),
  ].filter(Boolean);
  const hit = candidates.find((d) => existsSync(join(d, 'build-tools')));
  if (!hit)
    throw new Error(`no Android SDK with build-tools found (tried ${candidates.join(', ')})`);
  return hit;
}
function newestBuildTools(root) {
  const versions = readdirSync(join(root, 'build-tools')).filter((v) => /^\d+(\.\d+)*$/.test(v));
  versions.sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
    }
    return 0;
  });
  if (!versions.length) throw new Error('no build-tools version installed');
  return join(root, 'build-tools', versions[0]);
}
// ANDROID_BUILD_TOOLS pins a version (the release job pins the one it signed with); otherwise the
// newest installed. apksigner's output format changes between build-tools versions.
const BT = process.env.ANDROID_BUILD_TOOLS
  ? join(sdkRoot(), 'build-tools', process.env.ANDROID_BUILD_TOOLS)
  : newestBuildTools(sdkRoot());
if (!existsSync(BT)) throw new Error(`build-tools not found: ${BT}`);
const AAPT2 = join(BT, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
// The jar, not apksigner(.bat): a .bat can't be spawned with shell:false on Windows.
const APKSIGNER_JAR = join(BT, 'lib', 'apksigner.jar');
const JAVA = process.env.JAVA_HOME
  ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : 'java';

const run = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// ---------------------------------------------------------------------------------- xmltree parser
/**
 * Parses `aapt2 dump xmltree` output into { name, attrs, children } elements. An element's
 * attributes are indented 2 past it, its child elements 4 past it.
 */
function parseXmlTree(text) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [{ indent: -1, node: root }];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\s*)(E|A): (.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (m[2] === 'E') {
      const node = { name: m[3].replace(/\s*\(line=\d+\)$/, ''), attrs: {}, children: [] };
      parent.children.push(node);
      stack.push({ indent, node });
    } else {
      const a = m[3].match(/^(?:\S+:)?([\w-]+)(?:\(0x[0-9a-f]+\))?=(.*)$/i);
      if (!a) continue;
      const q = a[2].match(/^"(.*)" \(Raw: .*\)$/);
      parent.attrs[a[1]] = q ? q[1] : a[2];
    }
  }
  return root;
}
function* walk(node) {
  yield node;
  for (const c of node.children) yield* walk(c);
}
const isTrue = (v) => v === 'true' || v === '0xffffffff' || v === '-1';
const isFalse = (v) => v === 'false' || v === '0x00000000' || v === '0';

// ---------------------------------------------------------------------------------- zip reader
/** Reads every entry of a zip (APK) into memory: Map<name, Buffer>. Stored and deflated only. */
function readZip(file) {
  const buf = readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------------------------- checks
const results = [];
function check(id, title, fn) {
  console.log(`\n── ${id}: ${title}`);
  try {
    const verdict = fn();
    const note = typeof verdict === 'string' ? verdict : '';
    results.push({ id, ok: true, note });
    console.log(`   ✓ ${id}${note ? ` (${note})` : ''}`);
  } catch (e) {
    results.push({ id, ok: false, note: e.message });
    console.log(`   ✗ ${id}: ${e.message}`);
  }
}
const evidence = (label, value) => console.log(`   ${label}: ${value}`);

console.log(`APK ${APK}`);
console.log(`build-tools ${BT}`);

const manifest = parseXmlTree(
  run(AAPT2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', APK]),
);
const elements = [...walk(manifest)];
const application = elements.find((e) => e.name === 'application');
if (!application) {
  console.error('✗ no <application> in the manifest');
  process.exit(1);
}

let resources = null;
/** "@0x7f0c0001" → "res/4j.xml" (release builds shorten resource paths). */
function resourcePath(ref) {
  const id = ref?.match(/^@0x([0-9a-f]{8})$/i)?.[1];
  if (!id) return null;
  resources ??= run(AAPT2, ['dump', 'resources', APK]);
  const m = resources.match(
    new RegExp(`resource 0x${id} \\S+\\s*\\r?\\n\\s*\\(\\) \\(file\\) (\\S+)`, 'i'),
  );
  return m ? m[1] : null;
}

check('C1', 'no permissions beyond the allowed one', () => {
  const uses = elements
    .filter((e) => e.name === 'uses-permission' || e.name === 'uses-permission-sdk-23')
    .map((e) => e.attrs.name);
  const declared = elements.filter((e) => e.name === 'permission');
  evidence('uses-permission', uses.length ? uses.join(', ') : '(none)');
  evidence(
    'permission',
    declared.length
      ? declared.map((d) => `${d.attrs.name} protectionLevel=${d.attrs.protectionLevel}`).join(', ')
      : '(none)',
  );
  const extra = uses.filter((u) => u !== ALLOWED_PERMISSION);
  if (extra.length) throw new Error(`unexpected permission(s): ${extra.join(', ')}`);
  const foreign = declared.filter((x) => x.attrs.name !== ALLOWED_PERMISSION);
  if (foreign.length)
    throw new Error(
      `unexpected declared permission(s): ${foreign.map((x) => x.attrs.name).join(', ')}`,
    );
  if (uses.includes(ALLOWED_PERMISSION)) {
    const d = declared.find((x) => x.attrs.name === ALLOWED_PERMISSION);
    if (!d) throw new Error(`${ALLOWED_PERMISSION} is used but not declared`);
    if ((Number(d.attrs.protectionLevel) & 0xf) !== PROTECTION_SIGNATURE) {
      throw new Error(`protectionLevel ${d.attrs.protectionLevel} is not signature`);
    }
  }
});

check('C3', 'signing identity', () => {
  if (SKIP_C3) return 'SKIPPED by --skip-c3: unsigned build, never a release';
  const r = spawnSync(JAVA, ['-jar', APKSIGNER_JAR, 'verify', '--verbose', '--print-certs', APK], {
    encoding: 'utf8',
    maxBuffer: 16 << 20,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const line = (re) => out.match(re)?.[1];
  const v2 = line(/Verified using v2 scheme \(APK Signature Scheme v2\): (\w+)/);
  const v3 = line(/Verified using v3 scheme \(APK Signature Scheme v3\): (\w+)/);
  // Older apksigner labels signers "Signer #1"; newer ones may label them by SDK range. Take every
  // signer's digest: they must all be one certificate, and an unparsed output fails closed.
  const digests = [
    ...out.matchAll(/^Signer\b[^\n]*? certificate SHA-256 digest: ([0-9a-f]{64})\s*$/gim),
  ].map((m) => m[1].toLowerCase());
  if (!digests.length)
    evidence(
      'apksigner signer lines',
      out
        .split(/\r?\n/)
        .filter((l) => /^Signer\b/.test(l))
        .join(' | ') || '(none)',
    );
  if (new Set(digests).size > 1)
    throw new Error(`more than one signing certificate: ${digests.join(', ')}`);
  const digest = digests[0];
  evidence('verified', r.status === 0 ? 'yes' : 'NO');
  evidence('v2', v2);
  evidence('v3', v3);
  evidence('certificate SHA-256', digest || '(none)');
  evidence('certificate DN', line(/^Signer\b[^\n]*? certificate DN: (.+)$/m) || '(none)');
  if (r.status !== 0) throw new Error('apksigner verify failed');
  if (v2 !== 'true') throw new Error('v2 signature missing');
  if (v3 !== 'true') throw new Error('v3 signature missing');
  if (!digest)
    throw new Error('could not read a certificate digest from apksigner (signer lines above)');
  if (!FINGERPRINT_FILE)
    return 'fingerprint NOT pinned: a release passes --fingerprint android/SIGNING_FINGERPRINT';
  const expected = readFileSync(resolve(FINGERPRINT_FILE), 'utf8')
    .replace(/[^0-9a-f]/gi, '')
    .toLowerCase();
  evidence('expected SHA-256', expected);
  if (expected.length !== 64)
    throw new Error(`${FINGERPRINT_FILE} does not hold a SHA-256 fingerprint`);
  if (digest?.toLowerCase() !== expected)
    throw new Error('certificate does not match the pinned fingerprint');
});

check('C4', 'exported surface', () => {
  const kinds = ['activity', 'activity-alias', 'service', 'receiver', 'provider'];
  const components = application.children.filter((c) => kinds.includes(c.name));
  const filtersOf = (c) => c.children.filter((x) => x.name === 'intent-filter');
  for (const c of components) {
    evidence(
      c.name,
      `${c.attrs.name} exported=${c.attrs.exported ?? '(unset)'} filters=${filtersOf(c).length}`,
    );
  }
  for (const c of components) {
    // Unset exported with an intent filter means exported (pre-API-31 rule): treat it as exported.
    const exported =
      isTrue(c.attrs.exported) || (c.attrs.exported === undefined && filtersOf(c).length > 0);
    if (!exported) continue;
    if (c.name === 'provider') throw new Error(`exported provider ${c.attrs.name}`);
    if (!(c.name === 'activity' && c.attrs.name === LAUNCHER))
      throw new Error(`exported ${c.name} ${c.attrs.name}`);
  }
  for (const c of components) {
    for (const f of filtersOf(c)) {
      const actions = f.children.filter((x) => x.name === 'action').map((x) => x.attrs.name);
      const cats = f.children.filter((x) => x.name === 'category').map((x) => x.attrs.name);
      const data = f.children.filter((x) => x.name === 'data');
      const ok =
        c.attrs.name === LAUNCHER &&
        actions.join() === 'android.intent.action.MAIN' &&
        cats.join() === 'android.intent.category.LAUNCHER' &&
        data.length === 0;
      if (!ok)
        throw new Error(`intent filter on ${c.attrs.name}: actions=${actions} categories=${cats}`);
    }
  }
  const launcher = components.find((c) => c.attrs.name === LAUNCHER);
  if (!launcher || !isTrue(launcher.attrs.exported))
    throw new Error('launcher activity missing or not exported');
});

function excludesEverything(nodes, label) {
  if (!nodes.length) throw new Error(`<${label}> missing`);
  for (const n of nodes) {
    const all = [...walk(n)];
    if (all.some((e) => e.name === 'include')) throw new Error(`<${label}> has an <include>`);
    const excluded = new Set(
      all.filter((e) => e.name === 'exclude' && e.attrs.path === '.').map((e) => e.attrs.domain),
    );
    evidence(label, `excludes ${[...excluded].join(', ')}`);
    const missing = DOMAINS.filter((d) => !excluded.has(d));
    if (missing.length) throw new Error(`<${label}> does not exclude ${missing.join(', ')}`);
  }
}

check('C5', 'backup and transfer exclusion', () => {
  evidence('allowBackup', application.attrs.allowBackup ?? '(unset)');
  if (!isFalse(application.attrs.allowBackup)) throw new Error('allowBackup is not false');
  const dataRules = resourcePath(application.attrs.dataExtractionRules);
  const fullRules = resourcePath(application.attrs.fullBackupContent);
  evidence('dataExtractionRules', `${application.attrs.dataExtractionRules} → ${dataRules}`);
  evidence('fullBackupContent', `${application.attrs.fullBackupContent} → ${fullRules}`);
  if (!dataRules) throw new Error('dataExtractionRules absent');
  if (!fullRules) throw new Error('fullBackupContent absent');
  const data = [...walk(parseXmlTree(run(AAPT2, ['dump', 'xmltree', '--file', dataRules, APK])))];
  excludesEverything(
    data.filter((e) => e.name === 'cloud-backup'),
    'cloud-backup',
  );
  excludesEverything(
    data.filter((e) => e.name === 'device-transfer'),
    'device-transfer',
  );
  const full = [...walk(parseXmlTree(run(AAPT2, ['dump', 'xmltree', '--file', fullRules, APK])))];
  excludesEverything(
    full.filter((e) => e.name === 'full-backup-content'),
    'full-backup-content',
  );
});

check('C6', 'release hardening', () => {
  const meta = Object.fromEntries(
    application.children
      .filter((c) => c.name === 'meta-data')
      .map((c) => [c.attrs.name, c.attrs.value]),
  );
  evidence('debuggable', application.attrs.debuggable ?? '(unset)');
  evidence('WebView.MetricsOptOut', meta['android.webkit.WebView.MetricsOptOut']);
  evidence('WebView.EnableSafeBrowsing', meta['android.webkit.WebView.EnableSafeBrowsing']);
  if (application.attrs.debuggable !== undefined && !isFalse(application.attrs.debuggable)) {
    throw new Error('debuggable is set');
  }
  if (!isTrue(meta['android.webkit.WebView.MetricsOptOut']))
    throw new Error('MetricsOptOut is not true');
  if (!isFalse(meta['android.webkit.WebView.EnableSafeBrowsing']))
    throw new Error('EnableSafeBrowsing is not false');
});

check('C7', 'same web build as dist/', () => {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error(`${DIST} has no index.html`);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const want = new Map();
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) visit(p);
      else want.set(relative(DIST, p).split(sep).join('/'), sha(readFileSync(p)));
    }
  };
  visit(DIST);
  const have = new Map();
  for (const [name, bytes] of readZip(APK)) {
    if (name.startsWith('assets/www/') && !name.endsWith('/'))
      have.set(name.slice('assets/www/'.length), sha(bytes));
  }
  evidence('dist files', want.size);
  evidence('APK assets/www files', have.size);
  for (const [f, h] of [...want].sort()) evidence(f, h.slice(0, 16));
  const problems = [];
  for (const [f, h] of want) {
    if (!have.has(f)) problems.push(`missing ${f}`);
    else if (have.get(f) !== h) problems.push(`differs ${f}`);
  }
  for (const f of have.keys()) if (!want.has(f)) problems.push(`extra ${f}`);
  if (problems.length) throw new Error(problems.join('; '));
});

check('C9', 'no shell code in shared paths', () => {
  let base = BASE;
  if (!base) {
    for (const ref of ['origin/main', 'main']) {
      try {
        base = run('git', ['merge-base', 'HEAD', ref]).trim();
        break;
      } catch {
        // try the next ref
      }
    }
  }
  if (!base) throw new Error('no --base given and no merge-base with main');
  evidence('base', base);
  const commits = run('git', ['log', '--oneline', `${base}..HEAD`, '--', ...SHARED_PATHS]).trim();
  evidence(
    'commits touching shared paths',
    commits ? `\n      ${commits.split('\n').join('\n      ')}` : '(none)',
  );
  const diff = run('git', ['diff', `${base}..HEAD`, '--', ...SHARED_PATHS]);
  const hits = diff
    .split(/\r?\n/)
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l) && SHELL_PATTERN.test(l));
  for (const h of hits) evidence('mention', h);
  if (hits.length) throw new Error(`${hits.length} changed line(s) mention the shell`);
  return commits ? 'each listed commit must be marked distribution-neutral in the PR' : '';
});

// ---------------------------------------------------------------------------------- summary
console.log('\nSummary');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}${r.note ? `  ${r.note}` : ''}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`✗ ${failed.length} check(s) failed: ${failed.map((r) => r.id).join(', ')}`);
  process.exit(1);
}
console.log('✓ all static APK checks passed');

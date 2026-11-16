// In-app controls for the Windows egress gate (issue #23 item 2, RFC 23-2 §4 step 3).
//
// Launches the GATE-ONLY PROBE build and, through the Node inspector (Playwright's
// electronApp.evaluate), makes the app itself attempt egress through both network stacks it
// contains. scripts/windows-egress-gate.ps1 then requires the firewall/audit layer to have seen
// every positive attempt and none of the negative ones. Nothing here is packed into any binary:
// the probe stays the release's exact app.asar plus one fuse byte (scripts/check-fuses.mjs), and
// scripts/ is not in electron-builder's `files`.
//
// Usage: node scripts/egress-control.mjs <out.json> [repeat]
//   PKG_EXE   probe executable (default release-probe/win-unpacked/PDF Signer.exe)
//   repeat    attempts per Node TCP/UDP control, each to a distinct destination port (default 3)
//
// Destinations are documentation ranges (RFC 5737), never routable: 192.0.2.0/24 and 198.51.100.0/24.
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const TARGETS = {
  nodeTcp: { host: '192.0.2.1', firstPort: 443, basePort: 20000 },
  nodeUdp: { host: '198.51.100.1', firstPort: 53, basePort: 21000 },
  nodeDns: 'egress-probe-node.invalid',
  chromiumDns: 'egress-probe-chromium.invalid',
  // NEGATIVE: defaultSession carries the layer-2 webRequest block (electron/network.js), so this
  // must be cancelled before a socket exists.
  defaultSessionUrl: 'http://192.0.2.2/',
  // NEGATIVE: renderer fetch, stopped by CSP and layer 2.
  rendererUrl: 'http://192.0.2.3/',
  // POSITIVE: an unlocked throwaway partition, so Chromium's network service really connects.
  partitionUrl: 'http://192.0.2.4/',
  partition: 'egress-gate-control',
};

const [outFile, repeatArg] = process.argv.slice(2);
if (!outFile) {
  console.error('usage: node scripts/egress-control.mjs <out.json> [repeat]');
  process.exit(2);
}
const repeat = Math.max(1, Number(repeatArg || 3));
const exe = resolve(process.env.PKG_EXE || 'release-probe/win-unpacked/PDF Signer.exe');
const portableDir = mkdtempSync(join(tmpdir(), 'pdfsigner-egress-control-'));
const out = { exe, repeat, started: new Date().toISOString() };

const app = await electron.launch({
  executablePath: exe,
  env: { ...process.env, PDFSIGNER_HEADLESS: '1', PORTABLE_EXECUTABLE_DIR: portableDir },
});
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  Object.assign(
    out,
    await app.evaluate(
      async ({ app, session, net: electronNet }, { T, repeat }) => {
        // The shell is CommonJS (electron/package.json), so the main module's require reaches Node
        // built-ins from an inspector evaluate (confirmed on the runner, run 43802298765).
        const load = (m) => process.mainModule.require(m);
        const net = load('node:net');
        const dgram = load('node:dgram');
        const dns = load('node:dns');

        const tcp = (host, port) =>
          new Promise((done) => {
            const s = net.connect({ host, port });
            let fin = false;
            const end = (ev, code) => {
              if (fin) return;
              fin = true;
              s.destroy(); // closed at once: the short-lived case the socket sampler cannot see
              done({ host, port, ev, code });
            };
            s.once('connect', () => end('connect'));
            s.once('error', (e) => end('error', e.code));
            setTimeout(() => end('timeout'), 1000);
          });
        const udp = (host, port) =>
          new Promise((done) => {
            const s = dgram.createSocket('udp4');
            let fin = false;
            const end = (ev, code) => {
              if (fin) return;
              fin = true;
              try {
                s.close();
              } catch {
                /* already closed */
              }
              done({ host, port, ev, code });
            };
            s.once('error', (e) => end('error', e.code));
            s.send(Buffer.from('x'), port, host, (err) => end('sent', err ? err.code : undefined));
            setTimeout(() => end('timeout'), 1000);
          });
        const request = (url, ses) =>
          new Promise((done) => {
            const req = electronNet.request(ses ? { url, session: ses } : { url });
            const timer = setTimeout(() => {
              req.abort();
              done({ url, ev: 'timeout' });
            }, 8000);
            req.on('response', (r) => {
              clearTimeout(timer);
              done({ url, ev: 'response', status: r.statusCode });
            });
            req.on('error', (e) => {
              clearTimeout(timer);
              done({ url, ev: 'error', message: e.message });
            });
            req.end();
          });
        const port = (t, i) => (i === 0 ? t.firstPort : t.basePort + i);

        const attempts = { nodeTcp: [], nodeUdp: [] };
        for (let i = 0; i < repeat; i++) attempts.nodeTcp.push(await tcp(T.nodeTcp.host, port(T.nodeTcp, i)));
        for (let i = 0; i < repeat; i++) attempts.nodeUdp.push(await udp(T.nodeUdp.host, port(T.nodeUdp, i)));
        attempts.nodeDns = await new Promise((done) =>
          dns.lookup(T.nodeDns, (e) => done({ name: T.nodeDns, code: e ? e.code : 'RESOLVED' })),
        );
        attempts.chromiumDns = await session.defaultSession.resolveHost(T.chromiumDns).then(
          () => ({ name: T.chromiumDns, result: 'RESOLVED' }),
          (e) => ({ name: T.chromiumDns, result: String(e.message || e) }),
        );
        attempts.defaultSession = await request(T.defaultSessionUrl);
        attempts.partition = await request(T.partitionUrl, session.fromPartition(T.partition));

        const pids = app
          .getAppMetrics()
          .map((m) => ({ pid: m.pid, type: m.type, serviceName: m.serviceName || null }));
        const ns = pids.find((p) => p.serviceName === 'network.mojom.NetworkService');
        return { mainPid: process.pid, networkServicePid: ns ? ns.pid : null, pids, attempts };
      },
      { T: TARGETS, repeat },
    ),
  );

  out.attempts.renderer = {
    url: TARGETS.rendererUrl,
    result: await page.evaluate(
      (url) =>
        fetch(url).then(
          (r) => 'response ' + r.status,
          (e) => 'rejected ' + String(e),
        ),
      TARGETS.rendererUrl,
    ),
  };
  // Let any deferred network-service activity reach the audit log before the processes exit.
  await new Promise((r) => setTimeout(r, 2000));
} catch (e) {
  out.error = String(e && e.stack ? e.stack : e);
} finally {
  out.finished = new Date().toISOString();
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  await app.close().catch(() => {});
  rmSync(portableDir, { recursive: true, force: true });
}
console.log(`[egress-control] ${out.error ? 'FAILED: ' + out.error : 'attempts made'} -> ${outFile}`);
process.exit(out.error ? 1 : 0);

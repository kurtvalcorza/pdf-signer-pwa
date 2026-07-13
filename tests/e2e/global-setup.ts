import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Regenerate E2E fixtures (sample.pdf, signature.png, e2e-cert.p12) before the run.
 * The .p12 is gitignored (never commit certs), so it must be produced here.
 */
export default function globalSetup(): void {
  execFileSync(process.execPath, [resolve('scripts/make-e2e-fixtures.mjs')], { stdio: 'inherit' });
}

/**
 * Regenerate E2E fixtures (sample.pdf, signature.png, e2e-cert.p12) before the run.
 * The .p12 is gitignored (never commit certs), so it must be produced here.
 */
export default async function globalSetup(): Promise<void> {
  await import('../../scripts/make-e2e-fixtures.mjs');
}

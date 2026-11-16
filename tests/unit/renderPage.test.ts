/**
 * Preview scripting (spec 004 T030, threat T9, research.md R7).
 *
 * The page preview hands untrusted PDF bytes to pdf.js. A certified form may carry JavaScript
 * actions on its fields; the preview must run none of them. pdf.js only runs document scripts
 * through its viewer's scripting manager and sandbox, which this app never loads, so what is
 * pinned here is the call itself: the options that would let a document's code or XFA run are
 * set off explicitly at `getDocument`, rather than left to pdf.js defaults that could change.
 *
 * The fixture is real: pdf.js itself reports the field's actions, so the test cannot pass on a
 * document that has nothing to run. tests/e2e/us7-certified-field.spec.ts opens the same fixture
 * in the app and checks that nothing ran.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const getDocument = vi.fn();
vi.mock('pdfjs-dist', () => ({ getDocument, GlobalWorkerOptions: {} }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }));

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../signing/fixtures/policy/certified-p2-empty-field-aa-javascript.pdf',
);

describe('the page preview runs no document script (T030)', () => {
  beforeEach(() => {
    getDocument.mockReset();
    // Built per call, so no rejected promise is left unhandled by a test that never renders.
    getDocument.mockImplementation(() => ({
      promise: Promise.reject(new Error('stop after getDocument')),
      destroy: () => Promise.resolve(),
    }));
  });

  it('the fixture carries JavaScript actions on its signature field', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(FIXTURE)),
      isEvalSupported: false,
      useWorkerFetch: false,
    }).promise;
    const annotations = await (await doc.getPage(1)).getAnnotations();
    const approver = annotations.find((a: { fieldName?: string }) => a.fieldName === 'Approver');
    expect(JSON.stringify(approver?.actions ?? null)).toContain("app.alert('field action ran');");
    await doc.destroy();
  });

  it('pins scripting, eval and XFA off at getDocument', async () => {
    const { renderPage } = await import('../../src/features/viewer/renderPage');
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const canvas = {} as HTMLCanvasElement;
    const handle = renderPage(bytes, 0, canvas, 200);
    await expect(handle.promise).rejects.toThrow('stop after getDocument');

    expect(getDocument).toHaveBeenCalledTimes(1);
    const params = getDocument.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toMatchObject({ isEvalSupported: false, enableXfa: false });
    expect(params.data).toEqual(bytes);
    // A copy, so pdf.js transferring the buffer to its worker cannot empty the app's bytes.
    expect(params.data).not.toBe(bytes);
  });
});

/**
 * Guards of the classification that no pyHanko-built fixture reaches (review finding R3).
 *
 * Each case parses a committed fixture, changes one thing in the parsed document, and classifies
 * it against the fixture's real bytes. The document-level and per-field rules read the parsed
 * document, so the change is seen; rule 5c and rule 5d read the bytes, so they still pass. Every
 * case asserts the exact reason, so it fails when its guard is removed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { classifySigning } from '../../src/features/signing/signingPolicy';
import {
  MAX_FORM_NODES,
  analyzeRevisions,
  partialName,
  walkFormNodes,
} from '../../src/features/signing/revisions';
import type { SigningClassification } from '../../src/features/signing/types';

const POLICY = resolve(dirname(fileURLToPath(import.meta.url)), '../signing/fixtures/policy');
const load = (name: string) => new Uint8Array(readFileSync(resolve(POLICY, name)));
const N = (s: string) => PDFName.of(s);

async function classified(
  name: string,
  change: (doc: PDFDocument, field: PDFDict) => void,
): Promise<SigningClassification> {
  const bytes = load(name);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const field = walkFormNodes(doc).nodes.find((n) => partialName(n.dict) === 'Approver')!.dict;
  change(doc, field);
  return classifySigning(doc, bytes);
}
const ONE = 'certified-p2-empty-field.pdf';
const form = (doc: PDFDocument) => doc.catalog.lookup(N('AcroForm'), PDFDict);
const reasonOf = (signing: SigningClassification) =>
  signing.kind === 'blocked' ? signing.reason : signing.kind;
const fieldReason = (signing: SigningClassification) =>
  signing.kind === 'ok' ? 'ok' : (signing.ineligible[0]?.reason ?? `${signing.kind}:eligible`);

function addFields(doc: PDFDocument, count: number) {
  const fields = form(doc).lookup(N('Fields'), PDFArray);
  for (let i = 0; i < count; i++) {
    fields.push(doc.context.register(doc.context.obj({ FT: 'Tx' })));
  }
}

describe('document-level guards', () => {
  it('the unchanged fixture is fill-only (control)', async () => {
    expect(reasonOf(await classified(ONE, () => {}))).toBe('fill-only');
  });

  it('a document that cannot be walked is unreadable, never an error', async () => {
    const result = await classifySigning({} as PDFDocument, load(ONE));
    expect(result).toMatchObject({ kind: 'blocked', reason: 'unreadable-policy' });
  });

  it('a certified document without a form is not fillable', async () => {
    const result = await classified(ONE, (doc) => doc.catalog.delete(N('AcroForm')));
    expect(reasonOf(result)).toBe('form-not-fillable');
  });

  it(`more than ${MAX_FORM_NODES} form nodes is refused (T10)`, async () => {
    const result = await classified(ONE, (doc) => addFields(doc, MAX_FORM_NODES));
    expect(reasonOf(result)).toBe('too-many-fields');

    const bytes = load(ONE);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    addFields(doc, MAX_FORM_NODES);
    expect(await analyzeRevisions(doc, bytes)).toEqual({ ok: false, reason: 'too-many-fields' });
  });

  it('a form that is not a tree (a node reachable twice) is unreadable', async () => {
    const result = await classified('certified-p2-inherited-v.pdf', (doc) => {
      const group = walkFormNodes(doc).nodes.find((n) => partialName(n.dict) === 'Group')!;
      group.dict.lookup(N('Kids'), PDFArray).push(group.ref!);
    });
    expect(reasonOf(result)).toBe('unreadable-policy');
  });
});

describe('per-field guards', () => {
  it.each([
    [
      'a field that is not a widget',
      (_d: PDFDocument, f: PDFDict) => f.delete(N('Subtype')),
      'separate-widget',
    ],
    [
      'annotation flags that are not a number',
      (_d: PDFDocument, f: PDFDict) => f.set(N('F'), N('Print')),
      'not-visible',
    ],
    [
      'the NoView flag',
      (d: PDFDocument, f: PDFDict) => f.set(N('F'), d.context.obj(32)),
      'not-visible',
    ],
    [
      'a box with no area',
      (d: PDFDocument, f: PDFDict) => f.set(N('Rect'), d.context.obj([72, 500, 72, 550])),
      'not-visible',
    ],
    [
      'a box that is not four numbers',
      (d: PDFDocument, f: PDFDict) => f.set(N('Rect'), d.context.obj([72, 500, 272])),
      'not-visible',
    ],
    [
      'a box outside the page',
      (d: PDFDocument, f: PDFDict) => f.set(N('Rect'), d.context.obj([700, 900, 800, 950])),
      'not-visible',
    ],
    [
      'an /MK that is not a dictionary',
      (d: PDFDocument, f: PDFDict) => f.set(N('MK'), d.context.obj(90)),
      'rotated-widget',
    ],
    [
      'an /MK /R that is not a number',
      (d: PDFDocument, f: PDFDict) => f.set(N('MK'), d.context.obj({ R: 'Quarter' })),
      'rotated-widget',
    ],
    [
      'a read-only flag that is not a number',
      (_d: PDFDocument, f: PDFDict) => f.set(N('Ff'), N('ReadOnly')),
      'read-only',
    ],
    ['an empty name', (_d: PDFDocument, f: PDFDict) => f.set(N('T'), PDFString.of('')), 'bad-name'],
    [
      'a /Parent the form tree does not have',
      (d: PDFDocument, f: PDFDict) => f.set(N('Parent'), d.context.obj({})),
      'bad-name',
    ],
  ] as const)('%s', async (_label, change, reason) => {
    expect(fieldReason(await classified(ONE, change))).toBe(reason);
  });

  it('a field with a direct dictionary in /Fields (no object of its own) cannot be filled', async () => {
    const result = await classified(ONE, (doc, field) => {
      const fields = form(doc).lookup(N('Fields'), PDFArray);
      for (let i = 0; i < fields.size(); i++) {
        if (fields.lookup(i) === field) fields.set(i, field);
      }
    });
    expect(fieldReason(result)).toBe('separate-widget');
  });
});

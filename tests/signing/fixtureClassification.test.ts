/**
 * Every pyHanko-built policy fixture, and what the app makes of it on open (spec 004).
 *
 * This pins the fixtures to the rule each was built for, so a fixture that stopped exercising
 * its rule (or a rule that moved) shows up here by name. The per-row refusal tests of User
 * Story 2 (tasks T028–T029: drawn-box refusal on every certified fixture, the node cap, cyclic
 * kids) build on this table.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPdf } from '../../src/features/viewer/loadPdf';
import type { BlockReason, FieldIneligibleReason } from '../../src/features/signing/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = resolve(HERE, 'fixtures/policy');
/**
 * Every fixture the app classified `fill-only` in this run. The signature gate runs the pinned
 * validator on each of these INPUTS: what the app is willing to sign into, the validator must
 * accept as it stands (spec Assumption 1, tested on the input side; review finding R2).
 */
const FILL_ONLY_LIST = resolve(HERE, 'out/fill-only-inputs.json');
const fillOnlyInputs: string[] = [];

type Expected =
  | { kind: 'ok' }
  | { kind: 'fill-only'; fields: string[]; ineligible?: Record<string, FieldIneligibleReason> }
  | { kind: 'blocked'; reason: BlockReason; ineligible?: Record<string, FieldIneligibleReason> };

const blocked = (
  reason: BlockReason,
  ineligible?: Record<string, FieldIneligibleReason>,
): Expected => ({ kind: 'blocked', reason, ineligible });
const noEligible = (ineligible: Record<string, FieldIneligibleReason>) =>
  blocked('certified-no-eligible-field', ineligible);

const EXPECTED: Record<string, Expected> = {
  // Not certified: free placement, as before this feature (D7).
  'unsigned.pdf': { kind: 'ok' },
  'approval.pdf': { kind: 'ok' },
  'approval-xref-stream.pdf': { kind: 'ok' },

  // Signable in a prepared field.
  'certified-p2-empty-field.pdf': { kind: 'fill-only', fields: ['Approver'] },
  'certified-p3-empty-field.pdf': { kind: 'fill-only', fields: ['Approver'] },
  'certified-p2-empty-field-xref-stream.pdf': { kind: 'fill-only', fields: ['Approver'] },
  'certified-p2-empty-field-rotated-page.pdf': { kind: 'fill-only', fields: ['Approver'] },
  'certified-p2-two-empty-fields.pdf': { kind: 'fill-only', fields: ['Approver', 'Witness'] },
  // A first fill by another tool (pyHanko), then the remaining field (rule 5d, C1).
  'certified-p2-two-empty-fields-signed-once.pdf': { kind: 'fill-only', fields: ['Witness'] },
  'certified-p2-two-empty-fields-signed-once-xref-stream.pdf': {
    kind: 'fill-only',
    fields: ['Witness'],
  },

  // R1.
  'certified-p1.pdf': blocked('certified-no-changes'),
  'certified-p1-empty-field.pdf': blocked('certified-no-changes'),
  'violates-p1.pdf': blocked('certified-no-changes'),
  // R2.
  'certified-p2.pdf': blocked('certified-no-empty-field'),
  'certified-p3.pdf': blocked('certified-no-empty-field'),
  'certified-p2-xref-stream.pdf': blocked('certified-no-empty-field'),
  'certified-p2-empty-field-signed-once.pdf': blocked('certified-no-empty-field'),
  // R4.
  'fieldmdp-all.pdf': blocked('field-locked'),
  'certified-p2-fieldmdp-approval.pdf': blocked('field-locked'),
  // R8, R9, R10.
  'certified-p2-perms-without-reference.pdf': blocked('unknown-policy'),
  'certified-p2-sigflags-1.pdf': blocked('form-not-fillable'),
  'certified-p2-need-appearances.pdf': blocked('form-not-fillable'),
  'certified-p2-xfa.pdf': blocked('xfa-form'),
  // R18 (and R17: a late field always arrives in a revision rule 5d refuses first).
  'certified-p2-two-revisions.pdf': blocked('changed-after-certification'),
  'certified-p2-late-visible-field.pdf': blocked('changed-after-certification'),
  'certified-p2-later-annotation.pdf': blocked('changed-after-certification'),
  'certified-p3-later-annotation.pdf': blocked('changed-after-certification'),
  'certified-p3-annotation-then-fill.pdf': blocked('changed-after-certification'),
  // R18 through the cross-reference data: invisible object by object (review finding R1).
  // Signatures intact in all six; tests/unit/xrefSections.test.ts pins the exact reason.
  'certified-p2-xref-duplicate-object.pdf': blocked('changed-after-certification'),
  'certified-p2-xref-free-entry.pdf': blocked('changed-after-certification'),
  'certified-p2-xref-generation-bump.pdf': blocked('changed-after-certification'),
  'certified-p2-xref-hybrid.pdf': blocked('changed-after-certification'),
  'certified-p2-xref-double-trailer.pdf': blocked('changed-after-certification'),
  'certified-p2-xref-rewritten-object.pdf': blocked('changed-after-certification'),

  // R3 and the per-field rows.
  'certified-p2-empty-field-lock.pdf': noEligible({ Approver: 'locked' }), // R5
  'certified-p2-empty-field-sv.pdf': noEligible({ Approver: 'seed-values' }), // R6
  'certified-p2-empty-field-kid-widget.pdf': noEligible({ Approver: 'separate-widget' }), // R12
  'certified-p3-empty-field-kid-widget.pdf': noEligible({ Approver: 'separate-widget' }), // R12
  'certified-p2-empty-field-two-widgets.pdf': noEligible({ Approver: 'separate-widget' }), // T3
  'certified-p2-duplicate-names.pdf': noEligible({ Approver: 'bad-name' }), // R13
  'certified-p2-dotted-name.pdf': noEligible({ 'Approver.One': 'bad-name' }), // R13
  'certified-p2-inherited-v.pdf': noEligible({ 'Group.Approver': 'inherited-value' }), // R14
  'certified-p2-shared-parent.pdf': noEligible({
    'Group.Approver': 'shared-parent',
    'Group.Witness': 'shared-parent',
  }), // R14
  'certified-p2-shared-appearance.pdf': noEligible({
    Approver: 'shared-appearance',
    Witness: 'shared-appearance',
  }), // rule 8
  'certified-p2-widget-two-pages.pdf': noEligible({ Approver: 'on-several-pages' }), // R15
  'certified-p2-widget-oc.pdf': noEligible({ Approver: 'optional-content' }), // R16
  'certified-p2-readonly-field.pdf': noEligible({ Approver: 'read-only' }), // R16
  'certified-p2-empty-field-hidden.pdf': noEligible({ Approver: 'not-visible' }), // T4
  'certified-p2-empty-field-p-mismatch.pdf': noEligible({ Approver: 'page-mismatch' }), // T2
  'certified-p2-empty-field-mk-rotation.pdf': noEligible({ Approver: 'rotated-widget' }),
};

describe('policy fixtures: what the app makes of each on open', () => {
  afterAll(() => {
    mkdirSync(dirname(FILL_ONLY_LIST), { recursive: true });
    writeFileSync(FILL_ONLY_LIST, JSON.stringify(fillOnlyInputs.sort(), null, 2));
  });

  it('has an expectation for every fixture file', () => {
    const files = readdirSync(POLICY).filter((f) => f.endsWith('.pdf'));
    expect(files.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s', async (name, expected) => {
    const { signing } = await loadPdf(new Uint8Array(readFileSync(resolve(POLICY, name))));
    if (signing.kind === 'fill-only') fillOnlyInputs.push(name);
    expect(signing.kind).toBe(expected.kind);
    if (signing.kind === 'ok' || expected.kind === 'ok') return;

    if (signing.kind === 'blocked' && expected.kind === 'blocked') {
      expect(signing.reason).toBe(expected.reason);
      expect(signing.message.length).toBeGreaterThan(20);
      // Principle IV: no message claims anything about the certification's validity.
      expect(signing.message).not.toMatch(/\bvalid\b|still certified|certification preserved/i);
    }
    if (signing.kind === 'fill-only' && expected.kind === 'fill-only') {
      expect(signing.fields.map((f) => f.name)).toEqual(expected.fields);
      for (const field of signing.fields) {
        expect(field).toMatchObject({ eligible: true, pageIndex: 0 });
        expect(field.reason).toBeUndefined();
        expect(field.rect).not.toBeNull();
        expect(field.box).not.toBeNull();
      }
    }
    const reasons = Object.fromEntries(signing.ineligible.map((f) => [f.name, f.reason]));
    expect(reasons).toEqual(expected.ineligible ?? {});
    expect(signing.ineligible.every((f) => f.eligible === false)).toBe(true);
  });
});

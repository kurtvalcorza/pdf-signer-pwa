import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CERTIFIED_FIELD_FIXTURE,
  CERTIFIED_FIELD_NAME,
  CERTIFIED_FIELD_PAGE,
  CERTIFICATION_CLAIM,
  FILL_ONLY_NOTICE as GATE_NOTICE,
  appendOnlyProblem,
  exactText,
  fieldOptionText,
  fieldSignedText,
} from '../../scripts/android-gate-certified.mjs';
import { FILL_ONLY_NOTICE, fieldLabel, fieldSignedMessage } from '../../src/components/FieldPicker';
import type { CandidateField } from '../../src/features/signing/types';

/**
 * Spec 004 T040: the Android gate's --certified-field mode finds the shared app's controls by
 * their visible text. These pin that text to the app's own, so a wording change fails here
 * instead of as an emulator timeout.
 */
describe('android-gate --certified-field helpers', () => {
  it('matches the shared app’s notice, field label and signed message exactly', () => {
    expect(GATE_NOTICE).toBe(FILL_ONLY_NOTICE);
    const field = {
      name: CERTIFIED_FIELD_NAME,
      pageIndex: CERTIFIED_FIELD_PAGE - 1,
    } as CandidateField;
    expect(fieldOptionText(CERTIFIED_FIELD_NAME, CERTIFIED_FIELD_PAGE)).toBe(fieldLabel(field));
    expect(fieldSignedText(CERTIFIED_FIELD_NAME)).toBe(fieldSignedMessage(CERTIFIED_FIELD_NAME));
    expect(CERTIFICATION_CLAIM.test(fieldSignedMessage(CERTIFIED_FIELD_NAME))).toBe(false);
  });

  it('builds exact, escaped matchers', () => {
    const option = exactText(fieldOptionText('Approver', 1));
    expect(option.test('Field name set by the document: "Approver" (page 1)')).toBe(true);
    // The on-page outline's label embeds the same text; the matcher must not hit it.
    expect(
      option.test('Sign in this field. Field name set by the document: "Approver" (page 1)'),
    ).toBe(false);
    expect(option.test('Field name set by the document: "Approver" (page 10)')).toBe(false);
    expect(exactText('a.b').test('axb')).toBe(false);
    expect(exactText(GATE_NOTICE).test(FILL_ONLY_NOTICE)).toBe(true);
  });

  it('names the fixture that exists in the policy set', () => {
    const path = fileURLToPath(
      new URL(`../signing/fixtures/policy/${CERTIFIED_FIELD_FIXTURE}`, import.meta.url),
    );
    expect(existsSync(path)).toBe(true);
    // The fixture itself carries exactly one signature: the certification.
    expect(
      (
        readFileSync(path)
          .toString('latin1')
          .match(/\/ByteRange/g) ?? []
      ).length,
    ).toBe(1);
  });

  it('accepts an append-only output with the expected signatures, and nothing else', () => {
    const input = Buffer.from('%PDF-1.7 /ByteRange [0 1 2 3] %%EOF\n', 'latin1');
    const good = Buffer.concat([input, Buffer.from('/ByteRange [0 4 5 6] %%EOF\n', 'latin1')]);
    expect(appendOnlyProblem(input, good, 2)).toBeNull();
    expect(appendOnlyProblem(input, good, 3)).toMatch(/2 \/ByteRange entries, expected 3/);
    expect(appendOnlyProblem(input, input, 1)).toMatch(/not longer/);
    const rewritten = Buffer.from(good);
    rewritten[1] = 0x41;
    expect(appendOnlyProblem(input, rewritten, 2)).toMatch(/not a byte prefix/);
  });
});

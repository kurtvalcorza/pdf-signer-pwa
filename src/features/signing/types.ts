/** Signing-engine contract types (see contracts/signing-engine.md). */

export interface PlacementInput {
  imageBytes: Uint8Array;
  format: 'png' | 'jpeg';
  pageIndex: number;
  /** Normalized 0..1 on the page box; converted to PDF points internally (research R6). */
  nx: number;
  ny: number;
  nw: number;
  nh: number;
}

export interface Pkcs12 {
  p12Bytes: Uint8Array;
  password: string;
}

/** Thrown when the certificate password does not unlock the .p12 (FR-015). */
export class BadPasswordError extends Error {
  constructor(message = 'Incorrect certificate password') {
    super(message);
    this.name = 'BadPasswordError';
  }
}

/**
 * Thrown when a .p12 is structurally unusable: not valid PKCS#12, no password-integrity
 * MAC, a forbidden iteration count, or no private key + certificate. Kept distinct from
 * BadPasswordError so a hostile or corrupt file is never reported as a mistyped password.
 */
export class MalformedCertificateError extends Error {
  constructor(message = 'This certificate file is damaged or not a usable .p12 / .pfx.') {
    super(message);
    this.name = 'MalformedCertificateError';
  }
}

/**
 * Thrown when an existing signature's policy does not permit the requested way of signing
 * (signingPolicy.ts), so compliant validators would flag the result as broken. The
 * document is left untouched.
 */
export class CertificationLockedError extends Error {
  constructor(
    message = 'This PDF is certified with a “no changes allowed” policy. Adding any ' +
      'signature would break that certification, so it was not signed.',
  ) {
    super(message);
    this.name = 'CertificationLockedError';
  }
}

/* ---- Certified-field signing (specs/004-certified-field-signing/data-model.md) ---- */

/** Identity of an indirect object (`N G R`), free of any pdf-lib type. */
export interface ObjectId {
  objectNumber: number;
  generationNumber: number;
}

/** Why a document cannot be signed here (document level). */
export type BlockReason =
  | 'certified-no-changes' // R1
  | 'certified-no-empty-field' // R2
  | 'certified-no-eligible-field' // R3
  | 'field-locked' // R4
  | 'unknown-policy' // R7, R8
  | 'form-not-fillable' // R9
  | 'xfa-form' // R10
  | 'changed-after-certification' // R18
  | 'too-many-fields' // T10
  | 'too-many-revisions' // FR-009
  | 'unreadable-policy'; // fail-closed

/** Why one empty signature field cannot be signed: the first rule that failed, in rule order. */
export type FieldIneligibleReason =
  | 'inherited-value' // rule 2 (R14)
  | 'shared-parent' // rule 2 (R14)
  | 'separate-widget' // rule 3 (R12)
  | 'page-mismatch' // rule 4 (T2)
  | 'on-several-pages' // rule 4 (R15)
  | 'not-visible' // rule 5 (T4)
  | 'optional-content' // rule 5 (R16)
  | 'rotated-widget' // research R6
  | 'read-only' // rule 5a (R16)
  | 'bad-name' // rule 5b (R13)
  | 'added-after-certification' // rule 5c (R17)
  | 'locked' // rule 6 (R5)
  | 'seed-values' // rule 6 (R6)
  | 'shared-appearance'; // rule 8

/** An empty signature field found by walking `/AcroForm /Fields`. */
export interface CandidateField {
  /** Identity; what `signIntoField` is given. */
  ref: ObjectId;
  /** Fully qualified `/T`. Data from the document, never a role the app asserts (T1). */
  name: string;
  /** Null when rule 4 could not resolve a single page. */
  pageIndex: number | null;
  /** `[x1, y1, x2, y2]` in PDF points: the box the stamp is fitted into. */
  rect: [number, number, number, number] | null;
  /**
   * The same box on the displayed page: top-left origin, 0..1, page rotation applied. Derived
   * from `rect`, the page's CropBox and its /Rotate, so the preview outlines the place the stamp
   * is really laid into (T2).
   */
  box: { nx: number; ny: number; nw: number; nh: number } | null;
  eligible: boolean;
  /** Present exactly when `eligible` is false. */
  reason?: FieldIneligibleReason;
}

/** The result of classifying an opened PDF. A document with a certification is never `ok`. */
export type SigningClassification =
  | { kind: 'ok' }
  | { kind: 'fill-only'; fields: CandidateField[]; ineligible: CandidateField[] }
  | { kind: 'blocked'; reason: BlockReason; message: string; ineligible: CandidateField[] };

/** What the UI hands to `signIntoField`. No position or size: they come from the field (D6). */
export interface FieldPlacementInput {
  imageBytes: Uint8Array;
  format: 'png' | 'jpeg';
  /** Must match an eligible `CandidateField` when the document is re-classified at signing time. */
  fieldRef: ObjectId;
}

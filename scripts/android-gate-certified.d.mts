// Types for scripts/android-gate-certified.mjs, so the unit tests can import it under `strict`.
export declare const CERTIFIED_FIELD_FIXTURE: string;
export declare const CERTIFIED_FIELD_NAME: string;
export declare const CERTIFIED_FIELD_PAGE: number;
export declare const CERTIFICATION_LEVEL: string;
export declare const FILL_ONLY_NOTICE: string;
export declare const CERTIFICATION_CLAIM: RegExp;
export declare function fieldOptionText(name: string, page: number): string;
export declare function fieldSignedText(name: string): string;
export declare function exactText(s: string): RegExp;
export declare function appendOnlyProblem(
  input: Buffer,
  output: Buffer,
  signatures: number,
): string | null;

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

# Contract: Signing Engine

The load-bearing module (`src/features/signing/`). Isolated behind this contract so it is testable
and pyHanko-validatable independently of the UI. All functions are pure with respect to I/O (no
network, no DOM); inputs and outputs are byte arrays + plain data.

## Types (shape, not implementation)

```ts
type PlacementInput = {
  imageBytes: Uint8Array;
  format: 'png' | 'jpeg';
  pageIndex: number;
  // normalized 0..1 on the page box; converted to PDF points internally (research R6)
  nx: number; ny: number; nw: number; nh: number;
};

type Pkcs12 = { p12Bytes: Uint8Array; password: string };
```

## Tier A — visual stamp (no crypto)

```ts
stampVisual(pdf: Uint8Array, placements: PlacementInput[]): Promise<Uint8Array>
```

- Draws each placement as page content on its target page (FR-006/008/009/010).
- MUST clamp/reject placements outside page bounds (FR-008).
- Returns a full PDF. Safe to call ONLY before any signature exists.

## Tier B — first cryptographic signature

```ts
signFirst(pdf: Uint8Array, placement: PlacementInput, cert: Pkcs12): Promise<Uint8Array>
```

- Builds an AcroForm signature field with a **visible widget** whose appearance stream draws the
  image (FR-011/012) — the image IS the field appearance (research R3).
- Adds a ByteRange/`/Contents` placeholder, saves once, hashes the ByteRange, produces a detached
  PKCS#7/CMS with `cert`, splices it byte-safe (research R3/R5).
- MUST verify `cert.password` first; on failure throw a typed `BadPasswordError` and produce no
  output (FR-015).
- Precondition: all Tier-A visual stamps already committed (FR-014). MUST throw if called on bytes
  that would require post-signature page mutation.

## Tier B — subsequent signatures (incremental)

```ts
signIncremental(signedPdf: Uint8Array, placement: PlacementInput, cert: Pkcs12): Promise<Uint8Array>
```

- Adds a new signature as a **byte-level incremental update** (`@signpdf/placeholder-plain`) — MUST
  NOT re-serialize `signedPdf` (research R4). Appends objects + xref only.
- Postcondition (verified in tests): all prior signatures remain valid (SC-009).

## Invariants (enforced + tested)

1. **Never re-serialize signed bytes.** After the first signature, only incremental appends.
2. **No mocked crypto.** Real CMS over a real ByteRange; a signature presented as valid MUST verify
   (Principle III).
3. **Byte-range integrity.** `/Contents` is spliced without shifting any other byte.
4. **No network, no persistence.** The engine touches neither (Principles I/VI).

## Verification (Principle V)

Every change here MUST pass `npm run verify:signatures`, which runs pyHanko (`pyhanko sign
validate`) / poppler `pdfsig` over engine output:
- single visible signature validates + is a clickable field (R3);
- second signature leaves the first valid (R4/SC-009);
- a tampered byte invalidates the covering signature (SC-007).

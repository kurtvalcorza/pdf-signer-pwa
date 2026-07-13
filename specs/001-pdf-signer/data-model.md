# Phase 1 Data Model: PDF Signer PWA

Client-side, in-memory state models (no server, no relational store). "Persisted?" notes whether
an entity may touch on-device storage — only the remembered certificate may, and only on opt-in.

---

## Document

The PDF being signed.

| Field | Type | Notes |
|-------|------|-------|
| `bytes` | `Uint8Array` | Original PDF bytes; in-memory only |
| `pages` | `PdfPage[]` | Derived page geometry |
| `isEncrypted` | `boolean` | If true, rejected (edge case / FR: encrypted PDFs unsupported) |
| `hasExistingSignature` | `boolean` | Drives ordering/invalidation warnings (FR-017) |
| `workingBytes` | `Uint8Array` | Current bytes as stamps/signatures are applied; **never re-serialized once signed** |

**Validation**: must parse as PDF; `isEncrypted === false`. **Persisted?** No.

## PdfPage

| Field | Type | Notes |
|-------|------|-------|
| `index` | `number` | 0-based |
| `widthPt` / `heightPt` | `number` | MediaBox size in PDF points |
| `rotation` | `0\|90\|180\|270` | Page rotation; part of coordinate transform (R6) |

**Persisted?** No.

## SignatureImage

The visual signature.

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Local id |
| `source` | `'upload' \| 'camera'` | Ingestion path (FR-004) |
| `originalBytes` | `Uint8Array` | As provided |
| `format` | `'png' \| 'jpeg'` | Drives embed path |
| `cleanedBytes` | `Uint8Array \| null` | Optional background-removed variant (US4); null if not applied |
| `hasAlpha` | `boolean` | Whether transparency present |

**Validation**: decodable PNG/JPEG. **Persisted?** No (v1 does not remember images).

## Placement

Where a signature image sits on the document. A document may have many.

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | |
| `imageId` | `string` | → SignatureImage |
| `pageIndex` | `number` | Target page |
| `nx` / `ny` / `nw` / `nh` | `number` | Normalized 0..1 position/size on the page (R6) |
| `mode` | `'visual' \| 'crypto'` | Visual = Tier A page stamp; crypto = becomes a signature field |
| `committed` | `boolean` | Visual stamps must be committed before crypto signing (FR-014) |

**Validation**: `0 ≤ n* ≤ 1` and within page bounds (FR-008). **Persisted?** No.

## Certificate

The user's PKCS#12 container — either supplied by the user or generated in-app.

| Field | Type | Notes |
|-------|------|-------|
| `p12Bytes` | `Uint8Array` | Password-protected container |
| `password` | `string` | **In-memory only, never persisted** (FR-022); re-entered each session |
| `remember` | `boolean` | Opt-in to persist `p12Bytes` (FR-021) |
| `unlocked` | `{ privateKey, certChain } \| null` | Transient, in-memory during a signing op only |

**Validation**: `p12Bytes` parses; password unlocks it before signing (FR-015).
**Persisted?** `p12Bytes` only if `remember === true`; `password` and `unlocked` **never**.

## CertificateSubject / GeneratedCertificate (in-app cert generation, FR-018/032)

Input for generating a self-signed Digital ID on-device.

| Field | Type | Notes |
|-------|------|-------|
| `commonName` | `string` | Full name (CN) — required |
| `organization` | `string?` | O |
| `organizationalUnit` | `string?` | OU / division |
| `email` | `string?` | Subject `emailAddress` + `subjectAltName` (rfc822) |

Output `GeneratedCertificate`: `{ p12Bytes: Uint8Array; certDer: Uint8Array }` — the `.p12`
(Digital ID, keep private) and the DER public cert (`.cer`, export to share for trust).
**Persisted?** No (generated in memory; user may explicitly download or opt-in-remember).

## AppearanceOptions (signature appearance config, FR-030/031)

| Field | Type | Notes |
|-------|------|-------|
| `label` | `boolean` | Show "Digitally signed by {name}" (default true) |
| `date` | `boolean` | Show "Date: …" line (default true) |
| `displayName` | `string?` | Overrides the name; defaults to the cert common name |

Both off → the appearance is the image alone. Text is uniform and fitted so it never clips.

## PersistedCertificate (storage shape)

Written to IndexedDB only under opt-in (R7).

| Field | Type | Notes |
|-------|------|-------|
| `p12Bytes` | `Uint8Array` | The password-protected container only |
| `savedAt` | `number` | Epoch ms |
| `label` | `string` | User-facing name for clearing |

No password, no key material. Clearable by the user (FR-021).

## SignatureField / SignedOutput

Result of Tier B signing.

| Field | Type | Notes |
|-------|------|-------|
| `signatureCount` | `number` | ≥ 1 for a signed output |
| `outputBytes` | `Uint8Array` | Final PDF; each signature over a correct ByteRange |
| `appearanceIsField` | `boolean` | True — visible image is the field appearance (FR-011) |

**Validation gate**: every signature validates in pyHanko/`pdfsig` (SC-002/007/009).
**Persisted?** No (delivered as a download).

---

## Signing flow — state transitions

```
idle
  └─ open document ─────────────▶ viewing
viewing
  ├─ add + place image ─────────▶ placing (repeatable; visual or crypto placements)
  ├─ commit visual stamps ──────▶ stamped         (Tier A page content written)
  └─ (no cert) export ──────────▶ done (visual-only PDF)              [US1]
stamped / viewing
  └─ supply cert + password ────▶ readyToSign      (password verified, FR-015)
readyToSign
  └─ sign crypto placement(s) ──▶ signed           (first sig: pdf-lib field; R3/R4)
signed
  ├─ add another signature ─────▶ signed           (incremental append only; R4)  [FR-013]
  └─ export ────────────────────▶ done (signed PDF)                    [US2]
```

**Invariants**:
- Once `signed`, `workingBytes` is only ever **appended** to (incremental updates). No
  re-serialization, no new page-content stamps (FR-014, Principle III).
- `Certificate.password` and `Certificate.unlocked` never leave memory and never persist
  (FR-022, Principle VI).
- No transition performs any network I/O (Principle I).

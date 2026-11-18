# Contract: signature gate additions

Applies to `scripts/validate_pdf.py`, `scripts/verify-signatures.mjs`,
`scripts/make_policy_fixtures.py`, `scripts/android-gate.mjs`, and the two T042 helpers
`scripts/pyhanko_probe.py` (pyHanko's field enumeration and own fill) and `scripts/sig-fields.mjs`
(the same enumeration through pdf-lib).

## `validate_pdf.py --expect-certification-level <NAME> <file.pdf> ...`

Exit 0 iff, for every file:

1. the default expectation holds (at least one signature; every one passes integrity and policy);
2. exactly one signature is the certification signature; and
3. its `modification_level` is `ModificationLevel.<NAME>`.

`<NAME>` is one of pyHanko's level names; this feature uses `FORM_FILLING`. An unknown name exits
2 with the usage line. The mode cannot be combined with `--expect-invalid` or
`--expect-policy-violation`.

## `verify-signatures.mjs` routing

| Files | Mode |
| :-- | :-- |
| Fill outputs written by the tests (`tests/signing/out/fill-*.pdf`) | `--expect-certification-level FORM_FILLING` |
| Every other signed output | default (unchanged) |
| `violates-p1.pdf`, `certified-p2-two-revisions.pdf` (existing), `certified-p2-late-visible-field.pdf`, `certified-p2-later-annotation.pdf`, `certified-p3-later-annotation.pdf`, `certified-p3-annotation-then-fill.pdf` | `--expect-policy-violation` |
| Forced add-a-field on `certified-p2-empty-field.pdf`; fill output plus one disallowed revision (`tests/signing/out-violations/`) | `--expect-policy-violation` |
| Every fixture the app classifies `fill-only` (the INPUT, listed by the classification tests in `tests/signing/out/fill-only-inputs.json`) | default: what the app will sign into, the validator must accept as it stands |
| `certified-p2-xref-duplicate-object.pdf`, `certified-p2-xref-free-entry.pdf`, `certified-p2-xref-double-trailer.pdf` | `--expect-policy-violation` |
| `certified-p2-xref-generation-bump.pdf`, `certified-p2-xref-hybrid.pdf` | must not validate in the default mode (the validator refuses to read them) |
| `certified-p2-signed-xref-repeated-key-field.pdf`, `-repeated-key-root.pdf`, `-repeated-key-prev.pdf`, `-size-low.pdf`, `-size-short.pdf`, `-decode-parms.pdf` | must not validate in the default mode |
| `certified-p2-signed-xref-control.pdf`, `-control-xref-stream.pdf` | fill-only for the app, so validated as inputs (first row) |
| `certified-p2-signed-xref-glued-definitions.pdf` | none: the validator passes it and the app refuses it (research.md R11) |
| pyHanko's own fill of `certified-p2-empty-field-kid-widget.pdf` and of `certified-p2-late-visible-field.pdf` (written to a temp dir by the gate) | `--expect-policy-violation` |

The gate fails if any of these lists is empty (no vacuous pass), as it already does for the
tampered set.

Fill outputs must not sit in the default list as well: the default mode would pass them without
checking the level.

## `make_policy_fixtures.py`

- Writes a file only when it is missing. `--force` regenerates everything.
- The signing key is created in memory per run and never written to the repository.
- Fixture names are those in [../research.md](../research.md) R2.

## `android-gate.mjs --certified-field`

Pushes `certified-p2-empty-field.pdf` to the emulator, drives the installed APK to pick the field
and sign, pulls the download, and runs `validate_pdf.py --expect-certification-level FORM_FILLING`
on it. Same airplane-mode precondition as the existing run.

## Field enumeration cross-check (T8)

For every fixture, the set of fully qualified signature field names pyHanko enumerates
(`enumerate_sig_fields`) must equal the set pdf-lib finds. A mismatch fails the gate.

As built (T042): the lists are compared sorted, duplicates included, with pyHanko reading
leniently. Three fixtures are listed as known differentials, the R11 cases where the two readers
resolve a different trailer: `certified-p2-signed-xref-decode-parms.pdf` (pyHanko cannot read
it), `-repeated-key-prev.pdf` and `-repeated-key-root.pdf`. The app refuses all three
(`changed-after-certification`). A listed fixture that starts to agree also fails the gate, so the
list cannot go stale.

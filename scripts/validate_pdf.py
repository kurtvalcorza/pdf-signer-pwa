"""Validate PDF signatures with pyHanko (Constitution Principle V gate).

Default: every signature in every file must be INTACT + VALID (self-signed certs
are expected UNTRUSTED — the gate cares about integrity, not trust).

With --expect-invalid: every file must FAIL to validate cleanly (used for tamper
fixtures, SC-007) — a file that still validates cleanly is a gate failure.

Exit 0 iff expectations hold for all files.
"""

import sys
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext


def is_cleanly_valid(path: str) -> bool:
    """True iff the file has >=1 signature and all are intact + valid."""
    with open(path, "rb") as fh:
        reader = PdfFileReader(fh)
        sigs = reader.embedded_signatures
        if not sigs:
            print(f"  {path}: no signatures")
            return False
        vc = ValidationContext(allow_fetching=False)
        clean = True
        for i, sig in enumerate(sigs):
            status = validate_pdf_signature(sig, signer_validation_context=vc)
            intact = bool(status.intact)
            valid = bool(status.valid)
            trusted = bool(getattr(status, "trusted", False))
            coverage = getattr(status, "coverage", None)
            print(
                f"  {path} sig[{i}]: intact={intact} valid={valid} "
                f"trusted={trusted} coverage={coverage}"
            )
            if not (intact and valid):
                clean = False
        return clean


def main() -> int:
    args = sys.argv[1:]
    expect_invalid = "--expect-invalid" in args
    paths = [a for a in args if not a.startswith("--")]
    if not paths:
        print("usage: validate_pdf.py [--expect-invalid] <file.pdf> ...")
        return 2

    all_ok = True
    for p in paths:
        try:
            clean = is_cleanly_valid(p)
        except Exception as exc:  # noqa: BLE001 — unreadable == not cleanly valid
            print(f"  {p}: {type(exc).__name__}: {exc}")
            clean = False

        met = (not clean) if expect_invalid else clean
        verdict = "OK" if met else "FAIL"
        expectation = "expect-invalid" if expect_invalid else "expect-valid"
        print(f"{verdict} [{expectation}] {p}")
        if not met:
            all_ok = False

    print("\nRESULT:", "PASS" if all_ok else "FAIL")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

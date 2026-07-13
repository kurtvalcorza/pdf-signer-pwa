"""Validate PDF signatures with pyHanko (Constitution Principle V gate).

Reports per-signature integrity/validity. Self-signed certs are expected to be
UNTRUSTED — the gate cares about INTACT + VALID (the signature covers the bytes
and has not been tampered with), not trust.

Exit code 0 iff every signature in every file is intact and valid.
"""

import sys
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext


def validate_file(path: str) -> bool:
    with open(path, "rb") as fh:
        reader = PdfFileReader(fh)
        sigs = reader.embedded_signatures
        if not sigs:
            print(f"FAIL {path}: no signatures found")
            return False

        # No trust roots on purpose: self-signed test certs are untrusted-but-valid.
        vc = ValidationContext(allow_fetching=False)
        ok = True
        for i, sig in enumerate(sigs):
            status = validate_pdf_signature(sig, signer_validation_context=vc)
            intact = bool(status.intact)
            valid = bool(status.valid)
            coverage = getattr(status, "coverage", None)
            trusted = bool(getattr(status, "trusted", False))
            verdict = "OK" if (intact and valid) else "FAIL"
            if not (intact and valid):
                ok = False
            print(
                f"{verdict} {path} sig[{i}]: intact={intact} valid={valid} "
                f"trusted={trusted} coverage={coverage}"
            )
        return ok


def main() -> int:
    paths = sys.argv[1:]
    if not paths:
        print("usage: validate_pdf.py <file.pdf> [more.pdf ...]")
        return 2
    all_ok = True
    for p in paths:
        try:
            if not validate_file(p):
                all_ok = False
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL {p}: {type(exc).__name__}: {exc}")
            all_ok = False
    print("\nRESULT:", "PASS" if all_ok else "FAIL")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

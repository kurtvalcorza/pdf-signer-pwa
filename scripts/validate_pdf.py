"""Validate PDF signatures with pyHanko (Constitution Principle V gate).

Each signature gets three SEPARATE results, because they answer different questions:

  integrity  intact + valid: the bytes and the cryptography check out.
  trust      the certificate chains to a trust root. Reported only. The app's certificates are
             self-signed and the gate is offline, so this is expected to be false and is never
             required. pyHanko's `bottom_line` includes trust, so it is deliberately not used.
  policy     every later revision is permitted by the document's modification policy.

Modes (exit 0 iff the expectation holds for every file):

  default                    >=1 signature; every one passes integrity AND policy.
  --expect-invalid           parses, has >=1 signature, and at least one fails integrity because
                             its signed bytes changed. A corrupt, unparseable or unsigned file does
                             NOT count: it would prove nothing about tamper detection.
  --expect-policy-violation  every signature passes integrity, and at least one fails policy.
"""

import sys
from dataclasses import dataclass

from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.diff_analysis import ModificationLevel
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext


@dataclass
class SigResult:
    intact: bool
    valid: bool
    trusted: bool
    policy_ok: bool

    @property
    def integrity_ok(self) -> bool:
        return self.intact and self.valid


def check_signatures(path: str) -> list[SigResult]:
    """Validate every signature strictly. An empty list means the file has none."""
    results = []
    with open(path, "rb") as fh:
        reader = PdfFileReader(fh, strict=True)
        vc = ValidationContext(allow_fetching=False)
        for i, sig in enumerate(reader.embedded_signatures):
            status = validate_pdf_signature(sig, signer_validation_context=vc)
            level = status.modification_level
            # An unknown level is a failure: the policy result must be positively established.
            policy_ok = (
                bool(status.docmdp_ok)
                and level is not None
                and level != ModificationLevel.OTHER
            )
            result = SigResult(
                intact=bool(status.intact),
                valid=bool(status.valid),
                trusted=bool(status.trusted),
                policy_ok=policy_ok,
            )
            print(
                f"  {path} sig[{i}]: integrity={result.integrity_ok} "
                f"(intact={result.intact} valid={result.valid}) "
                f"trust={result.trusted} policy={policy_ok} "
                f"modification={level} coverage={status.coverage}"
            )
            results.append(result)
    if not results:
        print(f"  {path}: no signatures")
    return results


def meets(results: list[SigResult], mode: str) -> bool:
    if not results:
        return False  # no mode can be satisfied by a file with no signature
    if mode == "expect-invalid":
        return any(not r.intact for r in results)
    if mode == "expect-policy-violation":
        return all(r.integrity_ok for r in results) and any(not r.policy_ok for r in results)
    return all(r.integrity_ok and r.policy_ok for r in results)


def main() -> int:
    args = sys.argv[1:]
    mode = "expect-valid"
    if "--expect-invalid" in args:
        mode = "expect-invalid"
    elif "--expect-policy-violation" in args:
        mode = "expect-policy-violation"
    paths = [a for a in args if not a.startswith("--")]
    if not paths:
        print("usage: validate_pdf.py [--expect-invalid|--expect-policy-violation] <file.pdf> ...")
        return 2

    all_ok = True
    for p in paths:
        try:
            met = meets(check_signatures(p), mode)
        except Exception as exc:  # noqa: BLE001 - unreadable fails every mode
            print(f"  {p}: {type(exc).__name__}: {exc}")
            met = False
        print(f"{'OK' if met else 'FAIL'} [{mode}] {p}")
        all_ok = all_ok and met

    print("\nRESULT:", "PASS" if all_ok else "FAIL")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

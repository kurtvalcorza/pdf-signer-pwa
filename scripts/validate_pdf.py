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
  --expect-certification-level NAME
                             the default expectation holds, exactly one signature is a
                             certification (it declares a DocMDP transform), and pyHanko classes
                             everything after it as ModificationLevel.NAME. Used with FORM_FILLING
                             for signatures the app adds INTO a prepared field of a certified PDF:
                             "policy passed" alone would not show the change was read as form
                             filling (specs/004-certified-field-signing/contracts/signature-gate.md).

The modes cannot be combined. A bad combination or an unknown level name exits 2.
"""

import sys
from dataclasses import dataclass
from typing import Optional

from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.diff_analysis import ModificationLevel
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext

USAGE = (
    "usage: validate_pdf.py [--expect-invalid | --expect-policy-violation | "
    "--expect-certification-level NAME] <file.pdf> ...\n"
    "       NAME is one of: " + ", ".join(level.name for level in ModificationLevel)
)


@dataclass
class SigResult:
    intact: bool
    valid: bool
    trusted: bool
    policy_ok: bool
    certification: bool
    level: Optional[ModificationLevel]

    @property
    def integrity_ok(self) -> bool:
        return self.intact and self.valid


def is_certification(sig) -> bool:
    """True if the signature dictionary declares a DocMDP transform in its /Reference array."""
    try:
        references = sig.sig_object.get("/Reference", ())
        return any(ref.get_object().get("/TransformMethod") == "/DocMDP" for ref in references)
    except Exception:  # noqa: BLE001 - an unreadable /Reference is not a certification we can assert
        return False


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
                certification=is_certification(sig),
                level=level,
            )
            print(
                f"  {path} sig[{i}]: integrity={result.integrity_ok} "
                f"(intact={result.intact} valid={result.valid}) "
                f"trust={result.trusted} policy={policy_ok} "
                f"certification={result.certification} "
                f"modification={level} coverage={status.coverage}"
            )
            results.append(result)
    if not results:
        print(f"  {path}: no signatures")
    return results


def meets(
    results: list[SigResult], mode: str, level: Optional[ModificationLevel] = None
) -> bool:
    if not results:
        return False  # no mode can be satisfied by a file with no signature
    if mode == "expect-invalid":
        return any(not r.intact for r in results)
    if mode == "expect-policy-violation":
        return all(r.integrity_ok for r in results) and any(not r.policy_ok for r in results)
    all_pass = all(r.integrity_ok and r.policy_ok for r in results)
    if mode == "expect-certification-level":
        certifications = [r for r in results if r.certification]
        return all_pass and len(certifications) == 1 and certifications[0].level == level
    return all_pass


def parse_args(args: list[str]):
    """Return (mode, level, paths), or None when the arguments are not a valid invocation."""
    modes = []
    level = None
    paths = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--expect-invalid", "--expect-policy-violation"):
            modes.append(arg[2:])
        elif arg == "--expect-certification-level":
            modes.append(arg[2:])
            i += 1
            name = args[i] if i < len(args) else ""
            if name not in ModificationLevel.__members__:
                return None
            level = ModificationLevel[name]
        elif arg.startswith("--"):
            return None
        else:
            paths.append(arg)
        i += 1
    if len(modes) > 1 or not paths:
        return None
    return (modes[0] if modes else "expect-valid"), level, paths


def main() -> int:
    parsed = parse_args(sys.argv[1:])
    if parsed is None:
        print(USAGE)
        return 2
    mode, level, paths = parsed
    label = mode if level is None else f"{mode} {level.name}"

    all_ok = True
    for p in paths:
        try:
            met = meets(check_signatures(p), mode, level)
        except Exception as exc:  # noqa: BLE001 - unreadable fails every mode
            print(f"  {p}: {type(exc).__name__}: {exc}")
            met = False
        print(f"{'OK' if met else 'FAIL'} [{label}] {p}")
        all_ok = all_ok and met

    print("\nRESULT:", "PASS" if all_ok else "FAIL")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

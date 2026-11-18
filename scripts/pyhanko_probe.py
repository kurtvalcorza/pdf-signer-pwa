"""pyHanko helpers for the signature gate (scripts/verify-signatures.mjs), spec 004 T042.

    python scripts/pyhanko_probe.py fields <file.pdf> ...
        Print one JSON object: {file: {"fields": [fully qualified names, sorted]}} or
        {file: {"error": "..."}}. The names are what pyHanko's `enumerate_sig_fields` yields,
        read leniently (strict=False) as the app's pdf-lib reads leniently; the gate compares
        them with pdf-lib's view (threat T8, contracts/signature-gate.md).

    python scripts/pyhanko_probe.py fill <in.pdf> <field> <out.pdf>
        pyHanko's own fill of the EXISTING field <field> (no new field), with a throwaway key,
        written to <out.pdf>. The gate then expects a policy violation from validate_pdf.py.

Exit 0 on success, 1 on a read or write error, 2 on bad usage.
"""

import json
import sys
from pathlib import Path

from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.fields import enumerate_sig_fields

USAGE = (
    "usage: pyhanko_probe.py fields <file.pdf> ...\n"
    "       pyhanko_probe.py fill <in.pdf> <field> <out.pdf>"
)


def fields(paths: list[str]) -> int:
    result = {}
    for p in paths:
        try:
            with open(p, "rb") as fh:
                reader = PdfFileReader(fh, strict=False)
                names = sorted(str(name) for name, _value, _ref in enumerate_sig_fields(reader))
            result[p] = {"fields": names}
        except Exception as exc:  # noqa: BLE001 - reported, the gate decides
            result[p] = {"error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result))
    return 0


def fill(src: str, field: str, out: str) -> int:
    # The fixture generator's own helpers: same signer kind, same fill call.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import make_policy_fixtures as mpf

    try:
        data = mpf.fill(Path(src).read_bytes(), mpf.make_signer(), field)
    except Exception as exc:  # noqa: BLE001
        print(f"fill failed: {type(exc).__name__}: {exc}")
        return 1
    Path(out).write_bytes(data)
    print(f"filled {field} of {src} -> {out}")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "fields":
        return fields(argv[1:])
    if len(argv) == 4 and argv[0] == "fill":
        return fill(argv[1], argv[2], argv[3])
    print(USAGE)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""T041: a certified P=2 document at the size limit, signed MAX (8) times after certification.

usage: python tests/e2e-perf/t041/make_cap_pdf.py <shape> <out.pdf> [target_mb]
  shape one-stream : one page, one uncompressed ~100 MB random-bytes stream
  shape many-pages : 5000 pages (the page limit), ~20 KB uncompressed content stream each

Reuses scripts/make_policy_fixtures.py helpers (make_signer, sign, fill) so the signatures are
the same kind the committed fixtures carry. The outputs (about 100 MB each) are never committed; write them outside the repo.
"""

import os
import sys
from io import BytesIO
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "scripts"))

import make_policy_fixtures as mpf  # noqa: E402
from pyhanko.pdf_utils import generic  # noqa: E402
from pyhanko.pdf_utils.writer import PageObject, PdfFileWriter  # noqa: E402
from pyhanko.sign.fields import MDPPerm, SigFieldSpec, append_signature_field  # noqa: E402

MB = 1024 * 1024
FILLS = 8  # MAX_SIGNED_REVISIONS_AFTER_CERTIFICATION
FIELDS = [(f"F{i}", (20 + 60 * (i % 9), 100, 70 + 60 * (i % 9), 130)) for i in range(1, FILLS + 2)]


def base(shape: str, target: int) -> bytes:
    w = PdfFileWriter()
    if shape == "one-stream":
        blob = generic.StreamObject(stream_data=os.urandom(target))
        ref = w.add_object(blob)
        content = generic.StreamObject(stream_data=b"72 700 300 40 re S")
        page = PageObject(contents=w.add_object(content), media_box=(0, 0, 612, 792))
        page["/Resources"] = generic.DictionaryObject(
            {generic.NameObject("/Properties"): generic.DictionaryObject(
                {generic.NameObject("/Blob"): ref})}
        )
        w.insert_page(page)
    elif shape == "many-pages":
        pages = 5000
        per = target // pages
        for _ in range(pages):
            # A comment line of random-looking but text-safe bytes keeps the stream a valid
            # content stream.
            body = b"%" + os.urandom(per // 2).hex().encode()[: per - 30] + b"\n72 700 300 40 re S"
            content = generic.StreamObject(stream_data=body)
            w.insert_page(PageObject(contents=w.add_object(content), media_box=(0, 0, 612, 792)))
    else:
        raise SystemExit("unknown shape")
    for name, box in FIELDS:
        append_signature_field(w, SigFieldSpec(name, box=box, on_page=0))
    buf = BytesIO()
    w.write(buf)
    return buf.getvalue()


def main() -> None:
    shape, out = sys.argv[1], Path(sys.argv[2])
    target = int(float(sys.argv[3]) * MB) if len(sys.argv) > 3 else 99 * MB
    signer = mpf.make_signer()
    pdf = base(shape, target)
    pdf = mpf.sign(pdf, signer, "Cert", mpf.BOX, certify=True, docmdp_permissions=MDPPerm.FILL_FORMS)
    for name, _ in FIELDS[:FILLS]:
        pdf = mpf.fill(pdf, signer, name)
    out.write_bytes(pdf)
    print(f"{out} {len(pdf)} bytes ({len(pdf) / MB:.2f} MB), {FILLS} fills after certification,"
          f" limit {100 * MB}")
    if len(pdf) > 100 * MB:
        raise SystemExit("over the size limit")


if __name__ == "__main__":
    main()

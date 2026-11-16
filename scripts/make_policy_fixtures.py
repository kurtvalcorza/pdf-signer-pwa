"""Generate the signed-PDF policy fixtures in tests/signing/fixtures/policy/.

These are produced by pyHanko, not by the app, so the app's incremental signer is tested
against documents it did not write. The outputs are committed. A run writes only the files that are missing, because the key is new on
every run and rewriting a committed fixture would change its bytes for no reason:

    python scripts/make_policy_fixtures.py            # add missing fixtures
    python scripts/make_policy_fixtures.py --force    # regenerate every fixture

The signing key is created in memory and discarded, so no private key is ever stored.
"""

import datetime
import sys
import tempfile
from io import BytesIO
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from pyhanko.keys import load_cert_from_pemder, load_private_key_from_pemder
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.writer import PageObject, PdfFileWriter
from pyhanko.sign import signers
from pyhanko.sign.fields import (
    FieldMDPAction,
    FieldMDPSpec,
    MDPPerm,
    SigFieldSpec,
    SigSeedSubFilter,
    append_signature_field,
)
from pyhanko_certvalidator.registry import SimpleCertificateStore

OUT = Path(__file__).resolve().parent.parent / "tests" / "signing" / "fixtures" / "policy"


def make_signer() -> signers.SimpleSigner:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Policy Fixture Signer")])
    now = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=36500))
        .sign(key, hashes.SHA256())
    )
    with tempfile.TemporaryDirectory() as tmp:
        cert_path = Path(tmp) / "cert.pem"
        key_path = Path(tmp) / "key.pem"
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        return signers.SimpleSigner(
            signing_cert=load_cert_from_pemder(str(cert_path)),
            signing_key=load_private_key_from_pemder(str(key_path), passphrase=None),
            cert_registry=SimpleCertificateStore(),
        )


def base_pdf(stream_xrefs: bool) -> bytes:
    writer = PdfFileWriter(stream_xrefs=stream_xrefs)
    content = generic.StreamObject(stream_data=b"72 700 300 40 re S")
    writer.insert_page(
        PageObject(contents=writer.add_object(content), media_box=(0, 0, 612, 792))
    )
    buf = BytesIO()
    writer.write(buf)
    return buf.getvalue()


def sign(pdf: bytes, signer, field: str, box, **meta) -> bytes:
    spec_args = meta.pop("spec_args", {})
    out = signers.sign_pdf(
        IncrementalPdfFileWriter(BytesIO(pdf)),
        signers.PdfSignatureMetadata(
            field_name=field,
            md_algorithm="sha256",
            subfilter=SigSeedSubFilter.ADOBE_PKCS7_DETACHED,
            **meta,
        ),
        signer=signer,
        new_field_spec=SigFieldSpec(field, box=box, **spec_args),
    )
    return out.getvalue()


BOX = (72, 600, 272, 650)

APPROVER_BOX = (72, 500, 272, 550)
WITNESS_BOX = (320, 500, 520, 550)


def base_pdf_with_fields(stream_xrefs: bool, fields) -> bytes:
    """A one-page PDF that already holds empty signature fields, before anything is signed."""
    writer = PdfFileWriter(stream_xrefs=stream_xrefs)
    content = generic.StreamObject(stream_data=b"72 700 300 40 re S")
    writer.insert_page(
        PageObject(contents=writer.add_object(content), media_box=(0, 0, 612, 792))
    )
    for name, box in fields:
        append_signature_field(writer, SigFieldSpec(name, box=box, on_page=0))
    buf = BytesIO()
    writer.write(buf)
    return buf.getvalue()


def fill(pdf: bytes, signer, field: str) -> bytes:
    """pyHanko's own fill of an EXISTING empty field: no new field is created."""
    out = signers.sign_pdf(
        IncrementalPdfFileWriter(BytesIO(pdf)),
        signers.PdfSignatureMetadata(
            field_name=field,
            md_algorithm="sha256",
            subfilter=SigSeedSubFilter.ADOBE_PKCS7_DETACHED,
        ),
        signer=signer,
        existing_fields_only=True,
    )
    return out.getvalue()


def append_empty_field(pdf: bytes, field: str, box) -> bytes:
    """A later, unsigned revision that adds a visible empty signature field."""
    writer = IncrementalPdfFileWriter(BytesIO(pdf))
    append_signature_field(writer, SigFieldSpec(field, box=box, on_page=0))
    buf = BytesIO()
    writer.write(buf)
    return buf.getvalue()


def append_square_annotation(pdf: bytes, rect) -> bytes:
    """A later, unsigned revision that adds a /Square annotation to page 1."""
    writer = IncrementalPdfFileWriter(BytesIO(pdf))
    page_ref, _ = writer.find_page_for_modification(0)
    page = page_ref.get_object()
    annot = generic.DictionaryObject(
        {
            generic.pdf_name("/Type"): generic.pdf_name("/Annot"),
            generic.pdf_name("/Subtype"): generic.pdf_name("/Square"),
            generic.pdf_name("/Rect"): generic.ArrayObject(
                [generic.NumberObject(v) for v in rect]
            ),
            generic.pdf_name("/F"): generic.NumberObject(4),
            generic.pdf_name("/P"): page_ref,
        }
    )
    annots = page["/Annots"]
    annots.append(writer.add_object(annot))
    writer.update_container(annots)
    buf = BytesIO()
    writer.write(buf)
    return buf.getvalue()


def certified_field_fixtures(signer) -> dict[str, bytes]:
    """Certified documents that hold empty signature fields (specs/004, RFC 23-1 section 7.1)."""

    def certified(perm, fields, stream_xrefs=False):
        return sign(
            base_pdf_with_fields(stream_xrefs, fields),
            signer,
            "Cert",
            BOX,
            certify=True,
            docmdp_permissions=perm,
        )

    one = [("Approver", APPROVER_BOX)]
    two = [("Approver", APPROVER_BOX), ("Witness", WITNESS_BOX)]
    t = {
        "certified-p2-empty-field.pdf": certified(MDPPerm.FILL_FORMS, one),
        "certified-p3-empty-field.pdf": certified(MDPPerm.ANNOTATE, one),
        "certified-p2-empty-field-xref-stream.pdf": certified(MDPPerm.FILL_FORMS, one, True),
        "certified-p2-two-empty-fields.pdf": certified(MDPPerm.FILL_FORMS, two),
    }
    t["certified-p2-empty-field-signed-once.pdf"] = fill(
        t["certified-p2-empty-field.pdf"], signer, "Approver"
    )
    t["certified-p2-two-empty-fields-signed-once.pdf"] = fill(
        t["certified-p2-two-empty-fields.pdf"], signer, "Approver"
    )
    t["certified-p2-two-empty-fields-signed-once-xref-stream.pdf"] = fill(
        certified(MDPPerm.FILL_FORMS, two, True), signer, "Approver"
    )
    t["certified-p2-late-visible-field.pdf"] = append_empty_field(
        certified(MDPPerm.FILL_FORMS, []),
        "Late",
        APPROVER_BOX,
    )
    t["certified-p2-later-annotation.pdf"] = append_square_annotation(
        t["certified-p2-empty-field.pdf"], APPROVER_BOX
    )
    t["certified-p3-later-annotation.pdf"] = append_square_annotation(
        t["certified-p3-empty-field.pdf"], APPROVER_BOX
    )
    # The annotation revision is unsigned but sits INSIDE the next signature's byte range, so
    # only a comparison of the two signed revisions can see it.
    t["certified-p3-annotation-then-fill.pdf"] = fill(
        append_square_annotation(
            certified(MDPPerm.ANNOTATE, two), (300, 480, 540, 570)
        ),
        signer,
        "Approver",
    )
    return t


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    signer = make_signer()
    table = {
        "unsigned.pdf": base_pdf(False),
        "approval.pdf": sign(base_pdf(False), signer, "Approval", BOX),
        "approval-xref-stream.pdf": sign(base_pdf(True), signer, "Approval", BOX),
    }
    for perm, name in (
        (MDPPerm.NO_CHANGES, "certified-p1.pdf"),
        (MDPPerm.FILL_FORMS, "certified-p2.pdf"),
        (MDPPerm.ANNOTATE, "certified-p3.pdf"),
    ):
        table[name] = sign(
            base_pdf(False), signer, "Cert", BOX, certify=True, docmdp_permissions=perm
        )
    table["certified-p2-xref-stream.pdf"] = sign(
        base_pdf(True), signer, "Cert", BOX, certify=True, docmdp_permissions=MDPPerm.FILL_FORMS
    )
    table["certified-p2-two-revisions.pdf"] = sign(
        table["certified-p2.pdf"], signer, "Approval", (72, 500, 272, 550)
    )
    table["fieldmdp-all.pdf"] = sign(
        base_pdf(False),
        signer,
        "Locked",
        BOX,
        spec_args={"field_mdp_spec": FieldMDPSpec(FieldMDPAction.ALL)},
    )

    # A disallowed change: certified "no changes", then the page content is rewritten. The first
    # signature's bytes stay intact, so only a policy check can catch this.
    writer = IncrementalPdfFileWriter(BytesIO(table["certified-p1.pdf"]))
    page_ref, _ = writer.find_page_for_modification(0)
    page = page_ref.get_object()
    page["/Contents"] = writer.add_object(generic.StreamObject(stream_data=b"0 0 612 792 re f"))
    writer.update_container(page)
    forged = BytesIO()
    writer.write(forged)
    table["violates-p1.pdf"] = forged.getvalue()

    table.update(certified_field_fixtures(signer))

    force = "--force" in sys.argv[1:]
    for name, data in table.items():
        path = OUT / name
        if path.exists() and not force:
            print(f"{name}: kept (already committed)")
            continue
        path.write_bytes(data)
        print(f"{name}: {len(data)} bytes")


if __name__ == "__main__":
    main()

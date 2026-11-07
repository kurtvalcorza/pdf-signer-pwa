"""Generate the signed-PDF policy fixtures in tests/signing/fixtures/policy/.

These are produced by pyHanko, not by the app, so the app's incremental signer is tested
against documents it did not write. The outputs are committed; re-run only to change them:

    python scripts/make_policy_fixtures.py

The signing key is created in memory and discarded, so no private key is ever stored.
"""

import datetime
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

    for name, data in table.items():
        (OUT / name).write_bytes(data)
        print(f"{name}: {len(data)} bytes")


if __name__ == "__main__":
    main()

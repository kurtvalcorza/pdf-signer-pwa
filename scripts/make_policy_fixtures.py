"""Generate the signed-PDF policy fixtures in tests/signing/fixtures/policy/.

These are produced by pyHanko, not by the app, so the app's incremental signer is tested
against documents it did not write. The outputs are committed. A run writes only the files that are missing, because the key is new on
every run and rewriting a committed fixture would change its bytes for no reason:

    python scripts/make_policy_fixtures.py            # add missing fixtures
    python scripts/make_policy_fixtures.py --force    # regenerate every fixture

The signing key is created in memory and discarded, so no private key is ever stored.
"""

import datetime
import re
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
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.writer import PageObject, PdfFileWriter
from pyhanko.sign import signers
from pyhanko.sign.fields import (
    FieldMDPAction,
    FieldMDPSpec,
    MDPPerm,
    SigFieldSpec,
    SigSeedSubFilter,
    SigSeedValueSpec,
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

    # ---- Refusal rows (RFC 23-1 section 7.1, research.md R2) and geometry (R6). ----
    # Each document is built with the field in place and certified AFTERWARDS, so the field is
    # part of the certified revision and only the rule under test refuses it.
    def name(s):
        return generic.pdf_name(s)

    def num(v):
        return generic.NumberObject(v)

    def text(s):
        return generic.pdf_string(s)

    def form(w):
        return w.root["/AcroForm"]

    def field_ref(w, i=0):
        return form(w)["/Fields"].raw_get(i)

    def page_of(w, i):
        return w.find_page_for_modification(i)[0]

    def built(build=None, perm=MDPPerm.FILL_FORMS, pages=1, fields=one, certify=True):
        writer = PdfFileWriter(stream_xrefs=False)
        for _ in range(pages):
            content = generic.StreamObject(stream_data=b"72 700 300 40 re S")
            writer.insert_page(
                PageObject(contents=writer.add_object(content), media_box=(0, 0, 612, 792))
            )
        for field, box in fields:
            append_signature_field(writer, SigFieldSpec(field, box=box, on_page=0))
        if build:
            build(writer)
        buf = BytesIO()
        writer.write(buf)
        if not certify:
            return buf.getvalue()
        return sign(buf.getvalue(), signer, "Cert", BOX, certify=True, docmdp_permissions=perm)

    def set_on_field(key, value):
        def build(w):
            field_ref(w).get_object()[name(key)] = value

        return build

    def split_widget(extra_page=False):
        """Turn the merged field/widget into a field with separate widget kid(s)."""

        def build(w):
            ref = field_ref(w)
            field = ref.get_object()
            widget = generic.DictionaryObject({name("/Parent"): ref})
            for key in ("/Type", "/Subtype", "/Rect", "/P", "/F", "/AP"):
                if key in field:
                    widget[name(key)] = field.raw_get(key)
                    del field[key]
            kids = [w.add_object(widget)]
            page_of(w, 0).get_object()[name("/Annots")] = generic.ArrayObject([kids[0]])
            if extra_page:
                second = generic.DictionaryObject(widget)
                second[name("/P")] = page_of(w, 1)
                kids.append(w.add_object(second))
                page_of(w, 1).get_object()[name("/Annots")] = generic.ArrayObject([kids[1]])
            field[name("/Kids")] = generic.ArrayObject(kids)

        return build

    def p_mismatch(w):
        ref = field_ref(w)  # its /P still names page 1
        page_of(w, 0).get_object()[name("/Annots")] = generic.ArrayObject([])
        page_of(w, 1).get_object()[name("/Annots")] = generic.ArrayObject([ref])

    def on_two_pages(w):
        page_of(w, 1).get_object()[name("/Annots")] = generic.ArrayObject([field_ref(w)])

    def duplicate_names(w):
        field_ref(w, 1).get_object()[name("/T")] = text("Approver")

    def inherited_value(w):
        ref = field_ref(w)
        parent = w.add_object(
            generic.DictionaryObject(
                {
                    name("/T"): text("Group"),
                    name("/V"): text("inherited"),
                    name("/Kids"): generic.ArrayObject([ref]),
                }
            )
        )
        ref.get_object()[name("/Parent")] = parent
        form(w)[name("/Fields")] = generic.ArrayObject([parent])

    def optional_content(w):
        group = w.add_object(
            generic.DictionaryObject(
                {name("/Type"): name("/OCG"), name("/Name"): text("Hidden layer")}
            )
        )
        w.root[name("/OCProperties")] = generic.DictionaryObject(
            {
                name("/OCGs"): generic.ArrayObject([group]),
                name("/D"): generic.DictionaryObject({name("/OFF"): generic.ArrayObject([group])}),
            }
        )
        field_ref(w).get_object()[name("/OC")] = group

    def with_spec(**spec_args):
        def build(w):
            append_signature_field(
                w, SigFieldSpec("Approver", box=APPROVER_BOX, on_page=0, **spec_args)
            )

        return build

    def need_appearances(w):
        # pyHanko drops /NeedAppearances when it signs, so this too has to be a later rewrite.
        acro = w.root["/AcroForm"]
        acro[name("/NeedAppearances")] = generic.BooleanObject(True)
        w.update_container(acro)

    def xfa(w):
        form(w)[name("/XFA")] = w.add_object(
            generic.StreamObject(stream_data=b'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>')
        )

    def rotate_page(w):
        page_of(w, 0).get_object()[name("/Rotate")] = num(90)

    def later_revision(pdf: bytes, change) -> bytes:
        """An unsigned revision after the last signature (so the signed bytes stay intact)."""
        writer = IncrementalPdfFileWriter(BytesIO(pdf))
        change(writer)
        buf = BytesIO()
        writer.write(buf)
        return buf.getvalue()

    def sigflags_1(w):
        # pyHanko always raises /SigFlags to 3 when it signs, so the only way to get a certified
        # document whose form says otherwise is a later rewrite of the form.
        acro = w.root["/AcroForm"]
        acro[name("/SigFlags")] = num(1)
        w.update_container(acro)

    def perms_without_reference(w):
        # The catalog names a certification, but that signature declares no DocMDP transform.
        fields = w.root["/AcroForm"]["/Fields"]
        sig = next(
            fields[i].raw_get("/V") for i in range(len(fields)) if fields[i]["/T"] == "Approval"
        )
        w.root[name("/Perms")] = generic.DictionaryObject({name("/DocMDP"): sig})
        w.update_root()

    t.update(
        {
            "certified-p1-empty-field.pdf": certified(MDPPerm.NO_CHANGES, one),
            "certified-p2-empty-field-lock.pdf": built(
                with_spec(field_mdp_spec=FieldMDPSpec(FieldMDPAction.ALL)), fields=[]
            ),
            "certified-p2-empty-field-sv.pdf": built(
                with_spec(seed_value_dict=SigSeedValueSpec(reasons=["Approval"])), fields=[]
            ),
            "certified-p2-fieldmdp-approval.pdf": sign(
                certified(MDPPerm.FILL_FORMS, one),
                signer,
                "Approval",
                WITNESS_BOX,
                spec_args={
                    "field_mdp_spec": FieldMDPSpec(FieldMDPAction.INCLUDE, fields=["Approver"])
                },
            ),
            "certified-p2-empty-field-hidden.pdf": built(set_on_field("/F", num(2))),
            "certified-p2-empty-field-two-widgets.pdf": built(split_widget(True), pages=2),
            "certified-p2-empty-field-p-mismatch.pdf": built(p_mismatch, pages=2),
            "certified-p2-empty-field-kid-widget.pdf": built(split_widget()),
            "certified-p3-empty-field-kid-widget.pdf": built(split_widget(), MDPPerm.ANNOTATE),
            "certified-p2-duplicate-names.pdf": built(duplicate_names, fields=two),
            "certified-p2-dotted-name.pdf": built(set_on_field("/T", text("Approver.One"))),
            "certified-p2-inherited-v.pdf": built(inherited_value),
            "certified-p2-widget-two-pages.pdf": built(on_two_pages, pages=2),
            "certified-p2-widget-oc.pdf": built(optional_content),
            "certified-p2-readonly-field.pdf": built(set_on_field("/Ff", num(1))),
            # Gap fixtures for rows R8, R9 and R10 (research.md R2).
            "certified-p2-perms-without-reference.pdf": later_revision(
                sign(built(certify=False), signer, "Approval", BOX), perms_without_reference
            ),
            "certified-p2-sigflags-1.pdf": later_revision(
                certified(MDPPerm.FILL_FORMS, one), sigflags_1
            ),
            "certified-p2-need-appearances.pdf": later_revision(
                certified(MDPPerm.FILL_FORMS, one), need_appearances
            ),
            "certified-p2-xfa.pdf": built(xfa),
            # Geometry (research.md R6).
            "certified-p2-empty-field-rotated-page.pdf": built(rotate_page),
            "certified-p2-empty-field-mk-rotation.pdf": built(
                set_on_field("/MK", generic.DictionaryObject({name("/R"): num(90)}))
            ),
        }
    )

    # ---- Field rows that needed a hand-built form (rules 2 and 8). ----
    def shared_parent(w):
        kids = [field_ref(w, 0), field_ref(w, 1)]
        parent = w.add_object(
            generic.DictionaryObject(
                {name("/T"): text("Group"), name("/Kids"): generic.ArrayObject(kids)}
            )
        )
        for kid in kids:
            kid.get_object()[name("/Parent")] = parent
        form(w)[name("/Fields")] = generic.ArrayObject([parent])

    def shared_appearance(w):
        normal = w.add_object(
            generic.StreamObject(
                {
                    name("/Type"): name("/XObject"),
                    name("/Subtype"): name("/Form"),
                    name("/BBox"): generic.ArrayObject([num(0), num(0), num(200), num(50)]),
                },
                stream_data=b"",
            )
        )
        shared = w.add_object(generic.DictionaryObject({name("/N"): normal}))
        for i in (0, 1):
            field_ref(w, i).get_object()[name("/AP")] = shared

    t["certified-p2-shared-parent.pdf"] = built(shared_parent, fields=two)
    t["certified-p2-shared-appearance.pdf"] = built(shared_appearance, fields=two)

    # ---- Changes made through the cross-reference data (review finding R1). ----
    # pdf-lib reads objects in file order and never reads the xref; a conforming reader does the
    # opposite. Each file below is certified, then carries a hand-written incremental section
    # that the two views read differently, then pyHanko's own fill of "Approver", so the fill's
    # signature covers the section and every signature stays cryptographically intact. The app
    # must refuse all of them (rule 5d, xrefSections.ts).
    def fill_lenient(pdf: bytes) -> bytes:
        out = signers.sign_pdf(
            IncrementalPdfFileWriter(BytesIO(pdf), strict=False),
            signers.PdfSignatureMetadata(
                field_name="Approver",
                md_algorithm="sha256",
                subfilter=SigSeedSubFilter.ADOBE_PKCS7_DETACHED,
            ),
            signer=signer,
            existing_fields_only=True,
        )
        return out.getvalue()

    def xref_case(make) -> bytes:
        base = certified(MDPPerm.FILL_FORMS, two)
        reader = PdfFileReader(BytesIO(base))
        page = reader.root["/Pages"]["/Kids"][0].get_object()
        contents = page.raw_get("/Contents")
        n, g = contents.idnum, contents.generation
        original = re.search(rb"(?<![0-9])%d %d obj.*?endobj" % (n, g), base, re.S).group(0)
        highest = max(int(m) for m in re.findall(rb"(?<![0-9])(\d+) \d+ obj", base))
        prev = int(re.findall(rb"startxref\s+(\d+)", base)[-1])
        trailer = re.findall(rb"trailer\s*(<<.*?>>)\s*startxref", base, re.S)[-1]
        trailer = re.sub(rb"/Prev\s+\d+", b"", trailer)[:-2]

        def section(objects, rows, trailer_extra=b"", unreached=b""):
            """objects: [(key, bytes)]; rows(offsets) -> xref rows after the object-0 entry."""
            out = base + b"\n"
            offsets = {}
            for key, data in objects:
                offsets[key] = len(out)
                out += data + b"\n"
            at = len(out)
            out += b"xref\n0 1\n0000000000 65535 f \n" + rows(offsets)
            out += b"trailer\n" + trailer + trailer_extra + b" /Prev %d >>\n" % prev
            out += unreached
            out += b"startxref\n%d\n%%%%EOF\n" % at
            return out

        def stream(num, gen, data):
            return b"%d %d obj\n<< /Length %d >>\nstream\n%s\nendstream\nendobj" % (
                num,
                gen,
                len(data),
                data,
            )

        return fill_lenient(make(n, g, original, highest, section, stream))

    black_page = b"0 0 612 792 re f"

    def duplicate_object(n, g, original, highest, section, stream):
        # Two definitions of the page content: the xref names the altered one, and a byte copy
        # of the original follows it, which is the one a file-order parser keeps.
        return section(
            [("evil", stream(n, g, black_page)), ("copy", original)],
            lambda o: b"%d 1\n%010d %05d n \n" % (n, o["evil"], g),
        )

    def free_entry(n, g, original, highest, section, stream):
        # The xref marks the page content free; no object is written at all.
        return section([], lambda o: b"%d 1\n0000000000 %05d f \n" % (n, g + 1))

    def generation_bump(n, g, original, highest, section, stream):
        # The same object number under a new generation: a new key to a file-order parser.
        return section(
            [("evil", stream(n, g + 1, black_page))],
            lambda o: b"%d 1\n%010d %05d n \n" % (n, o["evil"], g + 1),
        )

    def hybrid(n, g, original, highest, section, stream):
        # An empty classic table whose trailer points at a cross-reference stream (/XRefStm)
        # that names an altered definition of the page content.
        offsets = {}

        def rows(o):
            offsets.update(o)
            return b""

        section([("evil", stream(n, g, black_page))], rows)  # first pass: learn the offset
        entry = bytes([1]) + offsets["evil"].to_bytes(4, "big") + bytes([g])
        xref_stream = (
            b"%d 0 obj\n<< /Type /XRef /W [ 1 4 1 ] /Index [ %d 1 ] /Size %d /Length %d >>\n"
            b"stream\n%s\nendstream\nendobj" % (highest + 1, n, highest + 2, len(entry), entry)
        )
        learned = {}

        def rows_again(o):
            learned.update(o)
            return b""

        # A byte copy of the original follows, so a file-order parser sees nothing changed.
        objects = [("evil", stream(n, g, black_page)), ("xref", xref_stream), ("copy", original)]
        section(objects, rows_again)
        return section(objects, lambda o: b"", trailer_extra=b" /XRefStm %d" % learned["xref"])

    def double_trailer(n, g, original, highest, section, stream):
        # Two xref+trailer pairs in one section. startxref reaches the first, which frees the
        # page content; the second, which a file-order parser reads last, looks harmless.
        return section(
            [],
            lambda o: b"%d 1\n0000000000 %05d f \n" % (n, g + 1),
            unreached=b"xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Root 1 0 R /Size 1 >>\n",
        )

    for label, make in (
        ("duplicate-object", duplicate_object),
        ("free-entry", free_entry),
        ("generation-bump", generation_bump),
        ("hybrid", hybrid),
        ("double-trailer", double_trailer),
    ):
        t[f"certified-p2-xref-{label}.pdf"] = xref_case(make)

    def rewritten_object() -> bytes:
        # One section only, written by pyHanko: its fill of "Approver" also re-emits the page
        # content unchanged. Nothing differs object by object; only the xref shows it.
        writer = IncrementalPdfFileWriter(BytesIO(certified(MDPPerm.FILL_FORMS, two)))
        page = writer.root["/Pages"]["/Kids"][0].get_object()
        writer.mark_update(page.raw_get("/Contents"))
        out = signers.sign_pdf(
            writer,
            signers.PdfSignatureMetadata(
                field_name="Approver",
                md_algorithm="sha256",
                subfilter=SigSeedSubFilter.ADOBE_PKCS7_DETACHED,
            ),
            signer=signer,
            existing_fields_only=True,
        )
        return out.getvalue()

    t["certified-p2-xref-rewritten-object.pdf"] = rewritten_object()
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

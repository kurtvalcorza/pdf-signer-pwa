"""Generate the signed-PDF policy fixtures in tests/signing/fixtures/policy/.

These are produced by pyHanko, not by the app, so the app's incremental signer is tested
against documents it did not write. The outputs are committed. A run writes only the files that are missing, because the key is new on
every run and rewriting a committed fixture would change its bytes for no reason:

    python scripts/make_policy_fixtures.py            # add missing fixtures
    python scripts/make_policy_fixtures.py --force    # regenerate every fixture

The signing key is created in memory and discarded, so no private key is ever stored.
"""

import asyncio
import datetime
import hashlib
import re
import sys
import tempfile
import time
import zlib
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
    # pyHanko's fill rewrites the trailer /Info with the time of the fill. Written in the same
    # second as the certification, that rewrite serializes identically and the C1 case (a
    # foreign fill that rewrote /Info is accepted) would pass by accident (research.md F1).
    # Waiting for the next second makes /ModDate move, as it does in real use.
    def fill_a_second_later(pdf):
        time.sleep(1.1)
        return fill(pdf, signer, "Approver")

    t["certified-p2-two-empty-fields-signed-once.pdf"] = fill_a_second_later(
        t["certified-p2-two-empty-fields.pdf"]
    )
    t["certified-p2-two-empty-fields-signed-once-xref-stream.pdf"] = fill_a_second_later(
        certified(MDPPerm.FILL_FORMS, two, True)
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

    def unknown_transform(w):
        # Row R7: a signature that declares a transform this app does not recognise (UR3, usage
        # rights). pyHanko cannot sign with one, so the signature dictionary is rewritten later.
        fields = w.root["/AcroForm"]["/Fields"]
        ref = next(
            fields[i].raw_get("/V") for i in range(len(fields)) if fields[i]["/T"] == "Approval"
        )
        sig = ref.get_object()
        sig[name("/Reference")] = generic.ArrayObject(
            [
                generic.DictionaryObject(
                    {
                        name("/Type"): name("/SigRef"),
                        name("/TransformMethod"): name("/UR3"),
                        name("/TransformParams"): generic.DictionaryObject(
                            {name("/Type"): name("/TransformParams"), name("/V"): name("/2.2")}
                        ),
                    }
                )
            ]
        )
        w.mark_update(ref)

    def js_action(script):
        return generic.DictionaryObject(
            {name("/S"): name("/JavaScript"), name("/JS"): generic.pdf_string(script)}
        )

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
            # Row R7 (spec 004 T028).
            "approval-unknown-transform.pdf": later_revision(
                sign(built(certify=False), signer, "Approval", BOX), unknown_transform
            ),
            # Preview scripting (T9, research.md R7, task T030): the field's actions must not run.
            "certified-p2-empty-field-aa-javascript.pdf": built(
                set_on_field(
                    "/AA",
                    generic.DictionaryObject(
                        {
                            name("/E"): js_action("app.alert('field action ran');"),
                            name("/PO"): js_action("app.alert('page-open action ran');"),
                        }
                    ),
                )
            ),
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

    # ---- One hand-written, validly SIGNED fill revision (review round 2). ----
    # The files above put a crafted section under pyHanko's fill, which makes two sections in one
    # signed revision. An attacker who signs with their own tool writes one. So: take pyHanko's
    # fill of "Approver", rebuild its revision by hand as a single cross-reference section, change
    # one thing, and sign it again (SHA-256 over the new byte range, CMS from the fixture
    # signer). Every signature in these files verifies. The unchanged rebuild is the control: the
    # app must offer "Witness" on it and the validator must pass it. Every variant must be
    # refused by the app.
    def resigned(change=None, stream_xrefs=False) -> bytes:
        whole = fill(certified(MDPPerm.FILL_FORMS, two, stream_xrefs), signer, "Approver")
        cert_end = [m.end() for m in re.finditer(rb"%%EOF\s*", whole)][-2]
        base = whole[:cert_end]
        starts = [int(v) for v in re.findall(rb"startxref\s+(\d+)", whole)]
        first_xref, prev, fill_xref = starts[0], starts[-2], starts[-1]
        objs = {
            int(m.group(1)): m.group(0)
            for m in re.finditer(
                rb"(?<![0-9])(\d+) 0 obj\n.*?\nendobj\n", whole[cert_end:fill_xref], re.S
            )
        }
        section = whole[fill_xref:]
        root = re.search(rb"/Root (\d+ \d+ R)", section).group(1)
        info = re.search(rb"/Info (\d+ \d+ R)", section).group(1)
        file_id = re.search(rb"/ID (\[.*?\])", section, re.S).group(1)
        reader = PdfFileReader(BytesIO(base))
        contents = reader.root["/Pages"]["/Kids"][0].get_object().raw_get("/Contents").idnum
        plan = {
            "chunks": [(n, objs[n]) for n in sorted(objs)],  # (number or None, bytes)
            "size": None,
            "trailer_head": b"",
            "before_prev": b"",
            "decode_parms": b"",
            "field": next(n for n, data in objs.items() if b"/T (Approver)" in data),
            "contents": contents,
            "original_contents": re.search(
                rb"(?<![0-9])%d 0 obj\n.*?\nendobj\n" % contents, base, re.S
            ).group(0),
            "highest": max(objs),
            "first_xref": first_xref,
        }
        if change:
            change(plan)

        out = base
        offsets = {}
        for num, data in plan["chunks"]:
            data = re.sub(
                rb"/ByteRange \[[^\]]*\]", b"/ByteRange [0 1000000 1000000 1000000]", data
            )
            if num is not None:
                offsets[num] = len(out)
            out += data
        at = len(out)
        if not stream_xrefs:
            size = plan["size"] or max(offsets) + 1
            out += b"xref\n0 1\n0000000000 65535 f \n"
            out += b"".join(b"%d 1\n%010d 00000 n \n" % (n, offsets[n]) for n in sorted(offsets))
            out += b"trailer\n<<\n" + plan["trailer_head"]
            out += b"/Root %s\n/Info %s\n/ID %s\n/Size %d\n" % (root, info, file_id, size)
            out += plan["before_prev"] + b"/Prev %d\n>>\nstartxref\n%d\n%%%%EOF\n" % (prev, at)
        else:
            own = max(offsets) + 1
            rows = [(0, 0, 0, 65535)] + [(n, 1, offsets[n], 0) for n in sorted(offsets)]
            rows.append((own, 1, at, 0))
            table = b"".join(
                bytes([kind]) + second.to_bytes(4, "big") + third.to_bytes(2, "big")
                for _, kind, second, third in rows
            )
            packed = zlib.compress(table)
            index = b" ".join(b"%d 1" % n for n, *_ in rows)
            out += b"%d 0 obj\n<<\n/Type /XRef\n/W [ 1 4 2 ]\n/Index [ %s ]\n" % (own, index)
            out += b"/Filter /FlateDecode\n" + plan["decode_parms"]
            out += b"/Root %s\n/Info %s\n/ID %s\n/Size %d\n" % (root, info, file_id, own + 1)
            out += b"/Prev %d\n/Length %d\n>>\nstream\n" % (prev, len(packed))
            out += packed + b"\nendstream\nendobj\n\nstartxref\n%d\n%%%%EOF\n" % at

        # Point the new signature's /ByteRange at the rebuilt file and sign it.
        gap = re.search(rb"/Contents <([0-9A-Fa-f]+)>", out[cert_end:])
        a = cert_end + gap.start(1) - 1
        b = cert_end + gap.end(1) + 1
        declared = re.search(rb"/ByteRange \[[^\]]*\]", out[cert_end:])
        actual = b"/ByteRange [0 %d %d %d]" % (a, b, len(out) - b)
        assert len(actual) <= len(declared.group(0))
        actual = actual[:-1] + b" " * (len(declared.group(0)) - len(actual)) + b"]"
        out = out[: cert_end + declared.start()] + actual + out[cert_end + declared.end() :]
        digest = hashlib.sha256(out[:a] + out[b:]).digest()
        cms = asyncio.run(signer.async_sign(digest, "sha256")).dump().hex().upper().encode()
        width = b - a - 2
        assert len(cms) <= width
        return out[: a + 1] + cms + b"0" * (width - len(cms)) + out[b - 1 :]

    def plain_stream(num, data):
        return b"%d 0 obj\n<<\n/Length %d\n>>\nstream\n%s\nendstream\nendobj\n" % (
            num,
            len(data),
            data,
        )

    def replace_chunk(plan, num, change):
        plan["chunks"] = [(n, change(d) if n == num else d) for n, d in plan["chunks"]]

    def repeated_key_field(plan):
        # The field's dictionary names /Rect twice: first the whole page, last the real box.
        replace_chunk(
            plan,
            plan["field"],
            lambda d: d.replace(b"<<\n", b"<<\n/Rect [ 0 0 612 792 ]\n", 1),
        )

    def repeated_key_root(plan):
        # The trailer names /Root twice: first a catalog of the signer's own, last the real one.
        h = plan["highest"]
        plan["chunks"] += [
            (h + 1, b"%d 0 obj\n<<\n/Type /Catalog\n/Pages %d 0 R\n>>\nendobj\n" % (h + 1, h + 2)),
            (
                h + 2,
                b"%d 0 obj\n<<\n/Type /Pages\n/Count 1\n/Kids [ %d 0 R ]\n>>\nendobj\n"
                % (h + 2, h + 3),
            ),
            (
                h + 3,
                b"%d 0 obj\n<<\n/Type /Page\n/MediaBox [ 0 0 612 792 ]\n/Contents %d 0 R\n"
                b"/Parent %d 0 R\n>>\nendobj\n" % (h + 3, h + 4, h + 2),
            ),
            (h + 4, plain_stream(h + 4, b"0 0 612 792 re f")),
        ]
        plan["trailer_head"] = b"/Root %d 0 R\n" % (h + 1)

    def repeated_key_prev(plan):
        # /Prev twice: first the section written before certification, last the certified one.
        plan["before_prev"] = b"/Prev %d\n" % plan["first_xref"]

    def size_low(plan):
        plan["size"] = 3  # a reader ignores every object numbered 3 or above

    def size_short(plan):
        plan["size"] = plan["highest"]  # one short: the new signature itself is ignored

    def decode_parms(plan):
        # The rows are written plain, but the stream declares a PNG predictor: a reader that
        # applies it reads a different table from the one a reader that does not.
        plan["decode_parms"] = b"/DecodeParms << /Predictor 12 /Columns 7 >>\n"

    def glued_definitions(plan):
        # An altered page content and a byte copy of the original, both glued to the previous
        # `endobj` (no white space before the object number) and both left out of the xref.
        num, last = plan["chunks"][-1]
        n = plan["contents"]
        glued = last[:-1] + plain_stream(n, b"0 0 612 792 re f")[:-1] + plan["original_contents"]
        plan["chunks"][-1] = (num, glued)

    t["certified-p2-signed-xref-control.pdf"] = resigned()
    t["certified-p2-signed-xref-control-xref-stream.pdf"] = resigned(stream_xrefs=True)
    t["certified-p2-signed-xref-repeated-key-field.pdf"] = resigned(repeated_key_field)
    t["certified-p2-signed-xref-repeated-key-root.pdf"] = resigned(repeated_key_root)
    t["certified-p2-signed-xref-repeated-key-prev.pdf"] = resigned(repeated_key_prev)
    t["certified-p2-signed-xref-size-low.pdf"] = resigned(size_low)
    t["certified-p2-signed-xref-size-short.pdf"] = resigned(size_short)
    t["certified-p2-signed-xref-decode-parms.pdf"] = resigned(decode_parms, stream_xrefs=True)
    t["certified-p2-signed-xref-glued-definitions.pdf"] = resigned(glued_definitions)
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

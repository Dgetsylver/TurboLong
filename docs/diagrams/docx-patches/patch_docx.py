#!/usr/bin/env python3
"""Replace the single §1.6 data-flow diagram in threat-model-stride.docx with
the two corrected views, and adjust the surrounding prose.

Rewrites the package in place (via a temp file), preserving every other part
byte-for-byte.
"""
import shutil
import zipfile
from pathlib import Path

DOCX = Path("/Users/hugoheer/Documents/The_Aha_Company/turbolong/TurboLong/"
            "docs/threat-model-stride.docx")
SP = Path(__file__).parent
EMU = 914400

# Rendered PNG pixel sizes, used to preserve aspect ratio.
PX = {"a": (3040, 2080), "b": (2880, 2140)}
WIDTH_IN = {"a": 9.4, "b": 8.7}

REL_A, REL_B = "rId18", "rId40"        # rId18 already exists; rId40 is new
MEDIA_A, MEDIA_B = "media/rId18.png", "media/rId40.png"

ALT_A = ("Data-flow diagram, view A - control: trust boundaries TB-1, TB-2, "
         "TB-3 and TB-6, and flows DF-1 to DF-8, DF-20, DF-21.")
ALT_B = ("Data-flow diagram, view B - value: trust boundaries TB-1, TB-4 and "
         "TB-5, and flows DF-9 to DF-19 and DF-23.")


def drawing(rel, alt, w_in, px, pid):
    cx = int(w_in * EMU)
    cy = int(cx * px[1] / px[0])
    return (
        '<w:p><w:pPr><w:pStyle w:val="BodyText" /></w:pPr><w:r><w:drawing>'
        f'<wp:inline><wp:extent cx="{cx}" cy="{cy}" />'
        '<wp:effectExtent b="0" l="0" r="0" t="0" />'
        f'<wp:docPr descr="{alt}" title="" id="{pid}" name="Picture" />'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/'
        'drawingml/2006/picture"><pic:pic><pic:nvPicPr>'
        f'<pic:cNvPr descr="dfd.png" id="{pid + 1}" name="Picture" />'
        '<pic:cNvPicPr><a:picLocks noChangeArrowheads="1" '
        'noChangeAspect="1" /></pic:cNvPicPr></pic:nvPicPr><pic:blipFill>'
        f'<a:blip r:embed="{rel}" /><a:stretch><a:fillRect /></a:stretch>'
        '</pic:blipFill><pic:spPr bwMode="auto"><a:xfrm>'
        f'<a:off x="0" y="0" /><a:ext cx="{cx}" cy="{cy}" /></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst /></a:prstGeom><a:noFill />'
        '<a:ln w="9525"><a:noFill /><a:headEnd /><a:tailEnd /></a:ln>'
        '</pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline>'
        '</w:drawing></w:r></w:p>')


def caption(bold, rest):
    return ('<w:p><w:pPr><w:pStyle w:val="BodyText" /></w:pPr>'
            f'<w:r><w:rPr><w:b /><w:bCs /></w:rPr>'
            f'<w:t xml:space="preserve">{bold}</w:t></w:r>'
            f'<w:r><w:t xml:space="preserve">{rest}</w:t></w:r></w:p>')


PAGE_BREAK = '<w:p><w:r><w:br w:type="page" /></w:r></w:p>'


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    rels = zin.read("word/_rels/document.xml.rels").decode("utf-8")
    ctypes = zin.read("[Content_Types].xml").decode("utf-8")

    # ── 1. swap the drawing paragraph for the two views ──────────────
    start = doc.find('<w:p><w:pPr><w:pStyle w:val="BodyText" /></w:pPr>'
                     '<w:r><w:drawing>')
    assert start != -1, "drawing paragraph not found"
    tail = '<w:t xml:space="preserve">{width=9.4in}</w:t></w:r></w:p>'
    end = doc.find(tail, start)
    assert end != -1, "stray {width} run not found"
    end += len(tail)

    block = (
        caption("A · Control view — who may invoke what. ",
                "TB-1, TB-2 and TB-3 gate the callers; TB-6 is the boundary "
                "between the strategy and the share token, not a box around "
                "them. Nothing consumes the emitted events (Repudiate.1).")
        + drawing(REL_A, ALT_A, WIDTH_IN["a"], PX["a"], 19)
        + PAGE_BREAK
        + caption("B · Value view — principal, and the harvest round trip. ",
                  "TB-4 is the external-protocol boundary; TB-5 cuts between "
                  "the on-chain swap account and the off-chain Broker leg, "
                  "which is the only flow the chain cannot observe. The "
                  "underlying and BLND token contracts appear as edge labels "
                  "rather than nodes.")
        + drawing(REL_B, ALT_B, WIDTH_IN["b"], PX["b"], 21))

    doc = doc[:start] + block + doc[end:]

    # ── 2. explain the split in the §1.6 lead-in ─────────────────────
    old = '<w:r><w:t xml:space="preserve">can cite them.</w:t></w:r>'
    assert doc.count(old) == 1, f"lead-in run appears {doc.count(old)}x"
    doc = doc.replace(old, (
        '<w:r><w:t xml:space="preserve">can cite them. The model is drawn '
        'as two views — A for control and authority, B for value movement — '
        'because a single picture of both was unreadable at page size. '
        'Between them they carry every boundary TB-1 to TB-6 and every flow '
        'cited in §2. DF-22 has been withdrawn: it recorded the alerts '
        'worker reading contract events, and no such reader exists.'
        '</w:t></w:r>'))

    # ── 3. register the second image ─────────────────────────────────
    assert REL_B not in rels
    rels = rels.replace(
        '</Relationships>',
        '<Relationship Type="http://schemas.openxmlformats.org/'
        'officeDocument/2006/relationships/image" '
        f'Id="{REL_B}" Target="{MEDIA_B}" /></Relationships>')

    # This package overrides the content type per image rather than
    # declaring a png default, so the new part needs its own entry.
    assert MEDIA_B not in ctypes
    ctypes = ctypes.replace(
        '</Types>',
        f'<Override PartName="/word/{MEDIA_B}" '
        'ContentType="image/png" /></Types>')

    # ── 4. write the package ─────────────────────────────────────────
    png_a = (SP / "dfd_a.png").read_bytes()
    png_b = (SP / "dfd_b.png").read_bytes()
    out = SP / "patched.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in zin.infolist():
            if item.filename == "word/document.xml":
                zo.writestr(item, doc.encode("utf-8"))
            elif item.filename == "word/_rels/document.xml.rels":
                zo.writestr(item, rels.encode("utf-8"))
            elif item.filename == "[Content_Types].xml":
                zo.writestr(item, ctypes.encode("utf-8"))
            elif item.filename == "word/" + MEDIA_A:
                zo.writestr(item, png_a)
            else:
                zo.writestr(item, zin.read(item.filename))
        zo.writestr("word/" + MEDIA_B, png_b)
    zin.close()

    shutil.copy(DOCX, SP / "threat-model-stride.docx.bak")
    shutil.move(out, DOCX)
    print(f"patched {DOCX}  ({DOCX.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Re-embed docs/diagrams/dfd_{a,b}.png into the threat model, resizing the
drawing extents to the images' true aspect ratio.

Run after ./render.sh whenever a diagram changes. Idempotent.
"""
import re
import shutil
import struct
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIAGRAMS = HERE.parent
DOCX = DIAGRAMS.parent / "threat-model-stride.docx"
EMU = 914400

# Rendered width on the page. The text column is 10in (landscape Letter, 0.5in
# margins); these leave ~0.6in under each caption so it cannot orphan.
PLAN = {"rId18": ("dfd_a.png", 9.4), "rId40": ("dfd_b.png", 8.7)}


def png_size(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    w, h = struct.unpack(">II", data[16:24])          # IHDR width, height
    return w, h


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    blobs = {}

    for rel, (name, w_in) in PLAN.items():
        data = (DIAGRAMS / name).read_bytes()
        px_w, px_h = png_size(data)
        cx = int(w_in * EMU)
        cy = int(cx * px_h / px_w)
        blobs[rel] = data

        # Locate the <w:drawing> that references this relationship, then fix
        # both extent elements inside it (wp:extent and a:ext must agree).
        i = doc.index(f'r:embed="{rel}"')
        a = doc.rindex("<w:drawing>", 0, i)
        b = doc.index("</w:drawing>", i) + len("</w:drawing>")
        block = doc[a:b]
        fixed, n = re.subn(r'cx="\d+" cy="\d+"', f'cx="{cx}" cy="{cy}"', block)
        assert n == 2, f"{rel}: expected 2 extents, found {n}"
        doc = doc[:a] + fixed + doc[b:]
        print(f"  {name}: {px_w}x{px_h}px -> {w_in}in x {cy / EMU:.2f}in")

    media = {f"word/media/{rel}.png": d for rel, d in blobs.items()}
    out = HERE / "_reembed.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in zin.infolist():
            if item.filename == "word/document.xml":
                zo.writestr(item, doc.encode("utf-8"))
            elif item.filename in media:
                zo.writestr(item, media[item.filename])
            else:
                zo.writestr(item, zin.read(item.filename))
    zin.close()
    shutil.move(out, DOCX)
    print(f"re-embedded into {DOCX.name}")


if __name__ == "__main__":
    main()

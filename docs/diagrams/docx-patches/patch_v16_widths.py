#!/usr/bin/env python3
"""Fix two table-width defects.

§3.3 (Decisions needed). The table declares three grid columns
(1795 + 2950 + 9655 = 14400) but every row carries four cells
(1795 + 2950 + 1700 + 7955 = 14400). Under `<w:tblLayout w:type="fixed"/>`
Word positions columns from the tblGrid, so the fourth cell has no column to
sit in: the table renders about 7955 dxa — 5.5in — wider than the 10in text
column, and Trade-off runs off the page. The row widths are the intended
layout and already sum to exactly 14400, so the grid is what is wrong.

This is what adding the Kind column cost: §3.3's own prose records that the
column was introduced because "§3, §3.2 and this table previously disagreed",
and the grid was never widened to match. Nothing in the document's checks
looks at geometry, which is why it survived a version.

§4 findings log. The row added by patch_v16_log.py used 6870 dxa for its last
cell where every other row and the grid use 6865. Mine, and harmless under a
fixed layout, but a row that disagrees with its grid is the defect above in
miniature.
"""
import shutil
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCX = HERE.parent.parent / "threat-model-stride.docx"

# Ref / Decision / Kind / Trade-off, matching the tcW every row already uses.
OLD_GRID = ('<w:gridCol w:w="1795" /><w:gridCol w:w="2950" />'
            '<w:gridCol w:w="9655" />')
NEW_GRID = ('<w:gridCol w:w="1795" /><w:gridCol w:w="2950" />'
            '<w:gridCol w:w="1700" /><w:gridCol w:w="7955" />')


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    others = [(n, zin.read(n)) for n in zin.namelist()
              if n != "word/document.xml"]
    zin.close()

    # §3.3 — patch the grid of the first table after the heading only.
    i = doc.index("3.3 Decisions needed")
    j = doc.index("<w:tblGrid>", i)
    k = doc.index("</w:tblGrid>", j) + len("</w:tblGrid>")
    grid = doc[j:k]
    assert OLD_GRID in grid, f"unexpected §3.3 grid: {grid}"
    doc = doc[:j] + grid.replace(OLD_GRID, NEW_GRID) + doc[k:]
    print("  §3.3 grid  3 cols -> 4 cols (1795+2950+1700+7955 = 14400)")

    # §4 findings log — the row this pass added.
    assert doc.count('<w:tcW w:type="dxa" w:w="6870" />') == 1
    doc = doc.replace('<w:tcW w:type="dxa" w:w="6870" />',
                      '<w:tcW w:type="dxa" w:w="6865" />')
    print("  §4 log row 6870 -> 6865")

    out = DOCX.with_suffix(".docx.new")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", doc)
        for n, b in others:
            z.writestr(n, b)
    shutil.move(out, DOCX)
    print(f"patched {DOCX}")


if __name__ == "__main__":
    main()

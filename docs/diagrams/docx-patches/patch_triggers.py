#!/usr/bin/env python3
"""§4.1 Review triggers — close the gap this pass exposed.

Verified first: lib.rs:123-131 is exactly the HF lower-bound derivation the
Blend-governance trigger cites, and four rows carry † so the custody trigger
is meaningful. No errors.

The gap is completeness. Every existing trigger fires on a change to the
*code*; none fires on a change to the *document*. That is why §3.1 kept
calling two Low rows Critical for two revisions after §2.3 downgraded them,
why six planned treatments had no work item, and why §3, §3.2 and §3.3 drifted
into three different pending-decision sets — insight 16's failure mode, with
nothing in the checklist that would catch it.

Adds two document-consistency triggers next to the source-verification one, so
the three group together ahead of the code triggers. Also points the
new-entrypoint trigger at view A specifically, now that §1.6 is two diagrams.
"""
import re
import shutil
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCX = HERE.parent.parent / "threat-model-stride.docx"

RPR = {"plain": "",
       "code": '<w:rPr><w:rStyle w:val="VerbatimChar" /></w:rPr>',
       "bold": '<w:rPr><w:b /><w:bCs /></w:rPr>',
       "ital": '<w:rPr><w:i /><w:iCs /></w:rPr>'}
C, P, B, I = "code", "plain", "bold", "ital"
W = [3895, 10505]


def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace("'", "&#39;"))


def runs(parts):
    if isinstance(parts, str):
        parts = [(P, parts)]
    return "".join(f'<w:r>{RPR[k]}<w:t xml:space="preserve">{esc(t)}</w:t>'
                   '</w:r>' for k, t in parts)


def row(cells):
    out = []
    for w, c in zip(W, cells):
        out.append(f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{w}" /></w:tcPr>'
                   '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
                   + runs(c) + '</w:p></w:tc>')
    return "<w:tr>" + "".join(out) + "</w:tr>"


NEW = [
 row([[(B, "A threat row is added or removed")],
      [(P, "§2.4's coverage map, "), (I, "re-derived"), (P, " from the "),
       (C, "Boundary"), (P, " column rather than hand-edited (insight 9); §3 "
           "for at least one treatment; §3.2 for a work item if that "
           "treatment is planned; §3.3 if it needs sign-off; and §4's counts. "
           "Six planned treatments had no work item before v1.5 because this "
           "loop was never closed.")]]),
 row([[(B, "A severity is re-scored")],
      [(P, "§3.1's residual list, §2.6's ranking, the "), (B, "†"),
       (P, " markers, and §4's counts — none of which derive themselves. "
           "§3.1 called Spoof.2 and Elevation.3 Critical for two revisions "
           "after §2.3 downgraded them to Low, so the section stating what "
           "risk remained overstated it by two rows.")]]),
]


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    a = doc.index("Review triggers")
    b = doc.index("What this model does not cover")
    m = re.search(r'<w:tbl>.*?</w:tbl>', doc[a:b], re.S)
    tbl = m.group(0)
    rows = list(re.finditer(r'<w:tr>.*?</w:tr>', tbl, re.S))
    assert len(rows) == 12, f"expected 12 rows, found {len(rows)}"
    assert "source-verification pass" in rows[1].group(0), "row 1 moved"

    # insert after the source-verification trigger
    at = rows[1].end()
    new_tbl = tbl[:at] + "".join(NEW) + tbl[at:]

    # §1.6 is two diagrams now — name the one a new entrypoint belongs in
    old = "§1.6 (new data flow)"
    assert new_tbl.count(old) == 1, f"entrypoint trigger text changed"
    new_tbl = new_tbl.replace(old, "§1.6 view A (control) for the new flow")

    print(f"  triggers: {len(rows) - 1} -> {len(rows) - 1 + len(NEW)}")
    doc = doc[:a + m.start()] + new_tbl + doc[a + m.end():]

    out = HERE / "_trg.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("§4.1 extended")


if __name__ == "__main__":
    main()

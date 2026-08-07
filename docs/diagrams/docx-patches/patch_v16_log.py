#!/usr/bin/env python3
"""v1.6: bump the version and log the pass, per §4.1 and insight 16.

patch_review_v16.py made the corrections; this records that they happened.
The document's own rules require both: §4.1 makes "any source-verification
pass on this document" a trigger, §4's log asks every pass to answer "should
this model have caught it?", and insight 16 is that cross-section state — the
version line included — drifts because nothing derives it.

Leaving the header at v1.5 after a v1.6 pass would be that exact defect.
"""
import shutil
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCX = HERE.parent.parent / "threat-model-stride.docx"

RPR = {"plain": "", "bold": '<w:rPr><w:b /><w:bCs /></w:rPr>'}
P, B = "plain", "bold"


def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace("'", "&#39;"))


def runs(parts):
    return "".join(f'<w:r>{RPR[k]}<w:t xml:space="preserve">{esc(t)}</w:t>'
                   '</w:r>' for k, t in parts)


def cell(width, parts):
    return (f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{width}" /></w:tcPr>'
            '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
            + runs(parts) + '</w:p></w:tc>')


ROW = ('<w:tr>'
       + cell(1270, [(P, "2026-08-07")])
       + cell(4570, [
           (B, "§1.2 claimed Blend's risk parameters are read live"),
           (P, " when only "), (P, "l_factor"), (P, " is — the premise "
            "Tamper.1 exists to contradict. Alongside it: five diagram flows "
            "no §2 row cited, two Info rows tagged to call flows for threats "
            "about reading published state, half of §2.4's empty cells left "
            "silent, §2.5's parameter summary true for two assets of four, "
            "Tamper.11's margins resting on an unstated l = 0.95, a treatment "
            "typed accepted that §3.3 says cannot be decided yet, and §1.3's "
            "asset register cited nowhere after §1.3"),
         ])
       + cell(1690, [(P, "v1.6 review pass")])
       + cell(6870, [
           (B, "Yes, and the shape repeats."), (P, " Every one is a join: a "
            "premise in §1 that a §2 row refutes, a table whose ids nothing "
            "downstream cites, a count that stopped matching what produces "
            "it. v1.5 found the same class in §3 and §4 and fixed the "
            "instances rather than the mechanism, so the next pass found more "
            "of it in §1 and §2. The citations — the mechanical claims — held: "
            "all ~100 file:line references resolved. Insight 15 predicted "
            "exactly that split and this pass confirms it a second time, "
            "which makes it a standing property of the document rather than "
            "an observation about one revision"),
         ])
       + '</w:tr>')


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    others = [(n, zin.read(n)) for n in zin.namelist()
              if n != "word/document.xml"]
    zin.close()

    # Header: version, and the scope sentence that says what is verified.
    old = ("COMPLETE (v1.5, reconciled against the 2026-08 audit. §2 and §3 "
           "are source-verified against the contracts; §1&#39;s assumption "
           "columns and the §1.6 diagram only as of v1.5 — see the findings "
           "log). Pending: key custody decision (§1.7),")
    new = ("COMPLETE (v1.6, reconciled against the 2026-08 audit. §1, §2 and "
           "§3 are source-verified against the contracts as of v1.6, "
           "including every file:line citation and the §1.6 diagram&#39;s "
           "flow coverage — see the findings log). Pending: key custody "
           "decision (§1.7),")
    assert doc.count(old) == 1
    doc = doc.replace(old, new)

    assert doc.count(">1.5 ·</w:t>") == 1
    doc = doc.replace(">1.5 ·</w:t>", ">1.6 ·</w:t>")

    # Newest-first findings log: insert above the current top row.
    i = doc.index("Should this model have caught it?")
    j = doc.index("</w:tr>", i) + len("</w:tr>")
    doc = doc[:j] + ROW + doc[j:]

    out = DOCX.with_suffix(".docx.new")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", doc)
        for n, b in others:
            z.writestr(n, b)
    shutil.move(out, DOCX)
    print(f"patched {DOCX}")


if __name__ == "__main__":
    main()

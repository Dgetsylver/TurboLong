#!/usr/bin/env python3
"""Remove Appendix A (Change log) and Appendix B (Open items).

Boundaries: bookmarkStart id=38 opens Appendix A and bookmarkEnd id=39 closes
Appendix B, so the whole span deletes as one range with both bookmark pairs
inside it. The document-wide bookmark 40 and the trailing <w:sectPr> both sit
outside and are preserved.

Two knock-on edits are required, because both appendices were referenced:

  §2.2   "Revision history does not go here; it goes in §4's findings log and
         Appendix A" — the second destination no longer exists.
  ins.14 "...it regrew in §4 and the changelog and was cut again in v1.5".

Nothing else in the body referenced either appendix. Appendix B was pure
duplication of §1.7/§3.2/§3.3/§4.2 and had already drifted: it listed DoS.2 as
blocked on product sign-off, where §3.3 now records it as not yet decidable
pending the P0 netting investigation.
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


def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace("'", "&#39;"))


def runs(parts):
    return "".join(f'<w:r>{RPR[k]}<w:t xml:space="preserve">{esc(t)}</w:t>'
                   '</w:r>' for k, t in parts)


def para(style, parts, num_id=None):
    npr = (f'<w:numPr><w:ilvl w:val="0" /><w:numId w:val="{num_id}" /></w:numPr>'
           if num_id else '')
    return (f'<w:p><w:pPr><w:pStyle w:val="{style}" />{npr}</w:pPr>'
            + runs(parts) + '</w:p>')


RULE = [
 (B, "What belongs in a row."),
 (P, " §2.3 is the operative register — what the threat is, what bounds it, "
     "how bad it is. "), (B, "Revision history does not go here;"),
 (P, " it goes in §4's findings log. A row's length should track its "
     "severity, not how interesting its discovery was, and a row that mainly "
     "explains its relation to another row is a sentence in that row. See "
     "insight 14."),
]

INSIGHT_14 = [
 (B, "A register accumulates narration, and narration crowds out threats."),
 (P, " By v1.3 a sixth of §2.3 was the document narrating its own past. Cut "
     "in v1.4, it regrew in §4 and was cut again in v1.5. Re-measure it every "
     "pass; it does not stay cut."),
]


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    before = len(doc)

    # ── excise both appendices ───────────────────────────────────────
    start = re.search(r'<w:bookmarkStart[^>]*w:id="38"[^>]*/>', doc)
    end = re.search(r'<w:bookmarkEnd[^>]*w:id="39"[^>]*/>', doc)
    assert start and end and end.end() > start.start()
    span = doc[start.start():end.end()]
    assert "Change log" in span and "Open items" in span, "wrong span"
    assert "<w:sectPr>" not in span, "would delete page setup"
    assert 'w:id="40"' not in span, "would orphan the document bookmark"
    doc = doc[:start.start()] + doc[end.end():]
    print(f"  removed {len(span):,} XML chars (Appendix A + B)")

    # ── knock-on edit 1: §2.2's editorial rule ───────────────────────
    i = doc.index("What belongs in a row")
    a = doc.rindex("<w:p>", 0, i)
    b = doc.index("</w:p>", i) + len("</w:p>")
    assert "Appendix A" in doc[a:b], "rule text moved"
    doc = doc[:a] + para("BodyText", RULE) + doc[b:]
    print("  §2.2 rule re-pointed at §4's findings log")

    # ── knock-on edit 2: insight 14 ──────────────────────────────────
    i = doc.index("A register accumulates narration")
    a = doc.rindex("<w:p>", 0, i)
    b = doc.index("</w:p>", i) + len("</w:p>")
    nid = re.search(r'w:numId w:val="(\d+)"', doc[a:b]).group(1)
    doc = doc[:a] + para("Compact", INSIGHT_14, nid) + doc[b:]
    print("  insight 14 de-referenced")

    # ── confirm nothing dangles ──────────────────────────────────────
    txt = "".join(re.findall(r'<w:t(?: [^>]*)?>(.*?)</w:t>', doc, re.S))
    for probe in ("Appendix A", "Appendix B", "changelog", "Change log"):
        n = txt.count(probe)
        print(f"  remaining {probe!r}: {n}")
        assert n == 0, f"dangling reference to {probe}"
    assert "<w:sectPr>" in doc and 'w:id="40"' in doc
    print(f"  document.xml {before:,} -> {len(doc):,}")

    out = HERE / "_ap.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("appendices removed")


if __name__ == "__main__":
    main()

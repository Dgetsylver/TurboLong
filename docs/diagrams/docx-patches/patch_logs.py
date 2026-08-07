#!/usr/bin/env python3
"""Cut the v1.5 log entries down to what changed, not why.

The v1.5 changelog row was 3,617 chars — 44% of a ten-version changelog for
one version — and its three findings-log rows were 37% of that log. That is
the failure insight 14 describes, committed in the same edit that cited it.
The reasoning lives in the diff and in insight 15; the log records the change.
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


CHANGELOG_CELL = cell(12175, [
    ("bold", "§1 verification pass — the first to check §1's claims rather "
             "than §2's."),
    ("plain", " Rebuilt the §1.6 diagram as two views (A control, B value), "
              "correcting five errors; DF-22 withdrawn — it recorded a reader "
              "of contract events that does not exist. Corrected three claims "
              "in §1.2 (keeper harvest floor, "), ("code", "partial_unwind"),
    ("plain", "'s gate, “nothing” assumed of depositors) and three "
              "in §1.7 ("), ("code", "c_factor"),
    ("plain", " is not read live, assumption 2's measurement scope, the "
              "keeper custody rationale). Added §1.7 assumption 7 ("),
    ("code", "preflight()"), ("plain", " is the only implementation of "),
    ("code", "design_hf > orange_hf"),
    ("plain", "), the §1.7 "), ("bold", "Token admin"),
    ("plain", " custody row Elevation.4 already cited, and a Constructor row "
              "to §1.4's token table. Fixed two §2.3 citations: Info.1's "
              "floor guidance (a doc comment, not §1.7) and DoS.5's TTL claim "
              "(misses "), ("code", "upgrade"),
    ("plain", "). §1.4 and §1.5 were verified and stand. Editorial: §4 cut "
              "28% and these log entries with it — see insights 14 and 15. "
              "No threat added, removed or re-scored."),
])

FINDING_ROW = "<w:tr>" + (
    cell(1270, [("plain", "2026-08-07")])
    + cell(4570, [
        ("bold", "§1's prose asserted six things the contracts contradict"),
        ("plain", " — three in §1.2, three in §1.7 — plus five errors in the "
                  "§1.6 diagram and two cross-references to guidance that was "
                  "not where they pointed (Info.1, Elevation.4)"),
    ])
    + cell(1690, [("plain", "v1.5 §1 verification")])
    + cell(6865, [
        ("bold", "Yes."), ("plain", " Every one was already contradicted by a "
                                    "row in this same document — Elevation.5, "
                                    "§1.4, Tamper.6, Tamper.1. The v1.2 pass "
                                    "verified “every threat row and "
                                    "~50 of §3's citations”, so §1's "
                                    "assumption columns and the diagram were "
                                    "never in scope: the premises §2 is "
                                    "enumerated "), ("ital", "from"),
        ("plain", " went unchecked for three revisions while the conclusions "
                  "drawn from them were checked twice. See insight 15."),
    ])) + "</w:tr>"


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    def table_span(anchor):
        i = doc.index(anchor)
        j = doc.index("<w:tbl>", i)
        return j, doc.index("</w:tbl>", j)

    # ── changelog: replace the v1.5 row's third cell ─────────────────
    j, k = table_span("Change log")
    rows = list(re.finditer(r'<w:tr>.*?</w:tr>', doc[j:k], re.S))
    v15 = rows[1].group(0)
    assert "§1 verification pass" in v15, "v1.5 row not where expected"
    cells = list(re.finditer(r'<w:tc>.*?</w:tc>', v15, re.S))
    assert len(cells) == 3
    before = len(cells[2].group(0))
    new_row = v15[:cells[2].start()] + CHANGELOG_CELL + v15[cells[2].end():]
    doc = doc[:j + rows[1].start()] + new_row + doc[j + rows[1].end():]
    print(f"  changelog v1.5 cell: {before:,} -> {len(CHANGELOG_CELL):,}")

    # ── findings log: three v1.5 rows -> one ─────────────────────────
    j, k = table_span("Have additional issues been found")
    rows = list(re.finditer(r'<w:tr>.*?</w:tr>', doc[j:k], re.S))
    mine = [r for r in rows[1:4]]
    assert all("v1.5 §1 verification" in r.group(0) for r in mine), \
        "the three v1.5 rows are not rows 1-3"
    before = sum(len(r.group(0)) for r in mine)
    doc = (doc[:j + mine[0].start()] + FINDING_ROW
           + doc[j + mine[-1].end():])
    print(f"  findings-log rows:   {before:,} -> {len(FINDING_ROW):,} (3 -> 1)")

    out = HERE / "_logs.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("trimmed the v1.5 log entries")


if __name__ == "__main__":
    main()

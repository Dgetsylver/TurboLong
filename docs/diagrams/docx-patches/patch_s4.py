#!/usr/bin/env python3
"""§4 Did we do a good job? — correct the self-assessment.

Three defects, all of the kind §4 exists to catch:

1. COUNT. The prose said "Ten issues are genuinely additional ... Seven came
   from the v1.0 boundary sweep and are listed below" — above a table of eight
   rows carrying nine threats (Repudiate.2 and .3 share a row). The table also
   includes Elevation.5, which §2.5 deliberately excludes from its own
   "genuinely additional" list because it is a residual of audit M-5. So the
   section measuring this model's yield miscounted it, in the direction that
   understates the work. This is insight 9's failure — a derived number
   maintained by hand — committed by the section that states insight 9.

2. STALE. "Yes — v1.2 is the result" under "have additional issues been found
   afterward?" was true two revisions ago.

3. CONTRADICTION. "DoS.2 (pool liquidity blocks withdrawals) has no fix
   whatsoever" contradicts DoS.2.R.2, a planned treatment, and §3.1, which now
   records that whether DoS.2 is residual at all is unproven pending the P0
   netting investigation.

Adds insight 16 and a findings-log row for the §3 reconciliation, both earned
by this session rather than restated from it.
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
    if isinstance(parts, str):
        parts = [(P, parts)]
    return "".join(f'<w:r>{RPR[k]}<w:t xml:space="preserve">{esc(t)}</w:t>'
                   '</w:r>' for k, t in parts)


def cell(width, parts):
    return (f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{width}" /></w:tcPr>'
            '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
            + runs(parts) + '</w:p></w:tc>')


def replace_para(doc, anchor, parts, style="BodyText"):
    i = doc.index(anchor)
    a = doc.rindex("<w:p>", 0, i)
    b = doc.index("</w:p>", i) + len("</w:p>")
    new = (f'<w:p><w:pPr><w:pStyle w:val="{style}" /></w:pPr>'
           + runs(parts) + '</w:p>')
    return doc[:a] + new + doc[b:], len(doc[a:b]), len(new)


INSIGHT_16 = [
    (B, "Cross-section state drifts, and nothing flags it."),
    (P, " §3.2's priority order, §3.3's item count and §3's sign-off markers "
        "each looked right in isolation and disagreed with one another; §1.2, "
        "§1.6 and §1.7 each contradicted a §2 row. A document has no "
        "type-checker for its own joins, so check the joins deliberately: "
        "counts against the tables that produce them, cross-references "
        "against the thing they point at."),
]

FINDING = "<w:tr>" + (
    cell(1270, [(P, "2026-08-07")])
    + cell(4570, [
        (B, "§3 and §4 disagreed with themselves"),
        (P, " — §3.2 was not in priority order despite claiming to be, six "
            "planned treatments had no work item, §3/§3.2/§3.3 listed three "
            "different pending-decision sets, §3.1 called two Low rows "
            "Critical, and §4 miscounted its own yield"),
    ])
    + cell(1690, [(P, "v1.5 §3/§4 pass")])
    + cell(6865, [
        (B, "Yes — and the shape is the point."),
        (P, " Every one of these sections is internally coherent; the defects "
            "are all at the joins, where one section restates or counts "
            "another. §3.1's stale severities predate the v1.2 re-scoring "
            "that §2.3 and §2.5 both record, and §4's undercount is insight "
            "9's own failure mode committed by the section that states "
            "insight 9. Derived numbers and cross-references need re-deriving "
            "on every pass, not proof-reading. See insight 16."),
    ])) + "</w:tr>"


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    # 1. the count
    doc, o, n = replace_para(doc, "Ten issues are genuinely additional", [
        (P, "Twelve issues are additional to the prior audit, two of them "
            "significant. Nine came from the v1.0 boundary sweep — the eight "
            "rows below, in which Repudiate.2 and .3 share one; Elevation.5 "
            "sits there as a residual of audit M-5 rather than a wholly new "
            "finding, which is why §2.5 excludes it from the equivalent list. "
            "DoS.9, Tamper.9 and Tamper.11 came from later "
            "source-verification passes and are logged in the findings table "
            "further down, since they were found by reading code against the "
            "model rather than by the model itself."),
    ])
    print(f"  count paragraph:   {o:,} -> {n:,}")

    doc, o, n = replace_para(doc, "Honest accounting: of the 39 threats", [
        (P, "Honest accounting: of the 39 threats here, roughly half restate "
            "the audit, twelve are additional, and five things the audit "
            "found were missed on the first pass. A boundary sweep run "),
        (I, "after"), (P, " a point-finding review adds structure, coverage "
            "evidence and off-chain threats that per-file review misses — but "
            "it is not a substitute for one, and must be run "), (I, "against"),
        (P, " it rather than in ignorance of it."),
    ])
    print(f"  honest accounting: {o:,} -> {n:,}")

    # 2. stale lead-in
    doc, o, n = replace_para(doc, "v1.2 is the result", [
        (P, "Yes — v1.2, v1.3 and v1.5 are each the result of one. Log new "
            "findings here as they arrive, with their source (audit, bug "
            "bounty, incident, review), so the model's hit rate becomes "
            "measurable over time rather than assumed."),
    ])
    print(f"  stale lead-in:     {o:,} -> {n:,}")

    # 3. DoS.2 contradiction (spans several runs -> rebuild the list item)
    i = doc.index("Not code-fixable")
    a = doc.rindex("<w:p>", 0, i)
    b = doc.index("</w:p>", i) + len("</w:p>")
    nid = re.search(r'w:numId w:val="(\d+)"', doc[a:b]).group(1)
    doc = doc[:a] + ('<w:p><w:pPr><w:pStyle w:val="Compact" /><w:numPr>'
        f'<w:ilvl w:val="0" /><w:numId w:val="{nid}" /></w:numPr></w:pPr>'
        + runs([
            (B, "Not code-fixable at all."), (P, " Elevation.1 (admin "),
            (C, "upgrade"), (P, ") has no on-chain bound; the treatment is "
                "custody. DoS.2 has no "), (I, "code"), (P, " fix — DoS.2.R.2 "
                "sizes and discloses it instead — and whether it is residual "
                "at all is unproven pending the P0 netting investigation. "
                "Spoof.3 (off-chain leg unverifiable) is irreducible. These "
                "are where the residual risk actually lives, and §3.1 states "
                "them plainly rather than dressing them as mitigated."),
        ]) + '</w:p>') + doc[b:]
    print("  DoS.2 contradiction resolved")

    # 4. insight 16
    i = doc.index("Interpretive claims drift")
    p_end = doc.index("</w:p>", i) + len("</w:p>")
    num_id = re.search(r'w:numId w:val="(\d+)"',
                       doc[doc.rindex("<w:p>", 0, i):p_end]).group(1)
    item = ('<w:p><w:pPr><w:pStyle w:val="Compact" /><w:numPr>'
            f'<w:ilvl w:val="0" /><w:numId w:val="{num_id}" /></w:numPr>'
            '</w:pPr>' + runs(INSIGHT_16) + '</w:p>')
    doc = doc[:p_end] + item + doc[p_end:]
    print("  insight 16 added")

    # 5. findings-log row
    i = doc.index("Have additional issues been found")
    j = doc.index("<w:tbl>", i)
    first = doc.index("</w:tr>", j) + len("</w:tr>")
    doc = doc[:first] + FINDING + doc[first:]
    print("  findings-log row added")

    out = HERE / "_s4.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("§4 corrected")


if __name__ == "__main__":
    main()

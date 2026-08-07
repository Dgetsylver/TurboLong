#!/usr/bin/env python3
"""Bring the v1.5 changelog row up to date with the whole pass.

It described only the §1 work and omitted the six §2.3 register passes, §3.1,
§3.2, §3.3 and §4 — which is itself the drift insight 16 names, in the row
that records insight 16 being added.

Kept terse on purpose: what changed and where, not why. The reasoning lives in
§4's findings log, and insight 14 is about exactly this row's tendency to
sprawl. Target is proportionate — v1.5 is the largest single revision of this
document, so a longer row is earned, but not a second §4.
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


CELL = [
 (B, "Full-document verification pass — every section checked against source."),

 (P, " "), (B, "§1:"), (P, " rebuilt the §1.6 diagram as two views (A "
   "control, B value), correcting five errors; DF-22 withdrawn — it recorded "
   "a reader of contract events that does not exist. Corrected three claims "
   "in §1.2 (keeper harvest floor, "), (C, "partial_unwind"),
 (P, "'s gate, “nothing” assumed of depositors) and three in §1.7 ("),
 (C, "c_factor"), (P, " is not read live, assumption 2's measurement scope, "
   "the keeper custody rationale). Added §1.7 assumption 7 ("),
 (C, "preflight()"), (P, " is the only implementation of "),
 (C, "design_hf > orange_hf"), (P, "), the §1.7 "), (B, "Token admin"),
 (P, " custody row Elevation.4 already cited, and a Constructor row to §1.4's "
   "token table. §1.4 and §1.5 verified and stand."),

 (P, " "), (B, "§2.3:"), (P, " all 39 rows verified block by block. Corrected "
   "Tamper.1's pool-"), (C, "c_factor"), (P, " citation ("),
 (C, "deploy_strategy_mainnet.ts:74-77"), (P, ", not "), (C, ":106-111"),
 (P, "), Tamper.6's test range, Elevation.4's comment range, Info.1 (the view "
   "also publishes "), (C, "underlying_before"), (P, "), Info.2 (no getter "
   "exists; "), (C, "claim_ids"), (P, " is "), (C, "reserve_id"),
 (P, " arithmetic), and Info.1/DoS.5's citations. Narrowed DoS.2: "),
 (C, "blend_pool.rs:46-47"), (P, " is falsifiable from this repo, so the open "
   "question is sequential versus full netting. Six rows truncated by the "
   "archaeology strip (Tamper.9, Tamper.11, DoS.7, DoS.9, Elevation.2, "
   "Elevation.6) were repaired; a sweep confirms none remain. Register prose "
   "24,100 → 22,021 chars, with length now tracking severity monotonically "
   "(Critical 1,149 → Info 390, previously inverted)."),

 (P, " "), (B, "§3:"), (P, " §3.1 called Spoof.2 and Elevation.3 Critical — "
   "both Low since v1.2 — and asserted DoS.2 as residual though its severity "
   "is unproven. §3.2 was not in priority order despite claiming to be, and "
   "six planned treatments had no work item, four of them user-facing or "
   "operational (pause-state UI, pool-dependency disclosure, incident "
   "runbook, PR checklist); reordered, and all 49 planned treatments now "
   "covered. §3.3 reconciled with §3 and §3.2, which listed three different "
   "pending-decision sets: added a "), (I, "Kind"), (P, " column, the §1.7 "
   "custody decision, and a corrected status line."),

 (P, " "), (B, "§4:"), (P, " miscounted its own yield (ten claimed, twelve "
   "actual), still said “v1.2 is the result”, and asserted DoS.2 "
   "“has no fix whatsoever” against a planned treatment. Insights "
   "15 and 16 added."),

 (P, " "), (B, "Editorial:"), (P, " §4 cut 28%, document prose 119,554 → "
   "107,000 (−10%). "), (B, "No threat, treatment or severity was added, "
   "removed or re-scored anywhere in this pass"), (P, " — every change is a "
   "correction, a citation, or a cut."),
]


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    i = doc.index("Change log")
    j = doc.index("<w:tbl>", i)
    k = doc.index("</w:tbl>", j)
    rows = list(re.finditer(r'<w:tr>.*?</w:tr>', doc[j:k], re.S))
    v15 = rows[1].group(0)
    assert "verification pass" in v15, "v1.5 row not where expected"
    cells = list(re.finditer(r'<w:tc>.*?</w:tc>', v15, re.S))
    assert len(cells) == 3
    w = re.search(r'w:w="(\d+)"', cells[2].group(0)).group(1)
    new_cell = (f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{w}" /></w:tcPr>'
                '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
                + runs(CELL) + '</w:p></w:tc>')
    print(f"  v1.5 cell: {len(cells[2].group(0)):,} -> {len(new_cell):,} XML")
    new_row = v15[:cells[2].start()] + new_cell + v15[cells[2].end():]
    doc = doc[:j + rows[1].start()] + new_row + doc[j + rows[1].end():]

    out = HERE / "_cl.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("changelog updated")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""§3.3 Decisions needed — reconcile it with §3 and §3.2.

Three sections listed three different sets of pending decisions, and only two
entries appeared in all three:

  §3.2 "⚠ decision first"  DoS.7.R.1, Elevation.1.R.3, DoS.3.R.1
  §3   "needs sign-off"    DoS.7.R.1, Elevation.1.R.3, DoS.2.R.1
  §3.3 table               those four plus Info.1.R.1

Meanwhile §3.3's own lead-in said "Three items" above a five-row table, and
the status line promised "the three sign-offs in §3.3", matching none of the
sets exactly. Anyone auditing what is outstanding got a different answer
depending on which section they opened.

Fix: §3.3 becomes the authority and states what kind each item is, rather than
implying all five are the same thing. Three genuinely block work; DoS.2.R.1 is
not yet decidable (its own text says so — the severity is unproven pending the
P0 netting investigation); Info.1.R.1 is a standing tuning call, not a gate.
The lead-in and the status line now agree with the table.

Also adds a pointer to the §1.7 key-custody decision. §3.1 calls it the
dominant risk in the system and §3.2's top P0 depends on it, but a reader of
"Decisions needed" would not have found it — it lived only in §1.7.
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
W = [1795, 2950, 1700, 7955]          # Ref | Decision | Kind | Trade-off
C, P, B, I = "code", "plain", "bold", "ital"


def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace("'", "&#39;"))


def runs(parts):
    if isinstance(parts, str):
        parts = [(P, parts)]
    return "".join(f'<w:r>{RPR[k]}<w:t xml:space="preserve">{esc(t)}</w:t>'
                   '</w:r>' for k, t in parts)


def row(cells, header=False):
    out = []
    for w, c in zip(W, cells):
        out.append(f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{w}" /></w:tcPr>'
                   '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
                   + runs(c) + '</w:p></w:tc>')
    pr = '<w:trPr><w:tblHeader w:val="on" /></w:trPr>' if header else ''
    return "<w:tr>" + pr + "".join(out) + "</w:tr>"


ROWS = [
 ("Ref", "Decision", "Kind", "Trade-off"),

 ("DoS.7.R.1", [(P, "Add an emergency pause on "), (C, "deposit"), (P, "?")],
  [(B, "Blocks work")],
  [(P, "Today the only incident lever is "), (C, "upgrade"), (P, " — slow, "
    "unbounded, and gated on the key whose compromise may be the incident. "
    "But a pause is itself a new privileged control and a griefing surface. "
    "Note DoS.7.R.2 (the incident runbook) is now P1 regardless of how this "
    "lands.")]),

 ("Elevation.1.R.3", "Timelock upgrade?", [(B, "Blocks work")],
  "Converts a silent instant drain into a public window holders can exit "
  "through, at the cost of delaying emergency fixes. Depends on how fast you "
  "would need to ship one."),

 ("DoS.3.R.1", [(P, "Cap the keeper's "), (C, "target_hf"), (P, "?")],
  [(B, "Blocks work")],
  "Reopens a decision audit M-1 explicitly made: it left the keeper unbounded "
  "on the grounds that it is a trusted role needing latitude in an emergency. "
  "Capping trades that latitude for blast-radius reduction. Defer to whoever "
  "made the M-1 call."),

 ("DoS.2.R.1", "Accept that a fully-utilized pool blocks withdrawals",
  [(B, "Not yet decidable")],
  [(P, "Do not decide this yet — the severity is unproven pending the "
       "Blend-netting investigation (P0). Deciding now would be accepting a "
       "risk of unknown size. "), (C, "blend_pool.rs:46-47"),
   (P, " is already known to be the wrong comment; what remains is sequential "
       "versus full netting.")]),

 ("Info.1.R.1", "How tight should the harvest floor be?",
  [(B, "Standing call")],
  "Tighter floor = less capturable spread, more harvests halted on ordinary "
  "volatility. Currently optimised entirely against false trips. A tuning "
  "parameter to revisit as Broker fills are observed, not a one-time gate."),

 ("§1.7", "Admin and token-admin key custody model",
  [(B, "Blocks work")],
  [(P, "Recorded in §1.7 rather than here, but it is a decision and §3.1 "
       "calls it the dominant risk in the system: §3.2's top P0 cannot be "
       "completed without it, and Elevation.4 is only a "), (I, "separate"),
   (P, " Critical from Elevation.1 if the two keys are actually held apart. "
       "Every "), (B, "†"), (P, "-marked severity in §2 is scored against the "
       "worst case until it is settled.")]),
]


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    a = doc.index("Decisions needed")
    b = doc.index("Did we do a good job")

    # lead-in
    i = doc.index("Three items are not ours to close unilaterally", a)
    p0 = doc.rindex("<w:p>", 0, i)
    p1 = doc.index("</w:p>", i) + len("</w:p>")
    lead = ('<w:p><w:pPr><w:pStyle w:val="BodyText" /></w:pPr>' + runs([
        (P, "Six items are not ours to close unilaterally. "),
        (B, "Four block work"), (P, " — the three gated rows at the foot of "
            "§3.2, plus the key-custody model §1.7 defers. One is "),
        (B, "not yet decidable"), (P, ", and one is a "), (B, "standing call"),
        (P, " rather than a gate; the "), (I, "Kind"), (P, " column says "
            "which is which, because §3, §3.2 and this table previously "
            "disagreed about the set."),
    ]) + '</w:p>')
    doc = doc[:p0] + lead + doc[p1:]

    # table
    b = doc.index("Did we do a good job")
    a = doc.index("Decisions needed")
    m = re.search(r'<w:tbl>.*?</w:tbl>', doc[a:b], re.S)
    tbl = m.group(0)
    rows = list(re.finditer(r'<w:tr>.*?</w:tr>', tbl, re.S))
    assert len(rows) == 6, f"expected 6 rows, found {len(rows)}"
    body = row(ROWS[0], header=True) + "".join(row(r) for r in ROWS[1:])
    new = tbl[:rows[0].start()] + body + tbl[rows[-1].end():]
    # widen the declared table width to match the new column set
    new = new.replace('<w:tblW w:type="dxa" w:w="14400" />',
                      f'<w:tblW w:type="dxa" w:w="{sum(W)}" />')
    print(f"  table: {len(rows) - 1} -> {len(ROWS) - 1} rows, "
          f"{len(tbl):,} -> {len(new):,} XML")
    doc = doc[:a + m.start()] + new + doc[a + m.end():]

    # status line
    old = "the three sign-offs in §3.3"
    assert doc.count(old) == 1
    doc = doc.replace(old, "the four blocking decisions in §3.3")
    print("  status line reconciled")

    out = HERE / "_dec.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("§3.3 reconciled")


if __name__ == "__main__":
    main()

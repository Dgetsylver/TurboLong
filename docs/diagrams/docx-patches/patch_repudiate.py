#!/usr/bin/env python3
"""Repudiation pass.

Verified, all four correct — event emission enumerated across every
entrypoint; rebalance()'s self-attribution at lib.rs:514; sync_reserves'
caller-less topic tuple; the no-op paths in rebalance_keeper and releverage
that skip both cooldown and event.

Repudiate.2/.3/.4 are 201-279 chars and already sized to their severity;
untouched. Only Repudiate.1 is edited, and mostly for precision rather than
length: it said `alerts/src/` "subscribes to none of this contract's events",
which understates what is actually true — the worker consumes no events at
all, and the views it polls by simulation belong to the Blend pool, not to
this contract. Dropped the "single largest observability gap" ranking, which
§2.6 already makes and a row should not assert about itself.
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
C, P, B = "code", "plain", "bold"


def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace("'", "&#39;"))


def runs(parts):
    return "".join(f'<w:r>{RPR[k]}<w:t xml:space="preserve">{esc(t)}</w:t>'
                   '</w:r>' for k, t in parts)


R1 = [
    (P, "The most security-critical actions emit "), (B, "no events at all"),
    (P, ": "), (C, "upgrade"), (P, ", "), (C, "set_admin"), (P, ", "),
    (C, "admin_set_keeper"), (P, ", "), (C, "set_share_token"), (P, ", "),
    (C, "set_swap_account"), (P, ", "), (C, "set_keeper"),
    (P, ", and the token's "), (C, "set_minter"), (P, ". "),
    (C, "set_min_harvest_rate"), (P, " is the only setter that emits. An "
        "admin key rotation or a contract upgrade therefore leaves no "
        "contract-level record, and reconstructing one means parsing "
        "transaction envelopes — which nothing does: "),
    (C, "alerts/src/stellar.ts"), (P, " consumes no events, and the views it "
        "polls by simulation belong to the "), (B, "Blend pool"),
    (P, ", not to this contract. "), (C, "set_keeper"),
    (P, "'s absence is the load-bearing one: Elevation.7 is the "
        "hostile-keeper self-rotation scenario, and its treatment asks "
        "monitoring to “alert on any "), (C, "set_keeper"),
    (P, " call” — unimplementable from events as the contract stands, "
        "so that treatment depends on this row being fixed first."),
]


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    i = doc.index("2.3 Threat table")
    j = doc.index(">Repudiate.1</w:t>", i)
    rs = doc.rindex("<w:tr>", i, j)
    re_ = doc.index("</w:tr>", j) + len("</w:tr>")
    row = doc[rs:re_]
    cells = list(re.finditer(r'<w:tc>.*?</w:tc>', row, re.S))
    issue = cells[3]
    w = re.search(r'w:w="(\d+)"', issue.group(0)).group(1)
    new = (f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{w}" /></w:tcPr>'
           '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
           + runs(R1) + '</w:p></w:tc>')
    print(f"  Repudiate.1  {len(issue.group(0)):,} -> {len(new):,}")
    doc = (doc[:rs] + row[:issue.start()] + new + row[issue.end():]
           + doc[re_:])

    out = HERE / "_rep.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("Repudiation pass applied (R.2/.3/.4 unchanged)")


if __name__ == "__main__":
    main()

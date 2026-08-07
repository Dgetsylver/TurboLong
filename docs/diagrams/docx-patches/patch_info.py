#!/usr/bin/env python3
"""Information Disclosure pass.

All four rows verified against source. This block was already the leanest in
the register (1,346 chars for four rows, Info.4 at 148), so the pass is a
correction pass, not a cut.

Two fixes:

Info.1 said pending_harvest() publishes the floor, the BLND claimed and the
expiry. It also returns `underlying_before` (lib.rs:1043) — the baseline the
floor is measured against. Floor plus baseline is the exact balance the
contract must reach, which is the number a counterparty actually prices
against, so omitting it understated the leak.

Info.2 said "reward_threshold and the claim IDs are public". True, but not
because anything publishes them: there is no getter for either. They are
readable because Soroban instance storage is readable, and claim_ids is not
even stored knowledge — it is reserve_id arithmetic. This matters for the
treatment: §3 already warns that removing a getter conceals nothing, and here
there is no getter to remove.

Info.3 and Info.4 verified correct and left untouched.
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


ROWS = {
 "Info.1": [
  (C, "pending_harvest()"), (P, " publishes the entire settlement parameter "
      "set while a claim is in flight: the BLND claimed, the floor, the "
      "allowance expiry, and "), (C, "underlying_before"),
  (P, " — the baseline the floor is measured against ("),
  (C, "lib.rs:1043"), (P, "). Floor plus baseline is the exact balance the "
      "contract must reach, so a Broker counterparty (or anyone watching) can "
      "price the settlement at precisely the minimum the vault will accept. "),
  (C, "set_min_harvest_rate"), (P, "'s doc comment ("),
  (C, "lib.rs:1002-1006"), (P, ") recommends a floor at a third to a half of "
      "market to avoid false trips, so the capturable spread is by design "
      "large. Publishing it converts a safety backstop into a price target."),
 ],
 "Info.2": [
  (P, "Harvest timing and size are fully derivable on-chain: emissions accrue "
      "predictably, the Soroswap route is fixed in "), (C, "Config"),
  (P, ", and "), (C, "reward_threshold"), (P, " — the size gate — is readable "
      "in instance storage "), (B, "though no view exposes it"), (P, ". "),
  (C, "claim_ids"), (P, " need not be read at all: they are "),
  (C, "[reserve_id * 2 + 1, reserve_id * 2]"), (P, " ("), (C, "lib.rs:105"),
  (P, "). The BLND→underlying swap is therefore a scheduled, sized, "
      "single-venue trade that can be sandwiched; "), (C, "amount_out_min"),
  (P, " bounds the loss but does not prevent the extraction. Note there is no "
      "getter to remove here — the treatment has to be economic or "
      "operational, per §3."),
 ],
}


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    for tid, parts in ROWS.items():
        i = doc.index("2.3 Threat table")
        j = doc.index(f'>{tid}</w:t>', i)
        rs = doc.rindex("<w:tr>", i, j)
        re_ = doc.index("</w:tr>", j) + len("</w:tr>")
        row = doc[rs:re_]
        cells = list(re.finditer(r'<w:tc>.*?</w:tc>', row, re.S))
        issue = cells[3]
        w = re.search(r'w:w="(\d+)"', issue.group(0)).group(1)
        new = (f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{w}" /></w:tcPr>'
               '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
               + runs(parts) + '</w:p></w:tc>')
        print(f"  {tid:8s} {len(issue.group(0)):,} -> {len(new):,}")
        doc = (doc[:rs] + row[:issue.start()] + new + row[issue.end():]
               + doc[re_:])

    out = HERE / "_info.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("Information Disclosure pass applied (Info.3/.4 unchanged)")


if __name__ == "__main__":
    main()

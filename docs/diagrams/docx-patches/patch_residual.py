#!/usr/bin/env python3
"""§3.1 Residual risk — correct and tighten.

One real error. Item 1 read "every other Critical row (Spoof.2,
Elevation.3, Elevation.4) sits behind the same credential". Spoof.2 and
Elevation.3 are Low, not Critical — §2.3 says so in both rows ("Low, not
Critical", "re-scored down from this model's initial Critical") and §2.5
records the correction ("This model over-scored it Critical; corrected to
Low"). §3.1 preserved the pre-v1.2 over-scoring, so the section that states
what risk remains was overstating it by two rows.

Item 2 also asserted DoS.2 as an irreducible property of building on a shared
pool. Its severity is unproven pending the Blend-netting question, and if
Blend nets it largely evaporates — so it cannot be asserted as residual.

Treatment IDs cited (Elevation.1.R.1, .R.3, Tamper.1.R.1) all verified present.
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


ITEMS = [
 [(B, "Admin compromise is unbounded and un-codeable."), (P, " "),
  (C, "upgrade"), (P, " replaces the strategy wholesale; only custody bounds "
      "it (Elevation.1.R.1, plus a timelock if accepted — R.3). Until "
      "multisig lands this dominates everything else. Elevation.4 is the only "
      "other Critical, and is a genuinely separate risk only if §1.7's "),
  (I, "Token admin"), (P, " separation is implemented; Spoof.2 and "
      "Elevation.3 are Low because they add nothing to an admin who can "
      "already upgrade.")],

 [(B, "Pool-liquidity dependence cannot be engineered away."), (P, " DoS.1 is "
   "inherent to building on a shared lending pool — the treatments improve "),
  (I, "communication"), (P, " about the failure, not its rate. Whether DoS.2 "
      "belongs here at all is unproven, pending the Blend-netting question "
      "(§2.5).")],

 [(B, "Blend governance can move the ground under us."), (P, " Tamper.1.R.1 "
   "turns silent mis-pricing into detect-and-refuse: a solvency risk "
   "converted into an availability one. A good trade, not elimination.")],

 [(B, "The off-chain harvest leg is verified only at its endpoints."),
  (P, " Spoof.3 is irreducible — no on-chain contract can witness an off-chain "
      "swap. The floor bounds the loss; it does not prove execution.")],

 [(B, "Sandwich exposure on the Soroswap route persists"), (P, " at whatever "),
  (C, "amount_out_min"), (P, " permits. Route selection, not slippage bounds, "
      "is the real mitigation.")],
]


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    a = doc.index("Residual risk")
    b = doc.index("Work items, prioritised")
    pat = r'<w:p><w:pPr><w:pStyle w:val="Compact" /><w:numPr>.*?</w:p>'
    items = list(re.finditer(pat, doc[a:b], re.S))
    assert len(items) == 5, f"expected 5 residuals, found {len(items)}"
    num_id = re.search(r'w:numId w:val="(\d+)"', items[0].group(0)).group(1)

    before = sum(len(i.group(0)) for i in items)
    new = "".join(
        '<w:p><w:pPr><w:pStyle w:val="Compact" /><w:numPr>'
        f'<w:ilvl w:val="0" /><w:numId w:val="{num_id}" /></w:numPr></w:pPr>'
        + runs(p) + '</w:p>' for p in ITEMS)
    doc = doc[:a + items[0].start()] + new + doc[a + items[-1].end():]
    print(f"  §3.1 items: {before:,} -> {len(new):,} XML chars")

    out = HERE / "_res.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("§3.1 corrected and tightened")


if __name__ == "__main__":
    main()

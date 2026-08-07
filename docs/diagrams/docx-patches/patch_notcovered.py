#!/usr/bin/env python3
"""§4.2 What this model does not cover — verified, two items sharpened.

Verified: all five cited paths exist (src/bin/execute_loop.rs, alerts/,
SECURITY.md, test_integration.rs, test_leverage.rs), and SECURITY.md does run
an Immunefi bounty programme. Six items, 1,203 chars, all accurate.

Two sharpened:

  Blend/Soroswap internals — listed as trusted "by scope", which reads as a
  choice. It is also a hard limit: vendor/blend-contract-sdk ships client
  bindings and six WASM blobs, no pool source. That is why DoS.2's netting
  question could not be settled here even once it became a P0, and it tells a
  reader what to fetch rather than leaving it as a decision already made.

  Governance/upgrade process — the incident runbook now has an owner
  (DoS.7.R.2, added at P1 in this pass), so the blanket "not modelled" was
  stale in one respect while remaining true of the rest.
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


BLEND = [
 (B, "Blend and Soroswap internals are trusted."),
 (P, " Their defects are out of scope per §Scope; only their "), (I, "effects"),
 (P, " on us are modelled. This is a hard limit as well as a choice: "),
 (C, "vendor/blend-contract-sdk"), (P, " ships client bindings and WASM, no "
   "pool source, which is why DoS.2's netting question could not be settled "
   "here even after it became a P0. Answering it needs the upstream Blend v2 "
   "repository."),
]

GOV = [
 (B, "Governance and upgrade "), (B, "process"),
 (P, " — who proposes, who reviews, what the runbook is — is referenced "
   "(Elevation.1, Elevation.2) but not modelled. The incident runbook now has "
   "an owner (DoS.7.R.2, P1); the proposal and review process still does not."),
]


def replace_item(doc, anchor, parts):
    """Replace a §4.2 bullet, preserving its list formatting."""
    i = doc.index(anchor)
    a = doc.rindex("<w:p>", 0, i)
    b = doc.index("</w:p>", i) + len("</w:p>")
    ppr = re.search(r'<w:pPr>.*?</w:pPr>', doc[a:b], re.S)
    assert ppr, "paragraph properties not found"
    new = "<w:p>" + ppr.group(0) + runs(parts) + "</w:p>"
    return doc[:a] + new + doc[b:], len(doc[a:b]), len(new)


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    a = doc.index("What this model does not cover")
    assert doc.index("Blend and Soroswap internals", a) > a
    assert doc.index("Governance and upgrade", a) > a

    doc, o, n = replace_item(doc, "Blend and Soroswap internals", BLEND)
    print(f"  Blend/Soroswap item: {o:,} -> {n:,}")
    doc, o, n = replace_item(doc, "Governance and upgrade", GOV)
    print(f"  governance item:     {o:,} -> {n:,}")

    out = HERE / "_nc.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("§4.2 sharpened")


if __name__ == "__main__":
    main()

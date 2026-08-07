#!/usr/bin/env python3
"""Spoofing pass — the sixth and last block of the register.

Verified, all four correct and no artifacts from the earlier prefix strip:

  Spoof.1  name and symbol are free-text String constructor arguments
           (vault_share/lib.rs:62-63) written verbatim into Metadata, and
           transfer is require_auth-only. A counterfeit carrying identical
           metadata is trivially deployable. Row had no citation; added.
  Spoof.2  withdraw reads the caller's balance from the configured token and
           burns against it. The setter's doc comment does say "one-time
           wiring" (lib.rs:908) while the body is require_admin +
           set_share_token with no guard. Row quoted that comment without
           citing it; added.
  Spoof.3  harvest_reinvest measures delivered_before as balance minus
           underlying_before, with no provenance check whatsoever.
  Spoof.4  five keeper entrypoints carry the caller-equality check,
           set_keeper does not. Left unchanged — already compressed once, and
           every remaining clause carries the reason it is a hazard.
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
 "Spoof.1": [
  (P, "Shares are a plain transferable SEP-41 token whose "), (C, "name"),
  (P, " and "), (C, "symbol"), (P, " are free-text "), (C, "String"),
  (P, " constructor arguments ("), (C, "vault_share/lib.rs:62-63"),
  (P, "), so anyone can deploy a counterfeit presenting itself as TurboLong "
      "shares and list it on a DEX or Aquarius. A user buying “TurboLong "
      "USDC shares” on the secondary market — an explicitly supported "
      "use case — has no in-contract way to tell the real ledger from a "
      "forgery."),
 ],
 "Spoof.2": [
  (B, "= audit L-2."), (P, " The strategy trusts whatever address sits in "),
  (C, "ShareToken"), (P, " as its ledger of record: "), (C, "withdraw"),
  (P, " reads the caller's balance from it and burns against it, so a token "
      "that lies about "), (C, "balance()"), (P, " fully determines who may "
      "withdraw what. The setter's own doc comment calls it “one-time "
      "wiring” ("), (C, "lib.rs:908"), (P, ") but nothing enforces that "
      "— it is re-settable at any time. "), (B, "Low, not Critical:"),
  (P, " the strategy is "), (C, "Upgradable"), (P, " under the "), (I, "same"),
  (P, " key, so an admin willing to re-point the token would simply upgrade "
      "the WASM instead; re-pointing confers no marginal capability over "
      "Elevation.1. Still worth the one-time guard (Elevation.3)."),
 ],
 "Spoof.3": [
  (P, "Settlement of the Broker harvest is measured as underlying balance "
      "growth over a baseline. Nothing establishes that the arriving "
      "underlying came from selling the claimed BLND — the keeper, or anyone, "
      "can satisfy the floor from an unrelated source. The contract verifies "
      "that value "), (I, "returned"), (P, ", not that the swap "),
  (I, "happened"), (P, ". Deliberate: it makes the floor a solvency check "
      "rather than an execution proof, and is recorded so that reading is "
      "explicit."),
 ],
}


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    saved = 0
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
        saved += len(issue.group(0)) - len(new)
        print(f"  {tid:10s} {len(issue.group(0)):6,d} -> {len(new):6,d}")
        doc = (doc[:rs] + row[:issue.start()] + new + row[issue.end():]
               + doc[re_:])
    print(f"  net saved: {saved:,} XML chars")

    out = HERE / "_spoof.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("Spoofing pass applied (Spoof.4 unchanged)")


if __name__ == "__main__":
    main()

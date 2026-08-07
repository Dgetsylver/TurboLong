#!/usr/bin/env python3
"""Add the missing 'Token admin' row to §1.7's key-custody table.

Elevation.4 (Critical) says key separation between the token admin and the
strategy admin "is the whole mitigation ... which is why §1.7 recommends
separate custody". §1.7 recommended no such thing: its custody table covered
Admin, Admin rotation, Keeper, Keeper compromise response, Swap account and
Deployment, and never mentioned the token admin. The recommendation exists
only as the §3 treatment Elevation.4.R.3.

Fixing the citation would have been the smaller change; adding the row is the
correct one, since §1.7 is where custody recommendations live and this is the
sole mitigation for a Critical.
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


ROW = "<w:tr>" + (
    cell(1585, [("bold", "Token admin")])
    + cell(6328, [
        ("plain", "Hold as a "), ("bold", "different key"),
        ("plain", " from the strategy admin — ideally its own multisig, at "
                  "minimum a disjoint signer set. Record both addresses and "
                  "their custody separately (see "), ("bold", "Deployment"),
        ("plain", " below), and alert on any "), ("code", "set_minter"),
        ("plain", " call"),
    ])
    + cell(6481, [
        ("code", "set_minter"),
        ("plain", " installs an arbitrary minter, which can mint unlimited "
                  "shares and redeem them through the ordinary "),
        ("code", "withdraw"),
        ("plain", " path — Elevation.4, Critical. The token's "
                  "non-upgradeability bounds the "), ("ital", "rewriting"),
        ("plain", " of balances, not the "), ("ital", "creation"),
        ("plain", " of new ones, so separation is the only thing that makes "
                  "this a second Critical path rather than the same one "
                  "behind a single credential. Shared with the strategy "
                  "admin, the token's missing "), ("code", "upgrade"),
        ("plain", " buys holders nothing."),
    ])) + "</w:tr>"


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    i = doc.index("Key custody")
    j = doc.index("<w:tbl>", i)
    k = doc.index("</w:tbl>", j)
    table = doc[j:k]
    rows = list(re.finditer(r'<w:tr>.*?</w:tr>', table, re.S))
    assert len(rows) == 7, f"expected 7 rows, found {len(rows)}"
    labels = ["".join(re.findall(r'<w:t(?: [^>]*)?>(.*?)</w:t>',
                                 re.findall(r'<w:tc>.*?</w:tc>', r.group(0),
                                            re.S)[0], re.S))
              for r in rows]
    assert "Token admin" not in labels, "row already present"
    assert labels[2] == "Admin rotation", labels

    # Insert after 'Admin rotation' so the three admin-side rows group.
    at = j + rows[2].end()
    doc = doc[:at] + ROW + doc[at:]

    # Fold into the v1.5 changelog row, alongside the other citation fixes.
    # Apostrophes are entity-escaped in the document, so anchor on a span
    # without one. The changelog ends: <code>upgrade</code> then a "." run.
    anchor = "mutating entrypoint bumps the TTL” missed "
    i = doc.index(anchor)
    end_code = ">upgrade</w:t></w:r>"
    p = doc.index(end_code, i) + len(end_code)
    tail = doc.index("</w:r>", p) + 6       # end of the trailing "." run
    doc = doc[:tail] + runs([
        ("plain", " Elevation.4 (Critical) likewise cited a §1.7 "
                  "recommendation of separate token-admin custody that §1.7 "
                  "did not contain — the recommendation existed only as the "
                  "§3 treatment Elevation.4.R.3, so the row naming key "
                  "separation as “the whole mitigation” pointed at "
                  "nothing. Added the missing "), ("bold", "Token admin"),
        ("plain", " row to §1.7's custody table rather than weakening the "
                  "citation."),
    ]) + doc[tail:]

    out = HERE / "_tok.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in zin.infolist():
            zo.writestr(item, doc.encode("utf-8")
                        if item.filename == "word/document.xml"
                        else zin.read(item.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("added §1.7 'Token admin' custody row")


if __name__ == "__main__":
    main()

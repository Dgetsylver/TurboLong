#!/usr/bin/env python3
"""§1.4 / §1.5 verification pass.

Both tables were checked claim by claim against the contracts and are
accurate — see the changelog text below for what was verified. One gap: the
token entrypoint table has no Constructor row, though the strategy table does
and Elevation.2 relies on "both constructors seed the admin atomically with
deployment". Adds that row and records the pass.
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
    cell(2320, [("plain", "Constructor")])
    + cell(3948, [
        ("code", "__constructor"),
        ("plain", " — seeds admin, minter and metadata atomically with "
                  "deployment ("), ("code", "vault_share/lib.rs:57"),
        ("plain", "). Elevation.2 depends on this: "), ("code", "set_admin"),
        ("plain", " is ungated whenever the "), ("code", "ADMIN"),
        ("plain", " entry is absent, and this is why no such window exists"),
    ])) + "</w:tr>"


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    i = doc.index("Holder-authenticated")
    j = doc.rindex("<w:tbl>", 0, i)
    k = doc.index("</w:tbl>", j)
    rows = list(re.finditer(r'<w:tr>.*?</w:tr>', doc[j:k], re.S))
    assert len(rows) == 5, f"expected 5 rows, found {len(rows)}"
    assert "Constructor" not in doc[j:k], "row already present"

    # Insert before the Views row, mirroring the strategy table's ordering.
    at = j + rows[3].end()
    doc = doc[:at] + ROW + doc[at:]

    # Record the pass in the v1.5 changelog row.
    anchor = "row to §1.7&#39;s custody table rather than weakening the citation."
    i = doc.index(anchor)
    rb = doc.index("</w:r>", i) + 6
    doc = doc[:rb] + runs([
        ("bold", " §1.4 and §1.5 were verified in the same pass and stand."),
        ("plain", " Every strategy entrypoint is accounted for in the correct "
                  "gate group; all five keeper entrypoints do carry the "
                  "caller-equality check; rate limits are on "),
        ("code", "rebalance_keeper"), ("plain", " and "),
        ("code", "releverage"), ("plain", " only; "), ("code", "set_keeper"),
        ("plain", "'s citation is exact; the constructor's assertions match "
                  "the described ordering checks; "), ("code", "withdraw"),
        ("plain", " is bounded by the caller's shares ("),
        ("code", "reserves.rs:227-228"),
        ("plain", "); and every durability class in §1.5 is correct, "
                  "including DoS.9's contrast between "),
        ("code", "get_vault_shares"), ("plain", " and "),
        ("code", "get_keeper"),
        ("plain", ". One addition only: a Constructor row for the token, "
                  "which the strategy table had and the token table did not. "
                  "Worth noting why these two held up where §1.2, §1.6 and "
                  "§1.7 did not — they enumerate mechanically checkable facts "
                  "(which gate, which durability), whereas the three that "
                  "failed make interpretive claims (what the system assumes, "
                  "what a boundary means). Interpretation is where this "
                  "document drifts from its code."),
    ]) + doc[rb:]

    out = HERE / "_s14.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in zin.infolist():
            zo.writestr(item, doc.encode("utf-8")
                        if item.filename == "word/document.xml"
                        else zin.read(item.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("added token Constructor row; recorded §1.4/§1.5 pass")


if __name__ == "__main__":
    main()

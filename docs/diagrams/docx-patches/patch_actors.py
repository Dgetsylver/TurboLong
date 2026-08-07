#!/usr/bin/env python3
"""Correct three claims in §1.2 (Actors and trust levels) of the STRIDE model.

1. Keeper row  - the harvest floor is the admin's number only on the Broker
   route; on the Soroswap route it collapses to the keeper's own number when
   `min_harvest_rate` is unset (lib.rs:325-329). Contradicted Elevation.5.
2. Permissionless-caller row - `partial_unwind` calls `caller.require_auth()`
   (lib.rs:621), so it does not belong with the genuinely ungated
   entrypoints. Split into its own row, matching §1.4.
3. Depositor row - "Nothing" is assumed is too strong: a holder's public
   `burn` desynchronises the two share ledgers (Tamper.6 / audit L-1).
"""
import re
import shutil
import zipfile
from pathlib import Path

DOCX = Path("/Users/hugoheer/Documents/The_Aha_Company/turbolong/TurboLong/"
            "docs/threat-model-stride.docx")
SP = Path(__file__).parent

W = {"actor": 2387, "trust": 1795, "powers": 4317, "assumes": 5898}


def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace("'", "&#39;"))


def runs(parts):
    """parts: list of (kind, text) where kind is plain | code | bold."""
    out = []
    for kind, t in parts:
        rpr = {"plain": "",
               "code": '<w:rPr><w:rStyle w:val="VerbatimChar" /></w:rPr>',
               "bold": '<w:rPr><w:b /><w:bCs /></w:rPr>'}[kind]
        out.append(f'<w:r>{rpr}<w:t xml:space="preserve">{esc(t)}</w:t></w:r>')
    return "".join(out)


def cell(width, parts):
    return (f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{width}" /></w:tcPr>'
            '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
            f'{runs(parts)}</w:p></w:tc>')


def find_cell(doc, start, anchor):
    """Exact XML span of the <w:tc> at/after `start` containing `anchor`."""
    pos = doc.index(anchor, start)
    a = doc.rindex("<w:tc>", start, pos)
    b = doc.index("</w:tc>", pos) + len("</w:tc>")
    return a, b


# ── new cell contents ────────────────────────────────────────────────
DEPOSITOR_ASSUMES = [
    ("plain", "Only that holders do not "),
    ("code", "burn"), ("plain", " outside "), ("code", "withdraw"),
    ("plain", ". Every call is "), ("code", "require_auth"),
    ("plain", "-gated to the acting address and bounded by that address's "
              "own share balance — but the token's public "),
    ("code", "burn"), ("plain", " / "), ("code", "burn_from"),
    ("plain", " decrement "), ("code", "total_supply"),
    ("plain", " with no path back to the strategy's "),
    ("code", "total_shares"),
    ("plain", ", so a holder can desynchronise the two ledgers and strand "
              "their own equity. See Tamper.6."),
]

PERMISSIONLESS_POWERS = [
    ("code", "rebalance"), ("plain", ", "), ("code", "sync_reserves"),
    ("plain", ", "), ("code", "migrate_position"),
    ("plain", " — no "), ("code", "require_auth"), ("plain", " at all"),
]

PERMISSIONLESS_ASSUMES = [
    ("plain", "That these entrypoints can move the system "),
    ("bold", "only toward safety or toward the truth"),
    ("plain", ". This is the property that justifies leaving them ungated, "
              "and it is the one to re-verify on every change to them. None "
              "carries a caller identity, so none is attributable — see "
              "Repudiate.2."),
]

UNWIND_ROW = (
    cell(W["actor"], [("bold", "Authenticated, unrestricted caller"),
                      ("plain", " (any address)")])
    + cell(W["trust"], [("plain", "Untrusted")])
    + cell(W["powers"], [("code", "partial_unwind"),
                         ("plain", " only while HF < "), ("code", "orange_hf")])
    + cell(W["assumes"], [
        ("plain", "Distinct from the row above, and the distinction is in "
                  "the code: "),
        ("code", "caller.require_auth()"),
        ("plain", " is called ("), ("code", "lib.rs:621"),
        ("plain", "), so any address may call but must authenticate as "
                  "itself. Inside the band their "),
        ("code", "target_hf"), ("plain", " is ignored and forced to "),
        ("code", "orange_hf"),
        ("plain", "; the keeper branch is unbounded above (DoS.3). Unlike "
                  "the ungated three, the action is attributable. Matches "
                  "§1.4's "),
        ("plain", "“Conditionally permissionless” row."),
    ]))

KEEPER_ASSUMES = [
    ("plain", "Available and honest enough to run maintenance; "),
    ("bold", "not"),
    ("plain", " assumed uncompromised. Discretion is granted only in the "
              "safe direction (unwinding), and revoked in the unsafe one — "),
    ("code", "releverage"),
    ("plain", "'s amount is derived on-chain. The harvest floor, however, is "
              "the admin's number "),
    ("bold", "only on the Broker route"),
    ("plain", ", which is fail-closed ("), ("code", "harvest_claim"),
    ("plain", " grants no allowance unless both "), ("code", "SwapAccount"),
    ("plain", " and "), ("code", "min_harvest_rate"),
    ("plain", " are set, "), ("code", "lib.rs:1110-1125"),
    ("plain", "). On the Soroswap route the effective floor is "),
    ("code", "max(keeper, admin)"), ("plain", " ("), ("code", "lib.rs:329"),
    ("plain", ") and collapses to the keeper's own "), ("code", "data"),
    ("plain", " value whenever "), ("code", "min_harvest_rate"),
    ("plain", " is unset — see Elevation.5."),
]


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    base = doc.index("Actors and trust levels")

    # 1. Depositor "what the system assumes"
    a, b = find_cell(doc, base, "Nothing. Every call is")
    doc = doc[:a] + cell(W["assumes"], DEPOSITOR_ASSUMES) + doc[b:]

    # 2a. Permissionless powers cell (drop partial_unwind)
    a, b = find_cell(doc, base, '<w:t xml:space="preserve">rebalance</w:t>')
    doc = doc[:a] + cell(W["powers"], PERMISSIONLESS_POWERS) + doc[b:]

    # 2b. Permissionless assumptions cell
    a, b = find_cell(doc, base, "That these entrypoints can move the system")
    doc = doc[:a] + cell(W["assumes"], PERMISSIONLESS_ASSUMES) + doc[b:]

    # 2c. insert the partial_unwind row directly after that row
    row_end = doc.index("</w:tr>", b) + len("</w:tr>")
    doc = doc[:row_end] + "<w:tr>" + UNWIND_ROW + "</w:tr>" + doc[row_end:]

    # 3. Keeper assumptions cell
    a, b = find_cell(doc, base, "Available and honest enough to run")
    doc = doc[:a] + cell(W["assumes"], KEEPER_ASSUMES) + doc[b:]

    out = SP / "patched2.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in zin.infolist():
            zo.writestr(item, doc.encode("utf-8")
                        if item.filename == "word/document.xml"
                        else zin.read(item.filename))
    zin.close()
    shutil.copy(DOCX, SP / "threat-model-stride.pre-actors.docx.bak")
    shutil.move(out, DOCX)
    print(f"patched §1.2 ({DOCX.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()

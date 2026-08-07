#!/usr/bin/env python3
"""Bump the STRIDE model to v1.5 and record what changed.

Four edits:
  1. Status line + Version field - v1.4 -> v1.5, and narrow the
     "source-verified against the contracts" claim to what was actually
     verified (§2 and §3; §1's assumption columns only as of v1.5).
  2. Appendix A - new 1.5 changelog row.
  3. §4 post-hoc findings log - two rows for the §1.2 and DFD corrections.
  4. §4.1 - a review trigger so the next verification pass covers §1.
"""
import re
import shutil
import zipfile
from pathlib import Path

DOCX = Path("/Users/hugoheer/Documents/The_Aha_Company/turbolong/TurboLong/"
            "docs/threat-model-stride.docx")
SP = Path(__file__).parent


def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace("'", "&#39;"))


def runs(parts):
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


def row(cells):
    return "<w:tr>" + "".join(cells) + "</w:tr>"


def insert_row_after_header(doc, anchor, new_row):
    """Insert a row immediately after a table's header row."""
    i = doc.index(anchor)
    j = doc.index("<w:tbl>", i)
    first = doc.index("</w:tr>", j) + len("</w:tr>")
    return doc[:first] + new_row + doc[first:]


# ── 2. Appendix A changelog row (955 / 1270 / 12175) ─────────────────
CHANGELOG = row([
    cell(955, [("bold", "1.5")]),
    cell(1270, [("plain", "2026-08-07")]),
    cell(12175, [
        ("bold", "§1 verification pass — the first to cover §1's claims "
                 "rather than §2's."),
        ("plain", " Rebuilt the §1.6 DFD as two views (A control, B value) "
                  "because one picture of 20 nodes and 23 flows was "
                  "unreadable at page size, and corrected five errors in it: "
                  "DF-4 named "),
        ("code", "set_keeper"), ("plain", " where the admin path is "),
        ("code", "admin_set_keeper"),
        ("plain", "; DF-22 recorded the alerts worker reading contract "
                  "events, which it does not do ("),
        ("code", "alerts/src/stellar.ts"),
        ("plain", " simulates Blend pool views — DF-22 withdrawn); TB-6 was "
                  "drawn as a box around both contracts rather than the "
                  "boundary between them; TB-5 enclosed the on-chain swap "
                  "account; the alerts worker sat in no boundary. Also fixed "
                  "DF-12 (claimed BLND never reached the strategy) and added "
                  "the principal's own movement to DF-14. "),
        ("bold", "Corrected three claims in §1.2:"),
        ("plain", " the keeper row asserted the harvest floor is \"the "
                  "admin's number, not the keeper's\" — true only on the "
                  "Broker route, while the Soroswap route floors on "),
        ("code", "max(keeper, admin)"),
        ("plain", " and collapses to the keeper's own value when "),
        ("code", "min_harvest_rate"),
        ("plain", " is unset ("), ("code", "lib.rs:325-329"),
        ("plain", "), which is Elevation.5 stated as an assumption; the "
                  "permissionless-caller row grouped "),
        ("code", "partial_unwind"), ("plain", " with the ungated three "
                                              "though it calls "),
        ("code", "caller.require_auth()"), ("plain", " ("),
        ("code", "lib.rs:621"),
        ("plain", ") — split into its own row, matching §1.4; the depositor "
                  "row assumed \"Nothing\" of holders, though a public "),
        ("code", "burn"),
        ("plain", " desynchronises the two share ledgers (Tamper.6). No "
                  "threat added or re-scored. Added the §4.1 trigger that "
                  "would have caught these."),
    ]),
])

# ── 3. findings-log rows (1270 / 4570 / 1690 / 6865) ─────────────────
FINDING_1 = row([
    cell(1270, [("plain", "2026-08-07")]),
    cell(4570, [
        ("bold", "§1.2 asserted three trust properties the code does not "
                 "hold"),
        ("plain", " — the keeper harvest floor, "),
        ("code", "partial_unwind"),
        ("plain", "'s gate, and \"Nothing\" assumed of depositors"),
    ]),
    cell(1690, [("plain", "v1.5 §1 verification")]),
    cell(6865, [
        ("bold", "Yes, and this is the most instructive miss in the log."),
        ("plain", " Each was already documented as a finding in §2 — "
                  "Elevation.5, §1.4's own \"Conditionally permissionless\" "
                  "row, and Tamper.6 respectively — so the model contradicted "
                  "itself in three places for three revisions. The v1.2 pass "
                  "verified \"every threat row and ~50 of §3's "),
        ("code", "file:line"),
        ("plain", " citations\" and that scope is exactly the gap: §1.2's "),
        ("plain", "What the system assumes"),
        ("plain", " column was never checked against code. An assumption is "
                  "a claim about the implementation as much as a threat row "
                  "is, and it is the more dangerous of the two to get wrong, "
                  "because §2 is enumerated *from* it. New insight: verify "
                  "the premises, not only the conclusions."),
    ]),
])

FINDING_2 = row([
    cell(1270, [("plain", "2026-08-07")]),
    cell(4570, [
        ("bold", "The §1.6 DFD carried five errors, one of which invented a "
                 "monitoring path"),
        ("plain", " (DF-22, the alerts worker reading contract events)"),
    ]),
    cell(1690, [("plain", "v1.5 §1 verification")]),
    cell(6865, [
        ("bold", "Yes."),
        ("plain", " §4 asks whether the diagram has been referenced since "
                  "creation and answers \"within this exercise, yes\" — but "
                  "referencing it is not the same as checking it, and the "
                  "diagram was never verified against source the way §2 and "
                  "§3 were. DF-22 is the sharp one: Repudiate.1 states "
                  "plainly that "),
        ("code", "alerts/src/"),
        ("plain", " subscribes to none of this contract's events, while the "
                  "diagram drew that exact reader. A picture that contradicts "
                  "the prose beside it will be believed over the prose."),
    ]),
])

# ── 4. review trigger (3895 / 10505) ─────────────────────────────────
TRIGGER = row([
    cell(3895, [("bold", "Any source-verification pass"), ("plain", " on "
                "this document")]),
    cell(10505, [
        ("plain", "§1.2's "), ("bold", "What the system assumes"),
        ("plain", " column, §1.7's assumptions and the §1.6 diagram — not "
                  "only §2's threat rows and §3's citations. The v1.2 pass "
                  "covered the latter and three false claims survived in §1.2 "
                  "for three revisions, each already contradicted by a §2 row. "
                  "Check the premises the enumeration rests on before "
                  "re-checking the enumeration."),
    ]),
])


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    # 1. status line + version field
    old_status = ('<w:r><w:t xml:space="preserve">COMPLETE (v1.4, reconciled '
                  'against the 2026-08 audit and</w:t></w:r>'
                  '<w:r><w:t xml:space="preserve"> </w:t></w:r>'
                  '<w:r><w:t xml:space="preserve">source-verified against the '
                  'contracts). Pending: key custody decision (§1.7),</w:t>'
                  '</w:r>')
    assert doc.count(old_status) == 1, "status runs not matched"
    doc = doc.replace(old_status, runs([
        ("plain", "COMPLETE (v1.5, reconciled against the 2026-08 audit. "
                  "§2 and §3 are source-verified against the contracts; §1's "
                  "assumption columns and the §1.6 diagram only as of v1.5 — "
                  "see the findings log). Pending: key custody decision "
                  "(§1.7),"),
    ]))

    old_ver = '<w:r><w:t xml:space="preserve">1.4 ·</w:t></w:r>'
    assert doc.count(old_ver) == 1, "version field not matched"
    doc = doc.replace(old_ver, runs([("plain", "1.5 ·")]))

    # 2-4. table rows
    doc = insert_row_after_header(doc, "Change log", CHANGELOG)
    doc = insert_row_after_header(doc, "Have additional issues been found",
                                  FINDING_1 + FINDING_2)
    doc = insert_row_after_header(doc, "Review triggers", TRIGGER)

    out = SP / "patched3.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in zin.infolist():
            zo.writestr(item, doc.encode("utf-8")
                        if item.filename == "word/document.xml"
                        else zin.read(item.filename))
    zin.close()
    shutil.copy(DOCX, SP / "threat-model-stride.pre-v15.docx.bak")
    shutil.move(out, DOCX)
    print(f"bumped to v1.5 ({DOCX.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()

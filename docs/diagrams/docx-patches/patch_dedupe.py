#!/usr/bin/env python3
"""Remove restatement, keeping every finding.

Three targets:
  §2.6  — restated four §2.3 rows (and §2.5's DoS.2 paragraph) at length. Its
          real content is the *ordering*: expected loss, not severity label.
          Kept the ranking, dropped the re-argument.
  DoS.7 — carried a sentence narrating what §1.1 failed to ask, which §2.2's
          own editorial rule puts in §4, not in a threat row.
  DoS.6 / Spoof.4 / Elevation.8 — compressed, not deleted. Each occupies a
          §2.4 coverage-map cell, and §2.4 defines an empty cell as a gap in
          the model rather than evidence of safety; deleting them would
          manufacture three holes and desynchronise the counts.
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


FIVE = [
    [("bold", "Elevation.1 — admin authority is unbounded, and every other "
              "admin-side row collapses into it."),
     ("plain", " One key, not three: an admin willing to use "),
     ("code", "set_share_token"), ("plain", " or the token's "),
     ("code", "set_minter"), ("plain", " would simply "), ("code", "upgrade"),
     ("plain", ". No contract change bounds it; the mitigation is custody "
               "(§1.7).")],
    [("bold", "DoS.1 / DoS.2 — pool utilization governs both deposits and "
              "withdrawals."),
     ("plain", " DoS.1 is confirmed; DoS.2's severity is unproven pending the "
               "Blend-netting question (§2.5). A P0 investigation, not a "
               "documentation task.")],
    [("bold", "Tamper.1 + Tamper.11 — both risk-parameter invariants are "
              "checked once and then trusted forever."),
     ("plain", " Tamper.1 is the higher-severity failure, Tamper.11 trips "
               "first (~2pp against 5pp). Both close with the same call site "
               "in "), ("code", "check_deposit_safety"),
     ("plain", ", which is why they are one P0 line item.")],
    [("bold", "Repudiate.1 — admin actions are invisible to monitoring."),
     ("plain", " Not a loss path alone, but the difference between detecting "
               "an admin-key compromise in minutes and finding it after the "
               "drain. It compounds every item in (1).")],
    [("bold", "Info.1 — publishing the settlement floor prices the Broker leg "
              "against us."),
     ("plain", " A continuous leak rather than a discrete exploit, and the "
               "only item here whose cost accrues every harvest.")],
]

ROWS = {
    "DoS.6": [
        ("code", "withdraw"), ("plain", " computes "),
        ("code", "shares_to_burn"), ("plain", " with "),
        ("code", "fixed_mul_ceil"),
        ("plain", ", so a dust-sized withdrawal burns at least one share for "
                  "potentially zero underlying. Self-inflicted and "
                  "economically trivial."),
    ],
    "Spoof.4": [
        ("plain", "Keeper entrypoints authenticate by two different shapes: "
                  "five take a redundant caller parameter checked for "
                  "equality against "), ("code", "keeper.require_auth()"),
        ("plain", ", while "), ("code", "set_keeper"),
        ("plain", " ("), ("code", "lib.rs:807-813"),
        ("plain", ") takes none. All are correct as written, but the "
                  "convention is not uniform, so it cannot serve as a review "
                  "heuristic — the risk is a future entrypoint that takes a "
                  "caller parameter and omits the equality check, "
                  "authenticating the keeper while acting on an "
                  "attacker-supplied identity. A checklist item "
                  "(Spoof.4.R.1), not a defect."),
    ],
    "Elevation.8": [
        ("code", "migrate_position"), ("plain", " ("),
        ("code", "lib.rs:935-945"),
        ("plain", ") is the only permissionless entrypoint that calls "),
        ("code", "mint"),
        ("plain", ". Verified safe by three properties a future change must "
                  "preserve: the amount comes from "),
        ("code", "VaultPos(holder)"),
        ("plain", ", keyed on the subject rather than the caller; the entry "
                  "is zeroed in the same call, making it idempotent; and "),
        ("code", "total_shares"),
        ("plain", " already counted those shares, so minting restores the "
                  "invariant rather than inflating it. A review hazard — an "
                  "unauthenticated "), ("code", "mint"),
        ("plain", " with no "), ("code", "require_auth"),
        ("plain", " line to signal what is load-bearing — not a "
                  "vulnerability."),
    ],
}


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    saved = 0

    # ── §2.6: rebuild the five ranked items ──────────────────────────
    a = doc.index("The five that matter most")
    b = doc.index("What are we going to do about it")
    items = list(re.finditer(
        r'<w:p><w:pPr><w:pStyle w:val="Compact" /><w:numPr>.*?</w:p>',
        doc[a:b], re.S))
    assert len(items) == 5, f"expected 5 ranked items, found {len(items)}"
    num_id = re.search(r'w:numId w:val="(\d+)"', items[0].group(0)).group(1)
    before = sum(len(i.group(0)) for i in items)
    new = "".join(
        '<w:p><w:pPr><w:pStyle w:val="Compact" /><w:numPr>'
        f'<w:ilvl w:val="0" /><w:numId w:val="{num_id}" /></w:numPr></w:pPr>'
        + runs(p) + '</w:p>' for p in FIVE)
    doc = doc[:a + items[0].start()] + new + doc[a + items[-1].end():]
    saved += before - len(new)
    print(f"  §2.6 five items:  {before:,} -> {len(new):,}")

    # ── DoS.7: drop the self-narration sentence ──────────────────────
    i = doc.index("of this model recorded")
    ra = doc.rindex("<w:r>", 0, i)
    rb = doc.index("</w:r>", i) + 6
    seg = doc[ra:rb]
    assert "boundary walk that stopped at description" in seg, seg[:200]
    doc = doc[:ra] + doc[rb:]
    saved += len(seg)
    print(f"  DoS.7 narration:  removed {len(seg):,}")

    # ── three compressed rows ────────────────────────────────────────
    i = doc.index("2.3 Threat table")
    k = doc.index("2.4 Coverage map")
    for tid, parts in ROWS.items():
        j = doc.index(f'>{tid}</w:t>', i)
        rs = doc.rindex("<w:tr>", i, j)
        re_ = doc.index("</w:tr>", j) + len("</w:tr>")
        row = doc[rs:re_]
        cells = list(re.finditer(r'<w:tc>.*?</w:tc>', row, re.S))
        issue = cells[3]
        width = re.search(r'w:w="(\d+)"', issue.group(0)).group(1)
        new_cell = (f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{width}" />'
                    '</w:tcPr><w:tcPr /><w:p><w:pPr>'
                    '<w:pStyle w:val="Compact" /></w:pPr>'
                    + runs(parts) + '</w:p></w:tc>')
        saved += len(issue.group(0)) - len(new_cell)
        print(f"  {tid:12s}      {len(issue.group(0)):,} -> {len(new_cell):,}")
        doc = (doc[:rs] + row[:issue.start()] + new_cell + row[issue.end():]
               + doc[re_:])
        k = doc.index("2.4 Coverage map")

    print(f"  total saved: {saved:,} XML chars")

    out = HERE / "_dd.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("de-duplicated")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Editorial pass: cut self-narration and duplication without removing a
single finding, severity or treatment.

Measured before the cut: 12.5% of the document's sentences narrated its own
version history, §4 + Appendix A were 17.3% of the whole, and five facts were
restated between four and ten times each.

What this does NOT do: delete threat rows. DoS.6, Spoof.4 and Elevation.8 read
as non-findings, but each occupies a §2.4 coverage-map cell, and §2.4 defines
an empty cell as "a gap in this model, not evidence of safety". Deleting them
would manufacture three coverage holes and desynchronise the counts. They are
compressed in place instead.
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


def body(parts):
    return ('<w:p><w:pPr><w:pStyle w:val="BodyText" /></w:pPr>'
            + runs(parts) + '</w:p>')


def item(num_id, parts):
    return ('<w:p><w:pPr><w:pStyle w:val="Compact" /><w:numPr>'
            f'<w:ilvl w:val="0" /><w:numId w:val="{num_id}" /></w:numPr>'
            '</w:pPr>' + runs(parts) + '</w:p>')


def ins(lead, rest):
    """One numbered insight: bold lesson, then its evidence."""
    return item(1006, [("bold", lead), ("plain", " " + rest)])


# ── §4 replacements, keyed by block index ────────────────────────────
REPL = {
    # DFD-referenced question: two paragraphs -> one
    2: body([
        ("plain", "Within this exercise, yes — §2 was enumerated by walking "
                  "TB-1 through TB-6, and §2.4's coverage map is a direct "
                  "product of that. Beyond it, not yet: the diagram earns its "
                  "place only when someone opens it while adding an "
                  "entrypoint, which is what §4.1 exists to force."),
    ]),
    3: "",
    # same-day correction narration — the changelog carries this
    5: "",
    6: body([
        ("plain", "Ten issues are genuinely additional to the prior audit, "
                  "two of them significant. Seven came from the v1.0 boundary "
                  "sweep and are listed below with the boundary that surfaced "
                  "each; DoS.9, Tamper.9 and Tamper.11 came from later "
                  "source-verification passes and are logged in the findings "
                  "table further down, since they were found by reading code "
                  "against the model rather than by the model itself."),
    ]),
    8: body([
        ("plain", "The two that justify the exercise are "),
        ("bold", "Tamper.1 and Tamper.11"),
        ("plain", " — the same defect on the two risk parameters the whole HF "
                  "derivation rests on, each checked once and then trusted "
                  "forever. Tamper.1 was missed by a careful audit that had "
                  "already reasoned about governance drift for the adjacent "
                  "parameter; Tamper.11 was then missed here for two "
                  "revisions because H-1's fix made "), ("code", "l_factor"),
        ("plain", " feel handled. Together they are the argument for boundary "
                  "sweeps, and against treating a fixed finding as a closed "
                  "subject."),
    ]),
    9: body([
        ("plain", "Honest accounting: of the 39 threats here, roughly half "
                  "restate the audit, ten are new, and five things the audit "
                  "found were missed on the first pass. A boundary sweep run "),
        ("ital", "after"),
        ("plain", " a point-finding review adds structure, coverage evidence "
                  "and off-chain threats that per-file review misses — but it "
                  "is not a substitute for one, and must be run "),
        ("ital", "against"), ("plain", " it rather than in ignorance of it."),
    ]),
    10: body([
        ("plain", "Equally worth recording: the model "), ("bold", "confirmed"),
        ("plain", " a large set of controls as correct — the measured-delta "
                  "accounting discipline, downward-only reconciliation, the "),
        ("code", "PendingHarvest"),
        ("plain", " floor and its proration, the short allowance window, "
                  "on-chain derivation of "), ("code", "releverage"),
        ("plain", "'s bound. Fifteen §3 treatments are citations to code that "
                  "already does the right thing. A threat model that only "
                  "produces findings is not being honest about the system."),
    ]),
}

INSIGHTS = [
    ("Read the existing security work before starting.",
     "The first pass was written without consulting "
     "docs/security-audit-2026-08.md and missed five of its findings."),
    ("Calibrate severity against deployed parameters, not the code's ceiling.",
     "The audit revised its own ratings once it read the deploy script; this "
     "model over-scored L-2 as Critical before doing the same."),
    ("Enumerate data stores and their writers before enumerating threats.",
     "§1.5 directly produced Repudiate.1, and should have produced DoS.9 — "
     "having written “Persistent” in a column, the next question is "
     "“bumped by what, how often?”"),
    ("Read the dependencies' auth code, not just their READMEs.",
     "Elevation.2 sat in admin-sep and would never have surfaced from its "
     "interface alone."),
    ("Well-commented code is a hazard for reviewers.",
     "Spoof.2 and Elevation.4 both exist because a comment described an "
     "intent the code does not enforce."),
    ("Model the actor, not the function.",
     "DoS.3 and Elevation.5 are each defensible per function and unsafe once "
     "you assume a compromised keeper."),
    ("Force a row for Repudiation.",
     "It is the letter everyone skips, and it yielded the biggest "
     "observability gap here."),
    ("Verify every claim that reads like a bound, not only every claim that "
     "reads like an exploit.",
     "DoS.4 asserted a ~5-minute window the code does not enforce, in the "
     "very row that named the scenario where it fails."),
    ("Derived tables must be derived.",
     "§2.4's coverage map was maintained by hand and drifted from the "
     "Boundary column it is supposed to summarise."),
    ("A cited line number is a claim like any other.",
     "v1.2 checked ~50 file:line citations; several had rotted, and one was "
     "inherited wrong from the audit."),
    ("Read dependencies at the pinned revision, not the default branch.",
     "admin-sep's behaviour was confirmed against 46ed159, not main."),
    ("“Read live” is not “safe”, and a mitigation for one "
     "threat is not a mitigation for its neighbours.",
     "H-1 fixed the HF formula to carry l_factor, after which both the audit "
     "and this model treated the whole l_factor question as closed. "
     "Tamper.11 sat in that gap for two revisions."),
    ("Empty cells are questions, and re-testing them works.",
     "Elevation.8 exists because v1.2 wrote down which cells were empty and "
     "why, instead of leaving silence."),
    ("A register accumulates narration, and narration crowds out threats.",
     "By v1.3 a sixth of §2.3 was the document narrating its own past. Cut in "
     "v1.4, it regrew in §4 and the changelog and was cut again in v1.5. "
     "Re-measure it every pass; it does not stay cut."),
    ("Interpretive claims drift; mechanical ones do not.",
     "The v1.5 pass found errors in §1.2, §1.6 and §1.7 — every one an "
     "interpretive claim about what the system assumes or what a boundary "
     "means — and none in §1.4 or §1.5, which enumerate which gate guards "
     "what and which durability class each key uses. Point verification at "
     "the prose, not the tables."),
]


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    a = doc.rindex("<w:p>", 0, doc.index("Did we do a good job"))
    b = doc.rindex("<w:p>", 0, doc.index("Review triggers"))
    blocks = re.findall(r'<w:p>.*?</w:p>|<w:tbl>.*?</w:tbl>', doc[a:b], re.S)
    assert len(blocks) == 36, f"expected 36 blocks, found {len(blocks)}"
    assert blocks[7].startswith("<w:tbl") and blocks[19].startswith("<w:tbl")

    out = []
    for n, bl in enumerate(blocks):
        if 22 <= n <= 35:
            continue                     # insights rebuilt below
        out.append(REPL.get(n, bl))
    out += [ins(a_, b_) for a_, b_ in INSIGHTS]

    before = sum(len(x) for x in blocks)
    after = sum(len(x) for x in out)
    doc = doc[:a] + "".join(out) + doc[b:]
    print(f"  §4: {before:,} -> {after:,} XML chars "
          f"({100 * (before - after) // before}% smaller)")

    out_path = HERE / "_trim.docx"
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out_path, DOCX)
    print("trimmed §4")


if __name__ == "__main__":
    main()

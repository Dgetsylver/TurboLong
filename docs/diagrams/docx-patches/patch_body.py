#!/usr/bin/env python3
"""Strip revision archaeology from §1-§3, where §2.2's own rule forbids it.

The v1.4 pass cut this from the threat rows and it regrew around them: §2.2's
editorial rule narrates the measurement that produced it, §2.4 carries a
blockquote about miscounts fixed two versions ago, and eight rows open with
"Added in vX" before saying anything about the threat.

Rule applied: keep the *relation* ("narrows Tamper.3's guarantee"), drop the
*chronology* ("Added in v1.2 ---"). The changelog already has the dates.
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


# Opening chronology to delete from threat rows, verbatim as it appears.
PREFIXES = [
    "Added in v1.2 --- ", "Added in v1.2 — ", "Added in v1.2 ",
    "Added in v1.3 --- ", "Added in v1.3 — ", "Added in v1.3 ",
    "Added in v1.2", "Added in v1.3",
    "One qualification, added in v1.3:", "Qualified in v1.3:",
    "Missed by this model's first pass; ",
    "Missed by this model&#39;s first pass; ",
]


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    saved = 0

    # ── §2.2: the editorial rule keeps its rule, loses its memoir ────
    i = doc.index("What belongs in a row")
    p0 = doc.rindex("<w:p>", 0, i)
    p1 = doc.index("</w:p>", i) + len("</w:p>")
    old = doc[p0:p1]
    new = ('<w:p><w:pPr><w:pStyle w:val="BodyText" /></w:pPr>' + runs([
        ("bold", "What belongs in a row."),
        ("plain", " §2.3 is the operative register — what the threat is, what "
                  "bounds it, how bad it is. "),
        ("bold", "Revision history does not go here;"),
        ("plain", " it goes in §4's findings log and Appendix A. A row's "
                  "length should track its severity, not how interesting its "
                  "discovery was, and a row that mainly explains its relation "
                  "to another row is a sentence in that row. See insight 14."),
    ]) + '</w:p>')
    doc = doc[:p0] + new + doc[p1:]
    saved += len(old) - len(new)
    print(f"  §2.2 editorial rule: {len(old):,} -> {len(new):,}")

    # ── §2.4: drop the miscount blockquote, keep the rule it produced ─
    i = doc.index("Counting errors corrected")
    p0 = doc.rindex("<w:p>", 0, i)
    p1 = doc.index("</w:p>", i) + len("</w:p>")
    old = doc[p0:p1]
    new = ('<w:p><w:pPr><w:pStyle w:val="BlockText" /></w:pPr>' + runs([
        ("bold", "Re-derive this table from the "), ("code", "Boundary"),
        ("bold", " column whenever a row is added; never maintain it by "
                 "hand."),
        ("plain", " §2.4 declares empty cells to be findings rather than "
                  "oversights, so a miscounted cell propagates straight into "
                  "the prose below it — which is how a version of this "
                  "document came to assert that TB-1 had no Spoofing rows "
                  "while Spoof.1 sat at TB-1."),
    ]) + '</w:p>')
    doc = doc[:p0] + new + doc[p1:]
    saved += len(old) - len(new)
    print(f"  §2.4 miscount note:  {len(old):,} -> {len(new):,}")

    # ── §2.4: compress the gaps paragraph ───────────────────────────
    i = doc.index("Gaps worth noting")
    p0 = doc.rindex("<w:p>", 0, i)
    p1 = doc.index("</w:p>", i) + len("</w:p>")
    old = doc[p0:p1]
    new = ('<w:p><w:pPr><w:pStyle w:val="BodyText" /></w:pPr>' + runs([
        ("bold", "Gaps worth noting."),
        ("plain", " TB-1's Elevation cell was empty until Elevation.8 "
                  "resolved it — the intended lifecycle for an empty cell is "
                  "a row saying "), ("ital", "checked, and here is why"),
        ("plain", ", not silence. TB-2 has no Tampering rows: the keeper can "
                  "move the position but has no write path to stored "
                  "accounting that is not derived from measured pool deltas. "
                  "TB-3 has no Information Disclosure rows because admin "
                  "actions expose nothing the views do not already publish. "
                  "TB-4 has no Repudiation rows because Blend and Soroswap "
                  "emit independently of us. TB-5 and TB-6 have none either, "
                  "which is the weakest of these claims — the split-harvest "
                  "legs do emit, but nothing attributes a token-side mint or "
                  "burn back to the strategy action that caused it."),
    ]) + '</w:p>')
    doc = doc[:p0] + new + doc[p1:]
    saved += len(old) - len(new)
    print(f"  §2.4 gaps paragraph: {len(old):,} -> {len(new):,}")

    # ── threat rows: drop opening chronology ────────────────────────
    a = doc.index("2.3 Threat table")
    b = doc.index("2.4 Coverage map")
    seg, n = doc[a:b], 0
    for pre in PREFIXES:
        for m in re.finditer(re.escape(pre), seg):
            n += 1
        seg = seg.replace(pre, "")
    # tidy any run left holding only stray punctuation from the removal
    seg = re.sub(r'<w:r>(?:<w:rPr>.*?</w:rPr>)?<w:t xml:space="preserve">'
                 r'\s*[—-]{1,3}\s*</w:t></w:r>(?=<w:r>(?:<w:rPr>.*?</w:rPr>)?'
                 r'<w:t xml:space="preserve">[A-Z])', '', seg)
    saved += len(doc[a:b]) - len(seg)
    print(f"  threat rows: {n} chronology prefixes removed")
    doc = doc[:a] + seg + doc[b:]

    print(f"  total saved: {saved:,} XML chars")

    out = HERE / "_body.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("stripped §1-§3 archaeology")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Remove the header's "Applies to:" field.

It read `blend_leverage @ <commit>, vault_share @ <commit>` — the placeholders
were never filled, and shipping them visible in an official document is worse
than not having the field.

This was a decision, not an oversight: filling it with the real revisions
(blend_leverage @ debef5b, vault_share @ 92956eb, tree 4ff335c) was offered
and declined. Do not "restore" it as a lost line. If it comes back, it comes
back with hashes in it.

What that costs, recorded so the next pass knows: §3's Where column is
file:line citations, §4.1 requires re-verifying them on any upgrade, and
insight 10 is that a cited line number is a claim like any other. With no
revision in the document, that re-verification has no baseline to diff
against — the next reader has to establish which tree the citations were
written for before they can check any of them. The `.docx` also travels
detached from the repo, so nothing else in a mailed copy says which code it
describes.

The paragraph keeps its "Read first:" half; only the field after it goes,
along with the separating space run.
"""
import re
import shutil
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCX = HERE.parent.parent / "threat-model-stride.docx"

# From the space run before "Applies to:" through the final <commit> run.
START = '<w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:rPr><w:b /><w:bCs /></w:rPr><w:t xml:space="preserve">Applies to:</w:t></w:r>'


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    others = [(n, zin.read(n)) for n in zin.namelist()
              if n != "word/document.xml"]
    zin.close()

    assert doc.count(START) == 1, "expected exactly one 'Applies to:' field"
    i = doc.index(START)
    end = doc.index("</w:p>", i)
    cut = doc[i:end]

    # Guard: the span being removed must be exactly this field and nothing
    # more — every run in it, and no stray text past the last <commit>.
    text = "".join(re.findall(r'<w:t[^>]*>(.*?)</w:t>', cut))
    expected = (" Applies to: contracts/strategies/blend_leverage @ "
                "&lt;commit&gt;, contracts/tokens/vault_share @ &lt;commit&gt;")
    assert text == expected, f"span mismatch:\n  got      {text!r}\n  expected {expected!r}"

    doc = doc[:i] + doc[end:]
    print("removed:", text.strip())

    out = DOCX.with_suffix(".docx.new")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", doc)
        for n, b in others:
            z.writestr(n, b)
    shutil.move(out, DOCX)
    print(f"patched {DOCX}")


if __name__ == "__main__":
    main()

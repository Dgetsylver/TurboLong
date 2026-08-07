#!/usr/bin/env python3
"""Remove the remaining unfilled identity fields.

Header: `· Owner: TBD` goes, leaving `Version: 1.6 · Date: 2026-08-07`.
docProps/core.xml: the empty `<dc:creator/>` and `<cp:keywords/>` elements go
rather than shipping blank ones.

Decisions, not oversights — same as `Applies to:` in patch_v16_appliesto.py.
Do not restore either as a lost field. What it costs, recorded so the next
pass knows rather than rediscovers: §3.2 assigns P0 items to owners and §3.3
lists four decisions needing sign-off, and the document no longer names who
receives them. That routing now has to live outside the document.

Not touched: docProps/app.xml still carries the original conversion's word
and line counts (83 words, 12 lines). They are false but Word recomputes them
on open, and rewriting counters is not what this patch was asked to do.
"""
import re
import shutil
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCX = HERE.parent.parent / "threat-model-stride.docx"

DATE_RUN = '<w:r><w:t xml:space="preserve">2026-08-07 ·</w:t></w:r>'
OWNER = ('<w:r><w:t xml:space="preserve"> </w:t></w:r>'
         '<w:r><w:rPr><w:b /><w:bCs /></w:rPr>'
         '<w:t xml:space="preserve">Owner:</w:t></w:r>'
         '<w:r><w:t xml:space="preserve"> </w:t></w:r>'
         '<w:r><w:t xml:space="preserve">TBD</w:t></w:r>')


def main():
    zin = zipfile.ZipFile(DOCX)
    parts = {n: zin.read(n) for n in zin.namelist()}
    order = zin.namelist()
    zin.close()

    doc = parts["word/document.xml"].decode("utf-8")

    # The Owner field, plus the separator that introduced it.
    assert doc.count(DATE_RUN + OWNER) == 1, "header shape changed"
    doc = doc.replace(
        DATE_RUN + OWNER,
        '<w:r><w:t xml:space="preserve">2026-08-07</w:t></w:r>')
    print("removed: · Owner: TBD")

    # Guard: the whole header paragraph must still read cleanly. Slice from
    # the paragraph start, not from the "Version:" text — that lands inside a
    # run and drops the label from the reconstruction.
    i = doc.index("Version:")
    para = doc[doc.rindex("<w:p>", 0, i):doc.index("</w:p>", i)]
    tail = "".join(re.findall(r'<w:t[^>]*>(.*?)</w:t>', para))
    assert tail.endswith("Version: 1.6 · Date: 2026-08-07"), \
        f"header now: {tail!r}"
    print(f"header now: …{tail[-40:]}")

    core = parts["docProps/core.xml"].decode("utf-8")
    for tag in ("<dc:creator></dc:creator>", "<cp:keywords></cp:keywords>"):
        assert tag in core, f"missing {tag}"
        core = core.replace(tag, "")
        print(f"removed: {tag}")
    parts["docProps/core.xml"] = core.encode("utf-8")
    parts["word/document.xml"] = doc.encode("utf-8")

    out = DOCX.with_suffix(".docx.new")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for n in order:
            z.writestr(n, parts[n])
    shutil.move(out, DOCX)
    print(f"patched {DOCX}")


if __name__ == "__main__":
    main()

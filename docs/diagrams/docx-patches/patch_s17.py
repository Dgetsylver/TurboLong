#!/usr/bin/env python3
"""§1.7 verification pass — six corrections.

1. Assumption 5 claimed `c_factor` is read live. It is not: every HF site
   takes it from frozen config. Contradicted Tamper.1 (High) and the
   assumption's own v1.3 qualification.
2. Assumption 2 claimed measured deltas make the SEP-41 assumption
   defence-in-depth. True of pool accounting, false of the deposit inflow.
3. Info.1 attributed the "third to a half" floor guidance to §1.7, which
   contains none; it lives in a doc comment at lib.rs:1002-1006.
4. DoS.5 claimed every mutating entrypoint bumps the instance TTL; `upgrade`
   does not.
5. §1.7's keeper custody rationale repeated §1.2's overstatement about
   keeper discretion.
6. §1.7 never stated the off-chain precondition Tamper.11 rests on: that the
   deploy script's preflight() ran and passed. Added as assumption 7.

Also folds all of this into the existing v1.5 changelog row and adds a
findings-log entry. No threat added or re-scored.
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


def unesc(t):
    return (t.replace("&#39;", "'").replace("&lt;", "<")
             .replace("&gt;", ">").replace("&amp;", "&"))


def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace("'", "&#39;"))


def runs(parts):
    return "".join(f'<w:r>{RPR[k]}<w:t xml:space="preserve">{esc(t)}</w:t>'
                   '</w:r>' for k, t in parts)


def li(parts):
    """A numbered list item in the §1.7 'taken as given' list."""
    return ('<w:p><w:pPr><w:pStyle w:val="Compact" /><w:numPr>'
            '<w:ilvl w:val="0" /><w:numId w:val="1001" /></w:numPr></w:pPr>'
            + runs(parts) + '</w:p>')


def cell(width, parts):
    return (f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{width}" /></w:tcPr>'
            '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
            + runs(parts) + '</w:p></w:tc>')


LIST_RE = r'<w:p><w:pPr><w:pStyle w:val="Compact" /><w:numPr>.*?</w:p>'

# ── assumption 2 ─────────────────────────────────────────────────────
A2 = [
    ("plain", "The underlying and BLND token contracts behave as SEP-41 — in "
              "particular, "),
    ("code", "transfer"),
    ("plain", " moves exactly the stated amount (no fee-on-transfer, no "
              "rebasing). "),
    ("bold", "Load-bearing on the deposit path, defence-in-depth elsewhere."),
    ("plain", " Pool-side accounting is measured (b/d token deltas across "),
    ("code", "get_positions"),
    ("plain", "), and so is harvest settlement ("),
    ("code", "underlying_before"),
    ("plain", " plus balance delta) — but "), ("code", "deposit"),
    ("plain", " transfers "), ("code", "amount"), ("plain", " ("),
    ("code", "lib.rs:234"),
    ("plain", ") and then supplies that same figure rather than a measured "
              "balance ("), ("code", "lib.rs:238"),
    ("plain", "). A fee-on-transfer token would leave the contract holding "
              "less than it tries to supply; the call reverts rather than "
              "mis-accounting, so the exposure is deposit liveness, not "
              "solvency."),
]

# ── assumption 5 ─────────────────────────────────────────────────────
A5 = [
    ("plain", "Blend governance may re-parameterise a reserve at any time. "),
    ("bold", "Only "), ("code", "l_factor"), ("bold", " is read live"),
    ("plain", " — every HF computation takes it from "), ("code", "get_reserve"),
    ("plain", " ("), ("code", "blend_pool.rs:610-618"),
    ("plain", ") but takes "), ("code", "c_factor"),
    ("plain", " from frozen config ("), ("code", "lib.rs:489"),
    ("plain", ", "), ("code", ":788"),
    ("plain", "). The pool's live "), ("code", "c_factor"),
    ("plain", " is read in exactly one place, the "), ("code", "risk_factors()"),
    ("plain", " view ("), ("code", "lib.rs:882"),
    ("plain", "), which gates nothing. Reading "), ("code", "l_factor"),
    ("plain", " live keeps the HF "), ("ital", "measurement"),
    ("plain", " honest, and that is all it does. It does not protect "
              "invariants that "), ("ital", "relate"),
    ("plain", " live parameters to frozen config — "),
    ("code", "c_factor <= pool_c_factor"), ("plain", " (Tamper.1) and "),
    ("code", "design_hf > orange_hf"),
    ("plain", " (Tamper.11) are both such invariants, and both are asserted "
              "once and never revisited. “Read live” is not a "
              "synonym for “safe under governance drift”; it is the "
              "precondition for detecting drift, and nothing currently does "
              "the detecting."),
]

# ── new assumption 7 ─────────────────────────────────────────────────
A7 = [
    ("bold", "The deploy script's "), ("code", "preflight()"),
    ("bold", " was run and passed."), ("plain", " That "),
    ("code", "design_hf > orange_hf"),
    ("plain", " — that a position levered to "), ("code", "target_loops"),
    ("plain", " actually clears the rebalance band — is checked nowhere "
              "on-chain. The constructor validates parameter "),
    ("ital", "ordering"), ("plain", " only, and the sole implementation of "
                                    "the coherence check is "),
    ("code", "preflight()"), ("plain", " in "),
    ("code", "scripts/deploy_strategy_mainnet.ts"),
    ("plain", ". The leverage design therefore rests on an off-chain "
              "precondition with no on-chain witness that it held, and "
              "nothing re-evaluates it as "), ("code", "l_factor"),
    ("plain", " drifts. See Tamper.11, whose margin is ~2pp."),
]

FINDING = (
    cell(1270, [("plain", "2026-08-07")])
    + cell(4570, [
        ("bold", "§1.7 assumption 5 stated that "), ("code", "c_factor"),
        ("bold", " is read live on every HF computation"),
        ("plain", "; it is taken from frozen config at every site. Assumption "
                  "2 and the keeper custody rationale were similarly "
                  "overstated, and the "), ("code", "preflight()"),
        ("plain", " precondition was missing entirely"),
    ])
    + cell(1690, [("plain", "v1.5 §1 verification")])
    + cell(6865, [
        ("bold", "Yes — and it is the assumption that hid Tamper.11."),
        ("plain", " §1.7 already said so in its own v1.3 qualification "
                  "(“both are asserted once and never revisited”) "
                  "and Tamper.1 states plainly that "), ("code", "c_factor"),
        ("plain", " is the frozen one, so the paragraph contradicted both its "
                  "own second half and a High-severity row. The v1.3 edit was "
                  "written to fix exactly this and stopped one sentence short "
                  "— a correction appended as a qualification rather than "
                  "applied to the claim it qualifies. Check that the opening "
                  "sentence still holds whenever a qualification is bolted on "
                  "to one."),
    ]))


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    base = doc.index("Assumptions and dependencies")
    seg_end = doc.index("What can go wrong")

    items = list(re.finditer(LIST_RE, doc[base:seg_end], re.S))
    assert len(items) == 6, f"expected 6 assumptions, found {len(items)}"

    # Rewrite 5 then 2 (descending, so earlier offsets stay valid), then
    # append the new item 7 after the last.
    a, b = base + items[5].start(), base + items[5].end()
    doc = doc[:b] + li(A7) + doc[b:]                      # insert 7 after 6
    a, b = base + items[4].start(), base + items[4].end()
    doc = doc[:a] + li(A5) + doc[b:]
    a, b = base + items[1].start(), base + items[1].end()
    doc = doc[:a] + li(A2) + doc[b:]

    # ── single-run corrections ───────────────────────────────────────
    old = ('<w:r><w:t xml:space="preserve">§1.7 recommends setting the floor '
           'at a third to a half of market to avoid false trips')
    i = doc.index("recommends setting the floor")
    ra = doc.rindex("<w:r>", 0, i)
    rb = doc.index("</w:r>", i) + 6
    body = re.search(r'<w:t[^>]*>(.*?)</w:t>', doc[ra:rb], re.S).group(1)
    body = unesc(body)
    assert "§1.7 recommends" in body
    head, tail = body.split("§1.7 recommends setting the floor", 1)
    doc = doc[:ra] + runs([
        ("plain", head), ("code", "set_min_harvest_rate"),
        ("plain", "'s own doc comment ("), ("code", "lib.rs:1002-1006"),
        ("plain", ") recommends setting the floor" + tail),
    ]) + doc[rb:]

    old = ('<w:r><w:t xml:space="preserve">entrypoint and most views bump the '
           'TTL (</w:t></w:r>')
    assert doc.count(old) == 1
    doc = doc.replace(old, runs([
        ("plain", "entrypoint except "), ("code", "upgrade"),
        ("plain", " — and most views — bumps the TTL ("),
    ]))

    old = ('<w:r><w:t xml:space="preserve">The design already bounds keeper '
           'discretion to the safe direction; the residual exposure is yield '
           'and availability, not principal.</w:t></w:r>')
    assert doc.count(old) == 1
    doc = doc.replace(old, runs([
        ("plain", "The design bounds keeper discretion to the safe direction "
                  "on the position itself ("), ("code", "releverage"),
        ("plain", "'s amount is derived on-chain, and unwinding can only "
                  "help). The exception is the harvest price: an unset "),
        ("code", "min_harvest_rate"),
        ("plain", " leaves the floor entirely to the keeper (Elevation.5). "
                  "Residual exposure is yield and availability, not "
                  "principal."),
    ]))

    # ── fold into the v1.5 changelog row ─────────────────────────────
    anchor = "Added the §4.1 trigger that would have caught these."
    i = doc.index(anchor)
    ra = doc.rindex("<w:r>", 0, i)
    rb = doc.index("</w:r>", i) + 6
    body = re.search(r'<w:t[^>]*>(.*?)</w:t>', doc[ra:rb], re.S).group(1)
    body = unesc(body)
    assert body.endswith(anchor), body[-80:]
    doc = doc[:ra] + runs([
        ("plain", body + " "),
        ("bold", "Same pass over §1.7:"), ("plain", " assumption 5 claimed "),
        ("code", "c_factor"),
        ("plain", " is read live on every HF computation — it is frozen "
                  "config at every site, contradicting Tamper.1 and the "
                  "assumption's own v1.3 qualification; assumption 2's "
                  "“measures balance deltas rather than assuming” "
                  "is true of pool accounting but not of the deposit inflow; "
                  "the keeper custody rationale repeated §1.2's "
                  "overstatement. Added assumption 7 — the deploy script's "),
        ("code", "preflight()"),
        ("plain", " is the only implementation of "),
        ("code", "design_hf > orange_hf"),
        ("plain", ", an off-chain precondition Tamper.11 rests on and §1.7 "
                  "never stated. Corrected two §2.3 citations: Info.1 "
                  "attributed the “third to a half” floor guidance "
                  "to §1.7, which contains none (it is a doc comment at "),
        ("code", "lib.rs:1002-1006"),
        ("plain", ", as Info.1.R.1 already said), and DoS.5's “every "
                  "mutating entrypoint bumps the TTL” missed "),
        ("code", "upgrade"), ("plain", "."),
    ]) + doc[rb:]

    # ── findings-log row ─────────────────────────────────────────────
    i = doc.index("Have additional issues been found")
    j = doc.index("<w:tbl>", i)
    first = doc.index("</w:tr>", j) + len("</w:tr>")
    doc = doc[:first] + "<w:tr>" + FINDING + "</w:tr>" + doc[first:]

    out = HERE / "_s17.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in zin.infolist():
            zo.writestr(item, doc.encode("utf-8")
                        if item.filename == "word/document.xml"
                        else zin.read(item.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("patched §1.7 + two §2.3 citations")


if __name__ == "__main__":
    main()

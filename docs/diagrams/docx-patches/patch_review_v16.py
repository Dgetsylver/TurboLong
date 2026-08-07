#!/usr/bin/env python3
"""v1.6 review pass: defects found at the joins, all re-verified against source.

Every edit below was checked twice — once when found, once against the
contracts before writing this script. What changed and why:

§1.2   The Blend pool row claimed risk parameters "are read live rather than
       cached". Only `l_factor` is (blend_pool.rs:610-618); `c_factor` comes
       from frozen Config at lib.rs:489 and :788, which is the entire premise
       of Tamper.1. §1.7 assumption 5 already states it correctly, so §1.2 was
       contradicting both a §2 row and a §1 assumption.

Scope  "§2.6 maps every threat here to its audit ID" — that is §2.5, and it
       maps the audit's IDs onto threats, not the reverse. Most rows have no
       audit ID at all.

§2.2   Tamper.10's absence from §2.3 had no in-place note; the merge is
       recorded only in §4's log. DF-22 gets a note in §1.6; this now matches.

§2.3   Five diagram flows were cited by no row, which §2.2 claims cannot
       happen and docs/diagrams/README.md makes a rule. Retagged where the
       flow is what the row is actually about: DF-20/DF-21 (the emit flows)
       onto the Repudiation rows, DF-11 (claim) onto Info.2, DF-12 (BLND
       credited) onto Elevation.6, DF-14 (principal in/out) onto DoS.2.
       Info.3 and Info.4 go the other way: they were tagged DF-2 and DF-3,
       which are mutating-call flows, for threats about *reading* published
       state. Ledger state is readable without invoking anything, so there is
       no call to draw — Flow becomes "—", with the reason stated in the
       section preamble.

§2.4   "Gaps worth noting" explained 5 of the 10 empty cells while §2.4's own
       rule is that an empty cell gets a row saying checked, and here is why.
       The other five are now stated.

§2.5   "orange_hf 1.10 against design HFs of ~1.12-1.13" holds for USDC
       (1.1312) and CETES (1.1233) only; USTRY is 1.15/1.1768 and XLM is
       1.20/1.2238 (deploy_strategy_mainnet.ts:106-111). Since this sentence
       is what justifies the audit's severities governing, it now carries the
       real range. Netting row gains its audit ID (was M-6).

Tamper.11  All four margins are computed at l = 0.95; the deploy script
       records that figure only for USDC and CETES. Arithmetic re-derived and
       correct (trips at 0.9238 / 0.9284 / 0.9303 / 0.9315) — only the premise
       was unstated.

§3     DoS.2.R.1 was typed `accepted` while §3.3 says the decision is not yet
       decidable and §3.1 says its size is unproven. Retyped "—", the same
       marker Tamper.5.R.2 already uses, and the text now says what it is.
       DoS.3.R.1 carried no ⚠ though §3.2 and §3.3 both gate it. The ⚠
       preamble now admits the marker's second meaning (Ops ownership).
       Tamper.6.R.1 cited :3838-3849 where §2.3 cites :3844-3849 — the
       assert_eq is 3845-3849, the `let stored` it needs is 3844.
       Info.2.R.1's "every swap carries a non-zero amount_out_min" is true,
       but the sub-threshold branch of the trait harvest computes
       amount_out_min = 0; what saves it is perform_reinvest returning early
       (blend_pool.rs:536-538), which was uncited.
       DoS.5.R.1's list of views that skip the TTL bump omitted
       `swap_account` (lib.rs:983) — five, not four.
       Tamper.2.R.2 and Elevation.6.R.3 were filed out of order.

§3.2   Elevation.7.R.3 was claimed by both the P1 events row and the P2
       monitoring row. It stays in P2, where the plumbing is; P1's prose
       already explains that it unblocks it.

§2.6   §1.3's asset register A1-A7 was defined and then never cited again.
       The five entries here now name the asset each puts at risk, and A1's
       loss column admits loss of access, which is what DoS.2 actually is.
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

C, P, B, I = "code", "plain", "bold", "ital"


def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace("'", "&#39;"))


def unesc(t):
    return (t.replace("&#39;", "'").replace("&gt;", ">")
             .replace("&lt;", "<").replace("&amp;", "&"))


def runs(parts):
    return "".join(f'<w:r>{RPR[k]}<w:t xml:space="preserve">{esc(t)}</w:t>'
                   '</w:r>' for k, t in parts)


# ── primitives ───────────────────────────────────────────────────────────────

def find(doc, needle, after=None, before=None):
    """Index of `needle`, optionally bounded by markers (text or offsets)."""
    lo = (after if isinstance(after, int) else doc.index(after)) if after is not None else 0
    hi = (before if isinstance(before, int) else doc.index(before)) if before is not None else len(doc)
    return doc.index(needle, lo, hi)


def sub_run(doc, needle, parts, after=None, before=None, last=False):
    """Replace `needle` inside its enclosing run with `parts`.

    The text on either side of the needle within that run keeps the run's own
    formatting, so this is safe on runs that carry a rPr. `last` searches
    backwards from `before`, for anchors that recur earlier in the document.
    """
    n = esc(needle) if esc(needle) in doc else needle
    if last:
        lo = (after if isinstance(after, int) else doc.index(after)) if after is not None else 0
        hi = (before if isinstance(before, int) else doc.index(before)) if before is not None else len(doc)
        i = doc.rindex(n, lo, hi)
    else:
        i = find(doc, n, after, before)
    rs = doc.rindex("<w:r>", 0, i)
    re_ = doc.index("</w:r>", i) + len("</w:r>")
    run = doc[rs:re_]
    m = re.search(r'^<w:r>(<w:rPr>.*?</w:rPr>)?<w:t[^>]*>(.*?)</w:t></w:r>$',
                  run, re.S)
    assert m, f"unexpected run shape around: {needle!r}"
    rpr = m.group(1) or ""
    kind = next((k for k, v in RPR.items() if v == rpr), None)
    assert kind is not None, f"unknown rPr {rpr!r}"
    text = unesc(m.group(2))
    assert needle in text, f"needle not whole within one run: {needle!r}"
    head, tail = text.split(needle, 1)
    out = []
    if head:
        out.append((kind, head))
    out.extend(parts)
    if tail:
        out.append((kind, tail))
    return doc[:rs] + runs(out) + doc[re_:]


def para_append(doc, anchor, parts, after=None, before=None):
    """Append runs to the end of the paragraph containing `anchor`."""
    i = find(doc, anchor, after, before)
    end = doc.index("</w:p>", i)
    return doc[:end] + runs(parts) + doc[end:]


def row_bounds(doc, row_id, after, before):
    """(start, end) of the <w:tr> whose first cell is exactly `row_id`."""
    i = find(doc, f'>{row_id}</w:t>', after, before)
    rs = doc.rindex("<w:tr>", 0, i)
    re_ = doc.index("</w:tr>", i) + len("</w:tr>")
    return rs, re_


def replace_cell(doc, row_id, cell_idx, parts, after, before, expect=None):
    rs, re_ = row_bounds(doc, row_id, after, before)
    row = doc[rs:re_]
    cells = list(re.finditer(r'<w:tc>.*?</w:tc>', row, re.S))
    cell = cells[cell_idx]
    if expect is not None:
        got = "".join(re.findall(r'<w:t[^>]*>(.*?)</w:t>', cell.group(0)))
        assert expect in unesc(got), \
            f"{row_id} cell {cell_idx}: expected {expect!r}, got {got!r}"
    w = re.search(r'w:w="(\d+)"', cell.group(0)).group(1)
    new = (f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{w}" /></w:tcPr>'
           '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
           + runs(parts) + '</w:p></w:tc>')
    return doc[:rs] + row[:cell.start()] + new + row[cell.end():] + doc[re_:]


def move_row(doc, row_id, after_row_id, after, before):
    """Lift the <w:tr> for `row_id` and reinsert it after `after_row_id`."""
    rs, re_ = row_bounds(doc, row_id, after, before)
    block = doc[rs:re_]
    doc = doc[:rs] + doc[re_:]
    _, dest = row_bounds(doc, after_row_id, after, before)
    return doc[:dest] + block + doc[dest:]


# ── the edits ────────────────────────────────────────────────────────────────

def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    others = [(n, zin.read(n)) for n in zin.namelist()
              if n != "word/document.xml"]
    zin.close()

    # Section anchors. Every bounded search below is scoped by these so a
    # treatment ID cannot be matched in §3.2's work-item table by accident.
    S23 = "2.3 Threat table"
    S24 = "2.4 Coverage map"
    S25 = "2.5 Cross-reference"
    S26 = "2.6 The five that matter most"
    S3 = "3. What are we going to do about it?"
    S31 = "3.1 Residual risk"
    S32 = "3.2 Work items"
    S33 = "3.3 Decisions needed"

    # ── §1.2: c_factor is not read live ──────────────────────────────────────
    doc = sub_run(doc, "so they are read live rather than cached", [
        (P, "so "), (C, "l_factor"), (P, " is read live on every HF "
         "computation ("), (C, "blend_pool.rs:610-618"), (P, "). "),
        (C, "c_factor"), (P, " is not: it is frozen in "), (C, "Config"),
        (P, " at construction, and the pool's live value is read only by the "),
        (C, "risk_factors()"), (P, " view, which gates nothing — Tamper.1"),
    ])

    # ── Scope: wrong section reference ───────────────────────────────────────
    doc = sub_run(doc, "§2.6 maps every threat here to its audit ID.",
                  [(P, "§2.5 cross-references this model against the audit's "
                       "findings.")])

    # ── §2.2: record the Tamper.10 gap where a reader meets it ───────────────
    doc = para_append(doc, "See insight 14.", [
        (P, " Tamper.10 is absent by design: v1.4 merged it into Tamper.2 as "
            "the structural half of the same defect. The gap stays rather "
            "than renumbering, for the same reason DF-22's does."),
    ])

    # ── §2.3: flow tags ──────────────────────────────────────────────────────
    FLOWS = [
        ("Repudiate.1", "DF-3, DF-4, DF-5, DF-20, DF-21", "DF-3"),
        ("Repudiate.2", "DF-2, DF-20", "DF-2"),
        ("Repudiate.3", "DF-2, DF-20, DF-21", "DF-2"),
        ("Repudiate.4", "DF-3, DF-20", "DF-3"),
        ("Info.2", "DF-11, DF-13", "DF-13"),
        ("Info.3", "—", "DF-2"),
        ("Info.4", "—", "DF-3"),
        ("DoS.2", "DF-9, DF-14", "DF-9"),
        ("Elevation.6", "DF-12, DF-15, DF-16", "DF-15"),
    ]
    for rid, new, expect in FLOWS:
        doc = replace_cell(doc, rid, 2, [(P, new)],
                           after=S23, before=S24, expect=expect)

    # Why Info.3/.4 carry no flow.
    doc = para_append(doc, "data is economically", [
        (P, " Info.3 and Info.4 carry no flow: contract state is readable "
            "from the ledger without invoking anything, so publication "
            "crosses TB-1 without a call to draw. That is the same fact §3 "
            "leans on when it rules out “stop publishing it” as a treatment."),
    ], after=S23, before=S24)

    # ── §2.4: the other five empty cells ─────────────────────────────────────
    doc = para_append(doc, "attributes a token-side mint or burn back to the "
                           "strategy action that caused it.", [
        (P, " The remaining five, stated rather than left silent: TB-3 has no "
            "Spoofing rows because impersonating the admin means holding its "
            "key, which is Elevation.1 and not a separate path; TB-4 has none "
            "because the pool and router addresses are frozen in "),
        (C, "Config"), (P, " at construction, so substituting a counterfeit "
            "protocol needs "), (C, "upgrade"), (P, "; TB-4 has no Elevation "
            "rows because the contract holds no privilege inside Blend or "
            "Soroswap to escalate — it is an ordinary pool user; TB-5 has no "
            "Tampering rows because nothing crossing it is read as data, only "
            "as balances the contract measures itself (Spoof.3); and TB-6 has "
            "no Information Disclosure rows because the token publishes only "
            "balances and supply, which the strategy's own views already "
            "imply."),
    ], after=S24, before=S25)

    # ── Tamper.11: state the l = 0.95 premise ────────────────────────────────
    doc = sub_run(doc, "Margins are thinner than Tamper.1's:",
                  [(B, "Margins are thinner than Tamper.1's"),
                   (P, " (all four at "), (C, "l = 0.95"),
                   (P, ", which the deploy script records only for USDC and "
                       "CETES — re-derive the other two from the live "
                       "reserve)"), (B, ":")],
                  after=S23, before=S24)

    # ── §2.5: the parameter summary, and the netting row's audit ID ──────────
    doc = sub_run(doc, "1.10 against design", [(P, "1.10–1.20 against design")],
                  after=S25, before=S26)
    doc = sub_run(doc, "HFs of ~1.12–1.13), which this model's first pass did "
                       "not read.",
                  [(P, "HFs of 1.1233–1.2238 depending on the asset), which "
                       "this model's first pass did not read.")],
                  after=S25, before=S26)
    doc = sub_run(doc, "Withdrawn", [(B, "Withdrawn"), (P, " (was M-6)")],
                  after=find(doc, "does Blend net transfers per"), before=S26)

    # ── §2.6: wire §1.3's asset register in ──────────────────────────────────
    doc = sub_run(doc, "Ordered by expected loss, not by severity label.",
                  [(P, "Ordered by expected loss, not by severity label; the "
                       "parenthesised IDs are the §1.3 assets each row puts "
                       "at risk.")], after=S26, before=S3)
    for lead, tag in [("Elevation.1 —", "Elevation.1 (A5 → A1) —"),
                      ("DoS.1 / DoS.2 —", "DoS.1 / DoS.2 (A1) —"),
                      ("Tamper.1 + Tamper.11 —", "Tamper.1 + Tamper.11 (A3) —"),
                      ("Repudiate.1 —", "Repudiate.1 (A7) —"),
                      ("Info.1 —", "Info.1 (A4) —")]:
        doc = sub_run(doc, lead, [(B, tag)], after=S26, before=S3)

    # A1's loss column: DoS.2 is loss of access, which it did not admit.
    doc = sub_run(doc, "Direct theft, or a liquidation the vault could have "
                       "avoided",
                  [(P, "Direct theft, a liquidation the vault could have "
                       "avoided, or funds unreachable while the pool is "
                       "fully utilized (DoS.2)")])

    # ── §3 preamble: ⚠ carries two meanings; say so ──────────────────────────
    doc = para_append(doc, "the ones needing explicit sign-off are marked", [
        (P, " ⚠ also marks a row whose owner is Ops rather than the codebase; "
            "either way it means the row is not ours to close unilaterally."),
    ], after=S3, before=S31)

    # ── §3 treatment rows ────────────────────────────────────────────────────
    # DoS.2.R.1 — §3.3 says the decision is not yet available to take.
    doc = replace_cell(doc, "DoS.2.R.1", 1, [
        (B, "Not yet decidable — ⚠ needs sign-off, but not yet."),
        (P, " There is no code fix: withdrawal requires pool liquidity, and a "
            "fully-utilized pool blocks it. This is the most likely way a "
            "user experiences loss of access to funds, and accepting it is a "
            "product decision, not just an engineering one — but its size is "
            "unproven until the P0 Blend-netting investigation lands (§2.5, "
            "§3.3), and a risk of unknown size is not one anyone can accept."),
    ], after=S3, before=S31, expect="Accepted")
    doc = replace_cell(doc, "DoS.2.R.1", 2, [(P, "—")],
                       after=S3, before=S31, expect="accepted")

    # DoS.3.R.1 — gated in §3.2 and §3.3, unmarked here.
    doc = replace_cell(doc, "DoS.3.R.1", 3,
                       [(P, "⚠ "), (C, "lib.rs:626"), (P, " — decision first, "
                                                          "§3.3")],
                       after=S3, before=S31, expect="lib.rs:626")

    # DoS.5.R.1 — swap_account also skips the bump.
    doc = sub_run(doc, "min_harvest_rate",
                  [(C, "swap_account"), (P, ", "), (C, "min_harvest_rate")],
                  after=S3,
                  before=find(doc, "no realistic traffic pattern hits only "
                                   "those four"),
                  last=True)
    doc = sub_run(doc, "no realistic traffic pattern hits only those four",
                  [(P, "no realistic traffic pattern hits only those five")],
                  after=S3, before=S31)

    # Tamper.6.R.1 — cite the range §2.3 cites.
    doc = sub_run(doc, "test_integration.rs:3838-3849",
                  [(C, "test_integration.rs:3844-3849")],
                  after=S3, before=S31)

    # Info.2.R.1 — name the code the "non-zero amount_out_min" claim rests on.
    doc = sub_run(doc, "fails closed rather than swapping unprotected.", [
        (P, "fails closed rather than swapping unprotected; a BLND balance "
            "below "), (C, "reward_threshold"), (P, " never reaches the "
            "router at all ("), (C, "blend_pool.rs:536-538"), (P, ")."),
    ], after=S3, before=S31)

    # Filing order.
    doc = move_row(doc, "Tamper.2.R.2", "Tamper.2.R.1", S3, S31)
    doc = move_row(doc, "Elevation.6.R.3", "Elevation.6.R.2", S3, S31)

    # ── §3.2: Elevation.7.R.3 belongs to one work item, not two ──────────────
    doc = sub_run(doc, "Elevation.1.R.2, .7.R.3", [(P, "Elevation.1.R.2")],
                  after=S32, before=S33)

    out = DOCX.with_suffix(".docx.new")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", doc)
        for n, b in others:
            z.writestr(n, b)
    shutil.move(out, DOCX)
    print(f"patched {DOCX}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Tampering pass: verify every claim, then cut what the claims don't need.

Verified against source — all correct: Tamper.2 (lib.rs:201-204,
leverage.rs:78, lib.rs:787-791), Tamper.6 (invariant pinned at
test_integration.rs:3844-3849), Tamper.7 (blend_pool.rs:197-198, :258-263),
Tamper.8 (constants.rs:11-15), Tamper.9 (blend_pool.rs:577-590),
Tamper.11 (leverage.rs:302, preflight, and all four margin figures recomputed
from the deployed parameters).

One citation corrected: Tamper.1 cited deploy_strategy_mainnet.ts:106-111 for
the pool c_factors, but :106-111 holds only the *strategy's* c_factors. The
pool figures (USDC 0.95, USTRY 0.90, CETES 0.80, XLM 0.75) are at :74-77.

Three openings repaired: Tamper.9, Tamper.11 and DoS.9 lost their bolded
lead-in when patch_body.py stripped "Added in vX ---" and were left starting
mid-clause.
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


C, P, B, I = "code", "plain", "bold", "ital"

ROWS = {
 "Tamper.1": [
  (C, "c_factor <= pool_c_factor"),
  (P, " is asserted at construction only (plus "), (C, "preflight()"),
  (P, " at deploy), and it is the entire basis for the claim that the "
      "strategy's HF is a lower bound on Blend's solvency ratio. Blend "
      "governance can lower a reserve's "), (C, "c_factor"), (P, " afterwards ("),
  (C, "queue_set_reserve"), (P, "); nothing re-checks. The strategy would then "
      "report "), (C, "HF > 1.0"), (P, " on a position Blend considers "
      "liquidatable, and "),
  (B, "deposits would keep being accepted into a position the vault believes "
      "is safe"), (P, ". "), (C, "l_factor"), (P, " is read live (audit H-1); "),
  (C, "c_factor"), (P, " is the frozen one. "), (B, "Margin:"),
  (P, " every asset carries a uniform 5pp buffer — USDC 0.90 vs pool 0.95, "
      "USTRY 0.85 vs 0.90, CETES 0.75 vs 0.80, XLM 0.70 vs 0.75 ("),
  (C, "deploy_strategy_mainnet.ts:74-77"), (P, ", "), (C, ":106-111"),
  (P, ") — so this needs a governance de-risking of >5pp on a single asset. "
      "Latent, not live. "), (B, "Upper bound:"),
  (P, " the pool's own post-"), (C, "submit"), (P, " health check eventually "
      "fails deposits closed. On USDC's parameters the loop starts reverting "
      "once "), (C, "pool_c_factor < 3.0951 / (4.0951 × 0.95) ≈ 0.796"),
  (P, ", so the exposed window is "), (C, "pool_c ∈ (0.796, 0.90)"),
  (P, " — 10pp wide, and every point inside it is a position the vault "
      "reports as safer than Blend does."),
 ],
 "Tamper.2": [
  (B, "The deposit gate trusts a projection, in two ways."), (P, " "),
  (I, "Arithmetically:"), (P, " it degrades silently on overflow rather than "
      "reverting — "), (C, "add_supply.checked_mul(SCALAR_12).unwrap_or(0)"),
  (P, " ("), (C, "lib.rs:201-204"), (P, ") contributes "), (C, "0"),
  (P, " to the projection and "), (C, "compute_totals"),
  (P, " accumulates with "), (C, ".unwrap_or(total_supply)"), (P, " ("),
  (C, "leverage.rs:78"), (P, "), so a deposit large enough to overflow is "
      "checked against an under-stated projection. Needs ~1e26 stroops, so "
      "latent. "), (I, "Structurally:"), (P, " nothing re-reads the position "
      "after "), (C, "submit_leverage_loop"), (P, " settles, whereas "),
  (C, "releverage"), (P, " — the other path that adds leverage — re-reads and "
      "reverts if HF did not land above "), (C, "orange_hf"), (P, " ("),
  (C, "lib.rs:787-791"), (P, "). Within one atomic transaction the two differ "
      "only by pool rounding, so this half is Info-grade today. It matters if "
      "the projection arithmetic ever gains a term, and the asymmetry between "
      "two leverage-adding paths should be a decision rather than an "
      "oversight."),
 ],
 "Tamper.3": [
  (P, "The reserves-vs-pool reconciliation is deliberately downward-only, so "
      "collateral credited to the strategy from outside is never priced into "
      "shares. This is the correct trade — it is what makes "),
  (I, "collateral"), (P, "-donation share-price inflation impossible (see "
      "Tamper.9 for the path it does not close) — but an upward divergence is "
      "invisible and unbounded in duration: value accrues unpriced until a "
      "full close."),
 ],
 "Tamper.6": [
  (B, "= audit L-1."), (P, " The token's public "), (C, "burn"), (P, "/"),
  (C, "burn_from"), (P, " decrement "), (C, "total_supply"),
  (P, " without the strategy's "), (C, "total_shares"),
  (P, " following, so the two ledgers desynchronise. The burner's equity "
      "becomes permanently unclaimable and the "),
  (C, "total_supply == total_shares"), (P, " invariant — pinned at "),
  (C, "test_integration.rs:3844-3849"), (P, " — is silently violated. No "
      "pricing effect: the strategy prices off its own "), (C, "total_shares"),
  (P, " and reads only "), (C, "balance()"), (P, " from the token (DF-8). No "
      "attacker profit and no victim but the burner; voluntary burn is "
      "arguably correct SEP-41 behaviour."),
 ],
 "Tamper.9": [
  (B, "Narrows Tamper.3's guarantee."), (P, " The downward-only clamp closes "
      "the "), (I, "collateral"), (P, " donation path, not the underlying one. "),
  (C, "harvest_reinvest(via_soroswap = false, amount_in)"), (P, " routes to "),
  (C, "reinvest_underlying"), (P, " ("), (C, "blend_pool.rs:577-590"),
  (P, "), which levers whatever underlying the contract holds, mints no "
      "shares, and validates only "), (C, "held >= amount"),
  (P, " — never where it came from. Anyone can "), (C, "transfer"),
  (P, " underlying to the strategy, and the next Broker-route reinvest prices "
      "it into the share price. So “a donation cannot move the share "
      "price” is true of the b/d-token ledger and false of the token "
      "balance. Realising it is keeper-gated, it is a gift rather than an "
      "extraction, and it lands pro-rata on all holders — hence Low, not an "
      "inflation-attack finding."),
 ],
 "Tamper.11": [
  (B, "The "), (C, "l_factor"), (B, " half of Tamper.1, and the tighter of "
      "the two."), (P, " A deposit levers to "), (C, "target_loops"),
  (P, " and lands at "), (C, "design_hf = B × c_factor × l_factor / D"),
  (P, ". "), (C, "check_deposit_safety"), (P, " gates only on "),
  (C, "hf >= min_hf"), (P, " ("), (C, "leverage.rs:302"),
  (P, ") — never against "), (C, "orange_hf"), (P, ". The constructor asserts "
      "parameter ordering but never that "), (C, "design_hf > orange_hf"),
  (P, "; that check exists "), (B, "only"), (P, " in the deploy script's "),
  (C, "preflight()"), (P, " ("), (C, "deploy_strategy_mainnet.ts:236-247"),
  (P, ", "), (C, ":310-315"), (P, "). Since "), (C, "design_hf"),
  (P, " scales linearly in "), (C, "l_factor"), (P, ", a Blend cut past "),
  (C, "l₀ × orange_hf / design_hf"), (P, " puts "),
  (B, "every fresh deposit inside the rebalance band"), (P, ", where the first "
      "permissionless "), (C, "rebalance()"), (P, " unwinds the leverage that "
      "deposit just built — and anyone may call it. "),
  (B, "Margins are thinner than Tamper.1's:"), (P, " USDC 1.1312 vs 1.10 → "
      "trips at l = 0.924 ("), (B, "2.6pp"), (P, "); USTRY 1.1768 vs 1.15 → "
      "0.928 ("), (B, "2.2pp"), (P, "); CETES 1.1233 vs 1.10 → 0.930 ("),
  (B, "2.0pp"), (P, "); XLM 1.2238 vs 1.20 → 0.932 ("), (B, "1.9pp"),
  (P, "). A further ~4pp puts "), (C, "design_hf"), (P, " below "),
  (C, "min_hf"), (P, " and deposits revert outright, so the dangerous region "
      "is a "), (I, "band"), (P, ", not a cliff. No principal loss (every "
      "rebalance is equity-preserving); the cost is destroyed yield plus a "
      "griefing surface."),
 ],
 # repair only — orphaned by patch_body.py, outside the Tampering scope
 "DoS.9": None,
}

DOS9_LEAD = [(B, "The persistent half of DoS.5."), (P, " ")]


def replace_issue(doc, tid, parts):
    i = doc.index("2.3 Threat table")
    j = doc.index(f'>{tid}</w:t>', i)
    rs = doc.rindex("<w:tr>", i, j)
    re_ = doc.index("</w:tr>", j) + len("</w:tr>")
    row = doc[rs:re_]
    cells = list(re.finditer(r'<w:tc>.*?</w:tc>', row, re.S))
    issue = cells[3]
    w = re.search(r'w:w="(\d+)"', issue.group(0)).group(1)
    new = (f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{w}" /></w:tcPr>'
           '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
           + runs(parts) + '</w:p></w:tc>')
    return (doc[:rs] + row[:issue.start()] + new + row[issue.end():]
            + doc[re_:]), len(issue.group(0)), len(new)


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    saved = 0

    for tid, parts in ROWS.items():
        if parts is None:
            continue
        doc, before, after = replace_issue(doc, tid, parts)
        saved += before - after
        print(f"  {tid:12s} {before:6,d} -> {after:6,d}")

    # DoS.9: restore a lead-in without touching the rest of the row
    i = doc.index("2.3 Threat table")
    j = doc.index(">DoS.9</w:t>", i)
    rs = doc.rindex("<w:tr>", i, j)
    cells = list(re.finditer(r'<w:tc>.*?</w:tc>',
                             doc[rs:doc.index("</w:tr>", j)], re.S))
    issue_abs = rs + cells[3].start()
    p = doc.index('<w:pPr><w:pStyle w:val="Compact" /></w:pPr>', issue_abs)
    p += len('<w:pPr><w:pStyle w:val="Compact" /></w:pPr>')
    old = 'the persistent half of DoS.5, which v1.1 modelled only for instance storage.'
    k = doc.index(old, p)
    doc = doc[:p] + runs(DOS9_LEAD) + doc[p:k] + doc[k + len(old):]
    print(f"  DoS.9        lead-in repaired")

    print(f"  total saved: {saved:,} XML chars")
    out = HERE / "_tamper.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("Tampering pass applied")


if __name__ == "__main__":
    main()
